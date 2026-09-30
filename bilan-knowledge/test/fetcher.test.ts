import { describe, expect, it } from "vitest";
import { blockedReason, contentHash, fetchPage, htmlToText } from "../src/research/fetcher.js";
import { normalizeUrl, platformForUrl } from "../src/research/sources.js";
import { FakeWeb, page } from "./helpers.js";

const opts = (web: FakeWeb, over = {}) => ({
  maxAttempts: 3,
  timeoutMs: 1000,
  backoffBaseMs: 1,
  userAgent: "test",
  minChars: 20,
  maxChars: 10_000,
  fetchImpl: web.fetch,
  sleep: async () => {},
  ...over,
});

describe("fetchPage", () => {
  it("retries temporary failures (5xx, network errors) with a bounded number of attempts", async () => {
    const web = new FakeWeb();
    const url = "https://ads.tiktok.com/help/article/a";
    web.set(url, [{ status: 503 }, { status: -1 }, { status: 200, body: page("A", { X: "rule x applies to everyone" }) }]);
    const r = await fetchPage(url, opts(web));
    expect(r.kind).toBe("ok");
    expect(r.attempts).toBe(3);

    const url2 = "https://ads.tiktok.com/help/article/b";
    web.set(url2, { status: 503 });
    const r2 = await fetchPage(url2, opts(web));
    expect(r2.kind).toBe("failed");
    expect(web.hits.get(url2)).toBe(3);
  });

  it("treats 404/410 and redirects to a generic landing page as missing", async () => {
    const web = new FakeWeb();
    expect((await fetchPage("https://ads.tiktok.com/help/article/gone", opts(web))).kind).toBe("missing");
    web.set("https://www.facebook.com/business/help/123", {
      status: 200,
      redirectTo: "https://www.facebook.com/business/help",
      body: page("Help", { Home: "welcome to the help centre home page" }),
    });
    const r = await fetchPage("https://www.facebook.com/business/help/123", opts(web));
    expect(r.kind).toBe("missing");
  });

  it("never treats a login wall, 403, or JS shell as a successful (unchanged) page", async () => {
    const web = new FakeWeb();
    web.set("https://www.facebook.com/business/help/1", { status: 200, body: "<html><body>You must log in to continue.</body></html>" });
    web.set("https://www.facebook.com/business/help/2", { status: 403, body: "denied" });
    web.set("https://www.facebook.com/business/help/3", { status: 200, body: "<html><body><div id=root></div></body></html>" });
    for (const u of ["1", "2", "3"]) {
      const r = await fetchPage(`https://www.facebook.com/business/help/${u}`, opts(web));
      expect(r.kind).toBe("failed");
      if (r.kind === "failed") expect(r.blocked).toBe(true);
    }
  });

  it("flags oversize pages instead of silently truncating", async () => {
    const web = new FakeWeb();
    web.set("https://ads.tiktok.com/help/article/big", { status: 200, body: page("Big", { A: "x".repeat(20_000) }) });
    const r = await fetchPage("https://ads.tiktok.com/help/article/big", opts(web));
    expect(r.kind).toBe("failed");
    if (r.kind === "failed") expect(r.error).toMatch(/MAX_PAGE_CHARS/);
  });

  it("extracts readable text and links, and hashes stably across whitespace changes", () => {
    const html = page("T", { A: "one" }, `<a href="/help/article/next">FOLLOW next</a><script>var x=1</script>`);
    const { text, links } = htmlToText(html, "https://ads.tiktok.com/help");
    expect(text).toContain("RULE A: one");
    expect(text).not.toContain("var x");
    expect(links[0].url).toBe("https://ads.tiktok.com/help/article/next");
    expect(contentHash("a  b\n\n\nc")).toBe(contentHash("a b\n\nc"));
    expect(blockedReason("short", 20)).toMatch(/too short/);
  });
});

describe("official source rules", () => {
  it("keeps Meta and TikTok separate and rejects unofficial domains", () => {
    expect(platformForUrl("https://transparency.meta.com/policies/ad-standards")).toBe("meta");
    expect(platformForUrl("https://developers.facebook.com/docs/marketing-api")).toBe("meta");
    expect(platformForUrl("https://ads.tiktok.com/help/article/x")).toBe("tiktok");
    expect(platformForUrl("https://www.tiktok.com/@someuser")).toBeNull();
    expect(platformForUrl("https://example.com/meta-ads-guide")).toBeNull();
    expect(platformForUrl("http://ads.tiktok.com/help")).toBeNull();
    expect(platformForUrl("https://facebook.com.evil.example/")).toBeNull();
    expect(normalizeUrl("https://ADS.tiktok.com/help/article/x/?utm_source=a#top")).toBe("https://ads.tiktok.com/help/article/x");
  });
});
