import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/pool.js";
import { buildServer } from "../src/http/server.js";
import { cfg, FakeModel, FakeWeb, freshDb, META, page, runRefresh, seedFixtures } from "./helpers.js";

let db: Db;
let web: FakeWeb;
let model: FakeModel;
const auth = { authorization: "Bearer test-admin-token-0123456789" };

beforeEach(async () => {
  db = await freshDb();
  web = new FakeWeb();
  model = new FakeModel();
  await seedFixtures(db, web);
  await runRefresh(db, cfg(), model, web);
  web.set(META, { status: 200, body: page("Income", [["income-claims", "Financial and income claims", "Ads must not promise guaranteed income."]]) });
  await runRefresh(db, cfg(), model, web);
});
afterEach(async () => {
  await db.end();
});

describe("HTTP API", () => {
  it("requires the access token", async () => {
    const app = await buildServer({ db, cfg: cfg(), model, embedder: null });
    expect((await app.inject({ url: "/api/status" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/status", headers: { authorization: "Bearer nope" } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/healthz" })).statusCode).toBe(200);
    await app.close();
  });

  it("serves status, history, briefings, entries and settings for the UI", async () => {
    let woke = 0;
    const app = await buildServer({ db, cfg: cfg(), model, embedder: null, wakeWorker: () => woke++ });
    const get = async (url: string) => (await app.inject({ url, headers: auth })).json();

    const status = await get("/api/status");
    expect(status.lastSuccess.code).toBe("R-002");
    expect(status.updateLabel).toBe("Update now");

    const first = await app.inject({ method: "POST", url: "/api/refresh", headers: auth });
    expect(first.statusCode).toBe(202);
    const dup = await app.inject({ method: "POST", url: "/api/refresh", headers: auth });
    expect(dup.json()).toMatchObject({ created: false, message: "A refresh is already running. Duplicate request ignored." });
    expect(woke).toBe(1);

    const run = await get("/api/runs/R-002");
    expect(run.changes[0]).toMatchObject({ kind: "changed", title: "Financial and income claims", version: "v2", hasDiff: true });
    const briefing = await get(`/api/briefings/${run.briefingId}`);
    expect(briefing.sections[0].items[0].entry_id).toBe(run.changes[0].entry_id);
    const rec = briefing.recommendations[0];
    expect((await app.inject({ method: "PATCH", url: `/api/recommendations/${rec.id}`, headers: auth, payload: { status: "added_to_plan" } })).statusCode).toBe(200);

    const entries = await get("/api/entries?platform=meta&status=current");
    expect(entries.counts).toEqual({ current: 2, archived: 0 });
    const tiktok = await get("/api/entries?platform=tiktok&status=current");
    expect(tiktok.items.map((i: { title: string }) => i.title)).toEqual(["Ad creative and landing page policy"]);
    const entry = await get(`/api/entries/${run.changes[0].entry_id}`);
    expect(entry.versions.map((v: { version: number; status: string }) => [v.version, v.status])).toEqual([[2, "current"], [1, "archived"]]);
    expect(entry.latestChange.run_code).toBe("R-002");

    const logs = await get("/api/runs/R-002/logs");
    expect(logs.lines.at(-1).message).toMatch(/^Refresh complete · 3\/3 verified/);

    const bad = await app.inject({ method: "PUT", url: "/api/settings", headers: auth, payload: { run_window_utc: "25:00" } });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: "PUT", url: "/api/settings", headers: auth, payload: { run_window_utc: "04:30", budget_refresh_usd: 6, alert_email: "sabah@example.com" } });
    expect(ok.json().settings).toMatchObject({ run_window_utc: "04:30", budget_refresh_usd: 6, alert_email: "sabah@example.com", interval_days: 42 });

    const src = await app.inject({ method: "POST", url: "/api/sources", headers: auth, payload: { url: "https://example.com/meta" } });
    expect(src.statusCode).toBe(400);
    await app.close();
  });
});
