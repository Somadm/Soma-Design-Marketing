import { testConfig, type Config } from "../src/config.js";
import { migrate } from "../src/db/migrate.js";
import { createPool, type Db } from "../src/db/pool.js";
import { addSource } from "../src/kb/store.js";
import type { Budget } from "../src/research/budget.js";
import { resetVectorColumnCache, type Embedder } from "../src/research/embeddings.js";
import type {
  AnswerInput,
  BriefingInput,
  BriefingOutput,
  ClaudeFetchResult,
  DiscoveredPage,
  ExtractInput,
  Extraction,
  ResearchModel,
} from "../src/research/model.js";
import type { Platform, SourceType } from "../src/research/sources.js";
import { executeRun } from "../src/refresh/runner.js";
import { claimNextRun, enqueue } from "../src/refresh/runs.js";

export const TEST_DB = process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:5433/bilan_test";

export let cronJobScheduled = false;

export async function freshDb(): Promise<Db> {
  const db = createPool(TEST_DB);
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  resetVectorColumnCache();
  await migrate(db);
  // pg_cron (when preloaded) would tick in the background; tests call kb_tick() explicitly.
  const hasCron = await db.query("SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'");
  if (hasCron.rowCount) {
    const job = await db.query("SELECT jobid FROM cron.job WHERE jobname = 'bilan-kb-tick'");
    cronJobScheduled = Boolean(job.rowCount);
    if (job.rowCount) await db.query("SELECT cron.unschedule('bilan-kb-tick')");
  }
  return db;
}

export function cfg(overrides: Partial<Record<keyof Config, string>> = {}): Config {
  return testConfig({
    ANTHROPIC_API_KEY: "test-key",
    MIN_PAGE_CHARS: "20",
    MAX_DISCOVERY_SEARCHES_PER_PLATFORM: "2",
    BACKOFF_SCALE: "0.00001",
    ...overrides,
  });
}

/**
 * Page body. Each rule line is what the fake model extracts:
 *   slug | Title | body | limitations ("region:UK only; rollout:Gradual rollout") | category
 */
export function page(title: string, rules: [string, string, string, string?, string?][], extra = ""): string {
  const lis = rules.map((r) => `<li>RULE ${r.join(" | ")}</li>`).join("");
  return `<html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>Official guidance page for advertisers.</p><ul>${lis}</ul>${extra}</main></body></html>`;
}

type Route = { status: number; body?: string; location?: string; headers?: Record<string, string> };

/** In-memory web. Unknown URLs return 404. Supports manual redirects. */
export class FakeWeb {
  routes = new Map<string, Route | Route[]>();
  hits = new Map<string, number>();
  resend: { to: string[]; subject: string; text: string }[] = [];

  set(url: string, route: Route | Route[]) {
    this.routes.set(url, route);
  }

  fetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://api.resend.com/emails") {
      this.resend.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
    }
    const n = (this.hits.get(url) ?? 0) + 1;
    this.hits.set(url, n);
    let r = this.routes.get(url);
    if (Array.isArray(r)) r = r[Math.min(n - 1, r.length - 1)];
    if (!r) return new Response("not found", { status: 404 });
    if (r.status === -1) throw new TypeError("fetch failed: ECONNRESET");
    const headers: Record<string, string> = { "content-type": "text/html", ...(r.headers ?? {}) };
    if (r.location) headers.location = r.location;
    return new Response(r.status === 204 || (r.status >= 300 && r.status < 400) ? null : r.body ?? "", { status: r.status, headers });
  };
}

/** Deterministic stand-in for Claude that still goes through the budget. */
export class FakeModel implements ResearchModel {
  extractCalls: ExtractInput[] = [];
  briefCalls: BriefingInput[] = [];
  answerCalls: AnswerInput[] = [];
  discoverResult: Partial<Record<Platform, DiscoveredPage[]>> = {};
  claudeFetch = new Map<string, ClaudeFetchResult>();
  costPerCall = 0.01;
  failExtract = new Set<string>();
  failDiscovery = false;

  private async spend(budget: Budget, purpose: string) {
    await budget.assertCanSpend(this.costPerCall, purpose);
    // Sonnet pricing ($2/M in, $10/M out): 2500 in + 500 out = $0.01; scaled to costPerCall.
    const k = this.costPerCall / 0.01;
    await budget.recordAnthropic(purpose, "claude-sonnet-5-5", { input_tokens: Math.round(2500 * k), output_tokens: Math.round(500 * k) });
  }

  async extract(input: ExtractInput, budget: Budget): Promise<Extraction> {
    await this.spend(budget, "extract");
    this.extractCalls.push(input);
    if (this.failExtract.has(input.url)) throw new Error("simulated model outage");
    const rules = [...input.pageText.matchAll(/RULE ([^\n]+)/g)].map((m) => m[1].split("|").map((x) => x.trim()));
    const stored = new Map(input.stored.map((s) => [s.slug, s]));
    const entries: Extraction["entries"] = rules.map(([slug, title, body, lim, category]) => {
      const prev = stored.get(slug);
      const limitations = (lim ?? "")
        .split(";")
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => {
          const [kind, ...rest] = x.split(":");
          return { kind: kind as "region", text: rest.join(":").trim() };
        });
      return {
        slug,
        title,
        category: (category as Extraction["entries"][number]["category"]) || "policy",
        summary: body.split(".")[0] + ".",
        body,
        limitations,
        relevance: `For Creative Academy: check ${title.toLowerCase()} before the next campaign.`,
        classification: !prev ? "new" : prev.body === body ? "unchanged" : "changed",
        what_changed: prev && prev.body !== body ? `${title} was updated.` : null,
      };
    });
    const current = new Set(rules.map((r) => r[0]));
    const removed = input.stored.filter((s) => !current.has(s.slug)).map((s) => ({ slug: s.slug, reason: "No longer on the page" }));
    const substantive = removed.length > 0 || entries.some((e) => e.classification !== "unchanged");
    return {
      relevant_page: rules.length > 0 || input.stored.length > 0,
      page_change: substantive ? "substantive" : "cosmetic",
      entries,
      removed,
      follow_links: input.links.filter((l) => l.text.startsWith("FOLLOW")).map((l) => l.url),
    };
  }

  async discover(platform: Platform, _t: string[], known: string[], _m: number, budget: Budget): Promise<DiscoveredPage[]> {
    await this.spend(budget, `discover_${platform}`);
    if (this.failDiscovery) throw new Error("simulated search outage");
    return (this.discoverResult[platform] ?? []).filter((p) => !known.includes(p.url));
  }

  async fetchViaClaude(url: string, _p: Platform, budget: Budget): Promise<ClaudeFetchResult> {
    await this.spend(budget, "web_fetch");
    return this.claudeFetch.get(url) ?? { ok: false, error: "web_fetch: url_not_accessible" };
  }

  async brief(input: BriefingInput, budget: Budget): Promise<BriefingOutput> {
    await this.spend(budget, "briefing");
    this.briefCalls.push(input);
    const platforms = [...new Set(input.changes.map((c) => c.platform))];
    return {
      summary: `${input.changes.length} change(s) across ${input.sourcesVerified} official sources.`,
      sections: platforms.map((p) => ({
        platform: p,
        items: input.changes
          .filter((c) => c.platform === p)
          .map((c) => ({ ref: c.ref, kind: c.kind, title: c.title, what: c.what_changed ?? c.summary, means: c.relevance ?? "", scope: c.limitations.map((l) => l.text).join(". ") || null })),
      })),
      recommendations: input.changes.map((c) => `Review creative against: ${c.title}.`),
    };
  }

  async answer(input: AnswerInput, budget: Budget): Promise<string> {
    await this.spend(budget, "answer");
    this.answerCalls.push(input);
    return input.knowledge.map((k) => `[${k.ref}] ${k.title} (verified ${k.verified_at.slice(0, 10)})`).join("\n");
  }
}

/** Bag-of-words vectors: similar wording → similar vectors. */
export class FakeEmbedder implements Embedder {
  calls = 0;
  async embed(texts: string[]): Promise<number[][]> {
    this.calls++;
    return texts.map((t) => {
      const v = new Array(1024).fill(0);
      for (const w of t.toLowerCase().match(/[a-z]{3,}/g) ?? []) {
        let h = 0;
        for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) % 1024;
        v[h] += 1;
      }
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / norm);
    });
  }
}

export const META = "https://www.facebook.com/business/help/income-claims";
export const META2 = "https://transparency.meta.com/policies/ad-standards/lead-ads";
export const TIKTOK = "https://ads.tiktok.com/help/article/ad-creative-landing-page";

export async function seedFixtures(db: Db, web: FakeWeb) {
  const add = (url: string, title: string, t: SourceType) => addSource(db, url, { origin: "manual", title, sourceType: t });
  await add(META, "Financial and income claims", "policy");
  await add(META2, "Lead ads", "help_centre");
  await add(TIKTOK, "Ad creative and landing page policy", "policy");
  web.set(META, { status: 200, body: page("Income claims", [["income-claims", "Financial and income claims", "Ads must not make misleading claims about financial outcomes.", "region:All regions"]]) });
  web.set(META2, { status: 200, body: page("Lead ads", [["lead-ads-setup", "Lead ads setup", "Lead forms need a privacy policy link.", "", "setup_steps"]]) });
  web.set(TIKTOK, {
    status: 200,
    body: page("Landing page policy", [["landing-page", "Ad creative and landing page policy", "The landing page must be functional and consistent with the ad.", "region:Language expectations vary by targeted country"]]),
  });
}

export async function runRefresh(db: Db, c: Config, model: FakeModel, web: FakeWeb, trigger: "manual" | "scheduled" | "initial" | "retry" = "manual", opts: { deployed?: boolean; embedder?: Embedder | null } = {}) {
  const q = await enqueue(db, trigger, "test");
  const run = await claimNextRun(db, "w1");
  if (!run) throw new Error(`nothing to claim (enqueue created=${q.created})`);
  const status = await executeRun({ db, cfg: c, model, embedder: opts.embedder ?? null, deployed: opts.deployed ?? false, fetchImpl: web.fetch, sleep: async (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) }, run);
  return { id: run.id, code: run.code, trigger: run.trigger, status };
}
