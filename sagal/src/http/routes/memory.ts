import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assetLink } from "../../domain/assets.js";
import { deleteMemory, FACT_FIELDS, listMemory, memoryHistory, writeMemory } from "../../domain/memory.js";
import { hasSample, loadSample, removeSample } from "../../domain/sample.js";
import { getSettings, setSetting, WEEKDAYS } from "../../domain/settings.js";
import { maybeRunRoutine, MAX_PER_RUN, postingGaps, ROUTINE_FROM } from "../../agent/routine.js";
import { HttpError, idParam, parse, type Deps } from "../deps.js";
import { uploadFrom } from "./talk.js";

const BRAND_SLOTS = ["logo", "wordmark", "photo"];

export async function memoryRoutes(app: FastifyInstance, deps: Deps) {
  const { db, storages } = deps;

  /** Small summary for the app shell: nav badge, sample flag, signed-in email. */
  app.get("/api/overview", async () => {
    const inbox = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM sagal.inbox_items WHERE resolved_at IS NULL");
    const s = await getSettings(db);
    return {
      inboxCount: inbox.rows[0].n,
      sample: await hasSample(db),
      email: await deps.auth.ownerEmail(),
      brainMode: s.brain.mode,
      portraitUrl: s.appearance.approved && s.appearance.portraitAssetId ? await assetLink(db, storages, s.appearance.portraitAssetId) : null,
    };
  });

  app.get("/api/memory", async () => ({ entries: await listMemory(db), factFields: FACT_FIELDS, history: await memoryHistory(db, 30) }));

  app.put("/api/memory/facts", async (req) => {
    const b = parse(z.record(z.string().max(40), z.string().max(500)), req.body);
    const allowed = new Set(FACT_FIELDS.map(([k]) => k));
    for (const [k, v] of Object.entries(b)) if (allowed.has(k)) await writeMemory(db, "facts", k, v.trim(), "sabah");
    return { ok: true };
  });

  app.post("/api/memory/language", async (req) => {
    const b = parse(z.object({ say: z.string().min(1).max(300), not: z.string().max(300).optional(), note: z.string().max(300).optional() }), req.body);
    await writeMemory(db, "language", `l-${Date.now()}`, b, "sabah");
    return { ok: true };
  });

  app.post("/api/memory/preferences", async (req) => {
    const b = parse(z.object({ text: z.string().min(1).max(200) }), req.body);
    await writeMemory(db, "preferences", `p-${Date.now()}`, b.text, "sabah");
    return { ok: true };
  });

  app.delete("/api/memory/:id", async (req) => {
    await deleteMemory(db, idParam(req), "sabah");
    return { ok: true };
  });

  app.post("/api/memory/voice-feedback", async (req) => {
    const b = parse(z.object({ overall: z.string().max(2000), ratings: z.record(z.string(), z.string().max(20)), notes: z.record(z.string(), z.string().max(500)) }), req.body);
    const parts = [b.overall.trim(), ...Object.entries(b.ratings).map(([k, v]) => `${k}: ${v}${b.notes[k] ? ` (${b.notes[k]})` : ""}`)].filter(Boolean);
    if (!parts.length) throw new HttpError(400, "Rate a phrase or write a note first.");
    const saved = await writeMemory(db, "voice_feedback", `vf-${Date.now()}`, parts.join(" · "), "sabah");
    return { savedAt: saved.updated_at };
  });

  // ───── Settings ─────
  app.get("/api/settings", async () => {
    const s = await getSettings(db);
    const brandLinks: Record<string, string | null> = {};
    for (const slot of BRAND_SLOTS) brandLinks[slot] = s.brand[slot] ? await assetLink(db, storages, s.brand[slot]!) : null;
    return {
      settings: s,
      brandLinks,
      portraitUrl: s.appearance.portraitAssetId ? await assetLink(db, storages, s.appearance.portraitAssetId) : null,
    };
  });

  app.patch("/api/settings/notifications", async (req) => {
    const b = parse(z.object({ inbox: z.boolean(), fail: z.boolean(), daily: z.boolean(), published: z.boolean(), quiet: z.boolean() }).partial(), req.body);
    const s = await getSettings(db);
    await setSetting(db, "notifications", { ...s.notifications, ...b });
    return { ok: true };
  });

  app.get("/api/routine", async () => {
    const { routine } = await getSettings(db);
    return { routine, gaps: await postingGaps(db, routine), from: ROUTINE_FROM, maxPerRun: MAX_PER_RUN };
  });
  app.patch("/api/settings/routine", async (req) => {
    const b = parse(z.object({ enabled: z.boolean().optional(), days: z.array(z.enum(WEEKDAYS)).max(7).optional() }), req.body);
    const { routine } = await getSettings(db);
    const days = b.days ? WEEKDAYS.filter((d) => b.days!.includes(d)) : routine.days;
    await setSetting(db, "routine", { ...routine, enabled: b.enabled ?? routine.enabled, days });
    return { ok: true };
  });
  /** "Do it now": runs the morning check straight away, in the background. */
  app.post("/api/routine/run", async () => {
    void maybeRunRoutine({ db, cfg: deps.cfg, vault: deps.vault, storages: deps.storages, notifier: deps.notifier, brain: deps.brain, linkPreview: deps.linkPreview }, { force: true })
      .catch((err) => app.log.error(err));
    return { ok: true };
  });

  app.patch("/api/settings/brain", async (req) => {
    const b = parse(z.object({ mode: z.enum(["auto", "everyday", "deep"]) }), req.body);
    await setSetting(db, "brain", { mode: b.mode });
    return { ok: true };
  });

  app.patch("/api/settings/voice", async (req) => {
    const b = parse(z.object({ voice: z.string().max(60), speed: z.enum(["0.9×", "1.0×", "1.15×", "1.3×"]), transcript: z.boolean() }).partial(), req.body);
    const s = await getSettings(db);
    await setSetting(db, "voice", { ...s.voice, ...b });
    return { ok: true };
  });

  app.post("/api/brand/:slot", async (req) => {
    const slot = (req.params as { slot: string }).slot;
    if (!BRAND_SLOTS.includes(slot)) throw new HttpError(400, "Unknown brand slot.");
    const a = await uploadFrom(req, deps, "brand", { label: slot });
    const s = await getSettings(db);
    await setSetting(db, "brand", { ...s.brand, [slot]: a.id });
    return { ok: true };
  });

  app.post("/api/appearance/portrait", async (req) => {
    const a = await uploadFrom(req, deps, "portrait", { doNotPublish: true });
    await setSetting(db, "appearance", { portraitAssetId: a.id, approved: false });
    return { ok: true };
  });

  app.post("/api/appearance/approve", async (req) => {
    const b = parse(z.object({ approved: z.boolean() }), req.body);
    const s = await getSettings(db);
    if (b.approved && !s.appearance.portraitAssetId) throw new HttpError(400, "Add a portrait first.");
    await setSetting(db, "appearance", { ...s.appearance, approved: b.approved });
    return { ok: true };
  });

  // ───── Sample content ─────
  app.post("/api/sample/load", async () => {
    await loadSample(db);
    return { ok: true };
  });
  app.post("/api/sample/remove", async () => {
    await removeSample(db);
    return { ok: true };
  });
}
