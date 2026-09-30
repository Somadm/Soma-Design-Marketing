import type { DbClient } from "./db/pool.js";

export type Level = "INFO" | "WARN" | "ERROR";

export interface RunLog {
  (level: Level, stage: string, message: string, data?: Record<string, unknown>): Promise<void>;
  info: (stage: string, message: string, data?: Record<string, unknown>) => Promise<void>;
  warn: (stage: string, message: string, data?: Record<string, unknown>) => Promise<void>;
  error: (stage: string, message: string, data?: Record<string, unknown>) => Promise<void>;
}

/**
 * Execution log for a run: written to run_logs (shown in Execution logs) and stdout.
 * Every line also counts as run activity for stuck-run detection.
 */
export function runLog(db: DbClient, runId: number | null): RunLog {
  const log = (async (level: Level, stage: string, message: string, data?: Record<string, unknown>) => {
    const line = JSON.stringify({ t: new Date().toISOString(), level, runId, stage, message });
    (level === "INFO" ? console.log : console.error)(line);
    try {
      await db.query("INSERT INTO run_logs (run_id, level, stage, message, data) VALUES ($1,$2,$3,$4,$5)", [
        runId, level, stage, message.slice(0, 4000), data ? JSON.stringify(data) : null,
      ]);
      if (runId !== null) await db.query("UPDATE refresh_runs SET last_activity_at = now() WHERE id = $1", [runId]);
    } catch (err) {
      console.error(JSON.stringify({ level: "ERROR", message: "failed to persist log line", err: String(err) }));
    }
  }) as RunLog;
  log.info = (s, m, d) => log("INFO", s, m, d);
  log.warn = (s, m, d) => log("WARN", s, m, d);
  log.error = (s, m, d) => log("ERROR", s, m, d);
  return log;
}
