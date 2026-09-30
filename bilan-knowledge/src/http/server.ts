import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Db } from "../db/pool.js";
import { ask } from "../knowledge/ask.js";
import { searchKnowledge } from "../knowledge/search.js";
import { addSource, getCampaignProfile, setCampaignProfile } from "../knowledge/store.js";
import { BudgetExceededError } from "../research/budget.js";
import type { ResearchModel } from "../research/model.js";
import { getAutomationStatus, getScheduleState } from "../refresh/schedule.js";
import { enqueueRun } from "../refresh/runs.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export interface ServerDeps {
  db: Db;
  cfg: Config;
  model: ResearchModel | null;
  /** Nudges the in-process scheduler after "Update now" (single-process mode). */
  wakeScheduler?: () => void;
  fetchImpl?: typeof fetch;
}

const PlatformParam = z.enum(["meta", "tiktok"]).nullable().optional();

function tokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { db, cfg } = deps;
  const app = Fastify({ logger: process.env.NODE_ENV === "test" ? false : { level: "info" }, bodyLimit: 256 * 1024 });

  // public/ sits next to src/ (tsx) or two levels above dist/src/http (compiled).
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
    if (!token || !tokenMatches(token, cfg.ADMIN_TOKEN)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/api/status", async () => {
    const [schedule, automation] = await Promise.all([getScheduleState(db, cfg), getAutomationStatus(db, cfg)]);
    const counts = await db.query<{ platform: string; status: string; n: string }>(
      "SELECT platform, status, count(*) AS n FROM knowledge_items GROUP BY platform, status",
    );
    const sources = await db.query<{ platform: string; status: string; enabled: boolean; failing: boolean; n: string }>(
      `SELECT platform, status, enabled, (last_check_status IN ('failed','missing','skipped')) AS failing, count(*) AS n
       FROM sources GROUP BY 1,2,3,4`,
    );
    const spend = await db.query<{ month: string | null; total: string | null }>(
      `SELECT sum(usd) FILTER (WHERE created_at >= date_trunc('month', now())) AS month, sum(usd) AS total FROM spend_ledger`,
    );
    return {
      now: new Date().toISOString(),
      schedule,
      automation,
      knowledge: counts.rows.map((r) => ({ ...r, n: Number(r.n) })),
      sources: sources.rows.map((r) => ({ ...r, n: Number(r.n) })),
      spend: { monthUsd: Number(spend.rows[0]?.month ?? 0), totalUsd: Number(spend.rows[0]?.total ?? 0) },
      limits: {
        refreshIntervalDays: cfg.REFRESH_INTERVAL_DAYS,
        maxUsdPerRefresh: cfg.MAX_USD_PER_REFRESH,
        maxUsdPerMonth: cfg.MAX_USD_PER_MONTH,
        maxUsdPerQuestion: cfg.MAX_USD_PER_QUESTION,
        maxSourcesPerRefresh: cfg.MAX_SOURCES_PER_REFRESH,
        researchModel: cfg.RESEARCH_MODEL,
      },
      researchConfigured: Boolean(deps.model),
    };
  });

  app.get("/api/runs", async (req) => {
    const q = z.object({ limit: z.coerce.number().min(1).max(200).default(50), includeLiveChecks: z.coerce.boolean().default(true) }).parse(req.query);
    const { rows } = await db.query(
      `SELECT id::int, trigger, status, requested_by, created_at, started_at, finished_at, sources_total, sources_checked,
              sources_unchanged, sources_changed, sources_new, sources_discontinued, sources_failed, items_added,
              items_archived, spend_usd::float, error, briefing_id::int,
              (SELECT count(*)::int FROM knowledge_changes c WHERE c.run_id = r.id) AS changes
       FROM refresh_runs r WHERE ($2 OR trigger <> 'live_check') ORDER BY id DESC LIMIT $1`,
      [q.limit, q.includeLiveChecks],
    );
    return { runs: rows };
  });

  app.get("/api/runs/:id", async (req, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const run = await db.query("SELECT * FROM refresh_runs WHERE id = $1", [id]);
    if (!run.rowCount) return reply.code(404).send({ error: "not found" });
    const [checks, logs, changes, briefing] = await Promise.all([
      db.query(
        `SELECT sc.outcome, sc.http_status, sc.attempts, sc.fetched_via, sc.error, sc.checked_at, s.id::int AS source_id,
                s.platform, s.url, s.title
         FROM source_checks sc JOIN sources s ON s.id = sc.source_id WHERE sc.run_id = $1
         ORDER BY (sc.outcome IN ('failed','missing','skipped')) DESC, s.platform, s.url`,
        [id],
      ),
      db.query("SELECT level, message, data, created_at FROM run_logs WHERE run_id = $1 ORDER BY id LIMIT 2000", [id]),
      db.query(
        `SELECT c.platform, c.kind, c.title, c.summary, c.relevance, c.relevance_note, s.url AS source_url FROM knowledge_changes c
         LEFT JOIN sources s ON s.id = c.source_id WHERE c.run_id = $1 ORDER BY c.platform, c.id`,
        [id],
      ),
      db.query("SELECT id::int, complete, body_markdown, created_at FROM briefings WHERE run_id = $1 ORDER BY id DESC LIMIT 1", [id]),
    ]);
    return { run: run.rows[0], checks: checks.rows, logs: logs.rows, changes: changes.rows, briefing: briefing.rows[0] ?? null };
  });

  app.post("/api/refresh", async (_req, reply) => {
    if (!deps.model) return reply.code(409).send({ error: "ANTHROPIC_API_KEY is not configured; research cannot run" });
    const r = await enqueueRun(db, "manual", "dashboard");
    deps.wakeScheduler?.();
    return reply.code(r.created ? 202 : 200).send({
      created: r.created,
      run: { id: r.run.id, status: r.run.status, trigger: r.run.trigger },
      message: r.created ? "Refresh queued" : "A refresh is already queued or running",
    });
  });

  app.get("/api/briefings", async (req) => {
    const q = z.object({ limit: z.coerce.number().min(1).max(100).default(20) }).parse(req.query);
    const { rows } = await db.query(
      `SELECT b.id::int, b.run_id::int, b.complete, b.body_markdown, b.created_at, r.trigger, r.status
       FROM briefings b JOIN refresh_runs r ON r.id = b.run_id ORDER BY b.id DESC LIMIT $1`,
      [q.limit],
    );
    return { briefings: rows };
  });

  app.get("/api/sources", async () => {
    const { rows } = await db.query(
      `SELECT s.id::int, s.platform, s.url, s.title, s.category, s.origin, s.enabled, s.status, s.consecutive_misses,
              s.last_checked_at, s.last_check_status, s.last_error, s.last_verified_at,
              (SELECT count(*)::int FROM knowledge_items k WHERE k.source_id = s.id AND k.status = 'current') AS current_items,
              (SELECT count(*)::int FROM source_versions v WHERE v.source_id = s.id) AS versions
       FROM sources s ORDER BY s.platform, s.status, s.url`,
    );
    return { sources: rows };
  });

  app.post("/api/sources", async (req, reply) => {
    const body = z.object({ url: z.string().url(), title: z.string().optional() }).parse(req.body);
    const id = await addSource(db, body.url, { title: body.title, origin: "manual" });
    if (!id) return reply.code(400).send({ error: "URL is not on an official Meta/TikTok domain, or is already monitored" });
    return reply.code(201).send({ id });
  });

  app.patch("/api/sources/:id", async (req, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const body = z.object({ enabled: z.boolean() }).parse(req.body);
    const r = await db.query("UPDATE sources SET enabled = $2 WHERE id = $1", [id, body.enabled]);
    if (!r.rowCount) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  });

  app.get("/api/sources/:id/versions", async (req) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const { rows } = await db.query(
      `SELECT id::int, content_hash, final_url, fetched_via, page_summary, first_seen_at, last_verified_at, run_id::int
       FROM source_versions WHERE source_id = $1 ORDER BY id DESC`,
      [id],
    );
    return { versions: rows };
  });

  app.get("/api/knowledge/search", async (req) => {
    const q = z.object({ q: z.string().min(1), platform: PlatformParam, limit: z.coerce.number().min(1).max(50).default(12) }).parse(req.query);
    const hits = await searchKnowledge(db, q.q, { platform: q.platform ?? null, limit: q.limit });
    return { results: hits };
  });

  app.get("/api/knowledge/items/:id", async (req, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const item = await db.query(
      `SELECT k.*, s.url AS source_url, v.first_seen_at AS version_first_seen, v.last_verified_at AS version_verified
       FROM knowledge_items k JOIN sources s ON s.id = k.source_id JOIN source_versions v ON v.id = k.source_version_id
       WHERE k.id = $1`,
      [id],
    );
    if (!item.rowCount) return reply.code(404).send({ error: "not found" });
    // Version history: the chain of items this one superseded.
    const history = await db.query(
      `WITH RECURSIVE chain AS (
         SELECT id, title, guidance, status, archived_reason, archived_at, created_at, verified_at FROM knowledge_items WHERE superseded_by = $1
         UNION ALL
         SELECT k.id, k.title, k.guidance, k.status, k.archived_reason, k.archived_at, k.created_at, k.verified_at
         FROM knowledge_items k JOIN chain c ON k.superseded_by = c.id)
       SELECT * FROM chain ORDER BY created_at DESC`,
      [id],
    );
    const { search_tsv: _omit, ...row } = item.rows[0];
    return { item: row, previousVersions: history.rows };
  });

  app.post("/api/ask", async (req) => {
    const body = z.object({ question: z.string().min(3).max(4000), platform: PlatformParam }).parse(req.body);
    return ask({ db, cfg, model: deps.model, fetchImpl: deps.fetchImpl }, body.question, body.platform ?? null, "api");
  });

  app.get("/api/settings/campaign-profile", async () => ({ text: await getCampaignProfile(db) }));

  app.put("/api/settings/campaign-profile", async (req) => {
    const body = z.object({ text: z.string().min(1).max(8000) }).parse(req.body);
    await setCampaignProfile(db, body.text);
    return { ok: true };
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: "invalid request", issues: err.issues });
    if (err instanceof BudgetExceededError) return reply.code(429).send({ error: err.message });
    app.log.error(err);
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.code(status).send({ error: status >= 500 ? "internal error" : (err as Error).message });
  });

  return app;
}
