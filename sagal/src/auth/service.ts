import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { Config } from "../config.js";
import type { Db } from "../db/pool.js";
import type { Mailer } from "../email.js";
import { hashPassword, passwordProblem, verifyPassword } from "./passwords.js";

export const SESSION_DAYS = 30;
const CODE_MINUTES = 10;
const CODE_ATTEMPTS = 5;
const LOCK_AFTER = 5;
const LOCK_MINUTES = 15;

export class AuthError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const normEmail = (e: string) => e.trim().toLowerCase();

/**
 * Single-owner sign-in: email + password, then a 6-digit code sent by email.
 * The code is required when the account is created (to prove the address), on every
 * sign-in, and to reset a forgotten password.
 */
export class AuthService {
  constructor(
    private db: Db,
    private cfg: Config,
    private mailer: Mailer,
  ) {}

  async ownerExists(): Promise<boolean> {
    const { rowCount } = await this.db.query("SELECT 1 FROM sagal.owner WHERE verified_at IS NOT NULL");
    return Boolean(rowCount);
  }

  private async issueCode(purpose: "verify" | "login" | "reset", email: string): Promise<{ challengeId: string; delivery: "sent" | "logged" }> {
    const recent = await this.db.query("SELECT 1 FROM sagal.email_codes WHERE purpose = $1 AND created_at > now() - interval '20 seconds'", [purpose]);
    if (recent.rowCount) throw new AuthError("A code was just sent. Wait a few seconds before asking for another.", 429);
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const challengeId = randomBytes(18).toString("base64url");
    await this.db.query("UPDATE sagal.email_codes SET consumed_at = now() WHERE purpose = $1 AND consumed_at IS NULL", [purpose]);
    await this.db.query(
      `INSERT INTO sagal.email_codes (id, purpose, code_hash, expires_at) VALUES ($1, $2, $3, now() + make_interval(mins => $4))`,
      [challengeId, purpose, sha256(`${challengeId}:${code}`), CODE_MINUTES],
    );
    const what = { verify: "confirm your email for Sagal", login: "sign in to Sagal", reset: "reset your Sagal password" }[purpose];
    const delivery = await this.mailer.send({
      to: email,
      subject: `${code} is your Sagal code`,
      text: `Your code to ${what} is ${code}.\n\nIt works for ${CODE_MINUTES} minutes. If you didn't ask for it, you can ignore this email; your account is safe.`,
    });
    return { challengeId, delivery };
  }

  /** Step 1 of first-time setup. Only OWNER_EMAIL may register, and only once. */
  async register(emailRaw: string, password: string) {
    if (await this.ownerExists()) throw new AuthError("This app already has an owner. Sign in instead.", 409);
    const email = normEmail(emailRaw);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AuthError("That doesn't look like an email address.");
    if (this.cfg.OWNER_EMAIL && email !== normEmail(this.cfg.OWNER_EMAIL)) {
      throw new AuthError("This app is set up for a different email address.", 403);
    }
    const problem = passwordProblem(password);
    if (problem) throw new AuthError(problem);
    const hash = await hashPassword(password);
    await this.db.query(
      `INSERT INTO sagal.owner (id, email, password_hash) VALUES (1, $1, $2)
       ON CONFLICT (id) DO UPDATE SET email = $1, password_hash = $2, updated_at = now()
       WHERE sagal.owner.verified_at IS NULL`,
      [email, hash],
    );
    return this.issueCode("verify", email);
  }

  /** Step 1 of sign-in: check the password, then email a code. */
  async login(emailRaw: string, password: string) {
    const email = normEmail(emailRaw);
    const { rows } = await this.db.query<{ email: string; password_hash: string; verified_at: Date | null; locked_until: Date | null }>(
      "SELECT email, password_hash, verified_at, locked_until FROM sagal.owner WHERE id = 1",
    );
    const owner = rows[0];
    if (owner?.locked_until && owner.locked_until > new Date()) {
      throw new AuthError("Too many tries. Wait 15 minutes, then try again.", 429);
    }
    // Always run the hash so a wrong email takes as long as a wrong password.
    const ok = await verifyPassword(password, owner?.password_hash ?? "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA");
    if (!owner || !owner.verified_at || !sameText(owner.email, email) || !ok) {
      if (owner) {
        await this.db.query(
          `UPDATE sagal.owner SET failed_logins = failed_logins + 1,
             locked_until = CASE WHEN failed_logins + 1 >= $1 THEN now() + make_interval(mins => $2) ELSE locked_until END
           WHERE id = 1`,
          [LOCK_AFTER, LOCK_MINUTES],
        );
      }
      throw new AuthError("That email and password don't match.", 401);
    }
    await this.db.query("UPDATE sagal.owner SET failed_logins = 0, locked_until = NULL WHERE id = 1");
    return this.issueCode("login", owner.email);
  }

  async requestReset(emailRaw: string) {
    const email = normEmail(emailRaw);
    const { rows } = await this.db.query<{ email: string }>("SELECT email FROM sagal.owner WHERE id = 1 AND verified_at IS NOT NULL");
    // Same answer either way, so the form can't be used to discover the address.
    if (!rows[0] || !sameText(rows[0].email, email)) return { challengeId: randomBytes(18).toString("base64url"), delivery: "sent" as const };
    return this.issueCode("reset", rows[0].email);
  }

  /**
   * Step 2: check the code. Creates a session for verify and login; for reset, also
   * sets the new password. Returns the raw session token for the cookie.
   */
  async verify(challengeId: string, codeRaw: string, newPassword?: string, userAgent?: string): Promise<string> {
    const code = codeRaw.replace(/\s/g, "");
    const { rows } = await this.db.query<{ purpose: string; code_hash: string; attempts: number; expires_at: Date; consumed_at: Date | null }>(
      "SELECT purpose, code_hash, attempts, expires_at, consumed_at FROM sagal.email_codes WHERE id = $1",
      [challengeId],
    );
    const row = rows[0];
    if (!row || row.consumed_at) throw new AuthError("That code has already been used or replaced. Ask for a new one.", 400);
    if (row.expires_at < new Date()) throw new AuthError("That code has expired. Ask for a new one.", 400);
    if (row.attempts >= CODE_ATTEMPTS) throw new AuthError("Too many wrong codes. Ask for a new one.", 429);
    if (!sameText(row.code_hash, sha256(`${challengeId}:${code}`))) {
      await this.db.query("UPDATE sagal.email_codes SET attempts = attempts + 1 WHERE id = $1", [challengeId]);
      throw new AuthError("That code isn't right. Check the latest email and try again.", 401);
    }
    if (row.purpose === "reset") {
      const problem = passwordProblem(newPassword ?? "");
      if (problem) throw new AuthError(problem);
      await this.db.query("UPDATE sagal.owner SET password_hash = $1, failed_logins = 0, locked_until = NULL, updated_at = now() WHERE id = 1", [
        await hashPassword(newPassword!),
      ]);
      await this.db.query("DELETE FROM sagal.sessions"); // sign out everywhere else
    }
    await this.db.query("UPDATE sagal.email_codes SET consumed_at = now() WHERE id = $1", [challengeId]);
    if (row.purpose === "verify") await this.db.query("UPDATE sagal.owner SET verified_at = now() WHERE id = 1");
    return this.createSession(userAgent);
  }

  async createSession(userAgent?: string): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    await this.db.query(
      `INSERT INTO sagal.sessions (token_hash, expires_at, user_agent) VALUES ($1, now() + make_interval(days => $2), $3)`,
      [sha256(token), SESSION_DAYS, userAgent?.slice(0, 300) ?? null],
    );
    return token;
  }

  async checkSession(token: string | undefined): Promise<boolean> {
    if (!token) return false;
    const { rowCount } = await this.db.query(
      "UPDATE sagal.sessions SET last_seen_at = now() WHERE token_hash = $1 AND expires_at > now() RETURNING 1",
      [sha256(token)],
    );
    return Boolean(rowCount);
  }

  async logout(token: string | undefined): Promise<void> {
    if (token) await this.db.query("DELETE FROM sagal.sessions WHERE token_hash = $1", [sha256(token)]);
  }

  async ownerEmail(): Promise<string | null> {
    const { rows } = await this.db.query<{ email: string }>("SELECT email FROM sagal.owner WHERE id = 1 AND verified_at IS NOT NULL");
    return rows[0]?.email ?? null;
  }
}
