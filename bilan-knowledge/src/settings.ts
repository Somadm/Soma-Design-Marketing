import { z } from "zod";
import type { DbClient } from "./db/pool.js";

export interface Settings {
  interval_days: number;
  run_window_utc: string; // "HH:MM"
  run_window_hours: number;
  retries: number;
  backoff_minutes: number[];
  budget_refresh_usd: number;
  budget_initial_usd: number;
  budget_live_month_usd: number;
  on_limit: "stop" | "finish";
  alert_email: string | null;
  auto_initial: boolean;
  campaign_profile: string;
}

export async function getSettings(db: DbClient): Promise<Settings> {
  const { rows } = await db.query(
    `SELECT interval_days, to_char(run_window_utc, 'HH24:MI') AS run_window_utc, run_window_hours, retries,
            backoff_minutes, budget_refresh_usd, budget_initial_usd, budget_live_month_usd, on_limit,
            alert_email, auto_initial, campaign_profile
     FROM settings WHERE id = 1`,
  );
  return rows[0] as Settings;
}

/** Fields editable from the Settings tab. The 42-day interval and publishing lock are not. */
export const SettingsUpdateSchema = z
  .object({
    run_window_utc: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM (UTC)"),
    retries: z.coerce.number().int().min(1).max(6),
    budget_refresh_usd: z.coerce.number().min(0.1).max(500),
    budget_initial_usd: z.coerce.number().min(0.1).max(500),
    budget_live_month_usd: z.coerce.number().min(0).max(500),
    on_limit: z.enum(["stop", "finish"]),
    alert_email: z.union([z.string().email(), z.literal("")]).nullable(),
    campaign_profile: z.string().min(20).max(8000),
  })
  .partial();

export async function updateSettings(db: DbClient, patch: z.infer<typeof SettingsUpdateSchema>): Promise<Settings> {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length) {
    const sets = entries.map(([k], i) => `${k} = $${i + 1}`).join(", ");
    const values = entries.map(([k, v]) => (k === "alert_email" && v === "" ? null : v));
    await db.query(`UPDATE settings SET ${sets}, updated_at = now() WHERE id = 1`, values);
  }
  return getSettings(db);
}
