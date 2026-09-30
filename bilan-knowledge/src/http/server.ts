import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Db } from "../db/pool.js";
import { ask } from "../kb/ask.js";
import { verifyLive } from "../kb/liveCheck.js";
import { searchKb } from "../kb/search.js";
import { addSource } from "../kb/store.js";
import { BudgetExceededError } from "../research/budget.js";
import type { Embedder } from "../research/embeddings.js";
import type { ResearchModel } from "../research/model.js";
import { displayUrl, domainLabels, normalizeUrl, platformForUrl } from "../research/sources.js";
import { enqueue, TRIGGER_LABEL, type Trigger } from "../refresh/runs.js";
import { getStatusView } from "../refresh/status.js";
import { getSettings, SettingsUpdateSchema, updateSettings } from "../settings.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export interface ServerDeps {
  db: Db;
  cfg: Config;
  model: ResearchModel | null;
  embedder: Embedder | null;
  wakeWorker?: () => void;
  fetchImpl?: typeof fetch;
}

const Platform = z.enum(["meta", "tiktok"]);

function tokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function resultLabel(r: { trigger: string; status: string; result_label: string | null }): string {
  if (r.trigger === "live_check") return r.result_label ?? (r.status === "running" ? "Running" : "Not verified");
  return { complete: "Complete", incomplete: "Incomplete", failed: "Failed", running: "Running", queued: "Queued", cancelled: "Cancelled" }[r.status] ?? r.status;
}

/** Latest finished full refresh (what the Sources tab and status strip describe). */
const LATEST_REFRESH = `(SELECT max(id) FROM refresh_runs WHERE trigger <> 'live_check' AND status NOT IN ('queued','running'))`;

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { db, cfg } = deps;
  const app = Fastify({ logger: process.env.NODE_ENV === "test" ? false : { level: "info" }, bodyLimit: 256 * 1024 });

  const publicDir = [path.resolve(here, "../../public"), path.resolve(here, "../../../public")].find((p) => existsSync(p));
  if (publicDir) await app.register(fastifyStatic, { root: publicDir, prefix: "/" });

  app.get("/healthz", async () => {
    await db.query("SELECT 1");
    return { ok: true };
  });

  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token || !tokenMatches(token, cfg.ADMIN_TOKEN)) return reply.code(401).send({ error: "unauthorized" });
  });

  // ---------- Status and Update now ----------
  app.get("/api/status", async () => getStatusView(db, cfg, Boolean(deps.model)));

  app.post("/api/refresh", async (_req, reply) => {
    if (!deps.model) return reply.code(409).send({ error: "Research is not configured (ANTHROPIC_API_KEY)." });
    const r = await enqueue(db, "manual", "dashboard");
    if (r.created) deps.wakeWorker?.();
    return reply.code(r.created ? 202 : 200).send({
      created: r.created,
      code: r.run_code,
      message: r.created ? `${r.run_code} queued` : "A refresh is already running. Duplicate request ignored.",
    });
  });

  // ---------- Overview ----------
  app.get("/api/overview", async () => {
    const { rows: lr } = await db.query(
      `SELECT id, code, status, finished_at FROM refresh_runs WHERE id = ${LATEST_REFRESH}`,
    );
    let incomplete = null;
    if (lr[0] && lr[0].status !== "complete") {
      const { rows: failures } = await db.query(
        `SELECT s.title, s.platform, rs.failure_reason AS reason FROM run_sources rs JOIN sources s ON s.id = rs.source_id
         WHERE rs.run_id = $1 AND rs.result IN ('failed','skipped') ORDER BY s.platform, s.title`,
        [lr[0].id],
      );
      const { rows: run } = await db.query("SELECT error FROM refresh_runs WHERE id = $1", [lr[0].id]);
      incomplete = { code: lr[0].code, status: lr[0].status, failures, error: failures.length ? null : run[0].error };
    }
    const latestComplete = await briefingView(
      `SELECT b.id FROM briefings b JOIN refresh_runs r ON r.id = b.run_id WHERE r.status = 'complete' ORDER BY r.id DESC LIMIT 1`,
    );
    const latestWithChanges =
      latestComplete && !latestComplete.sections.length
        ? await briefingView(
            `SELECT b.id FROM briefings b JOIN refresh_runs r ON r.id = b.run_id
             WHERE r.status = 'complete' AND jsonb_array_length(b.body->'sections') > 0 ORDER BY r.id DESC LIMIT 1`,
          )
        : null;
    return { incomplete, briefing: latestComplete, recentChanges: latestWithChanges };
  });

  // ---------- Sources ----------
  app.get("/api/sources", async () => {
    const { rows: run } = await db.query(`SELECT id, code, trigger, finished_at FROM refresh_runs WHERE id = ${LATEST_REFRESH}`);
    const runId = run[0]?.id ?? null;
    const { rows } = await db.query(
      `SELECT s.id, s.platform, s.title, s.url, s.source_type, s.status, s.fetch_mode, s.origin, s.consecutive_failures,
              s.escalated_at, s.replaced_by, v.verified_at AS last_verified_at,
              rs.result, rs.attempts, rs.note, rs.failure_reason, rs.checked_at
       FROM sources s
       LEFT JOIN source_versions v ON v.id = s.current_version_id
       LEFT JOIN run_sources rs ON rs.source_id = s.id AND rs.run_id = $1
       WHERE s.status <> 'discontinued' OR rs.run_id IS NOT NULL
       ORDER BY s.platform, s.id`,
      [runId],
    );
    return {
      run: run[0] ? { code: run[0].code, trigger: run[0].trigger, finishedAt: run[0].finished_at } : null,
      sources: rows.map((r) => ({ ...r, display_url: displayUrl(r.url) })),
    };
  });

  app.post("/api/sources", async (req, reply) => {
    const body = z.object({ url: z.string().url(), title: z.string().optional(), source_type: z.enum(["policy", "help_centre", "api_docs", "announcements"]).optional() }).parse(req.body);
    const id = await addSource(db, body.url, { title: body.title, sourceType: body.source_type, origin: "manual" });
    if (!id) return reply.code(400).send({ error: "That URL is not on an official Meta or TikTok domain, or it is already tracked." });
    return reply.code(201).send({ id });
  });

  app.patch("/api/sources/:id", async (req, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const body = z.object({ status: z.enum(["active", "paused"]).optional(), url: z.string().url().optional(), fetch_mode: z.enum(["direct", "rendered"]).optional() }).parse(req.body);
    const { rows } = await db.query("SELECT platform, status FROM sources WHERE id = $1", [id]);
    if (!rows[0]) return reply.code(404).send({ error: "not found" });
    if (rows[0].status === "discontinued") return reply.code(409).send({ error: "Discontinued sources cannot be changed." });
    if (body.url) {
      if (platformForUrl(body.url) !== rows[0].platform) return reply.code(400).send({ error: "The new URL must be on the same platform's official domains." });
      await db.query("UPDATE sources SET url = $2, consecutive_failures = 0, escalated_at = NULL WHERE id = $1", [id, normalizeUrl(body.url)]);
    }
    if (body.status) await db.query("UPDATE sources SET status = $2, escalated_at = CASE WHEN $2 = 'paused' THEN escalated_at ELSE NULL END WHERE id = $1", [id, body.status]);
    if (body.fetch_mode) await db.query("UPDATE sources SET fetch_mode = $2 WHERE id = $1", [id, body.fetch_mode]);
    return { ok: true };
  });

  // ---------- Update history ----------
  app.get("/api/runs", async () => {
    const { rows } = await db.query(
      `SELECT code, trigger, status, result_label, question, created_at, started_at, finished_at, sources_total,
              sources_verified, sources_failed, spend_usd, budget_usd
       FROM refresh_runs ORDER BY created_at DESC, id DESC LIMIT 200`,
    );
    return {
      runs: rows.map((r) => ({
        ...r,
        kind: TRIGGER_LABEL[r.trigger as Trigger],
        result: resultLabel(r),
        spend_usd: Number(r.spend_usd),
        budget_usd: Number(r.budget_usd),
      })),
    };
  });

  app.get("/api/runs/:code", async (req, reply) => {
    const { code } = z.object({ code: z.string() }).parse(req.params);
    const { rows } = await db.query("SELECT * FROM refresh_runs WHERE code = $1", [code]);
    const run = rows[0];
    if (!run) return reply.code(404).send({ error: "not found" });
    const [counts, failures, changes, briefing, live] = await Promise.all([
      db.query("SELECT result, count(*)::int AS n FROM run_sources WHERE run_id = $1 GROUP BY result", [run.id]),
      db.query(
        `SELECT s.title, s.platform, rs.failure_reason AS reason FROM run_sources rs JOIN sources s ON s.id = rs.source_id
         WHERE rs.run_id = $1 AND rs.result IN ('failed','skipped') ORDER BY s.platform, s.title`,
        [run.id],
      ),
      db.query(
        `SELECT c.id, c.kind, c.what_changed, e.id AS entry_id, e.title, e.platform,
                fv.body AS old, tv.body AS new, tv.version AS to_version, fv.version AS from_version
         FROM changes c JOIN entries e ON e.id = c.entry_id
         LEFT JOIN entry_versions fv ON fv.id = c.from_version_id LEFT JOIN entry_versions tv ON tv.id = c.to_version_id
         WHERE c.run_id = $1 ORDER BY e.platform, c.id`,
        [run.id],
      ),
      db.query("SELECT id FROM briefings WHERE run_id = $1", [run.id]),
      db.query(`SELECT s.title, s.platform, s.url FROM run_sources rs JOIN sources s ON s.id = rs.source_id WHERE rs.run_id = $1 LIMIT 1`, [run.id]),
    ]);
    const n = Object.fromEntries(counts.rows.map((r) => [r.result, r.n]));
    return {
      run: {
        code: run.code,
        trigger: run.trigger,
        kind: TRIGGER_LABEL[run.trigger as Trigger],
        status: run.status,
        result: resultLabel(run),
        question: run.question,
        created_at: run.created_at,
        started_at: run.started_at,
        finished_at: run.finished_at,
        note: run.note,
        error: run.error,
        incomplete_reason: run.incomplete_reason,
        spend_usd: Number(run.spend_usd),
        budget_usd: Number(run.budget_usd),
        sources_total: run.sources_total,
        sources_failed: run.sources_failed,
        counts: n,
        liveSource: run.trigger === "live_check" ? live.rows[0] ?? null : null,
      },
      failures: failures.rows,
      changes: changes.rows.map((c) => ({
        ...c,
        version: c.kind === "archived" ? `v${c.from_version} archived` : `v${c.to_version}`,
        hasDiff: Boolean(c.kind === "changed" && c.old && c.new),
      })),
      briefingId: briefing.rows[0]?.id ?? null,
    };
  });

  app.get("/api/runs/:code/logs", async (req, reply) => {
    const { code } = z.object({ code: z.string() }).parse(req.params);
    const { rows: run } = await db.query("SELECT id FROM refresh_runs WHERE code = $1", [code]);
    if (!run[0]) return reply.code(404).send({ error: "not found" });
    const { rows } = await db.query("SELECT at, level, stage, message FROM run_logs WHERE run_id = $1 ORDER BY id LIMIT 5000", [run[0].id]);
    return { lines: rows.map((l) => ({ t: new Date(l.at).toISOString().slice(11, 19), level: l.level, stage: l.stage, message: l.message })) };
  });

  // ---------- Briefings ----------
  async function briefingView(idQuery: string, params: unknown[] = []) {
    const { rows: idr } = await db.query(idQuery, params);
    if (!idr[0]) return null;
    const { rows } = await db.query(
      `SELECT b.id, b.partial, b.summary, b.body, b.created_at, r.code AS run_code, r.trigger, r.finished_at
       FROM briefings b JOIN refresh_runs r ON r.id = b.run_id WHERE b.id = $1`,
      [idr[0].id],
    );
    const b = rows[0];
    const { rows: recs } = await db.query("SELECT id, text, status FROM recommendations WHERE briefing_id = $1 ORDER BY id", [b.id]);
    return {
      id: b.id,
      runCode: b.run_code,
      kind: TRIGGER_LABEL[b.trigger as Trigger],
      date: b.finished_at ?? b.created_at,
      partial: b.partial,
      summary: b.summary,
      sections: (b.body.sections ?? []) as unknown[],
      unverified: b.body.unverified ?? [],
      pending: b.body.pending ?? [],
      recommendations: recs,
    };
  }

  app.get("/api/briefings", async () => {
    const { rows } = await db.query(
      `SELECT b.id, b.partial, r.code AS run_code, r.trigger, COALESCE(r.finished_at, b.created_at) AS date
       FROM briefings b JOIN refresh_runs r ON r.id = b.run_id ORDER BY r.id DESC LIMIT 100`,
    );
    return { briefings: rows.map((r) => ({ ...r, kind: TRIGGER_LABEL[r.trigger as Trigger] })) };
  });

  app.get("/api/briefings/:id", async (req, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const b = await briefingView("SELECT id FROM briefings WHERE id = $1", [id]);
    return b ?? reply.code(404).send({ error: "not found" });
  });

  app.patch("/api/recommendations/:id", async (req, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const body = z.object({ status: z.enum(["added_to_plan", "dismissed", "proposed"]) }).parse(req.body);
    const r = await db.query(
      "UPDATE recommendations SET status = $2, decided_at = CASE WHEN $2 = 'proposed' THEN NULL ELSE now() END WHERE id = $1",
      [id, body.status],
    );
    return r.rowCount ? { ok: true } : reply.code(404).send({ error: "not found" });
  });

  // ---------- Knowledge base ----------
  app.get("/api/entries", async (req) => {
    const q = z.object({ platform: Platform, status: z.enum(["current", "archived"]).default("current"), q: z.string().optional() }).parse(req.query);
    // Archived = entries with no current version (their latest version is archived).
    const base = `
      SELECT DISTINCT ON (e.id) e.id AS entry_id, ev.id AS version_id, e.title, e.category, ev.version, ev.verified_at,
             ev.status, ev.summary, s.source_type
      FROM entries e JOIN entry_versions ev ON ev.entry_id = e.id JOIN sources s ON s.id = e.source_id
      WHERE e.platform = $1`;
    const current = `${base} AND ev.status = 'current' ORDER BY e.id, ev.version DESC`;
    const archived = `${base} AND NOT EXISTS (SELECT 1 FROM entry_versions x WHERE x.entry_id = e.id AND x.status = 'current')
                      ORDER BY e.id, ev.version DESC`;
    const [cur, arc] = await Promise.all([db.query(current, [q.platform]), db.query(archived, [q.platform])]);
    let items = q.status === "current" ? cur.rows : arc.rows;
    if (q.q?.trim()) {
      const needle = q.q.trim().toLowerCase();
      items = items.filter((i) => `${i.title} ${i.summary}`.toLowerCase().includes(needle));
    }
    items.sort((a, b) => new Date(b.verified_at).getTime() - new Date(a.verified_at).getTime());
    return { counts: { current: cur.rowCount, archived: arc.rowCount }, items };
  });

  app.get("/api/entries/:id", async (req, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const { rows: er } = await db.query(
      `SELECT e.id, e.platform, e.title, e.category, e.slug, s.id AS source_id, s.url AS source_url, s.source_type, s.status AS source_status
       FROM entries e JOIN sources s ON s.id = e.source_id WHERE e.id = $1`,
      [id],
    );
    if (!er[0]) return reply.code(404).send({ error: "not found" });
    const { rows: versions } = await db.query(
      `SELECT ev.id, ev.version, ev.summary, ev.body, ev.relevance, ev.limitations, ev.status, ev.origin, ev.verified_at,
              ev.created_at, ev.archived_at, ev.archived_reason, r.code AS run_code, r.trigger
       FROM entry_versions ev LEFT JOIN refresh_runs r ON r.id = ev.run_id WHERE ev.entry_id = $1 ORDER BY ev.version DESC`,
      [id],
    );
    const latest = versions[0];
    const current = versions.find((v) => v.status === "current") ?? latest;
    const { rows: failedNow } = await db.query(
      `SELECT rs.failure_reason FROM run_sources rs WHERE rs.source_id = $1 AND rs.run_id = ${LATEST_REFRESH} AND rs.result IN ('failed','skipped')`,
      [er[0].source_id],
    );
    const { rows: lastChange } = await db.query(
      `SELECT c.what_changed, fv.body AS old, tv.body AS new, r.code AS run_code
       FROM changes c JOIN refresh_runs r ON r.id = c.run_id
       LEFT JOIN entry_versions fv ON fv.id = c.from_version_id LEFT JOIN entry_versions tv ON tv.id = c.to_version_id
       WHERE c.entry_id = $1 AND c.kind = 'changed' ORDER BY c.id DESC LIMIT 1`,
      [id],
    );
    const by = (v: (typeof versions)[number]) => (v.trigger ? `${TRIGGER_LABEL[v.trigger as Trigger]} ${v.run_code}` : "");
    return {
      entry: {
        ...er[0],
        source_display: displayUrl(er[0].source_url),
        status: current.status,
        version: current.version,
        summary: current.summary,
        body: current.body,
        relevance: current.relevance,
        limitations: current.limitations,
        verified_at: current.verified_at,
        verified_by: by(current),
        archived_reason: current.archived_reason,
        unverified: current.status === "current" && failedNow.length > 0,
        unverified_reason: failedNow[0]?.failure_reason ?? null,
      },
      latestChange: lastChange[0] ?? null,
      versions: versions.map((v) => ({
        version: v.version,
        date: v.created_at,
        status: v.status,
        note: `${by(v)}${v.status === "archived" && v.archived_at ? `. ${v.archived_reason ?? "Archived"}` : ""}`,
      })),
    };
  });

  // ---------- Settings ----------
  app.get("/api/settings", async () => ({
    settings: await getSettings(db),
    domains: { meta: domainLabels("meta"), tiktok: domainLabels("tiktok") },
    publishing: "locked_off",
  }));

  app.put("/api/settings", async (req) => {
    const patch = SettingsUpdateSchema.parse(req.body);
    return { settings: await updateSettings(db, patch) };
  });

  // ---------- Used by Bilan's chat and planning ----------
  app.get("/api/kb/search", async (req) => {
    const q = z.object({ q: z.string().min(1), platform: Platform.optional(), limit: z.coerce.number().min(1).max(30).default(8) }).parse(req.query);
    return { results: await searchKb(db, q.q, { platform: q.platform ?? null, limit: q.limit, embedder: deps.embedder }) };
  });

  app.post("/api/kb/verify-live", async (req, reply) => {
    if (!deps.model) return reply.code(409).send({ error: "Research is not configured (ANTHROPIC_API_KEY)." });
    const body = z.object({ source_id: z.number().int(), question: z.string().max(2000).optional() }).parse(req.body);
    return verifyLive({ db, cfg, model: deps.model, embedder: deps.embedder, fetchImpl: deps.fetchImpl }, body.source_id, { question: body.question ?? null, requestedBy: "api" });
  });

  app.post("/api/ask", async (req) => {
    const body = z.object({ question: z.string().min(3).max(4000), platform: Platform.nullable().optional() }).parse(req.body);
    return ask({ db, cfg, model: deps.model, embedder: deps.embedder, fetchImpl: deps.fetchImpl }, body.question, body.platform ?? null, "chat");
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    if (err instanceof BudgetExceededError) return reply.code(429).send({ error: err.message });
    app.log.error(err);
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.code(status).send({ error: status >= 500 ? "internal error" : (err as Error).message });
  });

  return app;
}
