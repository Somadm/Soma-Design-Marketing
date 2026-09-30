/**
 * Post-deployment check of every paid research call type against the real APIs.
 * Run once after deploying (costs a few cents, capped at $0.75):
 *   npm run smoke
 * Exits non-zero if any step fails. It does not modify the knowledge base.
 */
import { loadConfig } from "../config.js";
import { migrate } from "../db/migrate.js";
import { createPool } from "../db/pool.js";
import { Budget } from "../research/budget.js";
import { ClaudeResearchModel } from "../research/claude.js";
import { fetchPage } from "../research/fetcher.js";
import { SEED_SOURCES } from "../research/sources.js";

async function main() {
  const cfg = loadConfig();
  const db = createPool(cfg.DATABASE_URL);
  await migrate(db);
  const model = new ClaudeResearchModel(cfg);
  const budget = new Budget(db, null, { perJobUsd: 0.75, perMonthUsd: cfg.MAX_USD_PER_MONTH });
  const results: { step: string; ok: boolean; detail: string }[] = [];
  const step = async (name: string, fn: () => Promise<string>) => {
    try {
      results.push({ step: name, ok: true, detail: await fn() });
    } catch (err) {
      results.push({ step: name, ok: false, detail: (err as Error).message });
    }
  };

  await step("direct fetch of official seeds", async () => {
    const outcomes = await Promise.all(
      SEED_SOURCES.map(async (s) => {
        const r = await fetchPage(s.url, {
          maxAttempts: 2, timeoutMs: cfg.FETCH_TIMEOUT_MS, backoffBaseMs: 1000, userAgent: cfg.USER_AGENT,
          minChars: cfg.MIN_PAGE_CHARS, maxChars: cfg.MAX_PAGE_CHARS,
        });
        return `${r.kind === "ok" ? "ok     " : r.kind.padEnd(7)} ${s.url}${r.kind === "failed" ? ` (${r.error})` : r.kind === "missing" ? ` (${r.reason})` : ""}`;
      }),
    );
    return `\n    ${outcomes.join("\n    ")}\n    (blocked pages fall back to Claude web_fetch during refreshes)`;
  });

  await step("analyze (structured output + fallbacks)", async () => {
    const a = await model.analyzeSource(
      {
        platform: "tiktok",
        url: "https://ads.tiktok.com/help/article/example",
        title: "Smoke test",
        pageText: "Advertisers in the education industry must display the institution name in the ad. This applies in the UK only. Available to some advertisers during a gradual rollout.",
        links: [],
        previousItems: [],
        campaignProfile: "Creative Academy – creative courses.",
      },
      budget,
    );
    return `${a.items.length} item(s); first: ${JSON.stringify(a.items[0] ?? null).slice(0, 200)}`;
  });

  await step("Claude web_fetch fallback", async () => {
    const r = await model.fetchViaClaude(SEED_SOURCES[0].url, SEED_SOURCES[0].platform, budget);
    if (!r.ok) throw new Error(r.error);
    return `${r.text.length} chars from ${r.finalUrl}`;
  });

  await step("discovery (web search, official domains only)", async () => {
    const pages = await model.discoverSources("meta", ["advertising standards for education and courses"], [], 1, budget);
    return `${pages.length} official page(s), e.g. ${pages[0]?.url ?? "none"}`;
  });

  await step("briefing", async () => {
    const text = await model.writeBriefing(
      {
        complete: true,
        runDate: new Date().toISOString().slice(0, 10),
        campaignProfile: "Creative Academy – creative courses.",
        failedSources: [],
        changes: [{ platform: "meta", kind: "changed", title: "Smoke test change", summary: "Example change for a connectivity test.", relevance: "low", relevance_note: "Connectivity test only.", sourceUrl: null }],
      },
      budget,
    );
    return `${text.length} chars`;
  });

  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.step}: ${r.detail}`);
  console.log(`Spent: $${budget.spentUsd.toFixed(4)}`);
  await db.end();
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
