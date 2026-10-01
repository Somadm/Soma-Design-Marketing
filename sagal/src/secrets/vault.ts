import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { masterKey } from "../config.js";
import type { DbClient } from "../db/pool.js";

/**
 * Encrypted secret store for API keys and OAuth tokens. AES-256-GCM with a random IV per
 * value; the master key lives only in the SECRETS_MASTER_KEY environment variable.
 * Values never leave the server: the API only returns a short hint (last four characters).
 */
export class Vault {
  private key: Buffer;

  constructor(
    private db: DbClient,
    masterKeyBase64: string,
  ) {
    this.key = masterKey(masterKeyBase64);
  }

  encrypt(plaintext: string, name: string): { ciphertext: Buffer; iv: Buffer; tag: Buffer } {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(name)); // binds the value to its name: rows can't be swapped
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return { ciphertext, iv, tag: cipher.getAuthTag() };
  }

  decrypt(row: { ciphertext: Buffer; iv: Buffer; tag: Buffer }, name: string): string {
    const decipher = createDecipheriv("aes-256-gcm", this.key, row.iv);
    decipher.setAAD(Buffer.from(name));
    decipher.setAuthTag(row.tag);
    return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString("utf8");
  }

  async set(name: string, value: string): Promise<void> {
    const v = value.trim();
    if (!v) throw new Error("Secret value is empty");
    const enc = this.encrypt(v, name);
    const hint = v.length > 8 ? `…${v.slice(-4)}` : "set";
    await this.db.query(
      `INSERT INTO sagal.secrets (name, ciphertext, iv, tag, hint) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (name) DO UPDATE SET ciphertext = $2, iv = $3, tag = $4, hint = $5, updated_at = now()`,
      [name, enc.ciphertext, enc.iv, enc.tag, hint],
    );
  }

  async get(name: string): Promise<string | null> {
    const { rows } = await this.db.query<{ ciphertext: Buffer; iv: Buffer; tag: Buffer }>(
      "SELECT ciphertext, iv, tag FROM sagal.secrets WHERE name = $1",
      [name],
    );
    return rows[0] ? this.decrypt(rows[0], name) : null;
  }

  async delete(name: string): Promise<void> {
    await this.db.query("DELETE FROM sagal.secrets WHERE name = $1", [name]);
  }

  async deletePrefix(prefix: string): Promise<void> {
    await this.db.query("DELETE FROM sagal.secrets WHERE name LIKE $1", [`${prefix}%`]);
  }

  /** Name → hint and update time, for display. Never the values. */
  async hints(): Promise<Record<string, { hint: string; updatedAt: string }>> {
    const { rows } = await this.db.query<{ name: string; hint: string; updated_at: Date }>(
      "SELECT name, hint, updated_at FROM sagal.secrets",
    );
    return Object.fromEntries(rows.map((r) => [r.name, { hint: r.hint, updatedAt: r.updated_at.toISOString() }]));
  }
}
