import { testConfig, type Config } from "../src/config.js";
import { migrate } from "../src/db/migrate.js";
import { createPool, type Db } from "../src/db/pool.js";
import type { Budget } from "../src/research/budget.js";
import type {
  AnalyzeInput,
  AnswerInput,
  AnswerOutput,
  BriefingInput,
  ClaudeFetchResult,
  DiscoveredPage,
  ResearchModel,
  SourceAnalysis,
} from "../src/research/model.js";
import type { Platform } from "../src/research/sources.js";

export const TEST_DB = process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:5433/bilan_test";

export async function freshDb(): Promise<Db> {
  const db = createPool(TEST_DB);
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(db);
  return db;
}

export function cfg(overrides: Partial<Record<keyof Config, string>> = {}): Config {
  return testConfig({
    ANTHROPIC_API_KEY: "test-key",
    FETCH_BACKOFF_BASE_MS: "1",
    MIN_PAGE_CHARS: "20",
    MAX_DISCOVERY_SEARCHES_PER_PLATFORM: "2",
    ...overrides,
  });
}

/** A page body. Lines "RULE <title>: <guidance>" are what the fake model extracts. */
export function page(title: string, rules: Record<string, string>, extra = ""): string {
  const lis = Object.entries(rules)
    .map(([t, g]) => `<li>RULE ${t}: ${g}</li>`)
    .join("");
  return `<html><head><title>${title}</title></head><body><main><h1>${title}</h1><ul>${lis}</ul>${extra}</main></body></html>`;
}

type Route = { status: number; body?: string; redirectTo?: string; headers?: Record<string, string> } | (() => Response | Promise<Response>);

/** In-memory web. Unknown URLs return 404. */
export class FakeWeb {
  routes = new Map<string, Route | Route[]>();
  hits = new Map<string, number>();

  set(url: string, route: Route | Route[]) {
    this.routes.set(url, route);
  }

  fetch: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const n = (this.hits.get(url) ?? 0) + 1;
    this.hits.set(url, n);
    let r = this.routes.get(url);
    if (Array.isArray(r)) r = r[Math.min(n - 1, r.length - 1)];
    if (!r) return mkResponse(url, 404, "not found");
    if (typeof r === "function") return r();
    if (r.status === -1) throw new TypeError("fetch failed: ECONNRESET");
    return mkResponse(r.redirectTo ?? url, r.status, r.body ?? "", r.headers);
  };
}

function mkResponse(finalUrl: string, status: number, body: string, headers: Record<string, string> = {}): Response {
  const res = new Response(status === 204 ? null : body, { status, headers: { "content-type": "text/html", ...headers } });
  Object.defineProperty(res, "url", { value: finalUrl });
  return res;
}

/** Deterministic stand-in for Claude that still exercises the budget. */
export class FakeModel implements ResearchModel {
  analyzeCalls: AnalyzeInput[] = [];
  briefingCalls: BriefingInput[] = [];
  answerCalls: AnswerInput[] = [];
  discoverResult: Partial<Record<Platform, DiscoveredPage[]>> = {};
  claudeFetch = new Map<string, ClaudeFetchResult>();
  costPerCall = 0.01;
  failAnalyzeFor = new Set<string>();

  private async spend(budget: Budget, purpose: string) {
    await budget.assertCanSpend(this.costPerCall, purpose);
    // $4/M input + $20/M output: 1000 in + 300 out ≈ $0.01
    await budget.record(purpose, "claude-opus-5-5", { input_tokens: 1000, output_tokens: 300 });
  }

  async analyzeSource(input: AnalyzeInput, budget: Budget): Promise<SourceAnalysis> {
    await this.spend(budget, "analyze_source");
    this.analyzeCalls.push(input);
    if (this.failAnalyzeFor.has(input.url)) throw new Error("simulated model outage");
    const rules = [...input.pageText.matchAll(/RULE ([^:\n]+): ([^\n]+)/g)].map((m) => ({ title: m[1].trim(), guidance: m[2].trim() }));
    const prevByTitle = new Map(input.previousItems.map((p) => [p.title, p]));
    const items: SourceAnalysis["items"] = rules.map((r) => {
      const prev = prevByTitle.get(r.title);
      const regions = /\(UK only\)/.test(r.guidance) ? ["UK"] : [];
      return {
        previous_item_id: prev?.id ?? null,
        change: prev ? (prev.guidance === r.guidance ? "unchanged" : "changed") : "new",
        topic: "test",
        title: r.title,
        guidance: r.guidance,
        regions,
        account_scope: /some advertisers/.test(r.guidance) ? "some advertisers" : null,
        rollout_status: /beta/.test(r.guidance) ? "beta" : null,
        limitations: null,
        effective_date: null,
      };
    });
    const current = new Set(rules.map((r) => r.title));
    const discontinued = input.previousItems.filter((p) => !current.has(p.title)).map((p) => ({ previous_item_id: p.id, reason: "removed from page" }));
    const changes: SourceAnalysis["changes"] = [
      ...items
        .filter((i) => i.change !== "unchanged")
        .map((i) => ({ kind: i.change as "new" | "changed", title: i.title, summary: i.guidance, relevance: "high" as const, relevance_note: "affects course lead ads" })),
      ...discontinued.map((d) => ({ kind: "discontinued" as const, title: `item ${d.previous_item_id}`, summary: d.reason, relevance: "low" as const, relevance_note: "not used" })),
    ];
    return {
      relevant: rules.length > 0,
      material_change: changes.length > 0,
      page_summary: `${rules.length} rules`,
      items,
      discontinued,
      changes,
      follow_links: input.links.filter((l) => l.text.startsWith("FOLLOW")).map((l) => l.url),
    };
  }

  async discoverSources(platform: Platform, _t: string[], known: string[], _m: number, budget: Budget): Promise<DiscoveredPage[]> {
    await this.spend(budget, `discover_${platform}`);
    return (this.discoverResult[platform] ?? []).filter((p) => !known.includes(p.url));
  }

  async fetchViaClaude(url: string, _p: Platform, budget: Budget): Promise<ClaudeFetchResult> {
    await this.spend(budget, "web_fetch");
    return this.claudeFetch.get(url) ?? { ok: false, error: "web_fetch error: url_not_accessible" };
  }

  async writeBriefing(input: BriefingInput, budget: Budget): Promise<string> {
    await this.spend(budget, "briefing");
    this.briefingCalls.push(input);
    return `# What changed and what it means for us\n${input.changes.length} change(s)`;
  }

  async answer(input: AnswerInput, budget: Budget): Promise<AnswerOutput> {
    await this.spend(budget, "answer");
    this.answerCalls.push(input);
    return { answer: `answer using ${input.knowledge.map((k) => k.ref).join(",")}`, searchedUrls: [] };
  }
}
