import type { Config } from "../config.js";
import type { Db } from "../db/pool.js";
import { runLogger } from "../log.js";
import { checkSource, type CheckResult } from "../refresh/checkSource.js";
import { createLiveCheckRun } from "../refresh/runs.js";
import { Budget } from "../research/budget.js";
import type { KnowledgeForAnswer, ResearchModel } from "../research/model.js";
import type { Platform } from "../research/sources.js";
import { searchKnowledge, detectPlatform, involvesChangeableGuidance, type KnowledgeHit } from "./search.js";
import { addSource, getCampaignProfile, getSource } from "./store.js";

export interface AskDeps {
  db: Db;
  cfg: Config;
  model: ResearchModel | null;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface LiveCheckReport {
  url: string;
  outcome: CheckResult["outcome"] | "skipped_fresh";
  error?: string;
}

export interface AskResult {
  answer: string | null;
  platform: Platform | null;
  knowledge: (KnowledgeForAnswer & { id: number })[];
  liveChecks: LiveCheckReport[];
  liveCheckRunId: number | null;
  spendUsd: number;
  note?: string;
}

function toRef(h: KnowledgeHit, i: number): KnowledgeForAnswer & { id: number } {
  return {
    id: h.id,
    ref: `K${i + 1}`,
    platform: h.platform,
    title: h.title,
    guidance: h.guidance,
    regions: h.regions,
    account_scope: h.account_scope,
    rollout_status: h.rollout_status,
    limitations: h.limitations,
    source_url: h.source_url,
    verified_at: new Date(h.source_last_verified_at ?? h.verified_at).toISOString(),
  };
}

/**
 * Answers an advertising question:
 *  1. always retrieves saved knowledge first;
 *  2. if the question involves changeable guidance, re-verifies the cited official
 *     sources live and saves any verified change;
 *  3. answers from the (now current) knowledge, searching official sites for gaps;
 *  4. in the background, indexes official pages found by that search.
 */
export async function ask(deps: AskDeps, question: string, explicitPlatform: Platform | null, requestedBy: string): Promise<AskResult> {
  const { db, cfg, model } = deps;
  const platform = explicitPlatform ?? detectPlatform(question);
  let hits = await searchKnowledge(db, question, { platform, limit: 12 });

  if (!model) {
    return {
      answer: null,
      platform,
      knowledge: hits.map(toRef),
      liveChecks: [],
      liveCheckRunId: null,
      spendUsd: 0,
      note: "ANTHROPIC_API_KEY not configured: returning saved knowledge only, without live verification.",
    };
  }

  const changeable = involvesChangeableGuidance(question);
  const liveChecks: LiveCheckReport[] = [];
  const liveCheck = changeable && cfg.LIVE_CHECK_MAX_SOURCES > 0 && hits.length > 0;
  const runId = liveCheck ? await createLiveCheckRun(db, requestedBy) : null;
  // One budget covers the live check and the answer, so MAX_USD_PER_QUESTION is a true per-question cap.
  const budget = new Budget(db, runId, { perJobUsd: cfg.MAX_USD_PER_QUESTION, perMonthUsd: cfg.MAX_USD_PER_MONTH });
  const campaignProfile = await getCampaignProfile(db);

  if (runId !== null) {
    const log = runLogger(db, runId);
    await log.info(`Live check for question: ${question.slice(0, 200)}`);
    const sourceIds = [...new Set(hits.map((h) => h.source_id))].slice(0, cfg.LIVE_CHECK_MAX_SOURCES);
    let changed = false;
    for (const id of sourceIds) {
      const source = await getSource(db, id);
      if (!source) continue;
      const fresh =
        source.last_verified_at &&
        Date.now() - new Date(source.last_verified_at).getTime() < cfg.LIVE_CHECK_FRESH_HOURS * 3600_000;
      if (fresh) {
        liveChecks.push({ url: source.url, outcome: "skipped_fresh" });
        continue;
      }
      const res = await checkSource({ db, cfg, model, budget, log, fetchImpl: deps.fetchImpl, sleep: deps.sleep }, runId, source, {
        recordChanges: true,
        campaignProfile,
      });
      liveChecks.push({ url: source.url, outcome: res.outcome, error: res.error });
      if (res.outcome === "changed" || res.outcome === "discontinued") changed = true;
      if (res.budgetExhausted) break;
    }
    await finishLiveCheck(db, runId, liveChecks);
    if (changed) hits = await searchKnowledge(db, question, { platform, limit: 12 });
  }

  const knowledge = hits.map(toRef);
  const liveCheckNotes = liveChecks.map((c) =>
    c.outcome === "skipped_fresh"
      ? `${c.url}: verified within the last ${cfg.LIVE_CHECK_FRESH_HOURS}h`
      : c.outcome === "failed" || c.outcome === "missing"
        ? `${c.url}: could NOT be re-checked just now (${c.error}); saved version may be out of date`
        : `${c.url}: re-checked just now – ${c.outcome}`,
  );

  const out = await model.answer(
    { question, platform, knowledge, liveCheckNotes, campaignProfile, allowWebSearch: changeable || knowledge.length === 0 },
    budget,
  );

  // Save official pages surfaced by the live search so they are verified and indexed.
  const discovered = out.searchedUrls.filter((u) => !platform || u.platform === platform).slice(0, 2);
  if (discovered.length) void indexDiscovered(deps, discovered, requestedBy, campaignProfile);

  return {
    answer: out.answer,
    platform,
    knowledge,
    liveChecks,
    liveCheckRunId: runId,
    spendUsd: Number(budget.spentUsd.toFixed(4)),
  };
}

async function finishLiveCheck(db: Db, runId: number, checks: LiveCheckReport[]) {
  const failed = checks.filter((c) => c.outcome === "failed" || c.outcome === "missing");
  const status = failed.length ? "incomplete" : "succeeded";
  await db.query(
    `UPDATE refresh_runs SET status = $2, finished_at = now(), sources_total = $3, sources_checked = $3,
       sources_changed = $4, sources_unchanged = $5, sources_failed = $6, sources_discontinued = $7, error = $8
     WHERE id = $1`,
    [
      runId,
      status,
      checks.filter((c) => c.outcome !== "skipped_fresh").length,
      checks.filter((c) => c.outcome === "changed").length,
      checks.filter((c) => c.outcome === "unchanged").length,
      failed.length,
      checks.filter((c) => c.outcome === "discontinued").length,
      failed.length ? failed.map((f) => `${f.url}: ${f.error}`).join("\n") : null,
    ],
  );
}

async function indexDiscovered(
  deps: AskDeps,
  pages: { url: string; title: string; platform: Platform }[],
  requestedBy: string,
  campaignProfile: string,
): Promise<void> {
  const { db, cfg, model } = deps;
  if (!model) return;
  try {
    const ids: number[] = [];
    for (const p of pages) {
      const id = await addSource(db, p.url, { title: p.title, origin: "live_check", platform: p.platform });
      if (id) ids.push(id);
    }
    if (!ids.length) return;
    const runId = await createLiveCheckRun(db, `${requestedBy} (index new pages)`);
    const budget = new Budget(db, runId, { perJobUsd: cfg.MAX_USD_PER_QUESTION, perMonthUsd: cfg.MAX_USD_PER_MONTH });
    const log = runLogger(db, runId);
    const checks: LiveCheckReport[] = [];
    for (const id of ids) {
      const source = await getSource(db, id);
      if (!source) continue;
      const res = await checkSource({ db, cfg, model, budget, log, fetchImpl: deps.fetchImpl, sleep: deps.sleep }, runId, source, {
        recordChanges: true,
        campaignProfile,
      });
      checks.push({ url: source.url, outcome: res.outcome, error: res.error });
      if (res.budgetExhausted) break;
    }
    await finishLiveCheck(db, runId, checks);
  } catch (err) {
    console.error(JSON.stringify({ level: "error", message: "indexing discovered pages failed", err: String(err) }));
  }
}
