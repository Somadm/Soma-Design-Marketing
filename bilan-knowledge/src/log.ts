import type { DbClient } from "./db/pool.js";

export type Level = "debug" | "info" | "warn" | "error";

export interface Logger {
  log(level: Level, message: string, data?: Record<string, unknown>): Promise<void>;
  info(message: string, data?: Record<string, unknown>): Promise<void>;
  warn(message: string, data?: Record<string, unknown>): Promise<void>;
  error(message: string, data?: Record<string, unknown>): Promise<void>;
}

/** Writes execution logs to stdout and to run_logs so they are visible in the dashboard. */
export function runLogger(db: DbClient, runId: number | null): Logger {
  const log = async (level: Level, message: string, data?: Record<string, unknown>) => {
    const line = JSON.stringify({ t: new Date().toISOString(), level, runId, message, ...(data ? { data } : {}) });
    (level === "error" || level === "warn" ? console.error : console.log)(line);
    try {
      await db.query("INSERT INTO run_logs (run_id, level, message, data) VALUES ($1, $2, $3, $4)", [
        runId,
        level,
        message.slice(0, 4000),
        data ? JSON.stringify(data) : null,
      ]);
    } catch (err) {
      console.error(JSON.stringify({ level: "error", message: "failed to persist log", err: String(err) }));
    }
  };
  return {
    log,
    info: (m, d) => log("info", m, d),
    warn: (m, d) => log("warn", m, d),
    error: (m, d) => log("error", m, d),
  };
}
