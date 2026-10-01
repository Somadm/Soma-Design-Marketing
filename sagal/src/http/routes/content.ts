import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assetLink, saveVoiceover, UploadError, voiceoverLink } from "../../domain/assets.js";
import { addComment, CAPTION_LIMITS, createCarousel, getCarousel, listCarousels, ROLES, updateCarousel } from "../../domain/carousels.js";
import { addMessage } from "../../domain/conversations.js";
import { listInbox, resolveByKey } from "../../domain/inbox.js";
import { markPostedByHand } from "../../domain/posts.js";
import { hasSample } from "../../domain/sample.js";
import { createVideoJob, getVideoJob, listVideoJobs, setHandoffDone } from "../../domain/video.js";
import { scriptText, scriptToSrt } from "../../integrations/production.js";
import { HttpError, idParam, notFound, parse, type Deps } from "../deps.js";
import { uploadFrom } from "./talk.js";

const SlideBody = z.object({
  role: z.string().max(20),
  kicker: z.string().max(80),
  head: z.string().max(240),
  body: z.string().max(600),
  visual: z.string().max(200),
  theme: z.string().max(10),
});
const ScriptLine = z.object({ t: z.string().max(6), part: z.string().max(40), line: z.string().max(400) });

export async function contentRoutes(app: FastifyInstance, deps: Deps) {
  const { db, storages } = deps;

  // ───── Carousels ─────
  app.get("/api/carousels", async () => ({ carousels: await listCarousels(db), roles: ROLES, captionLimits: CAPTION_LIMITS }));

  app.get("/api/carousels/:id", async (req, reply) => {
    const c = await getCarousel(db, idParam(req));
    return c ? { carousel: c } : notFound(reply);
  });

  app.post("/api/carousels", async (req) => {
    const b = parse(z.object({ title: z.string().min(1).max(160) }), req.body);
    const id = await createCarousel(db, { title: b.title, slides: ROLES.map((role, i) => ({ role, head: "", kicker: role, theme: i % 2 ? "paper" : "ink" })) });
    return { id };
  });

  app.patch("/api/carousels/:id", async (req) => {
    const b = parse(z.object({ title: z.string().min(1).max(160).optional(), slides: z.array(SlideBody).max(12).optional(), captions: z.record(z.string(), z.string()).optional() }), req.body);
    await updateCarousel(db, idParam(req), b);
    return { ok: true };
  });

  app.post("/api/carousels/:id/comments", async (req) => {
    const b = parse(z.object({ slide: z.number().int().min(0).max(11), text: z.string().min(1).max(2000) }), req.body);
    return { comment: await addComment(db, idParam(req), b.slide, "sabah", b.text) };
  });

  // ───── Video studio ─────
  app.get("/api/video", async () => ({ jobs: await listVideoJobs(db) }));

  app.post("/api/video", async (req) => {
    const b = parse(z.object({ title: z.string().min(1).max(160) }), req.body);
    return { id: await createVideoJob(db, { title: b.title, script: [{ t: "0:00", part: "Hook", line: "" }] }) };
  });

  app.get("/api/video/:id", async (req, reply) => {
    const job = await getVideoJob(db, idParam(req));
    if (!job) return notFound(reply);
    return {
      job,
      links: {
        voiceover: job.voiceover_id ? await voiceoverLink(db, storages, job.voiceover_id) : null,
        render: job.render_asset_id ? await assetLink(db, storages, job.render_asset_id) : null,
        final: job.final_asset_id ? await assetLink(db, storages, job.final_asset_id) : null,
      },
    };
  });

  app.patch("/api/video/:id", async (req) => {
    const b = parse(z.object({ title: z.string().min(1).max(160).optional(), script: z.array(ScriptLine).max(30).optional(), platformCaptions: z.record(z.string(), z.string()).optional(), scriptStatus: z.string().max(60).optional() }), req.body);
    await db.query(
      `UPDATE sagal.video_jobs SET title = COALESCE($2, title), script = COALESCE($3, script), platform_captions = COALESCE($4, platform_captions),
         script_status = COALESCE($5, script_status), updated_at = now() WHERE id = $1`,
      [idParam(req), b.title ?? null, b.script ? JSON.stringify(b.script) : null, b.platformCaptions ? JSON.stringify(b.platformCaptions) : null, b.scriptStatus ?? null],
    );
    return { ok: true };
  });

  /** Sabah's own voiceover. Separate table and storage area; the only audio HeyGen may use. */
  app.post("/api/video/:id/voiceover", async (req) => {
    const id = idParam(req);
    const file = await req.file();
    if (!file) throw new HttpError(400, "No file received.");
    try {
      const vo = await saveVoiceover(db, storages, { filename: file.filename, mimetype: file.mimetype, stream: file.file });
      if (file.file.truncated) throw new HttpError(413, `That file is over the ${deps.cfg.MAX_UPLOAD_MB} MB limit.`);
      await db.query("UPDATE sagal.video_jobs SET voiceover_id = $2, heygen = '{}'::jsonb, updated_at = now() WHERE id = $1", [id, vo.id]);
      await resolveByKey(db, `voiceover:${id}`, "Voiceover uploaded");
      // A post held for this voiceover can go again once Sabah resumes it.
      return { voiceover: vo };
    } catch (err) {
      if (err instanceof UploadError) throw new HttpError(400, err.message);
      throw err;
    }
  });

  app.delete("/api/video/:id/voiceover", async (req) => {
    await db.query("UPDATE sagal.video_jobs SET voiceover_id = NULL, render_asset_id = NULL, final_asset_id = NULL, heygen = '{}'::jsonb, captions_edit = '{}'::jsonb, updated_at = now() WHERE id = $1", [idParam(req)]);
    return { ok: true };
  });

  app.post("/api/video/:id/handoff", async (req) => {
    const b = parse(z.object({ which: z.enum(["heygen", "captions"]), done: z.boolean() }), req.body);
    await setHandoffDone(db, idParam(req), b.which, b.done);
    return { ok: true };
  });

  /** The finished HeyGen render (made by hand) or the final Captions edit. */
  for (const slot of ["render", "final"] as const) {
    app.post(`/api/video/:id/${slot}`, async (req) => {
      const id = idParam(req);
      const a = await uploadFrom(req, deps, slot === "render" ? "render" : "export");
      await db.query(`UPDATE sagal.video_jobs SET ${slot === "render" ? "render_asset_id" : "final_asset_id"} = $2, updated_at = now() WHERE id = $1`, [id, a.id]);
      return { ok: true };
    });
  }

  app.get("/api/video/:id/package/:file", async (req, reply) => {
    const job = await getVideoJob(db, idParam(req));
    if (!job) return notFound(reply);
    const file = (req.params as { file: string }).file;
    const notes = `Edit notes from Sagal for “${job.title}”\n\n- Trim silence at the start and end.\n- Burn in the subtitles (subtitles.srt). Captioning only: no generated voices or avatars.\n- Export 1080 × 1920, under 60 seconds for Shorts.\n`;
    const files: Record<string, string> = { "script.txt": scriptText(job.script), "subtitles.srt": scriptToSrt(job.script), "edit-notes.txt": notes };
    if (!(file in files)) return notFound(reply);
    return reply.header("content-disposition", `attachment; filename="${file}"`).type("text/plain; charset=utf-8").send(files[file]);
  });

  // ───── Needs Sabah ─────
  app.get("/api/inbox", async () => listInbox(db));

  app.post("/api/inbox/:id/act", async (req) => {
    const id = idParam(req);
    const b = parse(z.object({ which: z.enum(["primary", "secondary"]) }), req.body);
    const { rows } = await db.query("SELECT * FROM sagal.inbox_items WHERE id = $1 AND resolved_at IS NULL", [id]);
    const item = rows[0];
    if (!item) throw new HttpError(404, "Already handled.");
    const label = b.which === "primary" ? item.primary_label : item.secondary_label;
    const action: string = (b.which === "primary" ? item.primary_action : item.secondary_action) ?? "resolve";
    if (action.startsWith("go:")) return { navigate: action.slice(3) };
    if (action.startsWith("post_by_hand:")) await markPostedByHand(db, Number(action.split(":")[1]));
    await db.query("UPDATE sagal.inbox_items SET resolution = $2, resolved_at = now() WHERE id = $1", [id, label]);
    if (item.ref?.conversationId) {
      await addMessage(db, item.ref.conversationId, { sender: "system", text: `Sabah chose “${label}” on “${item.title}” in Needs Sabah.` });
    }
    return { ok: true };
  });

  // ───── Inspiration ─────
  app.get("/api/inspiration", async () => {
    const { rows } = await db.query("SELECT * FROM sagal.inspiration ORDER BY id");
    return { items: await Promise.all(rows.map(async (r) => ({ ...r, imageUrl: r.image_asset_id ? await assetLink(db, storages, r.image_asset_id) : null }))) };
  });

  const InspoBody = z.object({
    category: z.string().min(1).max(60),
    title: z.string().min(1).max(160),
    source: z.string().max(300).default(""),
    noticed: z.string().max(800).default(""),
    idea: z.string().max(400).default(""),
    private: z.boolean().default(false),
  });
  app.post("/api/inspiration", async (req) => {
    const b = parse(InspoBody, req.body);
    const { rows } = await db.query("INSERT INTO sagal.inspiration (category, title, source, noticed, idea, private) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id", [
      b.category, b.title, b.source, b.noticed, b.idea, b.private,
    ]);
    return { id: rows[0].id };
  });
  app.delete("/api/inspiration/:id", async (req) => {
    await db.query("DELETE FROM sagal.inspiration WHERE id = $1", [idParam(req)]);
    return { ok: true };
  });
  app.post("/api/inspiration/:id/image", async (req) => {
    const id = idParam(req);
    const { rows } = await db.query<{ private: boolean }>("SELECT private FROM sagal.inspiration WHERE id = $1", [id]);
    if (!rows[0]) throw new HttpError(404, "Not found.");
    const a = await uploadFrom(req, deps, "inspiration", { doNotPublish: true });
    await db.query("UPDATE sagal.inspiration SET image_asset_id = $2 WHERE id = $1", [id, a.id]);
    return { ok: true };
  });

  // ───── Results & Bilan ─────
  app.get("/api/results", async () => {
    const lessons = await db.query("SELECT * FROM sagal.lessons ORDER BY id");
    const tasks = await db.query("SELECT * FROM shared.tasks ORDER BY id");
    const confirmed = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM sagal.posts WHERE status = 'confirmed' AND NOT sample");
    const sample = await hasSample(db);
    return {
      lessons: lessons.rows,
      tasks: tasks.rows,
      // Real numbers only arrive from connected platforms. Until then: sample or nothing.
      metrics: sample ? { sample: true, reached: 4820, saves: 312, shares: 96, profileVisits: 188 } : null,
      confirmedPosts: confirmed.rows[0].n,
    };
  });

  app.post("/api/tasks/:id/decide", async (req) => {
    const b = parse(z.object({ decision: z.enum(["send", "keep"]) }), req.body);
    const next =
      b.decision === "send"
        ? ["Sent to Bilan", "Bilan", "Bilan decides on a test budget"]
        : ["Kept organic", "Sagal", "Stays organic"];
    await db.query("UPDATE shared.tasks SET status = $2, owner = $3, next_step = $4, updated_at = now() WHERE id = $1 AND status = 'Needs Sabah'", [idParam(req), ...next]);
    return { ok: true };
  });
}
