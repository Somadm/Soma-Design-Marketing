import { createHash } from "node:crypto";
import * as cheerio from "cheerio";

export interface PageLink {
  url: string;
  text: string;
}

export type Via = "direct" | "rendered" | "claude_web_fetch";

/** One retrieval attempt. Retries are scheduled by the caller (runner queue / live check). */
export type FetchOutcome =
  | { kind: "ok"; text: string; finalUrl: string; httpStatus: number; links: PageLink[]; via: Via }
  /** 410, or a permanent redirect to a different article. */
  | { kind: "discontinued"; httpStatus: number; reason: string; redirectTo: string | null }
  /** Not verified. Never treated as "unchanged". */
  | { kind: "failed"; httpStatus: number | null; reason: string; blocked: boolean };

export interface FetchOptions {
  timeoutMs: number;
  userAgent: string;
  minChars: number;
  maxChars: number;
  /** Length of the stored normalised text, for the "shrank below 40%" rule. */
  previousLength?: number | null;
  fetchImpl?: typeof fetch;
}

const BOT_MARKERS = [
  /you must log in to continue/i,
  /log in to (facebook|continue|see)/i,
  /please enable javascript/i,
  /enable javascript to (run|use|view)/i,
  /checking your browser/i,
  /verify you are (a )?human/i,
  /access denied/i,
  /unusual traffic/i,
  /captcha/i,
  /temporarily blocked/i,
  /security check/i,
];
const LOGIN_PATH = /\/(login|checkpoint|auth|signin|sso)(\/|$|\.)/i;

export function htmlToText(html: string, baseUrl?: string): { text: string; title: string | null; links: PageLink[] } {
  const $ = cheerio.load(html);
  const title = $("title").first().text().trim() || $("h1").first().text().trim() || null;
  const links: PageLink[] = [];
  const seen = new Set<string>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href || !baseUrl) return;
    try {
      const u = new URL(href, baseUrl);
      u.hash = "";
      const key = u.toString();
      if (u.protocol !== "https:" || seen.has(key)) return;
      seen.add(key);
      links.push({ url: key, text: $(el).text().replace(/\s+/g, " ").trim().slice(0, 120) });
    } catch {}
  });
  $("script, style, noscript, svg, iframe, template, nav, footer, header, form, [aria-hidden=true], [role=navigation]").remove();
  const root = $("main").first().length ? $("main").first() : $("article").first().length ? $("article").first() : $("body");
  root.find("h1,h2,h3,h4,h5,h6,p,li,tr,div,section,br,dd,dt,blockquote,pre").each((_, el) => {
    $(el).append("\n");
  });
  root.find("li").each((_, el) => {
    $(el).prepend("• ");
  });
  return { text: normalizeText(root.text()), title, links };
}

/** Normalise for hashing: whitespace, and volatile lines (dates, cookie banners) removed. */
export function normalizeText(s: string): string {
  return s
    .replace(/ /g, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => !/^(last updated|updated|published)[:\s]/i.test(l))
    .filter((l) => !/(we use cookies|cookie settings|accept all cookies)/i.test(l))
    .filter((l, i, arr) => l.length > 0 || (i > 0 && arr[i - 1].length > 0))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function contentHash(text: string): string {
  return createHash("sha256").update(normalizeText(text)).digest("hex");
}

/** Checks shared by every retrieval path. Returns a failure reason, or null if the content is usable. */
export function contentProblem(text: string, opts: Pick<FetchOptions, "minChars" | "maxChars" | "previousLength">): string | null {
  if (text.length < opts.minChars) return `Page content too short (${text.length} characters); likely blocked or rendered by JavaScript`;
  const head = text.slice(0, 3000);
  const marker = BOT_MARKERS.find((re) => re.test(head));
  if (marker && text.length < 6000) return "Login wall or bot challenge";
  if (text.length > opts.maxChars) return `Page is ${text.length} characters, above MAX_PAGE_CHARS; not truncated`;
  if (opts.previousLength && text.length < 0.4 * opts.previousLength) {
    return `Page returned ${Math.round((100 * text.length) / opts.previousLength)}% of the stored version's text; treated as not verified`;
  }
  return null;
}

/** Same article despite locale prefixes, trailing slashes or query strings. */
export function sameArticle(a: string, b: string): boolean {
  const key = (u: string) => {
    const url = new URL(u);
    const path = url.pathname
      .replace(/\/(en|en-us|en-gb|en_us|en_gb)(?=\/|$)/gi, "")
      .replace(/\/+$/, "")
      .toLowerCase();
    return url.hostname.replace(/^www\./, "") + path;
  };
  try {
    return key(a) === key(b);
  } catch {
    return false;
  }
}

/** Direct HTTPS GET with manual redirect handling. */
export async function fetchDirect(url: string, opts: FetchOptions): Promise<FetchOutcome> {
  const doFetch = opts.fetchImpl ?? fetch;
  let current = url;
  let permanentTo: string | null = null;
  try {
    for (let hop = 0; hop < 6; hop++) {
      const res = await doFetch(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(opts.timeoutMs),
        headers: {
          "user-agent": opts.userAgent,
          accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
          "accept-language": "en-GB,en;q=0.9",
        },
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) return { kind: "failed", httpStatus: res.status, reason: `HTTP ${res.status} without a Location header`, blocked: false };
        const next = new URL(location, current).toString();
        if (LOGIN_PATH.test(new URL(next).pathname)) {
          return { kind: "failed", httpStatus: res.status, reason: "Redirected to a login page", blocked: true };
        }
        if ((res.status === 301 || res.status === 308) && !permanentTo && !sameArticle(url, next)) permanentTo = next;
        current = next;
        continue;
      }
      if (res.status === 410) return { kind: "discontinued", httpStatus: 410, reason: "HTTP 410, page removed", redirectTo: null };
      if (res.status >= 400) {
        return {
          kind: "failed",
          httpStatus: res.status,
          reason: res.status === 403 || res.status === 401 ? `HTTP ${res.status}, access blocked` : `HTTP ${res.status}`,
          blocked: res.status === 401 || res.status === 403 || res.status === 429,
        };
      }
      if (permanentTo && !sameArticle(url, current)) {
        return { kind: "discontinued", httpStatus: 301, reason: `Moved permanently to ${current}`, redirectTo: current };
      }
      const body = await res.text();
      const isHtml = /html|xml/i.test(res.headers.get("content-type") ?? "") || /^\s*</.test(body);
      const parsed = isHtml ? htmlToText(body, current) : { text: normalizeText(body), links: [] as PageLink[] };
      const problem = contentProblem(parsed.text, opts);
      if (problem) return { kind: "failed", httpStatus: res.status, reason: problem, blocked: /blocked|bot|login|JavaScript|too short/.test(problem) };
      return { kind: "ok", text: parsed.text, finalUrl: current, httpStatus: res.status, links: parsed.links, via: "direct" };
    }
    return { kind: "failed", httpStatus: null, reason: "Too many redirects", blocked: false };
  } catch (err) {
    const e = err as Error;
    const reason = e.name === "TimeoutError" ? "Timeout" : `Network error: ${e.message}`;
    return { kind: "failed", httpStatus: null, reason, blocked: false };
  }
}
