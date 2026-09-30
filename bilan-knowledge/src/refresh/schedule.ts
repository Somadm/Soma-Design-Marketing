import type { Config } from "../config.js";
import type { Db, DbClient } from "../db/pool.js";
import { runLogger } from "../log.js";
import type { ResearchModel } from "../research/model.js";
import { executeRun } from "./runner.js";
import { activeRun, claimNextRun, enqueueRun, reapStaleRuns, type RunRow, type RunTrigger } from "./runs.js";

const FULL = "trigger <> 'live_check'";
const HOUR = 3600_000;
const DAY = 24 * HOUR;

export interface ScheduleState {
  lastSuccessAt: Date | null;
  lastSuccessRunId: number | null;
  /** When the 42-day refresh is due (last success + interval), or null before the first success. */
  nextScheduledAt: Date | null;
  /** When the scheduler will actually start the next run (accounts for retries). */
  nextAttemptAt: Date | null;
  nextTrigger: Exclude<RunTrigger, "live_check" | "manual"> | null;
  failuresSinceSuccess: number;
  retriesExhausted: boolean;
  activeRun: RunRow | null;
  lastRun: RunRow | null;
  note: string;
}

export async function getScheduleState(db: DbClient, cfg: Config, now = new Date()): Promise<ScheduleState> {
  const { rows: succ } = await db.query<{ id: number; finished_at: Date }>(
    `SELECT id::int, finished_at FROM refresh_runs WHERE ${FULL} AND status = 'succeeded' ORDER BY finished_at DESC LIMIT 1`,
  );
  const lastSuccess = succ[0] ?? null;
  const nextScheduledAt = lastSuccess ? new Date(lastSuccess.finished_at.getTime() + cfg.REFRESH_INTERVAL_DAYS * DAY) : null;
  // Only failures at/after the due time count toward retries: an early manual
  // "Update now" that fails must not use up the scheduled refresh's retries.
  const { rows: fails } = await db.query<{ finished_at: Date }>(
    `SELECT finished_at FROM refresh_runs WHERE ${FULL} AND status IN ('failed','incomplete')
       AND finished_at > $1 AND finished_at >= $2 ORDER BY finished_at`,
    [lastSuccess?.finished_at ?? new Date(0), nextScheduledAt ?? new Date(0)],
  );
  const { rows: last } = await db.query<RunRow>(`SELECT * FROM refresh_runs WHERE ${FULL} ORDER BY id DESC LIMIT 1`);
  const active = await activeRun(db);

  const delays = cfg.REFRESH_RETRY_DELAYS_HOURS;
  const failures = fails.length;
  const retriesExhausted = failures > delays.length;

  let nextAttemptAt: Date | null = null;
  let nextTrigger: ScheduleState["nextTrigger"] = null;
  let note = "";

  if (!cfg.KB_SCHEDULE_ENABLED) {
    note = "Automatic schedule is switched off (KB_SCHEDULE_ENABLED=false).";
  } else if (!lastSuccess && !cfg.KB_AUTO_INITIAL && failures === 0) {
    note = "Waiting for the initial research to be started with “Update now”.";
  } else if (retriesExhausted) {
    note = `Automatic retries exhausted after ${failures} failed/incomplete attempts. Fix the flagged sources or press “Update now”.`;
  } else {
    const base = nextScheduledAt ?? now; // no success yet: initial research is due now
    if (failures > 0) {
      const lastFail = fails[failures - 1].finished_at;
      nextAttemptAt = new Date(lastFail.getTime() + delays[failures - 1] * HOUR);
      nextTrigger = lastSuccess ? "retry" : "initial";
      note = `Retry ${failures} of ${delays.length} after a failed/incomplete refresh.`;
    } else {
      nextAttemptAt = base;
      nextTrigger = lastSuccess ? "scheduled" : "initial";
      note = lastSuccess ? `Every ${cfg.REFRESH_INTERVAL_DAYS} days from the last successful refresh.` : "Initial research is due.";
    }
  }

  return {
    lastSuccessAt: lastSuccess?.finished_at ?? null,
    lastSuccessRunId: lastSuccess?.id ?? null,
    nextScheduledAt,
    nextAttemptAt,
    nextTrigger,
    failuresSinceSuccess: failures,
    retriesExhausted,
    activeRun: active,
    lastRun: last[0] ?? null,
    note,
  };
}

export interface AutomationStatus {
  active: boolean;
  reasons: string[];
  schedulerLastSeenAt: Date | null;
}

/**
 * "Automatic updates are active" is only claimed when the deployed scheduler is
 * alive AND a refresh started by the scheduler itself has completed successfully.
 */
export async function getAutomationStatus(db: DbClient, cfg: Config, now = new Date()): Promise<AutomationStatus> {
  const reasons: string[] = [];
  const { rows } = await db.query<{ value: { at: string } }>("SELECT value FROM settings WHERE key = 'scheduler_heartbeat'");
  const seen = rows[0] ? new Date(rows[0].value.at) : null;
  if (!cfg.ANTHROPIC_API_KEY) reasons.push("ANTHROPIC_API_KEY is not configured");
  if (!cfg.KB_SCHEDULE_ENABLED) reasons.push("Schedule is switched off");
  if (!seen) reasons.push("The scheduler has never run on this deployment");
  else if (now.getTime() - seen.getTime() > cfg.SCHEDULER_TICK_SECONDS * 3000)
    reasons.push(`The scheduler has not checked in since ${seen.toISOString()}`);
  const { rowCount } = await db.query(
    `SELECT 1 FROM refresh_runs WHERE trigger IN ('initial','scheduled','retry') AND status = 'succeeded' AND requested_by = 'scheduler' LIMIT 1`,
  );
  if (!rowCount) reasons.push("No scheduler-started refresh has completed successfully yet");
  return { active: reasons.length === 0, reasons, schedulerLastSeenAt: seen };
}

export interface SchedulerDeps {
  db: Db;
  cfg: Config;
  model: ResearchModel | null;
  workerId: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * One scheduler tick: record liveness, recover crashed runs, enqueue a refresh if
 * one is due, then execute any queued run (including "Update now" requests).
 * Safe to call from several processes at once.
 */
export async function schedulerTick(deps: SchedulerDeps, now = new Date()): Promise<{ enqueued: boolean; executed: number | null }> {
  const { db, cfg } = deps;
  const log = runLogger(db, null);
  await schedulerHeartbeat(db, deps.workerId, now);
  const reaped = await reapStaleRuns(db, cfg.RUN_STALE_MINUTES);
  for (const id of reaped) await log.warn(`Refresh #${id} marked failed: worker stopped responding`);

  let enqueued = false;
  const state = await getScheduleState(db, cfg, now);
  if (!state.activeRun && state.nextAttemptAt && state.nextTrigger && state.nextAttemptAt <= now) {
    if (!deps.model) {
      await log.warn("Refresh is due but ANTHROPIC_API_KEY is not configured; not starting");
    } else {
      const r = await enqueueRun(db, state.nextTrigger, "scheduler");
      enqueued = r.created;
      if (r.created) await log.info(`Scheduled ${state.nextTrigger} refresh #${r.run.id} queued`);
    }
  }

  if (!deps.model) return { enqueued, executed: null };
  const run = await claimNextRun(db, deps.workerId);
  if (!run) return { enqueued, executed: null };
  await executeRun({ db, cfg, model: deps.model, fetchImpl: deps.fetchImpl, sleep: deps.sleep }, run);
  return { enqueued, executed: run.id };
}

export async function schedulerHeartbeat(db: DbClient, workerId: string, now = new Date()): Promise<void> {
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('scheduler_heartbeat', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify({ at: now.toISOString(), worker: workerId })],
  );
}

export interface SchedulerHandle {
  /** Run a tick as soon as possible (used after "Update now" in single-process mode). */
  wake: () => void;
  stop: () => Promise<void>;
}

/** Long-running loop for the worker process. Ticks never overlap. */
export function startScheduler(deps: SchedulerDeps): SchedulerHandle {
  let stopped = false;
  let running = false;
  let wakeRequested = false;
  let timer: NodeJS.Timeout | null = null;
  let current: Promise<unknown> = Promise.resolve();
  // Liveness is reported independently of ticks, so a long refresh doesn't look like a dead scheduler.
  const beat = setInterval(
    () => schedulerHeartbeat(deps.db, deps.workerId).catch(() => {}),
    Math.min(deps.cfg.SCHEDULER_TICK_SECONDS, 60) * 1000,
  );
  const loop = async () => {
    if (stopped || running) return;
    running = true;
    if (timer) clearTimeout(timer);
    do {
      wakeRequested = false;
      current = schedulerTick(deps).catch((err) =>
        console.error(JSON.stringify({ level: "error", message: "scheduler tick failed", err: String(err) })),
      );
      await current;
    } while (wakeRequested && !stopped);
    running = false;
    if (!stopped) timer = setTimeout(loop, deps.cfg.SCHEDULER_TICK_SECONDS * 1000);
  };
  void loop();
  return {
    wake: () => {
      if (running) wakeRequested = true;
      else void loop();
    },
    stop: async () => {
      stopped = true;
      clearInterval(beat);
      if (timer) clearTimeout(timer);
      await current;
    },
  };
}
