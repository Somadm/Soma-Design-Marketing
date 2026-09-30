/**
 * The design handoff's §9 acceptance tests, run against real Postgres with a fake
 * web and a fake research model. (On the deployed backend they must be repeated
 * against the real services; see README "Before calling updates active".)
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/pool.js";
import { ask } from "../src/kb/ask.js";
import { enqueue, tick } from "../src/refresh/runs.js";
import { getStatusView } from "../src/refresh/status.js";
import { workerCycle } from "../src/refresh/worker.js";
import { cfg, FakeModel, FakeWeb, freshDb, META, page, runRefresh, seedFixtures, TIKTOK } from "./helpers.js";

let db: Db;
let web: FakeWeb;
let model: FakeModel;

beforeEach(async () => {
  db = await freshDb();
  web = new FakeWeb();
  model = new FakeModel();
  await seedFixtures(db, web);
});
afterEach(async () => {
  await db.end();
});

const currentEntries = async () =>
  (await db.query("SELECT e.platform, e.slug, ev.version, ev.body, ev.limitations FROM entries e JOIN entry_versions ev ON ev.entry_id = e.id AND ev.status = 'current' ORDER BY e.platform, e.slug")).rows;

/** Puts "now" inside the run window. */
const openWindow = () => db.query("UPDATE settings SET run_window_utc = ((now() AT TIME ZONE 'UTC')::time - interval '30 minutes')");

describe("§9 acceptance", () => {
  it("1. initial research completes with separate Meta and TikTok entries", async () => {
    const r = await runRefresh(db, cfg(), model, web, "manual");
    expect(r.trigger).toBe("initial"); // "Run initial research" until a complete run exists
    expect(r.code).toBe("R-001");
    expect(r.status).toBe("complete");
    const entries = await currentEntries();
    expect(entries.map((e) => [e.platform, e.slug])).toEqual([
      ["meta", "income-claims"],
      ["meta", "lead-ads-setup"],
      ["tiktok", "landing-page"],
    ]);
    const b = await db.query("SELECT partial, summary FROM briefings");
    expect(b.rows[0].partial).toBe(false);
    expect(b.rows[0].summary).toMatch(/Initial index of 3 official sources: 2 Meta and 1 TikTok/);
    expect((await db.query("SELECT count(*)::int n FROM changes")).rows[0].n).toBe(0); // baseline, not changes
    const ss = (await db.query("SELECT last_success_at FROM system_status")).rows[0];
    expect(ss.last_success_at).not.toBeNull();
  });

  it("2. a scheduled run completes on the deployed backend and only then shows 'Automatic updates active'", async () => {
    await runRefresh(db, cfg(), model, web, "manual", { deployed: true });
    let status = await getStatusView(db, cfg(), true);
    expect(status.headline.title).toBe("Automatic updates not active"); // even after a successful manual run

    // Not due yet: nothing happens.
    await openWindow();
    expect(await tick(db)).toBe("nothing due");

    // Set last success back 42 days; "close the app" (no UI) and let the worker tick.
    await db.query("UPDATE system_status SET last_success_at = now() - interval '42 days 1 hour'");
    const deps = { db, cfg: cfg(), model, embedder: null, workerId: "prod-1", deployed: true, fetchImpl: web.fetch };
    const cycle = await workerCycle(deps, { runTick: true });
    expect(cycle.tick).toMatch(/^queued scheduled refresh R-002/);
    expect(cycle.executed).toBe("R-002");
    const run = (await db.query("SELECT trigger, status FROM refresh_runs WHERE code = 'R-002'")).rows[0];
    expect(run).toEqual({ trigger: "scheduled", status: "complete" });
    expect((await db.query("SELECT schedule_verified_at FROM system_status")).rows[0].schedule_verified_at).not.toBeNull();

    status = await getStatusView(db, cfg(), true);
    expect(status.headline).toMatchObject({ tone: "ok", title: "Automatic updates active" });
    expect(status.next.sub).toBe("In 42 days");
  });

  it("2b. a scheduled run on a non-production worker does not verify the schedule", async () => {
    await runRefresh(db, cfg(), model, web, "manual");
    await openWindow();
    await db.query("UPDATE system_status SET last_success_at = now() - interval '43 days'");
    await workerCycle({ db, cfg: cfg(), model, embedder: null, workerId: "dev", deployed: false, fetchImpl: web.fetch }, { runTick: true });
    expect((await db.query("SELECT schedule_verified_at FROM system_status")).rows[0].schedule_verified_at).toBeNull();
    expect((await getStatusView(db, cfg(), true)).headline.title).toBe("Automatic updates not active");
  });

  it("3. a 403 makes the run incomplete, promotes nothing, flags red, marks entries unverified and sends an alert", async () => {
    await runRefresh(db, cfg(), model, web, "manual", { deployed: true });
    await db.query("UPDATE settings SET alert_email = 'sabah@example.com'");
    web.set(META, { status: 403 });
    // Another source really changed in the same run: it must NOT be promoted.
    web.set(TIKTOK, { status: 200, body: page("Landing page policy", [["landing-page", "Ad creative and landing page policy", "The landing page must be functional, consistent with the offer, and in a language suited to the audience."]]) });
    const before = await currentEntries();
    const r = await runRefresh(db, cfg(), model, web, "manual", { deployed: true });
    expect(r.status).toBe("incomplete");
    expect(await currentEntries()).toEqual(before);

    const rs = (await db.query("SELECT result, attempts, failure_reason FROM run_sources WHERE run_id = $1 AND source_id = 1", [r.id])).rows[0];
    expect(rs).toMatchObject({ result: "failed", attempts: 3 });
    expect(rs.failure_reason).toMatch(/HTTP 403, access blocked.*after 3 attempts/);
    const b = (await db.query("SELECT partial, summary, body FROM briefings WHERE run_id = $1", [r.id])).rows[0];
    expect(b.partial).toBe(true);
    expect(b.body.pending.map((p: { title: string }) => p.title)).toContain("Ad creative and landing page policy");
    expect(b.body.unverified[0].title).toBe("Financial and income claims");

    const status = await getStatusView(db, cfg(), true);
    expect(status.headline).toMatchObject({ tone: "fail", title: "Last refresh incomplete" });
    expect(status.headline.detail).toMatch(/1 of 3 sources could not be verified in R-002\. Bilan is using the last verified versions from/);
    expect((await db.query("SELECT failure_path_verified_at FROM system_status")).rows[0].failure_path_verified_at).not.toBeNull();

    await workerCycle({ db, cfg: cfg({ RESEND_API_KEY: "re_test" }), model, embedder: null, workerId: "w", deployed: true, fetchImpl: web.fetch }, { runTick: false });
    expect(web.resend).toHaveLength(1);
    expect(web.resend[0].to).toEqual(["sabah@example.com"]);
    expect(web.resend[0].subject).toMatch(/R-002 incomplete/);
  });

  it("4. Update now twice quickly and during a tick → exactly one active run", async () => {
    await runRefresh(db, cfg(), model, web, "manual");
    await openWindow();
    await db.query("UPDATE system_status SET last_success_at = now() - interval '50 days'");
    const results = await Promise.all([enqueue(db, "manual", "a"), enqueue(db, "manual", "b"), tick(db), enqueue(db, "manual", "c")]);
    const active = await db.query("SELECT code FROM refresh_runs WHERE status IN ('queued','running')");
    expect(active.rowCount).toBe(1);
    const created = results.filter((x) => typeof x !== "string" && x.created);
    expect(created.length + (typeof results[2] === "string" && results[2].startsWith("queued") ? 1 : 0)).toBe(1);
  });

  it("5. a changed page creates a new version, archives the old one, shows a diff and is briefed with limitations", async () => {
    await runRefresh(db, cfg(), model, web, "manual");
    web.set(META, {
      status: 200,
      body: page("Income claims", [["income-claims", "Financial and income claims", "Ads must not promise or imply guaranteed income, including income from learning a skill or completing a course.", "region:All regions; other:Checked at ad review and after publishing"]]),
    });
    const r = await runRefresh(db, cfg(), model, web, "manual");
    expect(r.status).toBe("complete");
    const versions = (await db.query("SELECT version, status, archived_reason FROM entry_versions ev JOIN entries e ON e.id = ev.entry_id WHERE e.slug = 'income-claims' ORDER BY version")).rows;
    expect(versions).toEqual([
      { version: 1, status: "archived", archived_reason: "Superseded by v2 in R-002" },
      { version: 2, status: "current", archived_reason: null },
    ]);
    const change = (await db.query("SELECT c.kind, fv.body AS old, tv.body AS new FROM changes c JOIN entry_versions fv ON fv.id = c.from_version_id JOIN entry_versions tv ON tv.id = c.to_version_id WHERE c.run_id = $1", [r.id])).rows[0];
    expect(change.kind).toBe("changed");
    expect(change.old).toMatch(/misleading claims/);
    expect(change.new).toMatch(/guaranteed income/);
    const brief = (await db.query("SELECT body FROM briefings WHERE run_id = $1", [r.id])).rows[0].body;
    const item = brief.sections[0].items[0];
    expect(item).toMatchObject({ kind: "Changed", title: "Financial and income claims", scope: "All regions. Checked at ad review and after publishing" });
    expect(item.entry_id).toBeGreaterThan(0);
    expect((await db.query("SELECT count(*)::int n FROM recommendations WHERE status = 'proposed'")).rows[0].n).toBe(1);
    // Unchanged pages were hash-matched and never sent to the model.
    expect(model.extractCalls.filter((c) => c.url !== META).length).toBe(2); // only from the initial run
  });

  it("6. a $0.10 budget stops the run as incomplete (budget_limit) with spend ≤ cap", async () => {
    await runRefresh(db, cfg(), model, web, "manual");
    for (const u of [META, TIKTOK]) web.set(u, { status: 200, body: page("x", [["changed-" + u.length, "Changed", "Totally new guidance text for this page, long enough."]]) });
    await db.query("UPDATE settings SET budget_refresh_usd = 0.10");
    model.costPerCall = 0.04;
    const r = await runRefresh(db, cfg(), model, web, "manual");
    expect(r.status).toBe("incomplete");
    const run = (await db.query("SELECT incomplete_reason, spend_usd, budget_usd FROM refresh_runs WHERE id = $1", [r.id])).rows[0];
    expect(run.incomplete_reason).toBe("budget_limit");
    expect(run.spend_usd).toBeLessThanOrEqual(0.1);
    const ledger = (await db.query("SELECT sum(usd)::float s FROM budget_ledger WHERE run_id = $1", [r.id])).rows[0].s;
    expect(ledger).toBeLessThanOrEqual(0.1 + 1e-9);
  });

  it("7. a policy question whose source changed triggers a live check that saves an LC- version, and the answer cites the new date", async () => {
    await runRefresh(db, cfg(), model, web, "manual");
    await db.query("UPDATE entry_versions SET verified_at = now() - interval '20 days'");
    web.set(META, { status: 200, body: page("Income claims", [["income-claims", "Financial and income claims", "Ads must not promise guaranteed income from completing a course.", "region:All regions"]]) });
    const res = await ask({ db, cfg: cfg(), model, embedder: null, fetchImpl: web.fetch }, "Can Facebook ads mention how much students earn after the course? income claims", null, "chat");
    expect(res.platform).toBe("meta");
    expect(res.liveChecks[0]).toMatchObject({ runCode: "LC-001", outcome: "changed", label: "Saved 1 change" });
    const v = (await db.query("SELECT ev.version, ev.origin, r.code FROM entry_versions ev JOIN refresh_runs r ON r.id = ev.run_id WHERE ev.status = 'current' AND ev.entry_id = (SELECT id FROM entries WHERE slug = 'income-claims')")).rows[0];
    expect(v).toEqual({ version: 2, origin: "live_check", code: "LC-001" });
    const today = new Date().toISOString().slice(0, 10);
    expect(res.answer).toContain(`Financial and income claims (verified ${today})`);
    expect(res.knowledge[0].body).toMatch(/guaranteed income/);
  });

  it("8. the service holds no ad-account credentials and has no ad write endpoints", () => {
    const files: string[] = [];
    const walk = (d: string) => readdirSync(d).forEach((f) => (statSync(path.join(d, f)).isDirectory() ? walk(path.join(d, f)) : files.push(path.join(d, f))));
    walk(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src"));
    const src = files.map((f) => readFileSync(f, "utf8")).join("\n");
    expect(src).not.toMatch(/graph\.facebook\.com/);
    expect(src).not.toMatch(/open_api\/v\d/); // TikTok API for Business endpoints
    expect(src).not.toMatch(/META_ACCESS_TOKEN|TIKTOK_ACCESS_TOKEN|ads_management/i);
  });
});
