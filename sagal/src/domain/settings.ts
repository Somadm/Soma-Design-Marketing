import type { DbClient } from "../db/pool.js";

export type BrainMode = "auto" | "everyday" | "deep";
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface Settings {
  /** auto: Sonnet by default, Opus when the work needs it. everyday: always Sonnet. deep: always Opus. */
  brain: { mode: BrainMode };
  /** Sabah's taste in her own words; Sagal reads it with the Inspiration board every turn. */
  taste: { love: string; avoid: string };
  /** Let Sagal search the web and read pages (Claude's web tools). Off until Sabah turns it on. */
  web: { enabled: boolean; lastError?: string | null };
  /** Sagal's own morning check: keep the posting days filled without being asked. */
  routine: { enabled: boolean; days: Weekday[]; lastRun: string | null };
  notifications: { inbox: boolean; fail: boolean; daily: boolean; published: boolean; quiet: boolean };
  voice: { voice: string; speed: string; transcript: boolean };
  appearance: { portraitAssetId: number | null; approved: boolean };
  brand: Record<string, number | null>; // slot → asset id
  defaultPostTime: string;
  lastDailySummary: string | null;
}

export const DEFAULT_SETTINGS: Settings = {
  brain: { mode: "auto" },
  taste: { love: "", avoid: "" },
  web: { enabled: false },
  routine: { enabled: true, days: ["Mon", "Wed", "Fri"], lastRun: null },
  notifications: { inbox: true, fail: true, daily: true, published: false, quiet: true },
  voice: { voice: "Warm · lightly Brooklyn", speed: "1.0×", transcript: true },
  appearance: { portraitAssetId: null, approved: false },
  brand: { logo: null, wordmark: null, photo: null },
  defaultPostTime: "12:00",
  lastDailySummary: null,
};

export async function getSettings(db: DbClient): Promise<Settings> {
  const { rows } = await db.query<{ key: keyof Settings; value: unknown }>("SELECT key, value FROM sagal.settings");
  const out: Settings = structuredClone(DEFAULT_SETTINGS);
  for (const r of rows) {
    const def = DEFAULT_SETTINGS[r.key];
    if (def === undefined) continue;
    (out as unknown as Record<string, unknown>)[r.key] =
      def && typeof def === "object" && !Array.isArray(def) ? { ...(def as object), ...(r.value as object) } : r.value;
  }
  return out;
}

export async function setSetting<K extends keyof Settings>(db: DbClient, key: K, value: Settings[K]): Promise<void> {
  await db.query(
    `INSERT INTO sagal.settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}
