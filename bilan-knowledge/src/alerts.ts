import type { Config } from "./config.js";
import type { Db } from "./db/pool.js";
import { getSettings } from "./settings.js";

/**
 * Emails a notice for every refresh that finished incomplete or failed (including
 * runs recovered as stuck), via Resend. Each run is alerted once.
 */
export async function sendPendingAlerts(db: Db, cfg: Config, fetchImpl: typeof fetch = fetch): Promise<number> {
  const { rows } = await db.query<{ id: number; code: string; status: string; note: string | null; error: string | null }>(
    `SELECT id, code, status, note, error FROM refresh_runs
     WHERE trigger <> 'live_check' AND status IN ('incomplete','failed') AND alert_sent_at IS NULL AND alert_error IS NULL
     ORDER BY id`,
  );
  if (!rows.length) return 0;
  const settings = await getSettings(db);
  let sent = 0;
  for (const run of rows) {
    if (!settings.alert_email || !cfg.RESEND_API_KEY) {
      await db.query("UPDATE refresh_runs SET alert_error = $2 WHERE id = $1", [
        run.id,
        !settings.alert_email ? "No alert email set in Settings" : "Email sending not configured (RESEND_API_KEY)",
      ]);
      continue;
    }
    const { rows: esc } = await db.query<{ title: string; url: string }>("SELECT title, url FROM sources WHERE escalated_at IS NOT NULL AND status <> 'paused'");
    const text = [
      `Bilan knowledge refresh ${run.code} ${run.status === "failed" ? "failed" : "was incomplete"}.`,
      "",
      run.note ?? "",
      run.error ? `\nDetails:\n${run.error}` : "",
      "",
      "Bilan is using the last verified versions of any guidance that could not be checked. Nothing was published and no spend was changed.",
      esc.length ? `\nSources that failed in 3 consecutive runs (fix the URL or pause them):\n${esc.map((s) => `- ${s.title}: ${s.url}`).join("\n")}` : "",
      cfg.APP_URL ? `\nOpen Knowledge updates: ${cfg.APP_URL}` : "",
    ].join("\n");
    try {
      const res = await fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${cfg.RESEND_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ from: cfg.ALERT_FROM_EMAIL, to: [settings.alert_email], subject: `Bilan: knowledge refresh ${run.code} ${run.status}`, text }),
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      await db.query("UPDATE refresh_runs SET alert_sent_at = now() WHERE id = $1", [run.id]);
      sent++;
    } catch (err) {
      await db.query("UPDATE refresh_runs SET alert_error = $2 WHERE id = $1", [run.id, `Alert email failed: ${(err as Error).message}`]);
    }
  }
  return sent;
}
