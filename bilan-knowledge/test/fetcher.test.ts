import { describe, expect, it } from "vitest";
import { contentHash, contentProblem, fetchDirect, htmlToText, sameArticle } from "../src/research/fetcher.js";
import { normalizeUrl, platformForUrl } from "../src/research/sources.js";
import { FakeWeb, page } from "./helpers.js";

const opts = (web: FakeWeb, over = {}) => ({ timeoutMs: 1000, userAgent: "t", minChars: 20, maxChars: 20_000, fetchImpl: web.fetch, ...over });
const U = "https://ads.tiktok.com/help/article/spark-ads";

describe("fetchDirect: an inaccessible page is a failure, never 'unchanged'", () => {
  it("fails on HTTP ≥ 400 (including 404), network errors and timeouts", async () => {
    const web = new FakeWeb();
    for (const [status, reason] of [[404, "HTTP 404"], [500, "HTTP 500"], [403, "HTTP 403, access blocked"]] as const) {
      web.set(U, { status });
      const r = await fetchDirect(U, opts(web));
      expect(r).toMatchObject({ kind: "failed", reason });
    }
    web.set(U, { status: -1 });
    expect(await fetchDirect(U, opts(web))).toMatchObject({ kind: "failed", reason: expect.stringMatching(/Network error/) });
  });

  it("fails on login redirects, bot challenges and empty JavaScript shells", async () => {
    const web = new FakeWeb();
    web.set(U, { status: 302, location: "https://ads.tiktok.com/login?next=x" });
    expect(await fetchDirect(U, opts(web))).toMatchObject({ kind: "failed", reason: "Redirected to a login page", blocked: true });
    web.set(U, { status: 200, body: "<html><body><p>Checking your browser before accessing the site. Please wait.</p></body></html>" });
    expect(await fetchDirect(U, opts(web))).toMatchObject({ kind: "failed", reason: "Login wall or bot challenge" });
    web.set(U, { status: 200, body: "<html><body><div id=root></div></body></html>" });
    expect(await fetchDirect(U, opts(web))).toMatchObject({ kind: "failed", blocked: true });
  });

  it("fails when the page shrinks below 40% of the stored version", async () => {
    const web = new FakeWeb();
    web.set(U, { status: 200, body: page("Spark", [["spark", "Spark Ads", "Creators authorise posts."]]) });
    const r = await fetchDirect(U, opts(web, { previousLength: 2000 }));
    expect(r).toMatchObject({ kind: "failed", reason: expect.stringMatching(/% of the stored version/) });
  });

  it("treats 410 and a permanent redirect to a different article as discontinued", async () => {
    const web = new FakeWeb();
    web.set(U, { status: 410 });
    expect(await fetchDirect(U, opts(web))).toMatchObject({ kind: "discontinued", redirectTo: null });
    const target = "https://ads.tiktok.com/help/article/spark-ads-authorisation";
    web.set(U, { status: 301, location: target });
    web.set(target, { status: 200, body: page("Spark", [["spark", "Spark Ads", "Creators authorise posts for Spark Ads."]]) });
    expect(await fetchDirect(U, opts(web))).toMatchObject({ kind: "discontinued", httpStatus: 301, redirectTo: target });
  });

  it("follows temporary redirects and permanent redirects to the same article", async () => {
    const web = new FakeWeb();
    const same = "https://ads.tiktok.com/help/article/spark-ads/";
    web.set(U, { status: 301, location: same });
    web.set(same, { status: 200, body: page("Spark", [["spark", "Spark Ads", "Creators authorise posts for Spark Ads."]]) });
    expect(await fetchDirect(U, opts(web))).toMatchObject({ kind: "ok", finalUrl: same });
  });

  it("flags oversize pages instead of truncating", () => {
    expect(contentProblem("x".repeat(30_000), { minChars: 20, maxChars: 20_000 })).toMatch(/not truncated/);
  });

  it("extracts text and links, and hashes stably across whitespace and 'Last updated' lines", () => {
    const { text, links } = htmlToText(page("T", [["a", "A", "Body."]], `<a href="/help/article/next">FOLLOW next</a><script>var x=1</script>`), "https://ads.tiktok.com/help");
    expect(text).toContain("RULE a | A | Body.");
    expect(text).not.toContain("var x");
    expect(links.find((l) => l.text === "FOLLOW next")?.url).toBe("https://ads.tiktok.com/help/article/next");
    expect(contentHash("a  b\nLast updated: 3 Sep 2026\n\n\nc")).toBe(contentHash("a b\n\nc"));
    expect(sameArticle("https://www.facebook.com/business/help/1", "https://facebook.com/business/help/1/")).toBe(true);
  });
});

describe("official domains keep Meta and TikTok separate", () => {
  it("accepts only the configured official domains and paths", () => {
    expect(platformForUrl("https://transparency.meta.com/policies/ad-standards")).toBe("meta");
    expect(platformForUrl("https://www.facebook.com/business/help/123")).toBe("meta");
    expect(platformForUrl("https://developers.facebook.com/docs/marketing-api")).toBe("meta");
    expect(platformForUrl("https://about.fb.com/news/2026/09/x")).toBe("meta");
    expect(platformForUrl("https://ads.tiktok.com/help/article/x")).toBe("tiktok");
    expect(platformForUrl("https://www.tiktok.com/business/en/blog")).toBe("tiktok");
    // Not guidance / not official:
    expect(platformForUrl("https://www.facebook.com/someuser")).toBeNull();
    expect(platformForUrl("https://www.tiktok.com/@creator/video/1")).toBeNull();
    expect(platformForUrl("https://about.fb.com/company-info")).toBeNull();
    expect(platformForUrl("https://example.com/meta-ads-guide")).toBeNull();
    expect(platformForUrl("http://ads.tiktok.com/help")).toBeNull();
    expect(platformForUrl("https://facebook.com.evil.example/business")).toBeNull();
    expect(normalizeUrl("https://ADS.tiktok.com/help/article/x/?utm_source=a#top")).toBe("https://ads.tiktok.com/help/article/x");
  });
});
