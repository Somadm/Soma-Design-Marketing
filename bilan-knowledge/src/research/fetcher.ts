import { createHash } from "node:crypto";
import * as cheerio from "cheerio";

export type FetchOutcome =
  | { kind: "ok"; text: string; finalUrl: string; httpStatus: number; attempts: number; links: PageLink[] }
  /** The publisher removed the page (404/410, or redirected to a generic landing page). */
  | { kind: "missing"; httpStatus: number | null; finalUrl: string | null; attempts: number; reason: string }
  /** We could not see the page. This is never treated as "unchanged". */
  | { kind: "failed"; httpStatus: number | null; attempts: number; error: string; blocked: boolean };

export interface PageLink {
  url: string;
  text: string;
}

export interface FetcherOptions {
  maxAttempts: number;
  timeoutMs: number;
  backoffBaseMs: number;
  userAgent: string;
  minChars: number;
  maxChars: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const BLOCK_PATTERNS = [
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
];

/** Landing pages that a removed article typically redirects to. */
const GENERIC_LANDING = /^\/(business\/help|help|business|docs|policies|en|en-us|portal\/docs)?\/?$/i;

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
  const text = normalizeText(root.text());
  return { text, title, links };
}

export function normalizeText(s: string): string {
  return s
    .replace(/ /g, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter((l, i, arr) => l.length > 0 || (i > 0 && arr[i - 1].length > 0))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function contentHash(text: string): string {
  return createHash("sha256").update(normalizeText(text)).digest("hex");
}

/** Returns a reason if the extracted text looks like a login wall / bot check / empty shell. */
export function blockedReason(text: string, minChars: number): string | null {
  if (text.length < minChars) return `page content too short (${text.length} chars) – likely blocked or rendered by JavaScript`;
  const head = text.slice(0, 3000);
  const hit = BLOCK_PATTERNS.find((re) => re.test(head));
  if (hit && text.length < 5000) return `page appears to be a login wall or bot check (${hit.source})`;
  return null;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export async function fetchPage(url: string, opts: FetcherOptions): Promise<FetchOutcome> {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let lastError = "unknown error";
  let lastStatus: number | null = null;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    let retryAfterMs: number | null = null;
    try {
      const res = await doFetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(opts.timeoutMs),
        headers: {
          "user-agent": opts.userAgent,
          accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
          "accept-language": "en-GB,en;q=0.9",
        },
      });
      lastStatus = res.status;
      const finalUrl = res.url || url;

      if (res.status === 404 || res.status === 410) {
        return { kind: "missing", httpStatus: res.status, finalUrl, attempts: attempt, reason: `HTTP ${res.status}` };
      }
      if (res.ok) {
        const final = new URL(finalUrl);
        const requested = new URL(url);
        if (/\/login|checkpoint|\/auth/i.test(final.pathname)) {
          return { kind: "failed", httpStatus: res.status, attempts: attempt, error: `redirected to login (${finalUrl})`, blocked: true };
        }
        if (
          final.pathname !== requested.pathname &&
          GENERIC_LANDING.test(final.pathname) &&
          !GENERIC_LANDING.test(requested.pathname)
        ) {
          return {
            kind: "missing",
            httpStatus: res.status,
            finalUrl,
            attempts: attempt,
            reason: `redirected to generic landing page ${finalUrl}`,
          };
        }
        const contentType = res.headers.get("content-type") ?? "";
        const body = await res.text();
        const isHtml = /html|xml/i.test(contentType) || /^\s*</.test(body);
        const parsed = isHtml ? htmlToText(body, finalUrl) : { text: normalizeText(body), links: [] as PageLink[] };
        const text = parsed.text;
        const blocked = blockedReason(text, opts.minChars);
        if (blocked) {
          return { kind: "failed", httpStatus: res.status, attempts: attempt, error: blocked, blocked: true };
        }
        if (text.length > opts.maxChars) {
          return {
            kind: "failed",
            httpStatus: res.status,
            attempts: attempt,
            error: `page is ${text.length} chars, above MAX_PAGE_CHARS=${opts.maxChars}; not truncated – raise the limit to index it`,
            blocked: false,
          };
        }
        return { kind: "ok", text, finalUrl, httpStatus: res.status, attempts: attempt, links: parsed.links };
      }
      if (res.status === 401 || res.status === 403) {
        return { kind: "failed", httpStatus: res.status, attempts: attempt, error: `HTTP ${res.status} (access refused)`, blocked: true };
      }
      lastError = `HTTP ${res.status}`;
      if (!isRetryableStatus(res.status)) {
        return { kind: "failed", httpStatus: res.status, attempts: attempt, error: lastError, blocked: false };
      }
      const ra = Number(res.headers.get("retry-after"));
      if (Number.isFinite(ra) && ra > 0) retryAfterMs = Math.min(ra * 1000, 60_000);
    } catch (err) {
      lastError = (err as Error).name === "TimeoutError" ? `timeout after ${opts.timeoutMs}ms` : (err as Error).message;
    }
    if (attempt < opts.maxAttempts) {
      const backoff = retryAfterMs ?? opts.backoffBaseMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
      await sleep(backoff);
    }
  }
  return { kind: "failed", httpStatus: lastStatus, attempts: opts.maxAttempts, error: `${lastError} after ${opts.maxAttempts} attempts`, blocked: false };
}
