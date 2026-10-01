import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { runTurn, type TurnEvent } from "../../agent/turn.js";
import { saveMedia, assetLink, MEDIA_KINDS, UploadError, type MediaKind } from "../../domain/assets.js";
import { addMessage, createConversation, getConversation, messages, projectId, projectsWithThreads, renameIfNew, type Message } from "../../domain/conversations.js";
import { HttpError, idParam, notFound, parse, type Deps } from "../deps.js";

const Context = z.object({ type: z.string().max(20), id: z.union([z.number(), z.string().max(40)]).optional(), label: z.string().max(160) }).nullable().optional();

/** Reads one multipart file field, stores it, returns the asset. */
export async function uploadFrom(req: FastifyRequest, deps: Deps, kind: MediaKind, opts: { doNotPublish?: boolean; label?: string } = {}) {
  const file = await req.file();
  if (!file) throw new HttpError(400, "No file received.");
  try {
    const asset = await saveMedia(deps.db, deps.storages, kind, { filename: file.filename, mimetype: file.mimetype, stream: file.file }, opts);
    if (file.file.truncated) {
      await deps.db.query("DELETE FROM sagal.media_assets WHERE id = $1", [asset.id]);
      throw new HttpError(413, `That file is over the ${deps.cfg.MAX_UPLOAD_MB} MB limit.`);
    }
    return { ...asset, fields: Object.fromEntries(Object.entries(file.fields).map(([k, v]) => [k, (v as { value?: string })?.value])) };
  } catch (err) {
    if (err instanceof UploadError) throw new HttpError(400, err.message);
    throw err;
  }
}

export async function talkRoutes(app: FastifyInstance, deps: Deps) {
  const { db } = deps;

  app.get("/api/conversations", async () => ({ projects: await projectsWithThreads(db) }));

  app.post("/api/conversations", async (req) => {
    const b = parse(z.object({ project: z.string().max(80).optional(), title: z.string().max(120).optional() }), req.body ?? {});
    return { id: await createConversation(db, b.project || "Unsorted", b.title || "New conversation") };
  });

  app.patch("/api/conversations/:id", async (req) => {
    const id = idParam(req);
    const b = parse(z.object({ title: z.string().min(1).max(120).optional(), project: z.string().min(1).max(80).optional() }), req.body);
    if (b.title) await db.query("UPDATE sagal.conversations SET title = $2 WHERE id = $1", [id, b.title]);
    if (b.project) {
      await db.query("UPDATE sagal.conversations SET project_id = $2 WHERE id = $1", [id, await projectId(db, b.project)]);
    }
    return { ok: true };
  });

  app.get("/api/conversations/:id", async (req, reply) => {
    const id = idParam(req);
    const conv = await getConversation(db, id);
    if (!conv) return notFound(reply);
    const msgs = await messages(db, id);
    // Voice notes play through short-lived signed links.
    const withLinks = await Promise.all(
      msgs.map(async (m) => (m.voice_note_id ? { ...m, voiceNoteUrl: await assetLink(db, deps.storages, m.voice_note_id) } : m)),
    );
    return { conversation: conv, messages: withLinks };
  });

  /** Upload an attachment (reference image, PDF, footage, audio reference) or a voice note. */
  app.post("/api/uploads/:kind", async (req) => {
    const kind = (req.params as { kind: string }).kind as MediaKind;
    if (!["image", "pdf", "footage", "audio_reference", "conversation_audio"].includes(kind) || !MEDIA_KINDS.includes(kind)) {
      throw new HttpError(400, "Unknown upload type.");
    }
    const a = await uploadFrom(req, deps, kind);
    return { id: a.id, kind: a.kind, name: a.filename, size: a.size };
  });

  /**
   * Sabah sends a message; Sagal's reply streams back as server-sent events:
   * sabah → thinking → delta… → effect… → sagal | failed → done.
   */
  app.post("/api/conversations/:id/messages", async (req, reply) => {
    const id = idParam(req);
    const b = parse(
      z.object({
        text: z.string().max(20000).default(""),
        via: z.enum(["text", "voice", "voice_note"]).default("text"),
        context: Context,
        attachments: z.array(z.number().int()).max(10).default([]),
        voiceNoteId: z.number().int().optional(),
      }),
      req.body,
    );
    if (!(await getConversation(db, id))) throw new HttpError(404, "Conversation not found.");
    if (!b.text.trim() && !b.attachments.length && !b.voiceNoteId) throw new HttpError(400, "Say something first.");
    const atts = b.attachments.length
      ? (await db.query<{ id: number; kind: string; filename: string }>("SELECT id, kind, filename FROM sagal.media_assets WHERE id = ANY($1) AND kind <> 'conversation_audio'", [b.attachments])).rows
      : [];
    if (b.voiceNoteId) {
      const ok = await db.query("SELECT 1 FROM sagal.media_assets WHERE id = $1 AND kind = 'conversation_audio'", [b.voiceNoteId]);
      if (!ok.rowCount) throw new HttpError(400, "Voice note not found.");
    }
    await renameIfNew(db, id, b.text || atts.map((a) => a.filename).join(", ") || "Voice note");
    const sabah = await addMessage(db, id, {
      sender: "sabah",
      text: b.text.trim(),
      via: b.via,
      context: b.context ?? null,
      attachments: atts.map((a) => ({ assetId: a.id, kind: a.kind, name: a.filename })),
      voice_note_id: b.voiceNoteId ?? null,
    });
    return streamTurn(req, reply, deps, id, sabah);
  });

  /** Retry a message Sagal couldn't answer. */
  app.post("/api/messages/:id/retry", async (req, reply) => {
    const mid = idParam(req);
    const { rows } = await db.query<Message>("SELECT * FROM sagal.messages WHERE id = $1 AND sender = 'sabah' AND status = 'failed'", [mid]);
    if (!rows[0]) throw new HttpError(404, "Nothing to retry.");
    await db.query("UPDATE sagal.messages SET status = 'sent', error = NULL WHERE id = $1", [mid]);
    return streamTurn(req, reply, deps, rows[0].conversation_id, { ...rows[0], status: "sent" });
  });

  /** Sabah picks one of Sagal's option buttons. Recorded on the message, then sent as her reply. */
  app.post("/api/messages/:id/pick", async (req, reply) => {
    const mid = idParam(req);
    const b = parse(z.object({ option: z.string().min(1).max(60) }), req.body);
    const { rows } = await db.query<Message>("SELECT * FROM sagal.messages WHERE id = $1 AND sender = 'sagal'", [mid]);
    const m = rows[0];
    if (!m?.decision || !m.decision.options.includes(b.option)) throw new HttpError(400, "That option isn't on this message.");
    if (m.decision.picked) throw new HttpError(409, "Already decided.");
    await db.query("UPDATE sagal.messages SET decision = decision || jsonb_build_object('picked', $2::text) WHERE id = $1", [mid, b.option]);
    const sabah = await addMessage(db, m.conversation_id, { sender: "sabah", text: b.option, context: { type: "decision", id: mid, label: m.quote ? `“${m.quote.slice(0, 60)}”` : "Sagal's question" } });
    return streamTurn(req, reply, deps, m.conversation_id, sabah);
  });

  /** Voice turns are written to the same conversation; an interrupted Sagal turn is marked. */
  app.post("/api/messages/:id/interrupted", async (req) => {
    await db.query("UPDATE sagal.messages SET interrupted = true WHERE id = $1 AND sender = 'sagal'", [idParam(req)]);
    return { ok: true };
  });
}

async function streamTurn(req: FastifyRequest, reply: import("fastify").FastifyReply, deps: Deps, conversationId: number, sabah: Message) {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
  const ctrl = new AbortController();
  let open = true;
  req.raw.on("close", () => {
    open = false;
  });
  const emit = (e: TurnEvent) => {
    if (open) res.write(`data: ${JSON.stringify(e)}\n\n`);
  };
  const ping = setInterval(() => open && res.write(": ping\n\n"), 15000);
  emit({ type: "sabah", message: sabah });
  try {
    // The turn runs to completion even if the browser goes away, so the reply is saved
    // and appears when Sabah reopens the conversation on any device.
    await runTurn({ db: deps.db, cfg: deps.cfg, vault: deps.vault, storages: deps.storages, notifier: deps.notifier, brain: deps.brain }, conversationId, sabah, emit, ctrl.signal);
  } catch (err) {
    emit({ type: "failed", message: sabah, error: `Something went wrong: ${(err as Error).message}` });
  } finally {
    clearInterval(ping);
    emit({ type: "done" });
    res.end();
  }
}
