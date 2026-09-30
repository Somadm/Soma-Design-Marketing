/**
 * Post-deployment check of every external call type against the real services.
 * Run once after deploying (a few cents; capped at $0.75). Does not change the knowledge base.
 *   npm run smoke
 */
import { loadConfig } from "../config.js";
import { migrate } from "../db/migrate.js";
import { createPool } from "../db/pool.js";
import { Budget } from "../research/budget.js";
import { ClaudeResearchModel } from "../research/claude.js";
import { VoyageEmbedder } from "../research/embeddings.js";
import { fetchDirect } from "../research/fetcher.js";
import { fetchRendered } from "../research/firecrawl.js";
import { SEED_SOURCES } from "../research/sources.js";

async function main() {
  const cfg = loadConfig();
  const db = createPool(cfg.DATABASE_URL);
  await migrate(db);
  const model = new ClaudeResearchModel(cfg);
  const budget = new Budget(db, null, { kind: "answer", capUsd: 0.75 });
  const results: { step: string; ok: boolean | null; detail: string }[] = [];
  const step = async (name: string, fn: () => Promise<string | null>) => {
    try {
      const detail = await fn();
      results.push({ step: name, ok: detail === null ? null : true, detail: detail ?? "skipped (not configured)" });
    } catch (err) {
      results.push({ step: name, ok: false, detail: (err as Error).message });
    }
  };

  await step("direct fetch of official seeds", async () => {
    const lines = await Promise.all(
      SEED_SOURCES.map(async (s) => {
        const r = await fetchDirect(s.url, { timeoutMs: cfg.FETCH_TIMEOUT_MS, userAgent: cfg.USER_AGENT, minChars: cfg.MIN_PAGE_CHARS, maxChars: cfg.MAX_PAGE_CHARS });
        return `${r.kind.padEnd(12)} ${s.url}${r.kind === "failed" || r.kind === "discontinued" ? ` (${r.reason})` : ""}`;
      }),
    );
    return `\n    ${lines.join("\n    ")}\n    Blocked pages use the rendered / web_fetch fallbacks during refreshes.`;
  });

  await step("extraction (structured output + refusal fallbacks)", async () => {
    const x = await model.extract(
      {
        platform: "tiktok",
        url: "https://ads.tiktok.com/help/article/example",
        title: "Smoke test",
        sourceType: "policy",
        pageText: "Ads for courses must not make unrealistic claims about results, jobs or earnings. Additional requirements apply in some markets. Available to some advertisers during a gradual rollout.",
        links: [],
        stored: [],
        campaignProfile: "Creative Academy – creative courses on Skool.",
      },
      budget,
    );
    return `${x.entries.length} entr${x.entries.length === 1 ? "y" : "ies"}; limitations: ${JSON.stringify(x.entries[0]?.limitations ?? [])}`;
  });

  await step("Claude web_fetch fallback", async () => {
    const r = await model.fetchViaClaude(SEED_SOURCES[0].url, SEED_SOURCES[0].platform, budget);
    if (!r.ok) throw new Error(r.error);
    return `${r.text.length} characters from ${r.finalUrl}`;
  });

  await step("rendered fetch (Firecrawl)", async () => {
    if (!cfg.FIRECRAWL_API_KEY) return null;
    const r = await fetchRendered(cfg, SEED_SOURCES[1].url, budget);
    if (!r.ok) throw new Error(r.error);
    return `${r.text.length} characters`;
  });

  await step("discovery (web search on official domains)", async () => {
    const pages = await model.discover("meta", ["financial and income claims in ads"], [], 1, budget);
    return `${pages.length} official page(s), e.g. ${pages[0]?.url ?? "none"}`;
  });

  await step("briefing", async () => {
    const b = await model.brief(
      {
        runCode: "SMOKE",
        sourcesVerified: 1,
        campaignProfile: "Creative Academy – creative courses on Skool.",
        changes: [{ ref: "meta:smoke", platform: "meta", kind: "Changed", title: "Smoke test", what_changed: "Example change.", summary: "Example.", relevance: null, limitations: [], source_url: "https://transparency.meta.com/policies/ad-standards" }],
      },
      budget,
    );
    return `summary: ${b.summary.slice(0, 80)}`;
  });

  await step("embeddings (Voyage)", async () => {
    if (!cfg.VOYAGE_API_KEY) return null;
    const [v] = await new VoyageEmbedder(cfg).embed(["smoke test"], "query", budget);
    return `${v.length} dimensions`;
  });

  for (const r of results) console.log(`${r.ok === null ? "SKIP" : r.ok ? "PASS" : "FAIL"}  ${r.step}: ${r.detail}`);
  console.log(`Spent: $${budget.spentUsd.toFixed(4)}`);
  await db.end();
  process.exit(results.every((r) => r.ok !== false) ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
