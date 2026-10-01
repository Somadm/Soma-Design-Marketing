import { afterEach, describe, expect, it } from "vitest";
import { buildContext } from "../src/agent/context.js";
import { checkUrl, isPublicAddress, LinkError, parsePage } from "../src/inspiration/linkPreview.js";
import { api, FakeBrain, makeApp, sse, upload, type TestApp } from "./helpers.js";

let t: TestApp | undefined;
afterEach(async () => {
  await t?.app.close();
  await t?.db.end();
  t = undefined;
});

const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");

async function newCarousel(t: TestApp) {
  return (await api(t).post("/api/carousels", { title: "Our process" })).json().id as number;
}

describe("Images on slides", () => {
  it("puts uploaded images on slides, refuses private references, and serves the file behind sign-in", async () => {
    t = await makeApp();
    const a = api(t);
    const img = (await upload(t, "/api/uploads/image", "studio.png", "image/png", PNG)).json().id as number;
    const cid = await newCarousel(t);
    const ref = (await a.post("/api/inspiration", { title: "Bodega awning" })).json().id as number;
    const refImg = (await upload(t, `/api/inspiration/${ref}/image`, "awning.png", "image/png", PNG)).statusCode;
    expect(refImg).toBe(200);
    const refAsset = (await t.db.query("SELECT image_asset_id FROM sagal.inspiration WHERE id = $1", [ref])).rows[0].image_asset_id;

    const c = (await a.get(`/api/carousels/${cid}`)).json().carousel;
    const slides = c.slides.map((s: object, i: number) => (i === 0 ? { ...s, imageAssetId: img, imageLayout: "full" } : s));
    expect((await a.patch(`/api/carousels/${cid}`, { slides })).statusCode).toBe(200);
    expect((await a.get(`/api/carousels/${cid}`)).json().carousel.slides[0]).toMatchObject({ imageAssetId: img, imageLayout: "full" });

    // Inspiration is for learning, never for posting.
    const bad = c.slides.map((s: object, i: number) => (i === 0 ? { ...s, imageAssetId: refAsset } : s));
    const r = await a.patch(`/api/carousels/${cid}`, { slides: bad });
    expect(r.statusCode).toBe(400);

    // The picker only offers publishable images.
    const list = (await a.get("/api/assets/images")).json().images.map((i: { id: number }) => i.id);
    expect(list).toContain(img);
    expect(list).not.toContain(refAsset);

    // Same-origin file for the canvas export; only with a session.
    const raw = await a.get(`/api/assets/${img}/raw`);
    expect(raw.statusCode).toBe(200);
    expect(raw.headers["content-type"]).toBe("image/png");
    expect(raw.headers["x-content-type-options"]).toBe("nosniff");
    expect(Buffer.from(raw.rawPayload).equals(PNG)).toBe(true);
    const anon = await t.app.inject({ method: "GET", url: `/api/assets/${img}/raw` });
    expect(anon.statusCode).toBe(401);
  });

  it("Sagal can place an image on a slide, and a design made for a planned idea reaches its posts", async () => {
    const brain = new FakeBrain((input) => {
      const ctx = input.context;
      const img = Number(/\[image (\d+)\] studio\.png/.exec(ctx)![1]);
      const idea = Number(/\[idea (\d+)\]/.exec(ctx)![1]);
      return {
        text: "Done.",
        tools: [{ name: "create_carousel", input: { title: "Studio day", idea_id: idea, slides: [{ headline: "Our studio", image_id: img, image_layout: "frame" }], captions: { Instagram: "A day in the studio." } } }],
      };
    });
    t = await makeApp({ cfg: { ANTHROPIC_API_KEY: "sk-ant-test" }, brain });
    const a = api(t);
    const img = (await upload(t, "/api/uploads/image", "studio.png", "image/png", PNG)).json().id as number;
    const idea = (await a.post("/api/ideas", { title: "Studio day", format: "Carousel", platforms: ["Instagram"] })).json();
    const ideaId = idea.id ?? idea.idea?.id;
    const tomorrow = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10);
    expect((await a.post(`/api/ideas/${ideaId}/plan`, { date: tomorrow })).statusCode).toBe(200);
    const conv = (await a.post("/api/conversations", {})).json().id;
    const ev = sse((await a.post(`/api/conversations/${conv}/messages`, { text: "Use my studio photo." })).body);
    expect(ev.map((e) => e.type)).toContain("sagal");
    const c = (await t.db.query("SELECT id, slides FROM sagal.carousels WHERE title = 'Studio day'")).rows[0];
    expect(c.slides[0]).toMatchObject({ imageAssetId: img, imageLayout: "frame" });
    const post = (await t.db.query("SELECT carousel_id, caption FROM sagal.posts WHERE idea_id = $1", [ideaId])).rows[0];
    expect(post).toMatchObject({ carousel_id: c.id, caption: "A day in the studio." });
  });
});

describe("Inspiration: teaching Sagal your taste", () => {
  const pinterest = async (url: string) => ({
    url, title: "Calm editorial carousel", description: "Big serif type, lots of space", site: "Pinterest", image: "https://i.pinimg.com/x.png",
    imageBytes: { data: PNG, contentType: "image/png", filename: "Pinterest.png" },
  });

  it("saves a Pinterest link with its picture, reaction and reason, and Sagal reads it every turn", async () => {
    t = await makeApp({ cfg: { ANTHROPIC_API_KEY: "sk-ant-test" }, linkPreview: pinterest });
    const a = api(t);
    const r = await a.post("/api/inspiration", { url: "https://www.pinterest.com/pin/123/", reaction: "love", why: "The huge headline and calm colours", category: "Carousel design" });
    expect(r.statusCode).toBe(200);
    expect(r.json().note).toBeNull();
    const item = (await a.get("/api/inspiration")).json().items[0];
    expect(item).toMatchObject({ title: "Calm editorial carousel", site: "Pinterest", reaction: "love", url: "https://www.pinterest.com/pin/123/", why: "The huge headline and calm colours" });
    expect(item.imageUrl).toBeTruthy();
    // The picture is a private reference: never offered for slides.
    expect((await a.get("/api/assets/images")).json().images).toHaveLength(0);

    expect((await a.patch(`/api/inspiration/${item.id}`, { reaction: "not_for_us" })).statusCode).toBe(200);
    expect((await a.patch("/api/settings/taste", { love: "Warm neutrals, one strong blue", avoid: "Neon gradients" })).statusCode).toBe(200);
    const ctx = await buildContext(t.db, { spoken: false, conversationTitle: "x", project: "Soma" });
    expect(ctx).toContain("Warm neutrals, one strong blue");
    expect(ctx).toContain("Neon gradients");
    expect(ctx).toContain(`[reference ${item.id}] Not for us: “Calm editorial carousel”`);
    expect(ctx).toContain("The huge headline and calm colours");
  });

  it("keeps the link when the page can't be read, and refuses private addresses", async () => {
    t = await makeApp();
    const a = api(t);
    const r = await a.post("/api/inspiration", { url: "https://www.instagram.com/p/abc/" });
    expect(r.statusCode).toBe(200);
    expect(r.json().note).toMatch(/Saved the link/);
    expect((await a.get("/api/inspiration")).json().items[0]).toMatchObject({ title: "instagram.com", url: "https://www.instagram.com/p/abc/" });
    expect((await a.post("/api/inspiration", { url: "http://169.254.169.254/latest/meta-data" })).statusCode).toBe(400);
    expect((await a.post("/api/inspiration", { url: "file:///etc/passwd" })).statusCode).toBe(400);
    expect((await a.post("/api/inspiration", {})).statusCode).toBe(400);
  });

  it("Sagal saves a link Sabah shares and notes what she noticed, and sees the reference picture", async () => {
    let n = 0;
    const brain = new FakeBrain(() =>
      n++ === 0
        ? { text: "Saved it.", tools: [{ name: "save_reference", input: { url: "https://pin.it/abc", reaction: "love", why: "She loves the pattern at the edges" } }] }
        : { text: "Noted.", tools: [{ name: "update_reference", input: { reference_id: 1, noticed: "Pattern frames, never fills." } }] },
    );
    t = await makeApp({ cfg: { ANTHROPIC_API_KEY: "sk-ant-test" }, brain, linkPreview: pinterest });
    const a = api(t);
    const conv = (await a.post("/api/conversations", {})).json().id;
    await a.post(`/api/conversations/${conv}/messages`, { text: "I love this https://pin.it/abc" });
    const row = (await t.db.query("SELECT id, title, reaction, why, image_asset_id FROM sagal.inspiration")).rows[0];
    expect(row).toMatchObject({ title: "Calm editorial carousel", reaction: "love", why: "She loves the pattern at the edges" });
    await a.post(`/api/conversations/${conv}/messages`, { text: "What do you see?", context: { type: "reference", id: row.id, label: "Inspiration · x" } });
    expect((await t.db.query("SELECT noticed FROM sagal.inspiration WHERE id = $1", [row.id])).rows[0].noticed).toBe("Pattern frames, never fills.");
    const last = brain.calls[1].history[brain.calls[1].history.length - 1];
    expect(JSON.stringify(last.content)).toContain('"type":"image"');
  });
});

describe("Link reader", () => {
  it("reads Open Graph tags", () => {
    const html = `<html><head><title>Fallback</title><meta content="Pin &amp; more" property="og:title"><meta property='og:image' content='/img/a.jpg'><meta name="description" content="A pin"></head></html>`;
    expect(parsePage(html, "https://www.pinterest.com/pin/1/")).toEqual({ title: "Pin & more", description: "A pin", image: "https://www.pinterest.com/img/a.jpg", site: "pinterest.com" });
  });
  it("only fetches the public internet", () => {
    expect(isPublicAddress("104.20.23.154")).toBe(true);
    expect(isPublicAddress("2606:4700:10::6814:179a")).toBe(true);
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.1.1", "172.16.0.1", "169.254.169.254", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "0.0.0.0"]) expect(isPublicAddress(ip)).toBe(false);
    expect(() => checkUrl("http://localhost/")).toThrow(LinkError);
    expect(() => checkUrl("https://user:pw@example.com/")).toThrow(LinkError);
    expect(() => checkUrl("https://example.com:8443/")).toThrow(LinkError);
    expect(checkUrl("https://pin.it/abc").hostname).toBe("pin.it");
  });
});
