import type { DbClient } from "../db/pool.js";

export type Section = "facts" | "language" | "preferences" | "notes" | "voice_feedback";
export type Actor = "sabah" | "sagal" | "bilan";

export interface MemoryEntry {
  id: number;
  section: Section;
  key: string;
  value: unknown;
  owner: Actor;
  updated_by: Actor;
  sample: boolean;
  updated_at: Date;
}

/** The business facts Sabah fills in (Memory → Business facts). */
export const FACT_FIELDS: [string, string, string][] = [
  ["name", "Business name", ""],
  ["what", "What Soma does, in one line", "Add a one-line description so Sagal stops guessing"],
  ["where", "Based in", ""],
  ["tz", "Timezone", ""],
  ["lang", "Languages", ""],
  ["aud", "Main audiences", ""],
  ["handles", "Handles", "@soma on Instagram, …"],
];

export class OwnershipError extends Error {}

export async function listMemory(db: DbClient, section?: Section): Promise<MemoryEntry[]> {
  const { rows } = await db.query<MemoryEntry>(
    `SELECT id, section, key, value, owner, updated_by, sample, updated_at FROM shared.memory_entries
     ${section ? "WHERE section = $1" : ""} ORDER BY section, id`,
    section ? [section] : [],
  );
  return rows;
}

/**
 * Writes one entry and records the change. Sabah can change anything. Sagal and Bilan
 * can only change entries they own; an entry Sabah owns comes back to her instead.
 */
export async function writeMemory(db: DbClient, section: Section, key: string, value: unknown, by: Actor, opts: { sample?: boolean } = {}) {
  const { rows } = await db.query<MemoryEntry>("SELECT * FROM shared.memory_entries WHERE section = $1 AND key = $2", [section, key]);
  const cur = rows[0];
  if (cur && by !== "sabah" && cur.owner === "sabah") {
    throw new OwnershipError(`“${key}” in ${section} belongs to Sabah. Ask her before changing it.`);
  }
  const owner: Actor = cur ? (by === "sabah" ? "sabah" : cur.owner) : by;
  const { rows: saved } = await db.query<MemoryEntry>(
    `INSERT INTO shared.memory_entries (section, key, value, owner, updated_by, sample) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (section, key) DO UPDATE SET value = $3, owner = $4, updated_by = $5, sample = $6, updated_at = now()
     RETURNING *`,
    [section, key, JSON.stringify(value), owner, by, opts.sample ?? false],
  );
  await db.query(
    "INSERT INTO shared.memory_history (entry_id, section, key, old_value, new_value, changed_by) VALUES ($1,$2,$3,$4,$5,$6)",
    [saved[0].id, section, key, cur ? JSON.stringify(cur.value) : null, JSON.stringify(value), by],
  );
  return saved[0];
}

export async function deleteMemory(db: DbClient, id: number, by: Actor) {
  const { rows } = await db.query<MemoryEntry>("SELECT * FROM shared.memory_entries WHERE id = $1", [id]);
  const cur = rows[0];
  if (!cur) return;
  if (by !== "sabah" && cur.owner === "sabah") throw new OwnershipError("That entry belongs to Sabah.");
  await db.query("DELETE FROM shared.memory_entries WHERE id = $1", [id]);
  await db.query(
    "INSERT INTO shared.memory_history (entry_id, section, key, old_value, new_value, changed_by) VALUES ($1,$2,$3,$4,NULL,$5)",
    [id, cur.section, cur.key, JSON.stringify(cur.value), by],
  );
}

export async function memoryHistory(db: DbClient, limit = 50) {
  const { rows } = await db.query("SELECT * FROM shared.memory_history ORDER BY id DESC LIMIT $1", [limit]);
  return rows;
}

/** Compact text of everything Sagal should know, for her context each turn. */
export async function memoryDigest(db: DbClient): Promise<string> {
  const all = await listMemory(db);
  if (!all.length) return "(Memory is empty. Sabah hasn't added business facts yet: don't invent them; ask when it matters.)";
  const by = (s: Section) => all.filter((e) => e.section === s);
  const val = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
  const lines: string[] = [];
  const facts = by("facts").filter((e) => val(e.value).trim());
  if (facts.length) {
    const label = Object.fromEntries(FACT_FIELDS.map(([k, l]) => [k, l]));
    lines.push("Business facts:", ...facts.map((e) => `- ${label[e.key] ?? e.key}: ${val(e.value)}${e.sample ? " (sample value)" : ""}`));
  }
  const lang = by("language");
  if (lang.length) {
    lines.push("Approved language (copy the tone, not the words):");
    for (const e of lang) {
      const v = e.value as { say?: string; not?: string; note?: string };
      lines.push(`- We say “${v.say ?? ""}”${v.not ? ` — not “${v.not}”` : ""}${v.note ? ` (${v.note})` : ""}`);
    }
  }
  const prefs = by("preferences");
  if (prefs.length) lines.push("Creative preferences:", ...prefs.map((e) => `- ${val(e.value)}`));
  const notes = by("notes");
  if (notes.length) lines.push("Notes:", ...notes.map((e) => `- ${e.key}: ${val(e.value)} (written by ${e.updated_by})`));
  const vf = by("voice_feedback");
  if (vf.length) lines.push("Sabah's feedback on Sagal's speaking voice:", ...vf.slice(-3).map((e) => `- ${val(e.value)}`));
  return lines.join("\n");
}
