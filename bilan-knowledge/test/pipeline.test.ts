import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/pool.js";
import { verifyLive } from "../src/kb/liveCheck.js";
import { searchKb } from "../src/kb/search.js";
import { addSource } from "../src/kb/store.js";
import { claimNextRun, enqueue, tick } from "../src/refresh/runs.js";
import { cfg, cronJobScheduled, FakeEmbedder, FakeModel, FakeWeb, freshDb, META, META2, page, runRefresh, seedFixtures, TIKTOK } from "./helpers.js";

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

const openWindow = () => db.query("UPDATE settings SET run_window_utc = ((now() AT TIME ZONE 'UTC')::time - interval '30 minutes')");
const q = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows;

describe("refresh pipeline", () => {
  it("retries temporary failures with backoff and notes 'Succeeded on retry 2'", async () => {
    web.set(TIKTOK, [{ status: 503 }, { status: 200, body: page("x", [["landing-page", "Landing page", "Landing pages must work."]]) }]);
    const r = await runRefresh(db, cfg(), model, web);
    expect(r.status).toBe("complete");
    const rs = (await q("SELECT result, attempts, note FROM run_sources WHERE run_id = $1 AND source_id = 3", [r.id]))[0];
    expect(rs).toEqual({ result: "new", attempts: 2, note: "Succeeded on retry 2" });
    const logs = await q("SELECT level, message FROM run_logs WHERE run_id = $1 AND stage = 'fetch' ORDER BY id", [r.id]);
    expect(logs.some((l) => l.level === "WARN" && /HTTP 503 \(attempt 1\/3\) · retrying/.test(l.message))).toBe(true);
  });

  it("archives a discontinued page's entries and indexes the redirect target in the same run", async () => {
    await runRefresh(db, cfg(), model, web);
    const target = "https://transparency.meta.com/policies/ad-standards/lead-ads-setup";
    web.set(META2, { status: 301, location: target });
    web.set(target, { status: 200, body: page("Lead ads setup", [["lead-ads-v2", "Lead ads setup", "Covers form creation, privacy policy link and CRM connection.", "other:Privacy policy URL required"]]) });
    const r = await runRefresh(db, cfg(), model, web);
    expect(r.status).toBe("complete");
    const src = await q("SELECT url, status, replaced_by, origin FROM sources ORDER BY id");
    expect(src.find((s) => s.url === META2)).toMatchObject({ status: "discontinued", replaced_by: 4 });
    expect(src.find((s) => s.url === target)).toMatchObject({ status: "active", origin: "redirect" });
    const arch = await q("SELECT ev.status, ev.archived_reason FROM entry_versions ev JOIN entries e ON e.id = ev.entry_id WHERE e.slug = 'lead-ads-setup'");
    expect(arch[0].status).toBe("archived");
    expect(arch[0].archived_reason).toMatch(/Source discontinued in R-002; redirects to/);
    expect((await q("SELECT count(*)::int n FROM entry_versions ev JOIN entries e ON e.id = ev.entry_id WHERE e.slug = 'lead-ads-v2' AND ev.status = 'current'"))[0].n).toBe(1);
    const results = await q("SELECT s.url, rs.result FROM run_sources rs JOIN sources s ON s.id = rs.source_id WHERE rs.run_id = $1", [r.id]);
    expect(results.find((x) => x.url === target)?.result).toBe("new");
  });

  it("treats wording-only changes as cosmetic: new source version, no new entry versions", async () => {
    await runRefresh(db, cfg(), model, web);
    web.set(TIKTOK, {
      status: 200,
      body: page("Landing page policy (updated layout)", [["landing-page", "Ad creative and landing page policy", "The landing page must be functional and consistent with the ad.", "region:Language expectations vary by targeted country"]]),
    });
    const r = await runRefresh(db, cfg(), model, web);
    expect(r.status).toBe("complete");
    expect((await q("SELECT result, note FROM run_sources WHERE run_id = $1 AND source_id = 3", [r.id]))[0]).toEqual({ result: "cosmetic", note: "Wording changes only" });
    expect((await q("SELECT count(*)::int n FROM source_versions WHERE source_id = 3"))[0].n).toBe(2);
    expect((await q("SELECT count(*)::int n FROM entry_versions ev JOIN entries e ON e.id = ev.entry_id WHERE e.source_id = 3"))[0].n).toBe(1);
    expect((await q("SELECT summary FROM briefings WHERE run_id = $1", [r.id]))[0].summary).toMatch(/No changes found/);
  });

  it("adds discovered official pages and ignores third-party or cross-platform ones", async () => {
    const NEW = "https://ads.tiktok.com/help/article/smart-plus";
    model.discoverResult.tiktok = [
      { url: NEW, title: "Smart+ campaigns", source_type: "help_centre" },
      { url: "https://example.com/tiktok-tips", title: "blog", source_type: "help_centre" },
      { url: "https://www.facebook.com/business/help/999", title: "wrong platform", source_type: "help_centre" },
    ];
    web.set(NEW, { status: 200, body: page("Smart+", [["smart-plus", "Smart+ campaigns", "Automated campaign type.", "rollout:Not available in all markets; account:Eligibility is account-specific", "feature_availability"]]) });
    const r = await runRefresh(db, cfg(), model, web);
    expect(r.status).toBe("complete");
    const urls = (await q("SELECT url FROM sources")).map((s) => s.url);
    expect(urls).toContain(NEW);
    expect(urls).not.toContain("https://example.com/tiktok-tips");
    const lim = (await q("SELECT ev.limitations FROM entry_versions ev JOIN entries e ON e.id = ev.entry_id WHERE e.slug = 'smart-plus'"))[0].limitations;
    expect(lim).toEqual([
      { kind: "rollout", text: "Not available in all markets" },
      { kind: "account", text: "Eligibility is account-specific" },
    ]);
  });

  it("marks the run incomplete when discovery fails", async () => {
    model.failDiscovery = true;
    const r = await runRefresh(db, cfg(), model, web);
    expect(r.status).toBe("incomplete");
    expect((await q("SELECT incomplete_reason FROM refresh_runs WHERE id = $1", [r.id]))[0].incomplete_reason).toBe("discovery_failed");
    expect((await q("SELECT count(*)::int n FROM entry_versions"))[0].n).toBe(0);
  });

  it("with on_limit='finish', finishes the current source, then stops", async () => {
    await runRefresh(db, cfg(), model, web);
    for (const u of [META, TIKTOK]) web.set(u, { status: 200, body: page("x", [["n" + u.length, "Changed", "Totally new guidance text, long enough."]]) });
    await db.query("UPDATE settings SET budget_refresh_usd = 0.05, on_limit = 'finish'");
    model.costPerCall = 0.02;
    const r = await runRefresh(db, cfg(), model, web);
    expect(r.status).toBe("incomplete");
    const res = await q("SELECT source_id, result FROM run_sources WHERE run_id = $1 ORDER BY source_id", [r.id]);
    // Sources already in progress finished past the cap (not refused mid-source), then the run stopped.
    expect(res.filter((x) => x.result === "changed").length).toBeGreaterThanOrEqual(1);
    expect(res.some((x) => x.result === "failed")).toBe(false);
    const run = (await q("SELECT incomplete_reason, spend_usd FROM refresh_runs WHERE id = $1", [r.id]))[0];
    expect(run.incomplete_reason).toBe("budget_limit");
    expect(run.spend_usd).toBeLessThanOrEqual(0.05 + 3 * 0.02); // cap + at most one call per in-flight source
    expect((await q("SELECT count(*)::int n FROM changes WHERE run_id = $1", [r.id]))[0].n).toBe(0); // nothing promoted
  });

  it("escalates a source that fails in 3 consecutive runs", async () => {
    await runRefresh(db, cfg(), model, web);
    web.set(META, { status: 500 });
    for (let i = 0; i < 3; i++) await runRefresh(db, cfg(), model, web);
    const s = (await q("SELECT consecutive_failures, escalated_at FROM sources WHERE url = $1", [META]))[0];
    expect(s.consecutive_failures).toBe(3);
    expect(s.escalated_at).not.toBeNull();
    // Paused sources are excluded from completeness.
    await db.query("UPDATE sources SET status = 'paused' WHERE url = $1", [META]);
    expect((await runRefresh(db, cfg(), model, web)).status).toBe("complete");
    const hits = await searchKb(db, "financial income claims", { platform: "meta" });
    expect(hits[0].stale).toBe(true); // shown as stale
  });
});

describe("kb_tick scheduling", () => {
  it("pg_cron schedules kb_tick every 15 minutes where available", async (ctx) => {
    const available = (await db.query("SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'")).rowCount;
    if (!available) ctx.skip(); // e.g. CI Postgres without pg_cron preloaded; the worker ticks instead
    expect(cronJobScheduled).toBe(true);
  });

  it("queues the initial research automatically when configured", async () => {
    expect(await tick(db)).toBe("queued initial research R-001");
    await db.query("UPDATE refresh_runs SET status = 'cancelled'");
    await db.query("DELETE FROM refresh_runs");
    await db.query("UPDATE settings SET auto_initial = false");
    expect(await tick(db)).toBe("waiting for initial research");
  });

  it("waits for the run window before a due scheduled refresh", async () => {
    await runRefresh(db, cfg(), model, web);
    await db.query("UPDATE system_status SET last_success_at = now() - interval '43 days'");
    await db.query("UPDATE settings SET run_window_utc = ((now() AT TIME ZONE 'UTC')::time + interval '4 hours')");
    expect(await tick(db)).toBe("nothing due");
    await openWindow();
    expect(await tick(db)).toBe("queued scheduled refresh R-002");
  });

  it("retries an incomplete refresh once per day for up to 3 days, then stops", async () => {
    await runRefresh(db, cfg(), model, web);
    web.set(META, { status: 500 });
    await openWindow();
    await runRefresh(db, cfg(), model, web); // manual, incomplete
    const results: string[] = [];
    for (let day = 0; day < 5; day++) {
      await db.query("UPDATE refresh_runs SET created_at = created_at - interval '1 day' WHERE trigger <> 'live_check'");
      await db.query("UPDATE system_status SET last_success_at = last_success_at - interval '1 day'");
      const t = await tick(db);
      results.push(t);
      if (t.startsWith("queued")) {
        const run = await claimNextRun(db, "w");
        const { executeRun } = await import("../src/refresh/runner.js");
        await executeRun({ db, cfg: cfg(), model, embedder: null, deployed: false, fetchImpl: web.fetch }, run!);
        expect(await tick(db)).toBe("nothing due"); // not twice in the same window
      }
    }
    expect(results.filter((r) => r.startsWith("queued retry"))).toHaveLength(3);
    expect(results.slice(3)).toEqual(["nothing due", "nothing due"]);
  });

  it("recovers a run stuck for 2 hours and releases the lock", async () => {
    await enqueue(db, "manual", "t");
    const run = await claimNextRun(db, "dead");
    await db.query("UPDATE refresh_runs SET last_activity_at = now() - interval '3 hours' WHERE id = $1", [run!.id]);
    await tick(db);
    const r = (await q("SELECT status, error FROM refresh_runs WHERE id = $1", [run!.id]))[0];
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/No activity for 2 hours/);
    expect((await enqueue(db, "manual", "t")).created).toBe(true);
  });
});

describe("live checks and search", () => {
  it("a failed live check says it could not re-verify and keeps the stored version", async () => {
    await runRefresh(db, cfg(), model, web);
    web.set(META, { status: 500 });
    const r = await verifyLive({ db, cfg: cfg(), model, embedder: null, fetchImpl: web.fetch, sleep: async () => {} }, 1, { question: "income claims?", requestedBy: "t" });
    expect(r).toMatchObject({ runCode: "LC-001", outcome: "failed", label: "Not verified" });
    expect((await q("SELECT status, result_label FROM refresh_runs WHERE code = 'LC-001'"))[0]).toEqual({ status: "incomplete", result_label: "Not verified" });
    expect((await q("SELECT count(*)::int n FROM entry_versions WHERE status = 'current'"))[0].n).toBe(3);
  });

  it("an unchanged live check updates the verification date only", async () => {
    await runRefresh(db, cfg(), model, web);
    await db.query("UPDATE entry_versions SET verified_at = now() - interval '10 days'");
    const r = await verifyLive({ db, cfg: cfg(), model, embedder: null, fetchImpl: web.fetch }, 1, { requestedBy: "t" });
    expect(r.label).toBe("Verified current");
    const v = (await q("SELECT verified_at > now() - interval '1 minute' AS fresh, version FROM entry_versions ev JOIN entries e ON e.id = ev.entry_id WHERE e.source_id = 1"))[0];
    expect(v).toEqual({ fresh: true, version: 1 });
  });

  it.skipIf(process.env.NO_PGVECTOR === "1")("hybrid search returns only current guidance, filtered by platform", async () => {
    const embedder = new FakeEmbedder();
    await runRefresh(db, cfg(), model, web, "manual", { embedder });
    const hasEmb = (await q("SELECT count(*)::int n FROM entry_versions WHERE embedding IS NOT NULL"))[0].n;
    expect(hasEmb).toBe(3);
    web.set(META, { status: 200, body: page("Income", [["income-claims", "Financial and income claims", "Ads must not promise guaranteed earnings after a course."]]) });
    await runRefresh(db, cfg(), model, web, "manual", { embedder });
    const hits = await searchKb(db, "can ads promise earnings after a course", { platform: "meta", embedder });
    expect(hits[0].body).toMatch(/guaranteed earnings/);
    expect(hits.every((h) => h.platform === "meta")).toBe(true);
    expect(hits.map((h) => h.body)).not.toContain("Ads must not make misleading claims about financial outcomes.");
    const tt = await searchKb(db, "landing page language", { platform: "tiktok", embedder });
    expect(tt.map((h) => h.platform)).toEqual(["tiktok"]);
  });

  it("manually added sources must be official", async () => {
    expect(await addSource(db, "https://example.com/x", { origin: "manual" })).toBeNull();
    expect(await addSource(db, "https://ads.tiktok.com/help/article/new-one", { origin: "manual" })).toBeGreaterThan(0);
  });
});
