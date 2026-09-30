import type { Config } from "../config.js";
import { FIRECRAWL_USD_PER_CREDIT, type Budget } from "./budget.js";
import { normalizeText, type PageLink } from "./fetcher.js";

export type RenderedResult = { ok: true; text: string; finalUrl: string; httpStatus: number; links: PageLink[] } | { ok: false; error: string };

/**
 * Optional rendered fetch for JavaScript-rendered or bot-protected pages (Firecrawl).
 * Used when a source's fetch_mode is "rendered" or the direct body looks empty.
 */
export async function fetchRendered(cfg: Config, url: string, budget: Budget, fetchImpl: typeof fetch = fetch): Promise<RenderedResult> {
  if (!cfg.FIRECRAWL_API_KEY) return { ok: false, error: "Rendered fetch not configured (FIRECRAWL_API_KEY)" };
  await budget.assertCanSpend(FIRECRAWL_USD_PER_CREDIT * 5, "rendered fetch");
  try {
    const res = await fetchImpl(cfg.FIRECRAWL_API_URL, {
      method: "POST",
      signal: AbortSignal.timeout(Math.max(cfg.FETCH_TIMEOUT_MS, 60000)),
      headers: { authorization: `Bearer ${cfg.FIRECRAWL_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      error?: string;
      data?: { markdown?: string; metadata?: { statusCode?: number; url?: string; sourceURL?: string; creditsUsed?: number } };
    };
    const credits = json.data?.metadata?.creditsUsed ?? 1;
    await budget.recordOther("firecrawl", "rendered_fetch", credits, credits * FIRECRAWL_USD_PER_CREDIT);
    if (!res.ok || !json.success || !json.data?.markdown) {
      return { ok: false, error: `Rendered fetch failed: ${json.error ?? `HTTP ${res.status}`}` };
    }
    const status = json.data.metadata?.statusCode ?? 200;
    if (status >= 400) return { ok: false, error: `Rendered fetch: HTTP ${status}` };
    const md = json.data.markdown;
    const links = [...md.matchAll(/\[([^\]]{0,120})\]\((https:\/\/[^)\s]+)\)/g)].map((m) => ({ text: m[1], url: m[2] }));
    const text = normalizeText(md.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"));
    return { ok: true, text, finalUrl: json.data.metadata?.url ?? json.data.metadata?.sourceURL ?? url, httpStatus: status, links };
  } catch (err) {
    return { ok: false, error: `Rendered fetch error: ${(err as Error).message}` };
  }
}
