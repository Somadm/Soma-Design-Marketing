import type { DbClient } from "../db/pool.js";

export interface Message {
  id: number;
  conversation_id: number;
  sender: "sabah" | "sagal" | "system";
  text: string;
  via: "text" | "voice" | "voice_note";
  context: { type: string; id?: number | string; label: string } | null;
  attachments: { assetId: number; kind: string; name: string }[];
  voice_note_id: number | null;
  card: { type: string; id?: number; title: string; sub: string } | null;
  quote: string | null;
  decision: { options: string[]; picked: string | null } | null;
  status: "sent" | "failed";
  error: string | null;
  interrupted: boolean;
  created_at: Date;
}

export async function projectsWithThreads(db: DbClient) {
  const { rows } = await db.query<{ project_id: number; project: string; id: number | null; title: string | null; updated_at: Date | null; sample: boolean | null }>(
    `SELECT p.id AS project_id, p.name AS project, c.id, c.title, c.updated_at, c.sample
     FROM sagal.projects p LEFT JOIN sagal.conversations c ON c.project_id = p.id
     ORDER BY p.name = 'Unsorted' DESC, p.id, c.updated_at DESC`,
  );
  const out: { id: number; name: string; threads: { id: number; title: string; updatedAt: string; sample: boolean }[] }[] = [];
  for (const r of rows) {
    let p = out.find((x) => x.id === r.project_id);
    if (!p) out.push((p = { id: r.project_id, name: r.project, threads: [] }));
    if (r.id) p.threads.push({ id: r.id, title: r.title!, updatedAt: r.updated_at!.toISOString(), sample: Boolean(r.sample) });
  }
  return out.filter((p) => p.threads.length || p.name !== "Unsorted");
}

export async function projectId(db: DbClient, name: string): Promise<number> {
  const clean = name.trim().slice(0, 80) || "Unsorted";
  const { rows } = await db.query<{ id: number }>(
    "INSERT INTO sagal.projects (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id",
    [clean],
  );
  return rows[0].id;
}

export async function createConversation(db: DbClient, project = "Unsorted", title = "New conversation", sample = false) {
  const pid = await projectId(db, project);
  const { rows } = await db.query<{ id: number }>(
    "INSERT INTO sagal.conversations (project_id, title, sample) VALUES ($1, $2, $3) RETURNING id",
    [pid, title, sample],
  );
  return rows[0].id;
}

export async function getConversation(db: DbClient, id: number) {
  const { rows } = await db.query<{ id: number; title: string; project: string; sample: boolean }>(
    "SELECT c.id, c.title, p.name AS project, c.sample FROM sagal.conversations c JOIN sagal.projects p ON p.id = c.project_id WHERE c.id = $1",
    [id],
  );
  return rows[0] ?? null;
}

export async function messages(db: DbClient, conversationId: number, limit = 200): Promise<Message[]> {
  const { rows } = await db.query<Message>(
    "SELECT * FROM (SELECT * FROM sagal.messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT $2) m ORDER BY id",
    [conversationId, limit],
  );
  return rows;
}

export async function addMessage(db: DbClient, conversationId: number, m: Partial<Message> & { sender: Message["sender"] }): Promise<Message> {
  const { rows } = await db.query<Message>(
    `INSERT INTO sagal.messages (conversation_id, sender, text, via, context, attachments, voice_note_id, card, quote, decision, status, error, interrupted)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [
      conversationId, m.sender, m.text ?? "", m.via ?? "text", m.context ? JSON.stringify(m.context) : null,
      JSON.stringify(m.attachments ?? []), m.voice_note_id ?? null, m.card ? JSON.stringify(m.card) : null, m.quote ?? null,
      m.decision ? JSON.stringify(m.decision) : null, m.status ?? "sent", m.error ?? null, m.interrupted ?? false,
    ],
  );
  await db.query("UPDATE sagal.conversations SET updated_at = now() WHERE id = $1", [conversationId]);
  return rows[0];
}

/** First message names a new conversation. */
export async function renameIfNew(db: DbClient, conversationId: number, text: string) {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return;
  await db.query("UPDATE sagal.conversations SET title = $2 WHERE id = $1 AND title = 'New conversation'", [
    conversationId, t.length > 40 ? `${t.slice(0, 39)}…` : t,
  ]);
}
