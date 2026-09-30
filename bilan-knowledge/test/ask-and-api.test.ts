import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/pool.js";
import { buildServer } from "../src/http/server.js";
import { ask } from "../src/knowledge/ask.js";
import { addSource } from "../src/knowledge/store.js";
import { executeRun } from "../src/refresh/runner.js";
import { claimNextRun, enqueueRun } from "../src/refresh/runs.js";
import { cfg, FakeModel, FakeWeb, freshDb, page } from "./helpers.js";

const META = "https://www.facebook.com/business/help/200";
const TIKTOK = "https://ads.tiktok.com/help/article/lead-gen";
let db: Db;
let web: FakeWeb;
let model: FakeModel;

beforeEach(async () => {
  db = await freshDb();
  web = new FakeWeb();
  model = new FakeModel();
  await addSource(db, META, { origin: "manual" });
  await addSource(db, TIKTOK, { origin: "manual" });
  web.set(META, { status: 200, body: page("Meta", { "Lead ads": "Lead ads require a privacy policy link." }) });
  web.set(TIKTOK, { status: 200, body: page("TikTok", { "Lead generation": "Instant forms require a privacy policy link." }) });
  await enqueueRun(db, "initial", "t");
  await executeRun({ db, cfg: cfg(), model, fetchImpl: web.fetch, sleep: async () => {} }, (await claimNextRun(db, "w"))!);
});
afterEach(async () => {
  await db.end();
});

describe("ask", () => {
  it("retrieves saved knowledge for the right platform before answering", async () => {
    const r = await ask({ db, cfg: cfg({ LIVE_CHECK_MAX_SOURCES: "0" }), model }, "What do TikTok instant forms need?", null, "t");
    expect(r.platform).toBe("tiktok");
    expect(r.knowledge.map((k) => k.platform)).toEqual(["tiktok"]);
    expect(model.answerCalls[0].knowledge[0].source_url).toBe(TIKTOK);
    expect(r.answer).toContain("K1");
  });

  it("re-checks official sources live for changeable guidance and saves verified changes", async () => {
    web.set(META, { status: 200, body: page("Meta", { "Lead ads": "Lead ads require a privacy policy link and a custom disclaimer." }) });
    const c = cfg({ LIVE_CHECK_FRESH_HOURS: "0" });
    const r = await ask({ db, cfg: c, model, fetchImpl: web.fetch, sleep: async () => {} }, "What is the policy for Facebook lead ads?", null, "t");
    expect(r.liveChecks).toEqual([{ url: META, outcome: "changed", error: undefined }]);
    expect(r.knowledge[0].guidance).toMatch(/custom disclaimer/);
    const run = await db.query("SELECT trigger, status, sources_changed FROM refresh_runs WHERE id = $1", [r.liveCheckRunId]);
    expect(run.rows[0]).toEqual({ trigger: "live_check", status: "succeeded", sources_changed: 1 });
    const change = await db.query("SELECT kind FROM knowledge_changes WHERE run_id = $1", [r.liveCheckRunId]);
    expect(change.rows[0].kind).toBe("changed");
  });

  it("tells the model when a live check could not reach the source", async () => {
    web.set(META, { status: 503 });
    const r = await ask({ db, cfg: cfg({ LIVE_CHECK_FRESH_HOURS: "0" }), model, fetchImpl: web.fetch, sleep: async () => {} }, "Facebook lead ads policy requirements?", null, "t");
    expect(r.liveChecks[0].outcome).toBe("failed");
    expect(model.answerCalls.at(-1)!.liveCheckNotes[0]).toMatch(/could NOT be re-checked/);
    expect(r.knowledge[0].guidance).toBe("Lead ads require a privacy policy link.");
  });
});

describe("HTTP API", () => {
  it("requires the admin token and exposes monitoring + Update now", async () => {
    let woke = 0;
    const app = await buildServer({ db, cfg: cfg(), model, wakeScheduler: () => woke++ });
    const auth = { authorization: "Bearer test-admin-token-0123456789" };
    expect((await app.inject({ method: "GET", url: "/api/status" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/status", headers: { authorization: "Bearer wrong" } })).statusCode).toBe(401);

    const status = (await app.inject({ method: "GET", url: "/api/status", headers: auth })).json();
    expect(status.schedule.lastSuccessAt).not.toBeNull();
    expect(status.schedule.nextScheduledAt).not.toBeNull();
    expect(status.automation.active).toBe(false); // manual/test runs don't prove the deployed scheduler works

    const first = await app.inject({ method: "POST", url: "/api/refresh", headers: auth });
    expect(first.statusCode).toBe(202);
    const dup = await app.inject({ method: "POST", url: "/api/refresh", headers: auth });
    expect(dup.statusCode).toBe(200);
    expect(dup.json().created).toBe(false);
    expect(woke).toBe(2);

    const runs = (await app.inject({ method: "GET", url: "/api/runs", headers: auth })).json().runs;
    expect(runs[0].status).toBe("queued");
    const detail = (await app.inject({ method: "GET", url: `/api/runs/${runs[1].id}`, headers: auth })).json();
    expect(detail.checks).toHaveLength(2);
    expect(detail.logs.length).toBeGreaterThan(0);
    expect(detail.briefing.body_markdown).toMatch(/Initial research/);

    const search = (await app.inject({ method: "GET", url: "/api/knowledge/search?q=privacy%20policy&platform=meta", headers: auth })).json();
    expect(search.results).toHaveLength(1);

    const bad = await app.inject({ method: "POST", url: "/api/sources", headers: auth, payload: { url: "https://example.com/x" } });
    expect(bad.statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    await app.close();
  });
});
