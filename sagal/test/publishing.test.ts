import { afterEach, describe, expect, it } from "vitest";
import { createIdea, moveIntoPlan, todayHelsinki } from "../src/domain/plan.js";
import { nextAgreedSlot, retryPost, type Post } from "../src/domain/posts.js";
import { setState } from "../src/integrations/registry.js";
import { authoriseSpend, checkPublish, currentAuthorisation, grantAuthorisation } from "../src/publishing/permissions.js";
import { ADAPTERS, processDuePosts } from "../src/publishing/worker.js";
import { addDays, helsinkiToUtc } from "../src/time.js";
import { api, makeApp, type TestApp } from "./helpers.js";

let t: TestApp;
afterEach(async () => {
  for (const k of Object.keys(ADAPTERS)) delete ADAPTERS[k];
  await t?.app.close();
  await t?.db.end();
});

async function planned(t: TestApp, platforms = ["Instagram"], date = addDays(todayHelsinki(), -1)) {
  const idea = await createIdea(t.db, { title: "The one-sentence homepage", format: "Carousel", platforms });
  await moveIntoPlan(t.db, idea.id, date, "12:00");
  const { rows } = await t.db.query<Post>("SELECT * FROM sagal.posts WHERE idea_id = $1 ORDER BY id", [idea.id]);
  return { idea, posts: rows };
}

describe("publishing permissions, enforced server-side", () => {
  it("starts in 'publish within the approved plan' on all five channels, nothing paused", async () => {
    t = await makeApp();
    const a = await currentAuthorisation(t.db);
    expect(a.mode).toBe("plan");
    expect(a.channels).toHaveLength(5);
    expect(a.paused).toBe(false);
  });

  it("allows a planned post, and denies paused, unauthorised channel, held, unplanned and unapproved (review mode)", async () => {
    t = await makeApp();
    const { posts } = await planned(t, ["Instagram", "TikTok"]);
    const ig = posts.find((p) => p.platform === "Instagram")!;
    const tk = posts.find((p) => p.platform === "TikTok")!;
    expect((await checkPublish(t.db, ig)).allowed).toBe(true);

    await grantAuthorisation(t.db, { paused: true }, "test");
    expect(await checkPublish(t.db, ig)).toMatchObject({ allowed: false, code: "paused" });
    await grantAuthorisation(t.db, { paused: false, channels: ["Instagram"] }, "test");
    expect(await checkPublish(t.db, tk)).toMatchObject({ allowed: false, code: "channel" });
    expect(await checkPublish(t.db, { ...ig, held_by_sabah: true })).toMatchObject({ allowed: false, code: "held" });
    expect(await checkPublish(t.db, { ...ig, idea_id: null })).toMatchObject({ allowed: false, code: "scope" });
    expect(await checkPublish(t.db, { ...ig, sample: true })).toMatchObject({ allowed: false, code: "sample" });
    await grantAuthorisation(t.db, { mode: "review" }, "test");
    expect(await checkPublish(t.db, ig)).toMatchObject({ allowed: false, code: "approval" });
    expect((await checkPublish(t.db, { ...ig, approved_at: new Date() })).allowed).toBe(true);

    // Every decision is recorded, and authorisations are append-only records.
    const checks = await t.db.query("SELECT count(*)::int AS n FROM sagal.permission_checks");
    expect(checks.rows[0].n).toBeGreaterThanOrEqual(8);
    const auths = await t.db.query("SELECT count(*)::int AS n FROM sagal.authorisations");
    expect(auths.rows[0].n).toBe(4);
  });

  it("refuses production spend over the monthly limit", async () => {
    t = await makeApp();
    expect((await authoriseSpend(t.db, "heygen", "render 1", 30)).allowed).toBe(true);
    const over = await authoriseSpend(t.db, "heygen", "render 2", 15);
    expect(over).toMatchObject({ allowed: false, code: "limit" });
    const ledger = await t.db.query("SELECT sum(amount_eur)::numeric AS s FROM sagal.spend_ledger");
    expect(Number(ledger.rows[0].s)).toBe(30);
  });

  it("the API exposes pause/resume and permission changes as new records", async () => {
    t = await makeApp();
    const a = api(t);
    expect((await a.post("/api/publishing/pause", { paused: true })).statusCode).toBe(200);
    expect((await a.get("/api/publishing")).json().authorisation.paused).toBe(true);
    expect((await a.post("/api/publishing/permissions", { mode: "review", spendLimitEur: 25, channels: ["Instagram", "LinkedIn"] })).statusCode).toBe(200);
    const pub = (await a.get("/api/publishing")).json();
    expect(pub.authorisation).toMatchObject({ mode: "review", spendLimitEur: 25, channels: ["Instagram", "LinkedIn"], paused: true });
    expect((await a.get("/api/publishing/history")).json().authorisations.length).toBe(3);
  });
});

describe("publishing worker", () => {
  it("hands a due post to Sabah when the platform isn't connected (never 'published')", async () => {
    t = await makeApp();
    const { posts } = await planned(t);
    expect(await processDuePosts(t.db)).toBe(1);
    const p = (await t.db.query("SELECT status, note FROM sagal.posts WHERE id = $1", [posts[0].id])).rows[0];
    expect(p.status).toBe("manual");
    const inbox = (await t.db.query("SELECT * FROM sagal.inbox_items")).rows;
    expect(inbox[0]).toMatchObject({ primary_label: "I've posted it", primary_action: `post_by_hand:${posts[0].id}` });
    // Sabah marks it posted: recorded as by hand, not platform-confirmed.
    const r = await api(t).post(`/api/inbox/${inbox[0].id}/act`, { which: "primary" });
    expect(r.statusCode).toBe(200);
    const after = (await t.db.query("SELECT status FROM sagal.posts WHERE id = $1", [posts[0].id])).rows[0];
    expect(after.status).toBe("posted_by_hand");
  });

  it("confirms only on the platform's answer, and failures retry at the next agreed slot, never immediately", async () => {
    t = await makeApp();
    await setState(t.db, "meta", "connected");
    let fail = true;
    ADAPTERS.Instagram = {
      async publish() {
        if (fail) throw new Error("token expired");
        return { platformPostId: "ig_123" };
      },
    };
    const { posts } = await planned(t);
    const later = await planned(t, ["Instagram"], addDays(todayHelsinki(), 3));
    await processDuePosts(t.db);
    const failed = (await t.db.query("SELECT status FROM sagal.posts WHERE id = $1", [posts[0].id])).rows[0];
    expect(failed.status).toBe("failed");
    expect((await t.db.query("SELECT kind FROM sagal.inbox_items")).rows[0].kind).toBe("Publishing failed");
    await retryPost(t.db, posts[0].id);
    const retried = (await t.db.query<{ scheduled_at: Date; status: string }>("SELECT status, scheduled_at FROM sagal.posts WHERE id = $1", [posts[0].id])).rows[0];
    expect(retried.status).toBe("scheduled");
    expect(retried.scheduled_at.toISOString()).toBe(later.posts[0].scheduled_at.toISOString());
    expect(await processDuePosts(t.db)).toBe(0); // not due again until that slot
    fail = false;
    await processDuePosts(t.db, undefined, new Date(retried.scheduled_at.getTime() + 1000));
    const done = (await t.db.query("SELECT status, platform_post_id FROM sagal.posts WHERE id = $1", [posts[0].id])).rows[0];
    expect(done).toEqual({ status: "confirmed", platform_post_id: "ig_123" });
  });

  it("with no later slot planned, the next slot is the same time tomorrow", async () => {
    t = await makeApp();
    const { posts } = await planned(t);
    const now = helsinkiToUtc(todayHelsinki(), "13:00");
    const slot = await nextAgreedSlot(t.db, posts[0], now);
    expect(slot.toISOString()).toBe(helsinkiToUtc(addDays(todayHelsinki(), 1), "12:00").toISOString());
  });

  it("holds a video post whose voiceover hasn't arrived, and asks Sabah", async () => {
    t = await makeApp();
    const idea = await createIdea(t.db, { title: "Why one sentence", format: "Avatar video", platforms: ["Instagram"] });
    await t.db.query("INSERT INTO sagal.video_jobs (title, idea_id) VALUES ('Why one sentence', $1)", [idea.id]);
    await moveIntoPlan(t.db, idea.id, addDays(todayHelsinki(), -1), "12:30");
    await processDuePosts(t.db);
    const p = (await t.db.query("SELECT status FROM sagal.posts")).rows[0];
    expect(p.status).toBe("paused");
    expect((await t.db.query("SELECT kind FROM sagal.inbox_items")).rows[0].kind).toBe("Missing audio");
  });

  it("never touches sample posts", async () => {
    t = await makeApp();
    await api(t).post("/api/sample/load");
    await t.db.query("UPDATE sagal.posts SET scheduled_at = now() - interval '1 hour', status = 'scheduled'");
    expect(await processDuePosts(t.db)).toBe(0);
    await api(t).post("/api/sample/remove");
    expect((await t.db.query("SELECT count(*)::int AS n FROM sagal.posts")).rows[0].n).toBe(0);
  });

  it("paused publishing holds due posts instead of sending them", async () => {
    t = await makeApp();
    await planned(t);
    await grantAuthorisation(t.db, { paused: true }, "test");
    await processDuePosts(t.db);
    expect((await t.db.query("SELECT status FROM sagal.posts")).rows[0].status).toBe("paused");
  });
});
