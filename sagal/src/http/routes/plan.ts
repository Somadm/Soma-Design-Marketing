import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { backToBoard, cleanPlatforms, createIdea, FORMATS, listIdeas, moveIntoPlan, todayHelsinki, weekDays } from "../../domain/plan.js";
import { approvePost, holdPost, listPosts, markPostedByHand, resumePost, retryPost, updateCaption } from "../../domain/posts.js";
import { getSettings, setSetting } from "../../domain/settings.js";
import { CHANNELS, currentAuthorisation, grantAuthorisation, spentThisMonth } from "../../publishing/permissions.js";
import { isValidDate, isValidTime } from "../../time.js";
import { HttpError, idParam, parse, type Deps } from "../deps.js";

const Week = z.object({ week: z.string().optional() });

export async function planRoutes(app: FastifyInstance, { db }: Deps) {
  const weekOf = (q: unknown) => {
    const { week } = parse(Week, q);
    return weekDays(week && isValidDate(week) ? week : todayHelsinki());
  };

  app.get("/api/plan", async (req) => {
    const days = weekOf(req.query);
    return { today: todayHelsinki(), days, ideas: await listIdeas(db), formats: FORMATS, channels: CHANNELS, defaultPostTime: (await getSettings(db)).defaultPostTime };
  });

  const IdeaBody = z.object({
    title: z.string().min(1).max(160),
    story: z.string().max(1200).default(""),
    audience: z.string().max(200).default(""),
    purpose: z.string().max(200).default(""),
    format: z.enum(FORMATS as [string, ...string[]]).default("Carousel"),
    platforms: z.array(z.string()).default(["Instagram"]),
  });

  app.post("/api/ideas", async (req) => ({ idea: await createIdea(db, parse(IdeaBody, req.body), "sabah") }));

  app.patch("/api/ideas/:id", async (req) => {
    const id = idParam(req);
    const b = parse(IdeaBody.partial(), req.body);
    await db.query(
      `UPDATE sagal.ideas SET title = COALESCE($2, title), story = COALESCE($3, story), audience = COALESCE($4, audience),
         purpose = COALESCE($5, purpose), format = COALESCE($6, format), platforms = COALESCE($7, platforms), updated_at = now() WHERE id = $1`,
      [id, b.title ?? null, b.story ?? null, b.audience ?? null, b.purpose ?? null, b.format ?? null, b.platforms ? cleanPlatforms(b.platforms) : null],
    );
    return { ok: true };
  });

  app.delete("/api/ideas/:id", async (req) => {
    const id = idParam(req);
    await backToBoard(db, id);
    await db.query("DELETE FROM sagal.ideas WHERE id = $1 AND status = 'board'", [id]);
    return { ok: true };
  });

  /** Sabah's authorisation: the idea goes into the plan on a Helsinki day (and time). */
  app.post("/api/ideas/:id/plan", async (req) => {
    const b = parse(z.object({ date: z.string(), time: z.string().optional() }), req.body);
    if (b.time && !isValidTime(b.time)) throw new HttpError(400, "Time must be HH:MM.");
    return { idea: await moveIntoPlan(db, idParam(req), b.date, b.time) };
  });

  app.post("/api/ideas/:id/board", async (req) => {
    await backToBoard(db, idParam(req));
    return { ok: true };
  });

  // ───── Publishing ─────

  app.get("/api/publishing", async (req) => {
    const days = weekOf(req.query);
    const a = await currentAuthorisation(db);
    return {
      today: todayHelsinki(),
      days,
      posts: await listPosts(db, days[0], days[6]),
      authorisation: { mode: a.mode, channels: a.channels, spendLimitEur: a.spend_limit_eur, paused: a.paused, grantedAt: a.granted_at, scope: a.scope },
      spentThisMonth: await spentThisMonth(db),
    };
  });

  app.post("/api/publishing/pause", async (req) => {
    const b = parse(z.object({ paused: z.boolean() }), req.body);
    await grantAuthorisation(db, { paused: b.paused }, b.paused ? "Sabah paused all publishing" : "Sabah resumed publishing");
    return { ok: true };
  });

  app.post("/api/publishing/permissions", async (req) => {
    const b = parse(
      z.object({ mode: z.enum(["plan", "review"]).optional(), channels: z.array(z.enum(CHANNELS)).optional(), spendLimitEur: z.number().min(0).max(100000).optional() }),
      req.body,
    );
    await grantAuthorisation(db, { mode: b.mode, channels: b.channels, spend_limit_eur: b.spendLimitEur }, "Changed in Publishing permissions");
    return { ok: true };
  });

  app.get("/api/publishing/history", async () => {
    const { rows } = await db.query("SELECT id, mode, channels, spend_limit_eur, paused, granted_by, granted_at, note FROM sagal.authorisations ORDER BY id DESC LIMIT 30");
    return { authorisations: rows };
  });

  const postAction = (name: string, fn: (id: number) => Promise<void>) =>
    app.post(`/api/posts/:id/${name}`, async (req) => {
      await fn(idParam(req));
      return { ok: true };
    });
  postAction("hold", (id) => holdPost(db, id));
  postAction("resume", (id) => resumePost(db, id));
  postAction("retry", (id) => retryPost(db, id));
  postAction("approve", (id) => approvePost(db, id));
  postAction("posted", (id) => markPostedByHand(db, id));

  app.patch("/api/posts/:id", async (req) => {
    const b = parse(z.object({ caption: z.string().max(63206) }), req.body);
    await updateCaption(db, idParam(req), b.caption);
    return { ok: true };
  });

  app.post("/api/settings/default-post-time", async (req) => {
    const b = parse(z.object({ time: z.string() }), req.body);
    if (!isValidTime(b.time)) throw new HttpError(400, "Time must be HH:MM.");
    await setSetting(db, "defaultPostTime", b.time);
    return { ok: true };
  });
}
