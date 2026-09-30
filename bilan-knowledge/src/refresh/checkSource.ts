import type { Config } from "../config.js";
import type { Db } from "../db/pool.js";
import {
  applyAnalysis,
  currentItems,
  markVerifiedUnchanged,
  recordCheck,
  registerMiss,
  type SourceRow,
} from "../knowledge/store.js";
import type { Logger } from "../log.js";
import { BudgetExceededError, type Budget } from "../research/budget.js";
import { contentHash, fetchPage, type FetchOutcome } from "../research/fetcher.js";
import type { ResearchModel } from "../research/model.js";

export interface CheckDeps {
  db: Db;
  cfg: Config;
  model: ResearchModel;
  budget: Budget;
  log: Logger;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export type CheckOutcome = "unchanged" | "changed" | "new" | "discontinued" | "missing" | "failed";

export interface CheckResult {
  outcome: CheckOutcome;
  error?: string;
  itemsAdded: number;
  itemsArchived: number;
  changes: number;
  followLinks: string[];
  budgetExhausted?: boolean;
}

/**
 * Checks one source: retrieve → compare with stored version → (if different)
 * analyze and store. An inaccessible page is always reported as "failed" and the
 * last verified version is kept; it is never reported as unchanged.
 */
export async function checkSource(
  deps: CheckDeps,
  runId: number,
  source: SourceRow,
  opts: { recordChanges: boolean; campaignProfile: string },
): Promise<CheckResult> {
  const { cfg, log } = deps;
  const empty = { itemsAdded: 0, itemsArchived: 0, changes: 0, followLinks: [] as string[] };

  let fetched: FetchOutcome = await fetchPage(source.url, {
    maxAttempts: cfg.FETCH_MAX_ATTEMPTS,
    timeoutMs: cfg.FETCH_TIMEOUT_MS,
    backoffBaseMs: cfg.FETCH_BACKOFF_BASE_MS,
    userAgent: cfg.USER_AGENT,
    minChars: cfg.MIN_PAGE_CHARS,
    maxChars: cfg.MAX_PAGE_CHARS,
    fetchImpl: deps.fetchImpl,
    sleep: deps.sleep,
  });
  let via: "direct" | "claude_web_fetch" = "direct";

  if (fetched.kind === "failed" && cfg.USE_CLAUDE_WEB_FETCH_FALLBACK) {
    const direct = fetched;
    try {
      const viaClaude = await deps.model.fetchViaClaude(source.url, source.platform, deps.budget);
      if (viaClaude.ok && viaClaude.text.length >= cfg.MIN_PAGE_CHARS && viaClaude.text.length <= cfg.MAX_PAGE_CHARS) {
        fetched = { kind: "ok", text: viaClaude.text, finalUrl: viaClaude.finalUrl, httpStatus: 200, attempts: direct.attempts + 1, links: [] };
        via = "claude_web_fetch";
      } else {
        const why = viaClaude.ok ? `web_fetch content length ${viaClaude.text.length} outside limits` : viaClaude.error;
        fetched = { ...direct, error: `${direct.error}; fallback: ${why}` };
      }
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        await recordCheck(deps.db, { runId, sourceId: source.id, outcome: "failed", httpStatus: direct.httpStatus, attempts: direct.attempts, error: `${direct.error}; ${err.message}` });
        return { ...empty, outcome: "failed", error: err.message, budgetExhausted: true };
      }
      fetched = { ...direct, error: `${direct.error}; fallback error: ${(err as Error).message}` };
    }
  }

  if (fetched.kind === "failed") {
    await recordCheck(deps.db, { runId, sourceId: source.id, outcome: "failed", httpStatus: fetched.httpStatus, attempts: fetched.attempts, error: fetched.error });
    await log.warn(`Could not retrieve ${source.url}; keeping last verified version`, { error: fetched.error });
    return { ...empty, outcome: "failed", error: fetched.error };
  }

  if (fetched.kind === "missing") {
    const miss = await registerMiss(deps.db, {
      runId, source, reason: fetched.reason, threshold: cfg.DISCONTINUE_AFTER_MISSES, recordChanges: opts.recordChanges,
    });
    const outcome = miss.discontinued ? "discontinued" : "missing";
    const error = miss.discontinued ? null : `${fetched.reason} – will confirm on next attempt before archiving`;
    await recordCheck(deps.db, { runId, sourceId: source.id, outcome, httpStatus: fetched.httpStatus, attempts: fetched.attempts, error });
    await log.info(`${source.url}: ${outcome} (${fetched.reason})`);
    return { ...empty, outcome, error: error ?? undefined, itemsArchived: miss.itemsArchived, changes: miss.discontinued ? 1 : 0 };
  }

  const hash = contentHash(fetched.text);
  if (source.current_hash === hash) {
    await markVerifiedUnchanged(deps.db, source);
    await recordCheck(deps.db, { runId, sourceId: source.id, outcome: "unchanged", httpStatus: fetched.httpStatus, attempts: fetched.attempts, via, versionId: source.current_version_id });
    return { ...empty, outcome: "unchanged" };
  }

  try {
    const analysis = await deps.model.analyzeSource(
      {
        platform: source.platform,
        url: source.url,
        title: source.title,
        pageText: fetched.text,
        links: fetched.links,
        previousItems: await currentItems(deps.db, source.id),
        campaignProfile: opts.campaignProfile,
      },
      deps.budget,
    );
    const isNew = source.current_version_id === null;
    const applied = await applyAnalysis(deps.db, {
      runId, source, text: fetched.text, hash, finalUrl: fetched.finalUrl, via, title: null, analysis,
      recordChanges: opts.recordChanges && !isNew,
    });
    if (applied.unaccountedItemIds.length) {
      await log.warn(`${source.url}: ${applied.unaccountedItemIds.length} stored item(s) not matched in new analysis; left current but not re-verified`, {
        itemIds: applied.unaccountedItemIds,
      });
    }
    const outcome: CheckOutcome = isNew ? "new" : applied.materialChange ? "changed" : "unchanged";
    await recordCheck(deps.db, { runId, sourceId: source.id, outcome, httpStatus: fetched.httpStatus, attempts: fetched.attempts, via, versionId: applied.versionId });
    return {
      outcome,
      itemsAdded: applied.itemsAdded,
      itemsArchived: applied.itemsArchived,
      changes: applied.changesRecorded,
      followLinks: analysis.follow_links,
    };
  } catch (err) {
    const budgetExhausted = err instanceof BudgetExceededError;
    const error = `analysis/storage failed: ${(err as Error).message}`;
    await recordCheck(deps.db, { runId, sourceId: source.id, outcome: "failed", httpStatus: fetched.httpStatus, attempts: fetched.attempts, via, error });
    await log.error(`${source.url}: ${error}`);
    return { ...empty, outcome: "failed", error, budgetExhausted };
  }
}
