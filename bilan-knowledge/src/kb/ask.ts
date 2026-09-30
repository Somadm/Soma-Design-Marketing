import type { Config } from "../config.js";
import type { Db } from "../db/pool.js";
import { Budget } from "../research/budget.js";
import type { Embedder } from "../research/embeddings.js";
import { CHANGEABLE, type Category, type KnowledgeForAnswer, type ResearchModel } from "../research/model.js";
import { PLATFORM_LABEL, type Platform } from "../research/sources.js";
import { getSettings } from "../settings.js";
import { verifyLive, type LiveCheckResult } from "./liveCheck.js";
import { detectPlatform, searchKb, type SearchHit } from "./search.js";

export interface AskDeps {
  db: Db;
  cfg: Config;
  model: ResearchModel | null;
  embedder: Embedder | null;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface AskResult {
  answer: string | null;
  platform: Platform | null;
  knowledge: (KnowledgeForAnswer & { entry_id: number })[];
  liveChecks: LiveCheckResult[];
  note?: string;
}

function toKnowledge(h: SearchHit, i: number): KnowledgeForAnswer & { entry_id: number } {
  return {
    entry_id: h.entry_id,
    ref: `K${i + 1}`,
    platform: h.platform,
    title: h.title,
    summary: h.summary,
    body: h.body,
    relevance: h.relevance,
    limitations: h.limitations,
    source_url: h.source_url,
    verified_at: new Date(h.verified_at).toISOString(),
    version: h.version,
    stale: h.stale,
  };
}

/**
 * Bilan's answer path: always search saved knowledge first; re-verify changeable
 * guidance (policy, feature availability, setup steps) live; then answer.
 */
export async function ask(deps: AskDeps, question: string, explicitPlatform: Platform | null, requestedBy: string): Promise<AskResult> {
  const { db, cfg, model } = deps;
  const platform = explicitPlatform ?? detectPlatform(question);
  let hits = await searchKb(db, question, { platform, limit: 8, embedder: deps.embedder });
  if (!model) {
    return { answer: null, platform, knowledge: hits.map(toKnowledge), liveChecks: [], note: "Research is not configured: saved knowledge only, not re-verified." };
  }

  const liveChecks: LiveCheckResult[] = [];
  const changeableSources = [...new Set(hits.filter((h) => CHANGEABLE.includes(h.category as Category)).map((h) => h.source_id))].slice(0, 3);
  for (const sourceId of changeableSources) {
    const matched = hits.filter((h) => h.source_id === sourceId);
    liveChecks.push(
      await verifyLive({ ...deps, model }, sourceId, {
        question,
        requestedBy,
        retrievedNote: `Retrieved ${hits.length} saved entries${platform ? ` (${PLATFORM_LABEL[platform]})` : ""}. ${matched[0].category.replace(/_/g, " ")} topic flagged as changeable.`,
      }),
    );
  }
  if (liveChecks.some((c) => c.outcome === "changed" || c.outcome === "discontinued")) {
    hits = await searchKb(db, question, { platform, limit: 8, embedder: deps.embedder });
  }

  const knowledge = hits.map(toKnowledge);
  const notes = liveChecks.map((c) =>
    c.outcome === "failed"
      ? `${c.url}: could NOT be re-verified just now (${c.error}). Stored version verified ${c.storedVerifiedAt?.toISOString().slice(0, 10) ?? "never"}.`
      : `${c.url}: re-verified just now (${c.runCode}): ${c.label}.`,
  );
  const settings = await getSettings(db);
  const budget = new Budget(db, null, { kind: "answer", capUsd: cfg.MAX_USD_PER_ANSWER });
  const answer = await model.answer({ question, platform, knowledge, liveCheckNotes: notes, campaignProfile: settings.campaign_profile }, budget);
  return { answer, platform, knowledge, liveChecks };
}
