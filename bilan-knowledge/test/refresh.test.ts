import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/pool.js";
import { addSource, applyAnalysis, getSource } from "../src/knowledge/store.js";
import { contentHash } from "../src/research/fetcher.js";
import { searchKnowledge } from "../src/knowledge/search.js";
import { executeRun } from "../src/refresh/runner.js";
import { claimNextRun, enqueueRun, reapStaleRuns } from "../src/refresh/runs.js";
import { getAutomationStatus, getScheduleState, schedulerTick } from "../src/refresh/schedule.js";
import { cfg, FakeModel, FakeWeb, freshDb, page } from "./helpers.js";

const META = "https://www.facebook.com/business/help/100";
const TIKTOK = "https://ads.tiktok.com/help/article/education-policy";
const DAY = 86400_000;

let db: Db;
let web: FakeWeb;
let model: FakeModel;

beforeEach(async () => {
  db = await freshDb();
  web = new FakeWeb();
  model = new FakeModel();
  await addSource(db, META, { origin: "manual", title: "Meta education ads" });
  await addSource(db, TIKTOK, { origin: "manual", title: "TikTok education policy" });
  web.set(META, { status: 200, body: page("Meta", { "Course claims": "Do not guarantee job outcomes in course ads.", "Lead forms": "Lead forms are available to all advertisers." }) });
  web.set(TIKTOK, { status: 200, body: page("TikTok", { "Education industry": "Education ads must show the provider name (UK only)." }) });
});
afterEach(async () => {
  await db.end();
});

async function runOnce(trigger: "initial" | "scheduled" | "manual", c = cfg()) {
  const e = await enqueueRun(db, trigger, "test");
  expect(e.created).toBe(true);
  const run = await claimNextRun(db, "w1");
  const status = await executeRun({ db, cfg: c, model, fetchImpl: web.fetch, sleep: async () => {} }, run!);
  return { id: run!.id, status };
}

async function items(status: "current" | "archived") {
  const { rows } = await db.query("SELECT id::int, platform, title, guidance, regions, archived_reason, superseded_by::int FROM knowledge_items WHERE status = $1 ORDER BY id", [status]);
  return rows;
}

describe("initial research", () => {
  it("indexes official sources, keeps platforms separate, records regional limits, and saves a briefing", async () => {
    const r = await runOnce("initial");
    expect(r.status).toBe("succeeded");
    const cur = await items("current");
    expect(cur.map((i) => [i.platform, i.title])).toEqual([
      ["meta", "Course claims"],
      ["meta", "Lead forms"],
      ["tiktok", "Education industry"],
    ]);
    expect(cur[2].regions).toEqual(["UK"]);
    const b = await db.query("SELECT complete, body_markdown FROM briefings");
    expect(b.rows[0].complete).toBe(true);
    expect(b.rows[0].body_markdown).toMatch(/Initial research complete/);
    const v = await db.query("SELECT count(*)::int n FROM source_versions");
    expect(v.rows[0].n).toBe(2);
  });
});

describe("refresh", () => {
  it("skips analysis for unchanged pages, archives superseded guidance, preserves history, and writes a briefing", async () => {
    await runOnce("initial");
    model.analyzeCalls = [];
    web.set(META, {
      status: 200,
      body: page("Meta", { "Course claims": "Do not guarantee job outcomes in course ads.", "Lead forms": "Lead forms are in beta for some advertisers." }),
    });
    const r = await runOnce("scheduled");
    expect(r.status).toBe("succeeded");
    expect(model.analyzeCalls.map((c) => c.url)).toEqual([META]); // TikTok unchanged → no paid analysis

    const cur = await items("current");
    const lead = cur.find((i) => i.title === "Lead forms")!;
    expect(lead.guidance).toMatch(/beta/);
    const arch = await items("archived");
    expect(arch).toHaveLength(1);
    expect(arch[0].guidance).toBe("Lead forms are available to all advertisers.");
    expect(arch[0].superseded_by).toBe(lead.id);

    // Archived guidance is never returned as current advice.
    const hits = await searchKnowledge(db, "lead forms available advertisers", { platform: "meta" });
    expect(hits.map((h) => h.guidance)).not.toContain("Lead forms are available to all advertisers.");

    const versions = await db.query("SELECT count(*)::int n FROM source_versions s JOIN sources x ON x.id = s.source_id WHERE x.url = $1", [META]);
    expect(versions.rows[0].n).toBe(2);
    expect(model.briefingCalls).toHaveLength(1);
    expect(model.briefingCalls[0].changes[0]).toMatchObject({ platform: "meta", kind: "changed", title: "Lead forms", sourceUrl: META });
    const checks = await db.query("SELECT outcome FROM source_checks WHERE run_id = $1 ORDER BY outcome", [r.id]);
    expect(checks.rows.map((x) => x.outcome)).toEqual(["changed", "unchanged"]);
  });

  it("flags an inaccessible page as failed, keeps the last verified version, and marks the refresh incomplete", async () => {
    await runOnce("initial");
    const before = await db.query("SELECT last_verified_at FROM sources WHERE url = $1", [META]);
    web.set(META, { status: 200, body: "<html><body>You must log in to continue.</body></html>" });
    const r = await runOnce("scheduled");
    expect(r.status).toBe("incomplete");

    const check = await db.query("SELECT outcome, error FROM source_checks sc JOIN sources s ON s.id = sc.source_id WHERE sc.run_id = $1 AND s.url = $2", [r.id, META]);
    expect(check.rows[0].outcome).toBe("failed");
    expect(check.rows[0].error).toMatch(/login wall/);
    const after = await db.query("SELECT last_verified_at FROM sources WHERE url = $1", [META]);
    expect(after.rows[0].last_verified_at).toEqual(before.rows[0].last_verified_at);
    expect((await items("current")).filter((i) => i.platform === "meta")).toHaveLength(2);

    const run = await db.query("SELECT status, error, sources_failed FROM refresh_runs WHERE id = $1", [r.id]);
    expect(run.rows[0].sources_failed).toBe(1);
    const b = await db.query("SELECT complete, body_markdown FROM briefings WHERE run_id = $1", [r.id]);
    expect(b.rows[0].complete).toBe(false);
    expect(b.rows[0].body_markdown).toMatch(/Incomplete refresh/);
  });

  it("uses Claude web_fetch when a page blocks direct access", async () => {
    await runOnce("initial");
    web.set(TIKTOK, { status: 403 });
    model.claudeFetch.set(TIKTOK, { ok: true, text: "RULE Education industry: Education ads must show the provider name (UK only).", finalUrl: TIKTOK });
    const r = await runOnce("scheduled");
    expect(r.status).toBe("succeeded");
    const c = await db.query("SELECT outcome, fetched_via FROM source_checks sc JOIN sources s ON s.id = sc.source_id WHERE run_id = $1 AND s.url = $2", [r.id, TIKTOK]);
    expect(c.rows[0]).toMatchObject({ fetched_via: "claude_web_fetch" });
  });

  it("archives guidance only after a page is confirmed discontinued", async () => {
    await runOnce("initial");
    web.set(TIKTOK, { status: 404 });
    const first = await runOnce("scheduled");
    expect(first.status).toBe("incomplete"); // unconfirmed miss is not a success
    expect((await items("current")).some((i) => i.platform === "tiktok")).toBe(true);

    const second = await runOnce("scheduled");
    expect(second.status).toBe("succeeded");
    expect((await items("current")).some((i) => i.platform === "tiktok")).toBe(false);
    const arch = await items("archived");
    expect(arch[0].archived_reason).toMatch(/discontinued/);
    const ch = await db.query("SELECT kind FROM knowledge_changes WHERE run_id = $1", [second.id]);
    expect(ch.rows[0].kind).toBe("discontinued");
  });

  it("adds newly discovered official pages but ignores unofficial or cross-platform ones", async () => {
    const NEW = "https://ads.tiktok.com/help/article/smart-plus";
    model.discoverResult.tiktok = [
      { url: NEW, title: "Smart+", category: "help" },
      { url: "https://example.com/tiktok-tips", title: "blog", category: "other" },
      { url: "https://www.facebook.com/business/help/999", title: "wrong platform", category: "help" },
    ];
    web.set(NEW, { status: 200, body: page("Smart+", { "Smart+ campaigns": "Smart+ is rolling out gradually." }) });
    const r = await runOnce("initial");
    expect(r.status).toBe("succeeded");
    const s = await db.query("SELECT platform, url, origin FROM sources ORDER BY id");
    expect(s.rows.map((x) => x.url)).toContain(NEW);
    expect(s.rows.map((x) => x.url)).not.toContain("https://example.com/tiktok-tips");
    expect(s.rows.filter((x) => x.platform === "meta").map((x) => x.url)).not.toContain("https://www.facebook.com/business/help/999");
  });

  it("does not duplicate guidance when a live check and a refresh store the same new content", async () => {
    await runOnce("initial");
    const source = (await getSource(db, 1))!;
    const text = "RULE Course claims: Course ads may not promise salaries.";
    const analysis = {
      relevant: true, material_change: true, page_summary: "1 rule", discontinued: [], follow_links: [],
      items: [{ previous_item_id: 1, change: "changed" as const, topic: "t", title: "Course claims", guidance: "Course ads may not promise salaries.", regions: [], account_scope: null, rollout_status: null, limitations: null, effective_date: null }],
      changes: [{ kind: "changed" as const, title: "Course claims", summary: "stricter", relevance: "high" as const, relevance_note: "our ads" }],
    };
    const args = { runId: 1, source, text, hash: contentHash(text), finalUrl: source.url, via: "direct" as const, title: null, analysis, recordChanges: true };
    // Both writers analyzed the same stale snapshot of the source.
    const [a, b] = await Promise.all([applyAnalysis(db, args), applyAnalysis(db, args)]);
    expect([a.itemsAdded, b.itemsAdded].sort()).toEqual([0, 1]);
    const n = await db.query("SELECT count(*)::int n FROM knowledge_items WHERE source_id = 1 AND status = 'current' AND title = 'Course claims'");
    expect(n.rows[0].n).toBe(1);
  });

  it("stops at the spending limit and reports the refresh as incomplete", async () => {
    model.costPerCall = 0.01;
    // discovery (2 calls) + 1 analysis fits in $0.035; the next analysis does not.
    const r = await runOnce("initial", cfg({ MAX_USD_PER_REFRESH: "0.035" }));
    expect(r.status).toBe("incomplete");
    const run = await db.query("SELECT error, spend_usd::float FROM refresh_runs WHERE id = $1", [r.id]);
    expect(run.rows[0].error).toMatch(/limit/i);
    expect(run.rows[0].spend_usd).toBeLessThanOrEqual(0.035);
  });

  it("marks the run failed (never succeeded) when research breaks", async () => {
    model.failAnalyzeFor.add(META);
    model.failAnalyzeFor.add(TIKTOK);
    const r = await runOnce("initial");
    expect(r.status).toBe("failed");
    expect(await items("current")).toHaveLength(0);
  });
});

describe("scheduling", () => {
  it("prevents duplicate refresh jobs", async () => {
    const results = await Promise.all([1, 2, 3, 4].map(() => enqueueRun(db, "manual", "t")));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.run.id)).size).toBe(1);
  });

  it("runs the initial research, then waits 42 days from the last success, and only then claims automation is active", async () => {
    const c = cfg();
    const deps = { db, cfg: c, model, workerId: "w", fetchImpl: web.fetch, sleep: async () => {} };
    const t0 = new Date();
    expect((await getAutomationStatus(db, c, t0)).active).toBe(false);

    const first = await schedulerTick(deps, t0);
    expect(first).toMatchObject({ enqueued: true });
    const s1 = await getScheduleState(db, c);
    expect(s1.lastSuccessAt).not.toBeNull();
    const due = s1.nextScheduledAt!.getTime() - s1.lastSuccessAt!.getTime();
    expect(Math.round(due / DAY)).toBe(42);

    const status = await getAutomationStatus(db, c, new Date());
    expect(status).toMatchObject({ active: true, reasons: [] });

    expect(await schedulerTick(deps, new Date(Date.now() + 41 * DAY))).toEqual({ enqueued: false, executed: null });
    const later = await schedulerTick(deps, new Date(Date.now() + 43 * DAY));
    expect(later.enqueued).toBe(true);
    const run = await db.query("SELECT trigger, status FROM refresh_runs WHERE id = $1", [later.executed]);
    expect(run.rows[0]).toEqual({ trigger: "scheduled", status: "succeeded" });
  });

  it("retries failed refreshes with bounded backoff and then stops", async () => {
    const c = cfg({ REFRESH_RETRY_DELAYS_HOURS: "1,6" });
    web.set(META, { status: 500 });
    const deps = { db, cfg: c, model, workerId: "w", fetchImpl: web.fetch, sleep: async () => {} };
    const t = Date.now();
    await schedulerTick(deps, new Date(t));
    let s = await getScheduleState(db, c, new Date(t));
    expect(s.failuresSinceSuccess).toBe(1);
    expect(s.nextAttemptAt!.getTime()).toBeGreaterThan(t + 3500_000);

    await schedulerTick(deps, new Date(t + 2 * 3600_000));
    await schedulerTick(deps, new Date(t + 30 * 3600_000));
    s = await getScheduleState(db, c, new Date(t + 30 * 3600_000));
    expect(s.failuresSinceSuccess).toBe(3);
    expect(s.retriesExhausted).toBe(true);
    expect(s.nextAttemptAt).toBeNull();
    expect((await schedulerTick(deps, new Date(t + 100 * 3600_000))).enqueued).toBe(false);
  });

  it("does not let early manual failures use up the scheduled refresh's retries", async () => {
    const c = cfg({ REFRESH_RETRY_DELAYS_HOURS: "1" });
    await runOnce("initial", c);
    web.set(META, { status: 500 });
    await runOnce("manual", c);
    await runOnce("manual", c);
    const s = await getScheduleState(db, c);
    expect(s.failuresSinceSuccess).toBe(0);
    expect(s.retriesExhausted).toBe(false);
    expect(s.nextTrigger).toBe("scheduled");
    expect(s.nextAttemptAt).toEqual(s.nextScheduledAt);
  });

  it("recovers from a crashed worker", async () => {
    await enqueueRun(db, "manual", "t");
    const run = await claimNextRun(db, "dead-worker");
    await db.query("UPDATE refresh_runs SET heartbeat_at = now() - interval '1 hour' WHERE id = $1", [run!.id]);
    expect(await reapStaleRuns(db, 20)).toEqual([run!.id]);
    expect((await enqueueRun(db, "manual", "t")).created).toBe(true);
  });
});
