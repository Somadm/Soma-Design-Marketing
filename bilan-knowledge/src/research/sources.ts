export type Platform = "meta" | "tiktok";
export type SourceCategory = "policy" | "help" | "api" | "announcement" | "other";

export const PLATFORMS: Platform[] = ["meta", "tiktok"];

/**
 * Official domains per platform. A URL is only accepted into a platform's knowledge
 * base if its host is (a subdomain of) one of these. This keeps Meta and TikTok
 * guidance separate and keeps third-party blogs out of "official" knowledge.
 */
export const OFFICIAL_DOMAINS: Record<Platform, string[]> = {
  meta: ["facebook.com", "developers.facebook.com", "transparency.meta.com", "about.fb.com", "meta.com"],
  tiktok: ["ads.tiktok.com", "business-api.tiktok.com", "tiktok.com", "newsroom.tiktok.com"],
};

/** Paths on official domains that are never guidance (user content, login, etc.). */
const EXCLUDED_PATH_PATTERNS: RegExp[] = [/^\/@/, /^\/login/, /^\/video\//, /^\/watch/, /^\/groups\//, /^\/profile\.php/];

export function platformForUrl(raw: string): Platform | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (EXCLUDED_PATH_PATTERNS.some((re) => re.test(url.pathname))) return null;
  const host = url.hostname.toLowerCase();
  for (const platform of PLATFORMS) {
    if (OFFICIAL_DOMAINS[platform].some((d) => host === d || host.endsWith(`.${d}`))) return platform;
  }
  return null;
}

/** Canonical form used for de-duplication: no fragment, no tracking params, no trailing slash. */
export function normalizeUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid|ref$|_rdr)/i.test(key)) url.searchParams.delete(key);
  }
  url.hostname = url.hostname.toLowerCase();
  let s = url.toString();
  if (s.endsWith("/") && url.pathname !== "/") s = s.slice(0, -1);
  return s;
}

export interface SeedSource {
  platform: Platform;
  url: string;
  title: string;
  category: SourceCategory;
}

/**
 * Starting points for the initial research. These are official hub pages; the
 * discovery step (Claude web search restricted to OFFICIAL_DOMAINS) finds the
 * specific policy, help-centre and changelog articles beneath them. Any seed that
 * cannot be retrieved is reported as a failed source in the dashboard, never
 * silently ignored.
 */
export const SEED_SOURCES: SeedSource[] = [
  // Meta
  { platform: "meta", url: "https://transparency.meta.com/policies/ad-standards", title: "Meta Advertising Standards", category: "policy" },
  { platform: "meta", url: "https://www.facebook.com/policies/ads", title: "Meta Advertising Policies (entry point)", category: "policy" },
  { platform: "meta", url: "https://www.facebook.com/business/help", title: "Meta Business Help Centre", category: "help" },
  { platform: "meta", url: "https://developers.facebook.com/docs/marketing-api", title: "Meta Marketing API documentation", category: "api" },
  { platform: "meta", url: "https://developers.facebook.com/docs/graph-api/changelog", title: "Graph / Marketing API changelog", category: "api" },
  { platform: "meta", url: "https://developers.facebook.com/docs/marketing-api/conversions-api", title: "Meta Conversions API", category: "api" },
  { platform: "meta", url: "https://developers.facebook.com/docs/meta-pixel", title: "Meta Pixel documentation", category: "api" },
  { platform: "meta", url: "https://www.facebook.com/business/news", title: "Meta for Business news", category: "announcement" },
  // TikTok
  { platform: "tiktok", url: "https://ads.tiktok.com/help/article/tiktok-advertising-policies-industry-entry", title: "TikTok Advertising Policies – Industry Entry", category: "policy" },
  { platform: "tiktok", url: "https://ads.tiktok.com/help/article/tiktok-advertising-policies-ad-creatives-landing-page", title: "TikTok Advertising Policies – Ad Creatives & Landing Page", category: "policy" },
  { platform: "tiktok", url: "https://ads.tiktok.com/help", title: "TikTok Ads Manager Help Centre", category: "help" },
  { platform: "tiktok", url: "https://business-api.tiktok.com/portal/docs", title: "TikTok API for Business documentation", category: "api" },
  { platform: "tiktok", url: "https://www.tiktok.com/business/en/blog", title: "TikTok for Business blog", category: "announcement" },
  { platform: "tiktok", url: "https://newsroom.tiktok.com/en-us", title: "TikTok Newsroom", category: "announcement" },
];

/**
 * Topics the discovery step searches for on each platform's official domains.
 * Weighted toward what matters for Creative Academy (education / course advertising,
 * lead generation, creative rules, measurement).
 */
export const DISCOVERY_TOPICS: Record<Platform, string[]> = {
  meta: [
    "advertising standards and prohibited or restricted content",
    "ad review process, rejected ads and appeals",
    "education, courses and training advertising rules and claims",
    "special ad categories and targeting restrictions (including under-18 audiences and EU/UK rules)",
    "Advantage+ campaigns and automated campaign setup",
    "lead ads and instant forms setup",
    "Meta Pixel, Conversions API and event measurement setup",
    "Marketing API version changes and deprecations",
    "recent advertising product announcements and discontinued features",
  ],
  tiktok: [
    "advertising policies: prohibited and restricted industries",
    "ad creative and landing page policy requirements",
    "education and training industry advertising requirements",
    "ad review process and rejected ads",
    "targeting restrictions, minimum age and regional availability",
    "Smart+ / automated campaigns and campaign setup",
    "lead generation instant forms setup",
    "TikTok Pixel and Events API measurement setup",
    "TikTok API for Business changelog and version updates",
    "recent TikTok ads product announcements and discontinued features",
  ],
};
