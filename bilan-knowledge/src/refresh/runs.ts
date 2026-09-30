import type { DbClient } from "../db/pool.js";

export type Trigger = "initial" | "scheduled" | "manual" | "retry" | "live_check";
export type RunStatus = "queued" | "running" | "complete" | "incomplete" | "failed" | "cancelled";

export interface RunRow {
  id: number;
  code: string;
  trigger: Trigger;
  status: RunStatus;
  requested_by: string | null;
  question: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  budget_usd: number;
  spend_usd: number;
  error: string | null;
}

export const TRIGGER_LABEL: Record<Trigger, string> = {
  initial: "Initial research",
  scheduled: "Scheduled refresh",
  manual: "Manual refresh",
  retry: "Retry refresh",
  live_check: "Live check",
};

/** "Update now" and the scheduler both go through kb_enqueue(), which prevents duplicates. */
export async function enqueue(db: DbClient, trigger: "manual" | "scheduled" | "retry" | "initial", requestedBy: string) {
  const { rows } = await db.query<{ run_id: number; run_code: string; created: boolean }>(
    "SELECT * FROM kb_enqueue($1, $2)",
    [trigger, requestedBy],
  );
  return rows[0];
}

export async function tick(db: DbClient, now?: Date): Promise<string> {
  const { rows } = await db.query<{ kb_tick: string }>(now ? "SELECT kb_tick($1)" : "SELECT kb_tick()", now ? [now] : []);
  return rows[0].kb_tick;
}

export async function claimNextRun(db: DbClient, workerId: string): Promise<RunRow | null> {
  const { rows } = await db.query<RunRow>(
    `UPDATE refresh_runs SET status = 'running', started_at = now(), last_activity_at = now(), worker_id = $1, stage = 'lock'
     WHERE id = (SELECT id FROM refresh_runs WHERE status = 'queued' AND trigger <> 'live_check'
                 ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING *`,
    [workerId],
  );
  return rows[0] ?? null;
}

export async function createLiveCheckRun(db: DbClient, budgetUsd: number, question: string | null, requestedBy: string): Promise<RunRow> {
  const { rows } = await db.query<RunRow>(
    `INSERT INTO refresh_runs (code, trigger, status, requested_by, question, budget_usd, started_at, last_activity_at, stage, sources_total)
     VALUES ('LC-' || lpad(nextval('live_check_code_seq')::text, 3, '0'), 'live_check', 'running', $1, $2, $3, now(), now(), 'live', 1)
     RETURNING *`,
    [requestedBy, question, budgetUsd],
  );
  return rows[0];
}

export async function setStage(db: DbClient, runId: number, stage: string): Promise<void> {
  await db.query("UPDATE refresh_runs SET stage = $2, last_activity_at = now() WHERE id = $1", [runId, stage]);
}
