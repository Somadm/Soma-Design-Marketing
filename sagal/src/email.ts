import type { Config } from "./config.js";
import type { Vault } from "./secrets/vault.js";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  /** Returns "sent" when delivered to the email service, "logged" when email isn't set up yet. */
  send(msg: EmailMessage): Promise<"sent" | "logged">;
}

/**
 * Sends through Resend when a key is configured (Connected accounts, or RESEND_API_KEY).
 * Until then the message is written to the server log, so Sabah can still sign in by
 * reading the code from the hosting dashboard's logs.
 */
export class ResendMailer implements Mailer {
  constructor(
    private cfg: Config,
    private vault: Vault,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async send(msg: EmailMessage): Promise<"sent" | "logged"> {
    const key = (await this.vault.get("email.resend_api_key")) ?? this.cfg.RESEND_API_KEY;
    const from = (await this.vault.get("email.from")) ?? this.cfg.EMAIL_FROM;
    if (!key) {
      console.log(`[sagal] Email not set up yet, so here is the message instead.\nTo: ${msg.to}\nSubject: ${msg.subject}\n\n${msg.text}\n`);
      return "logged";
    }
    const res = await this.fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ from, to: [msg.to], subject: msg.subject, text: msg.text }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`Email service returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return "sent";
  }
}

/** Test double: keeps messages in memory. */
export class MemoryMailer implements Mailer {
  sent: EmailMessage[] = [];
  async send(msg: EmailMessage): Promise<"sent"> {
    this.sent.push(msg);
    return "sent";
  }
}
