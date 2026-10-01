import type { Config } from "../config.js";
import type { DbClient } from "../db/pool.js";
import type { Mailer } from "../email.js";
import { inQuietHours } from "../time.js";
import { getSettings } from "./settings.js";

/**
 * Email notifications, following Memory → Notifications. Quiet hours (21:00–08:00
 * Helsinki) hold everything except publishing failures, which always break through.
 * Held items go out in the next daily summary.
 */
export class Notifier {
  constructor(
    private db: DbClient,
    private cfg: Config,
    private mailer: Mailer,
    private ownerEmail: () => Promise<string | null>,
  ) {}

  async inboxItem(item: { id: number; kind: string; title: string; body: string; urgent: boolean }, now = new Date()): Promise<boolean> {
    const s = (await getSettings(this.db)).notifications;
    const isFailure = item.kind === "Publishing failed";
    if (isFailure ? !s.fail : !s.inbox) return false;
    if (s.quiet && inQuietHours(now) && !isFailure) return false;
    return this.send(`Needs you: ${item.title}`, `${item.body}\n\nOpen Needs Sabah: ${this.cfg.APP_URL}/inbox`, item.id);
  }

  async published(title: string, platform: string): Promise<boolean> {
    const s = (await getSettings(this.db)).notifications;
    if (!s.published || (s.quiet && inQuietHours(new Date()))) return false;
    return this.send(`Published: ${title}`, `${platform} confirmed “${title}”.`);
  }

  async send(subject: string, text: string, inboxId?: number): Promise<boolean> {
    const to = await this.ownerEmail();
    if (!to) return false;
    try {
      await this.mailer.send({ to, subject: `Sagal · ${subject}`, text });
      if (inboxId) await this.db.query("UPDATE sagal.inbox_items SET notified_at = now() WHERE id = $1", [inboxId]);
      return true;
    } catch (err) {
      console.error("[sagal] notification failed:", (err as Error).message);
      return false;
    }
  }
}
