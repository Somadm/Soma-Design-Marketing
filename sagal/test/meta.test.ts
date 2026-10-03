import { createCanvas } from "@napi-rs/canvas";
import { afterEach, describe, expect, it } from "vitest";
import { createCarousel } from "../src/domain/carousels.js";
import { createIdea, moveIntoPlan, todayHelsinki } from "../src/domain/plan.js";
import { setState } from "../src/integrations/registry.js";
import { processDuePosts } from "../src/publishing/worker.js";
import { createStorages } from "../src/storage/storage.js";
import { addDays } from "../src/time.js";
import { api, makeApp, upload, type TestApp } from "./helpers.js";

let t: TestApp | undefined;
afterEach(async () => {
  await t?.app.close();
  await t?.db.end();
  t = undefined;
});

interface Call { method: string; url: string; params: Record<string, string> }

/** A stand-in for Meta's Graph API that records every call. */
function fakeMeta(opts: { failPublish?: string; noInstagram?: boolean } = {}) {
  const calls: Call[] = [];
  let n = 0;
  const fetchImpl = (async (input: string, init: { method?: string; body?: URLSearchParams }) => {
    const u = new URL(input);
    const method = init.method ?? "GET";
    const params = Object.fromEntries(method === "POST" ? new URLSearchParams(String(init.body)) : u.searchParams);
    const path = u.pathname.replace(/^\/v\d+\.\d+\//, "");
    calls.push({ method, url: path, params });
    const ok = (body: object) => new Response(JSON.stringify(body), { status: 200 });
    if (u.hostname === "graph.facebook.com" && path === "oauth/access_token" && method === "POST") return ok({ access_token: "short_user_token" });
    if (path === "oauth/access_token") return ok({ access_token: "long_user_token", expires_in: 5_000_000 });
    if (path === "me/accounts") {
      return ok({ data: [{ id: "page_1", name: "Soma", access_token: "page_token", ...(opts.noInstagram ? {} : { instagram_business_account: { id: "ig_1", username: "soma.design" } }) }] });
    }
    if (path === "ig_1/media" && method === "POST") return ok({ id: `container_${++n}` });
    if (path.startsWith("container_")) return ok({ status_code: "FINISHED" });
    if (path === "ig_1/media_publish") {
      if (opts.failPublish) return new Response(JSON.stringify({ error: { message: opts.failPublish, code: 9 } }), { status: 400 });
      return ok({ id: "ig_media_9" });
    }
    if (path === "ig_media_9") return ok({ permalink: "https://www.instagram.com/p/abc/" });
    if (path === "page_1/photos") return ok(params.published === "false" ? { id: `photo_${++n}` } : { id: "photo_1", post_id: "page_1_post_1" });
    if (path === "page_1/feed") return ok({ id: "page_1_post_7" });
    if (path === "page_1") return ok({ name: "Soma", instagram_business_account: { id: "ig_1", username: "soma.design" } });
    return new Response(JSON.stringify({ error: { message: `unexpected ${method} ${path}` } }), { status: 404 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

async function connect(t: TestApp) {
  const a = api(t);
  await a.put("/api/accounts/meta", { client_id: "app_1", client_secret: "app_secret" });
  const start = new URL(String((await a.get("/api/oauth/meta/start")).headers.location));
  const cb = await t.app.inject({ url: `/api/oauth/meta/callback?code=abc&state=${start.searchParams.get("state")}` });
  return decodeURIComponent(String(cb.headers.location));
}

const realPng = () => {
  const c = createCanvas(64, 40);
  const g = c.getContext("2d");
  g.fillStyle = "#c96";
  g.fillRect(0, 0, 64, 40);
  return c.toBuffer("image/png");
};

async function plannedPost(t: TestApp, platforms: string[], format = "Carousel") {
  const idea = await createIdea(t.db, { title: "Three drafts, one survived", format, platforms });
  if (format === "Carousel") {
    await createCarousel(t.db, {
      title: "Three drafts", ideaId: idea.id,
      slides: [{ head: "We threw away two drafts.", kicker: "Process", theme: "ink" }, { head: "Here's the one that stayed.", theme: "paper" }],
      captions: { Instagram: "Two drafts didn't make it. #design", Facebook: "Two drafts didn't make it." },
    });
  }
  await moveIntoPlan(t.db, idea.id, addDays(todayHelsinki(), -1), "12:00");
  return idea;
}

const ctx = (t: TestApp, fetchImpl: typeof fetch) => ({ storages: createStorages(t.cfg), vault: t.vault, appUrl: t.cfg.APP_URL, fetchImpl, wait: async () => {} });

describe("Instagram + Facebook: Sagal posts approved content on her own", () => {
  it("connecting keeps the Page's long-lived access and the linked Instagram account", async () => {
    const meta = fakeMeta();
    t = await makeApp({ fetchImpl: meta.fetchImpl });
    expect(await connect(t)).toMatch(/ok=1.*Connected to Soma and @soma\.design/);
    expect(await t.vault.get("meta.page_token")).toBe("page_token");
    expect(await t.vault.get("meta.ig_user_id")).toBe("ig_1");
    expect(meta.calls.find((c) => c.url === "oauth/access_token" && c.params.grant_type === "fb_exchange_token")?.params.fb_exchange_token).toBe("short_user_token");
    const acct = (await api(t).get("/api/accounts")).json().services.find((s: { id: string }) => s.id === "meta");
    expect(acct).toMatchObject({ state: "connected", account: "Facebook: Soma · Instagram: @soma.design" });
    expect(JSON.stringify(acct)).not.toContain("page_token");
    const test = (await api(t).post("/api/accounts/meta/test")).json();
    expect(test).toMatchObject({ ok: true, message: expect.stringMatching(/Sagal can post to both/) });
  });

  it("posts the finished carousel with its caption to Instagram and Facebook, and links to it", async () => {
    const meta = fakeMeta();
    t = await makeApp({ fetchImpl: meta.fetchImpl });
    await connect(t);
    const img = (await upload(t, "/api/uploads/image", "studio.png", "image/png", realPng())).json().id;
    const idea = await plannedPost(t, ["Instagram", "Facebook"]);
    await t.db.query("UPDATE sagal.carousels SET slides = jsonb_set(slides, '{0,imageAssetId}', $1::jsonb) WHERE idea_id = $2", [String(img), idea.id]);
    expect(await processDuePosts(t.db, undefined, new Date(), ctx(t, meta.fetchImpl))).toBe(2);

    const posts = (await t.db.query("SELECT platform, status, platform_post_id, permalink FROM sagal.posts WHERE idea_id = $1 ORDER BY platform", [idea.id])).rows;
    expect(posts).toEqual([
      { platform: "Facebook", status: "confirmed", platform_post_id: "page_1_post_7", permalink: "https://www.facebook.com/page_1_post_7" },
      { platform: "Instagram", status: "confirmed", platform_post_id: "ig_media_9", permalink: "https://www.instagram.com/p/abc/" },
    ]);
    // Instagram: two carousel items (JPEGs at signed links), one carousel with the Instagram caption.
    const ig = meta.calls.filter((c) => c.url === "ig_1/media");
    expect(ig.filter((c) => c.params.is_carousel_item === "true")).toHaveLength(2);
    expect(ig[0].params.image_url).toMatch(/^http:\/\/localhost:8080\/media\/renders\/post-\d+-[0-9a-f]+-1\.jpg/);
    expect(ig.find((c) => c.params.media_type === "CAROUSEL")?.params.caption).toBe("Two drafts didn't make it. #design");
    expect(ig.every((c) => c.params.access_token === "page_token")).toBe(true);
    // Facebook: two unpublished photos attached to one post with the Facebook caption.
    const feed = meta.calls.find((c) => c.url === "page_1/feed")!;
    expect(feed.params.message).toBe("Two drafts didn't make it.");
    expect(JSON.parse(feed.params.attached_media)).toHaveLength(2);
    // The temporary renders are cleaned up.
    const { readdirSync, existsSync } = await import("node:fs");
    const dir = `${t.cfg.LOCAL_MEDIA_DIR}/renders`;
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });

  it("Instagram's refusal is a failure in plain words; videos and Pages without Instagram are handed over", async () => {
    const meta = fakeMeta({ failPublish: "The aspect ratio is not supported." });
    t = await makeApp({ fetchImpl: meta.fetchImpl });
    await connect(t);
    const carousel = await plannedPost(t, ["Instagram"]);
    const video = await plannedPost(t, ["Facebook"], "Avatar video");
    await t.db.query("UPDATE sagal.posts SET needs_voiceover_job = NULL WHERE idea_id = $1", [video.id]);
    await processDuePosts(t.db, undefined, new Date(), ctx(t, meta.fetchImpl));
    const status = async (ideaId: number) => (await t!.db.query("SELECT status, note FROM sagal.posts WHERE idea_id = $1", [ideaId])).rows[0];
    expect(await status(carousel.id)).toMatchObject({ status: "failed", note: expect.stringContaining("The aspect ratio is not supported.") });
    expect(await status(video.id)).toMatchObject({ status: "manual", note: expect.stringContaining("automatic video posting isn't built yet") });
    const inbox = (await api(t).get("/api/inbox")).json().open.map((i: { kind: string }) => i.kind).sort();
    expect(inbox).toEqual(["Production problem", "Publishing failed"]);
  });

  it("with no Instagram linked to the Page, Instagram posts go to Sabah, Facebook still posts", async () => {
    const meta = fakeMeta({ noInstagram: true });
    t = await makeApp({ fetchImpl: meta.fetchImpl });
    expect(await connect(t)).toMatch(/No Instagram account is linked/);
    const idea = await plannedPost(t, ["Instagram", "Facebook"]);
    await processDuePosts(t.db, undefined, new Date(), ctx(t, meta.fetchImpl));
    const rows = (await t.db.query("SELECT platform, status FROM sagal.posts WHERE idea_id = $1 ORDER BY platform", [idea.id])).rows;
    expect(rows).toEqual([{ platform: "Facebook", status: "confirmed" }, { platform: "Instagram", status: "manual" }]);
  });

  it("never re-sends a post that was interrupted mid-way", async () => {
    t = await makeApp();
    await setState(t.db, "meta", "connected");
    const idea = await plannedPost(t, ["Instagram"]);
    await t.db.query("UPDATE sagal.posts SET status = 'publishing', updated_at = now() - interval '1 hour' WHERE idea_id = $1", [idea.id]);
    await processDuePosts(t.db);
    expect((await t.db.query("SELECT status, note FROM sagal.posts WHERE idea_id = $1", [idea.id])).rows[0]).toMatchObject({
      status: "failed", note: expect.stringMatching(/may already be up/),
    });
  });
});
