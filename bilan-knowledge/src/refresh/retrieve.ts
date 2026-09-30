import type { Config } from "../config.js";
import type { SourceRow } from "../kb/store.js";
import type { Budget } from "../research/budget.js";
import { contentProblem, fetchDirect, type FetchOutcome } from "../research/fetcher.js";
import { fetchRendered } from "../research/firecrawl.js";
import type { ResearchModel } from "../research/model.js";

export interface RetrieveDeps {
  cfg: Config;
  model: ResearchModel | null;
  fetchImpl?: typeof fetch;
}

/**
 * One retrieval attempt: direct HTTPS; if the page is blocked or empty, a rendered
 * fetch (Firecrawl, optional), then Claude's web_fetch (optional). Temporary errors
 * (timeouts, 5xx) are returned as failed so the caller can retry with backoff.
 */
export async function retrieveOnce(deps: RetrieveDeps, source: SourceRow, budget: Budget): Promise<FetchOutcome> {
  const { cfg } = deps;
  const limits = { minChars: cfg.MIN_PAGE_CHARS, maxChars: cfg.MAX_PAGE_CHARS, previousLength: source.current_length };
  let first: FetchOutcome | null = null;

  if (source.fetch_mode === "direct") {
    first = await fetchDirect(source.url, { ...limits, timeoutMs: cfg.FETCH_TIMEOUT_MS, userAgent: cfg.USER_AGENT, fetchImpl: deps.fetchImpl });
    if (first.kind !== "failed" || !first.blocked) return first;
  }
  const reasons = first?.kind === "failed" ? [first.reason] : [];

  if (cfg.FIRECRAWL_API_KEY) {
    const r = await fetchRendered(cfg, source.url, budget, deps.fetchImpl);
    if (r.ok) {
      const problem = contentProblem(r.text, limits);
      if (!problem) return { kind: "ok", text: r.text, finalUrl: r.finalUrl, httpStatus: r.httpStatus, links: r.links, via: "rendered" };
      reasons.push(`rendered: ${problem}`);
    } else reasons.push(r.error);
  }

  if (cfg.USE_CLAUDE_WEB_FETCH_FALLBACK && deps.model) {
    const r = await deps.model.fetchViaClaude(source.url, source.platform, budget);
    if (r.ok) {
      const problem = contentProblem(r.text, limits);
      if (!problem) return { kind: "ok", text: r.text, finalUrl: r.finalUrl, httpStatus: 200, links: [], via: "claude_web_fetch" };
      reasons.push(`web_fetch: ${problem}`);
    } else reasons.push(r.error);
  }

  return {
    kind: "failed",
    httpStatus: first?.kind === "failed" ? first.httpStatus : null,
    reason: reasons.join("; ") || "Rendered fetch required but not configured",
    blocked: true,
  };
}
