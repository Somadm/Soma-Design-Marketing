import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assetLink, listUsableImages, saveVoiceover, UploadError, voiceoverLink } from "../../domain/assets.js";
import { addComment, assertUsableImages, CAPTION_LIMITS, createCarousel, getCarousel, listCarousels, ROLES, SlideImageError, updateCarousel } from "../../domain/carousels.js";
import { addMessage } from "../../domain/conversations.js";
import { listInbox, resolveByKey } from "../../domain/inbox.js";
import { moveIntoPlan } from "../../domain/plan.js";
import { markPostedByHand } from "../../domain/posts.js";
import { CATEGORIES, REACTIONS, refreshReference, saveReference, updateReference } from "../../domain/inspiration.js";
import { hasSample } from "../../domain/sample.js";
import { getSettings, setSetting } from "../../domain/settings.js";
import { fetchPreview, LinkError } from "../../inspiration/linkPreview.js";
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
  imageAssetId: z.number().int().positive().nullable().optional(),
  imageLayout: z.enum(["frame", "full"]).optional(),
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
    if (b.slides) {
      try {
        await assertUsableImages(db, b.slides);
      } catch (err) {
        if (err instanceof SlideImageError) throw new HttpError(400, err.message);
        throw err;
      }
    }
    await updateCarousel(db, idParam(req), b);
    return { ok: true };
  });

  app.post("/api/carousels/:id/comments", async (req) => {
    const b = parse(z.object({ slide: z.number().int().min(0).max(11), text: z.string().min(1).max(2000) }), req.body);
    return { comment: await addComment(db, idParam(req), b.slide, "sabah", b.text) };
  });

  // ───── Images for slides (library + same-origin bytes for canvas export) ─────
  app.get("/api/assets/images", async () => ({
    images: (await listUsableImages(db)).map((r) => ({ ...r, url: `/api/assets/${r.id}/raw` })),
  }));

  /**
   * The file itself, from private storage, behind the session cookie. Same-origin, so the
   * browser can draw it onto a canvas when exporting finished designs.
   */
  app.get("/api/assets/:id/raw", async (req, reply) => {
    const { rows } = await db.query<{ storage_key: string; content_type: string; filename: string }>(
      "SELECT storage_key, content_type, filename FROM sagal.media_assets WHERE id = $1 AND kind <> 'conversation_audio'",
      [idParam(req)],
    );
    if (!rows[0]) return notFound(reply);
    // Uploaded files never run as pages on Sagal's origin (an SVG with a script, say).
    reply.type(rows[0].content_type).header("cache-control", "private, max-age=3600")
      .header("x-content-type-options", "nosniff").header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    return reply.send(await storages.media.read(rows[0].storage_key));
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
    const plan = /^plan_idea:(\d+):(\d{4}-\d{2}-\d{2}):(\d{2}:\d{2})$/.exec(action);
    if (plan) {
      // Sabah's tap on Sagal's proposal: this is her authorisation to plan the post.
      try {
        await moveIntoPlan(db, Number(plan[1]), plan[2], plan[3]);
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
    }
    await db.query("UPDATE sagal.inbox_items SET resolution = $2, resolved_at = now() WHERE id = $1", [id, label]);
    if (item.ref?.conversationId) {
      await addMessage(db, item.ref.conversationId, { sender: "system", text: `Sabah chose “${label}” on “${item.title}” in Needs Sabah.` });
    }
    return { ok: true };
  });

  // ───── Inspiration: Sabah's taste board ─────
  const previewer = deps.linkPreview ?? fetchPreview;
  app.get("/api/inspiration", async () => {
    const { rows } = await db.query("SELECT * FROM sagal.inspiration ORDER BY CASE reaction WHEN 'love' THEN 0 WHEN 'like' THEN 1 ELSE 2 END, id DESC");
    const { taste } = await getSettings(db);
    return {
      taste,
      categories: CATEGORIES,
      items: await Promise.all(rows.map(async (r) => ({ ...r, imageUrl: r.image_asset_id ? await assetLink(db, storages, r.image_asset_id) : null }))),
    };
  });

  const Reaction = z.enum(REACTIONS);
  const InspoBody = z.object({
    url: z.string().max(2000).nullable().optional(),
    category: z.string().trim().min(1).max(60).optional(),
    title: z.string().max(160).optional(),
    source: z.string().max(300).optional(),
    why: z.string().max(800).optional(),
    noticed: z.string().max(800).optional(),
    idea: z.string().max(400).optional(),
    reaction: Reaction.optional(),
    private: z.boolean().optional(),
  });
  app.post("/api/inspiration", async (req) => {
    const b = parse(InspoBody, req.body);
    try {
      const r = await saveReference(db, storages, b, previewer);
      if (b.source) await db.query("UPDATE sagal.inspiration SET source = $2 WHERE id = $1", [r.id, b.source]);
      return r;
    } catch (err) {
      if (err instanceof LinkError) throw new HttpError(400, err.message);
      throw err;
    }
  });
  app.patch("/api/inspiration/:id", async (req, reply) => {
    const b = parse(InspoBody.omit({ url: true, source: true }).extend({ title: z.string().trim().min(1).max(160).optional() }), req.body);
    return (await updateReference(db, idParam(req), b)) ? { ok: true } : notFound(reply);
  });
  app.post("/api/inspiration/:id/refresh", async (req, reply) => {
    const r = await refreshReference(db, storages, idParam(req), previewer);
    return r.found ? { note: r.note } : notFound(reply);
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
    await db.query("UPDATE sagal.inspiration SET image_asset_id = $2, updated_at = now() WHERE id = $1", [id, a.id]);
    return { ok: true };
  });
  app.patch("/api/settings/taste", async (req) => {
    const b = parse(z.object({ love: z.string().max(2000), avoid: z.string().max(2000) }), req.body);
    await setSetting(db, "taste", b);
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
