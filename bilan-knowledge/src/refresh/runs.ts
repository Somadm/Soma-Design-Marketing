import type { DbClient } from "../db/pool.js";

export type RunTrigger = "initial" | "scheduled" | "retry" | "manual" | "live_check";
export type RunStatus = "queued" | "running" | "succeeded" | "incomplete" | "failed";

export interface RunRow {
  id: number;
  trigger: RunTrigger;
  status: RunStatus;
  requested_by: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  heartbeat_at: Date | null;
  error: string | null;
}

export type EnqueueResult = { created: true; run: RunRow } | { created: false; run: RunRow };

/**
 * Queues a full refresh. The partial unique index refresh_runs_one_active makes
 * this safe against duplicates across processes: a second enqueue while one is
 * queued/running returns the existing run instead.
 */
export async function enqueueRun(db: DbClient, trigger: Exclude<RunTrigger, "live_check">, requestedBy: string): Promise<EnqueueResult> {
  try {
    const { rows } = await db.query<RunRow>(
      "INSERT INTO refresh_runs (trigger, status, requested_by) VALUES ($1, 'queued', $2) RETURNING *",
      [trigger, requestedBy],
    );
    return { created: true, run: rows[0] };
  } catch (err) {
    if ((err as { code?: string }).code !== "23505") throw err;
    const active = await activeRun(db);
    if (!active) throw new Error("refresh already active but could not be loaded");
    return { created: false, run: active };
  }
}

export async function activeRun(db: DbClient): Promise<RunRow | null> {
  const { rows } = await db.query<RunRow>(
    "SELECT * FROM refresh_runs WHERE status IN ('queued','running') AND trigger <> 'live_check' ORDER BY id LIMIT 1",
  );
  return rows[0] ?? null;
}

/** Atomically claims the oldest queued run for this worker. */
export async function claimNextRun(db: DbClient, workerId: string): Promise<RunRow | null> {
  const { rows } = await db.query<RunRow>(
    `UPDATE refresh_runs SET status = 'running', started_at = now(), heartbeat_at = now(), worker_id = $1
     WHERE id = (SELECT id FROM refresh_runs WHERE status = 'queued' AND trigger <> 'live_check'
                 ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING *`,
    [workerId],
  );
  return rows[0] ?? null;
}

export async function heartbeat(db: DbClient, runId: number): Promise<void> {
  await db.query("UPDATE refresh_runs SET heartbeat_at = now() WHERE id = $1 AND status = 'running'", [runId]);
}

/** Marks runs whose worker died (no heartbeat) as failed so the schedule can continue. */
export async function reapStaleRuns(db: DbClient, staleMinutes: number): Promise<number[]> {
  const { rows } = await db.query<{ id: number }>(
    `UPDATE refresh_runs SET status = 'failed', finished_at = now(),
       error = 'worker stopped responding (no heartbeat for ' || $1::text || ' minutes); last verified knowledge retained'
     WHERE status = 'running' AND heartbeat_at < now() - make_interval(mins => $1::int)
     RETURNING id::int`,
    [staleMinutes],
  );
  return rows.map((r) => r.id);
}

export async function createLiveCheckRun(db: DbClient, requestedBy: string): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO refresh_runs (trigger, status, requested_by, started_at, heartbeat_at)
     VALUES ('live_check', 'running', $1, now(), now()) RETURNING id::int`,
    [requestedBy],
  );
  return rows[0].id;
}
