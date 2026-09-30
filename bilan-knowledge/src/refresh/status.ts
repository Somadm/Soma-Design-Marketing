import type { Config } from "../config.js";
import type { DbClient } from "../db/pool.js";
import { getSettings } from "../settings.js";
import { TRIGGER_LABEL, type Trigger } from "./runs.js";

const DAY = 86_400_000;

export type Tone = "ok" | "warn" | "fail" | "info";

export interface StatusView {
  now: string;
  headline: { tone: Tone; title: string; detail: string };
  lastSuccess: { at: string; code: string; triggerLabel: string } | null;
  next: { at: string | null; sub: string; overdue: boolean };
  latestRun: { code: string; status: string; checked: number; failed: number; total: number; spend: number; budget: number } | null;
  active: { code: string; trigger: string; stage: string | null; done: number; total: number; budget: number; lastLine: string | null } | null;
  activation: { label: string; detail: string; done: boolean }[];
  activationComplete: boolean;
  updateLabel: string;
  researchConfigured: boolean;
  worker: { seenAt: string | null; alive: boolean };
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** Everything the status strip, headline and activation checklist show. Driven only by backend state. */
export async function getStatusView(db: DbClient, cfg: Config, researchConfigured: boolean, now = new Date()): Promise<StatusView> {
  const settings = await getSettings(db);
  const { rows: ss } = await db.query("SELECT * FROM system_status WHERE id = 1");
  const st = ss[0];
  const { rows: lastOk } = st.last_success_run
    ? await db.query("SELECT code, trigger, finished_at FROM refresh_runs WHERE id = $1", [st.last_success_run])
    : { rows: [] as { code: string; trigger: Trigger; finished_at: Date }[] };
  const { rows: latest } = await db.query(
    `SELECT id, code, trigger, status, sources_total, sources_verified, sources_failed, spend_usd, budget_usd, finished_at
     FROM refresh_runs WHERE trigger <> 'live_check' AND status NOT IN ('queued','running') ORDER BY id DESC LIMIT 1`,
  );
  const { rows: act } = await db.query(
    `SELECT id, code, trigger, status, stage, sources_total, sources_verified, sources_failed, budget_usd
     FROM refresh_runs WHERE status IN ('queued','running') AND trigger <> 'live_check' ORDER BY id LIMIT 1`,
  );
  const workerSeen: Date | null = st.worker_seen_at;
  const alive = Boolean(workerSeen && now.getTime() - workerSeen.getTime() < Math.max(3 * cfg.WORKER_POLL_SECONDS * 1000, 180_000));

  let active: StatusView["active"] = null;
  if (act[0]) {
    const { rows: ll } = await db.query("SELECT at, level, message FROM run_logs WHERE run_id = $1 ORDER BY id DESC LIMIT 1", [act[0].id]);
    active = {
      code: act[0].code,
      trigger: TRIGGER_LABEL[act[0].trigger as Trigger],
      stage: act[0].status === "queued" ? "queued" : act[0].stage,
      done: act[0].sources_verified + act[0].sources_failed,
      total: act[0].sources_total,
      budget: Number(act[0].budget_usd),
      lastLine: ll[0] ? `${new Date(ll[0].at).toISOString().slice(11, 19)} ${ll[0].level} ${ll[0].message}` : null,
    };
  }

  const lastSuccess = lastOk[0]
    ? { at: new Date(lastOk[0].finished_at).toISOString(), code: lastOk[0].code, triggerLabel: TRIGGER_LABEL[lastOk[0].trigger as Trigger] }
    : null;
  const lr = latest[0];
  const latestRun = lr
    ? { code: lr.code, status: lr.status, checked: lr.sources_total, failed: lr.sources_failed, total: lr.sources_total, spend: Number(lr.spend_usd), budget: Number(lr.budget_usd) }
    : null;
  const deployed = Boolean(st.deployed_at && st.worker_deployed);

  // Next scheduled refresh: 42 days after the last success, at the start of the next run window.
  let next: StatusView["next"];
  if (!lastSuccess) {
    next = { at: null, sub: deployed ? "After initial research" : "Backend not deployed", overdue: false };
  } else {
    const due = new Date(new Date(lastSuccess.at).getTime() + settings.interval_days * DAY);
    const [hh, mm] = settings.run_window_utc.split(":").map(Number);
    // The refresh starts at the first tick inside a run window at or after the due time.
    const windowMs = settings.run_window_hours * 3600_000;
    let start = Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate(), hh, mm);
    if (start > due.getTime()) start -= DAY; // window that may already contain the due time
    const at = new Date(due.getTime() < start + windowMs ? due.getTime() : start + DAY);
    const days = Math.round((Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()) - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) / DAY);
    const windowEnd = at.getTime() + windowMs;
    const overdue = now.getTime() > windowEnd && !active;
    next = {
      at: at.toISOString(),
      sub: !deployed ? "Pending deployment" : overdue ? `Overdue by ${Math.max(1, -days)} day${Math.max(1, -days) === 1 ? "" : "s"}` : days > 0 ? `In ${days} day${days === 1 ? "" : "s"}` : "Due today",
      overdue: deployed && overdue,
    };
  }

  const activation = [
    { label: "Backend deployed", detail: deployed ? `Worker running in production since ${fmtDate(st.deployed_at)}.` : "Scheduler, worker and database running in production.", done: deployed && alive },
    { label: "Initial research complete", detail: lastSuccess ? `Done ${fmtDate(new Date(lastSuccess.at))}, ${lastSuccess.code}.` : "Indexes official Meta and TikTok sources.", done: Boolean(lastSuccess) },
    { label: "First scheduled refresh completed on the deployed backend", detail: st.schedule_verified_at ? `Verified ${fmtDate(st.schedule_verified_at)}.` : "Triggered by the scheduler with the app closed.", done: Boolean(st.schedule_verified_at) },
    { label: "Failure path tested", detail: st.failure_path_verified_at ? `Verified ${fmtDate(st.failure_path_verified_at)}.` : "A forced source failure shows as incomplete and keeps the last verified version.", done: Boolean(st.failure_path_verified_at) },
  ];

  let headline: StatusView["headline"];
  if (active && active.stage === "queued") {
    headline = {
      tone: "info",
      title: "Refresh queued",
      detail: !researchConfigured
        ? `Job ${active.code} cannot start: research is not configured on the server (ANTHROPIC_API_KEY).`
        : alive ? `Job ${active.code} is queued and will start within a minute.` : `Job ${active.code} is waiting for the worker, which has not checked in recently.`,
    };
  } else if (active) {
    headline = { tone: "info", title: "Refresh running", detail: `Job ${active.code} holds the refresh lock. Other refresh requests are blocked until it finishes.` };
  } else if (lr && lr.status !== "complete") {
    headline = {
      tone: "fail",
      title: lr.status === "failed" ? "Last refresh failed" : "Last refresh incomplete",
      detail:
        `${lr.sources_failed} of ${lr.sources_total} sources could not be verified in ${lr.code}. ` +
        (lastSuccess ? `Bilan is using the last verified versions from ${fmtDate(new Date(lastSuccess.at))}.` : "No guidance has been verified yet."),
    };
  } else if (!st.schedule_verified_at) {
    headline = {
      tone: "warn",
      title: "Automatic updates not active",
      detail: lastSuccess
        ? `A refresh completed on ${fmtDate(new Date(lastSuccess.at))}. Automatic updates become active after the deployed scheduler completes its first scheduled refresh.`
        : "The backend schedule has not been deployed or tested. Run initial research, then confirm a scheduled refresh on the deployed backend.",
    };
  } else if (!alive) {
    headline = { tone: "warn", title: "Automatic updates paused", detail: `The worker has not checked in since ${workerSeen ? fmtDate(workerSeen) : "deployment"}. Scheduled refreshes will not run until it is back.` };
  } else {
    headline = { tone: "ok", title: "Automatic updates active", detail: `Schedule tested on the deployed backend. ${lastSuccess!.code} completed and was stored on ${fmtDate(new Date(lastSuccess!.at))}.` };
  }

  return {
    now: now.toISOString(),
    headline,
    lastSuccess,
    next,
    latestRun,
    active,
    activation,
    activationComplete: activation.every((a) => a.done),
    updateLabel: active ? `Refreshing… ${active.done}/${active.total || "?"}` : lastSuccess ? "Update now" : "Run initial research",
    researchConfigured,
    worker: { seenAt: workerSeen ? workerSeen.toISOString() : null, alive },
  };
}
