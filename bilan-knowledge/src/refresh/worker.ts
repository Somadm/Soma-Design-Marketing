import { sendPendingAlerts } from "../alerts.js";
import type { Config } from "../config.js";
import type { Db } from "../db/pool.js";
import type { Embedder } from "../research/embeddings.js";
import type { ResearchModel } from "../research/model.js";
import { executeRun } from "./runner.js";
import { claimNextRun, tick } from "./runs.js";

export interface WorkerDeps {
  db: Db;
  cfg: Config;
  model: ResearchModel | null;
  embedder: Embedder | null;
  workerId: string;
  deployed: boolean;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export async function workerHeartbeat(deps: Pick<WorkerDeps, "db" | "workerId" | "deployed">): Promise<void> {
  await deps.db.query(
    `UPDATE system_status SET worker_seen_at = now(), worker_id = $1, worker_deployed = $2,
       deployed_at = CASE WHEN $2 THEN COALESCE(deployed_at, now()) ELSE deployed_at END
     WHERE id = 1`,
    [deps.workerId, deps.deployed],
  );
}

/**
 * One worker cycle: heartbeat, kb_tick() (also run by pg_cron where available),
 * execute a queued refresh, send alerts.
 */
export async function workerCycle(deps: WorkerDeps, opts: { runTick: boolean }): Promise<{ tick?: string; executed?: string }> {
  await workerHeartbeat(deps);
  const out: { tick?: string; executed?: string } = {};
  // Without research configured nothing could execute a queued run, so don't schedule one.
  if (opts.runTick && deps.model) out.tick = await tick(deps.db);
  if (deps.model) {
    const run = await claimNextRun(deps.db, deps.workerId);
    if (run) {
      await executeRun({ ...deps, model: deps.model }, run);
      out.executed = run.code;
    }
  }
  await sendPendingAlerts(deps.db, deps.cfg, deps.fetchImpl).catch((err) =>
    console.error(JSON.stringify({ level: "ERROR", message: "alert sending failed", err: String(err) })),
  );
  return out;
}

export interface WorkerHandle {
  wake: () => void;
  stop: () => Promise<void>;
}

/** Long-running worker loop. Cycles never overlap; "Update now" wakes it early. */
export function startWorker(deps: WorkerDeps): WorkerHandle {
  let stopped = false;
  let running = false;
  let again = false;
  let timer: NodeJS.Timeout | null = null;
  let lastTick = 0;
  let current: Promise<unknown> = Promise.resolve();
  // Liveness is reported independently, so a long refresh doesn't look like a dead worker.
  const beat = setInterval(() => workerHeartbeat(deps).catch(() => {}), 60_000);

  const loop = async () => {
    if (stopped || running) return;
    running = true;
    if (timer) clearTimeout(timer);
    do {
      again = false;
      const runTick = Date.now() - lastTick >= deps.cfg.TICK_MINUTES * 60_000;
      if (runTick) lastTick = Date.now();
      current = workerCycle(deps, { runTick }).catch((err) =>
        console.error(JSON.stringify({ level: "ERROR", message: "worker cycle failed", err: String(err) })),
      );
      await current;
    } while (again && !stopped);
    running = false;
    if (!stopped) timer = setTimeout(loop, deps.cfg.WORKER_POLL_SECONDS * 1000);
  };
  void loop();
  return {
    wake: () => {
      if (running) again = true;
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
