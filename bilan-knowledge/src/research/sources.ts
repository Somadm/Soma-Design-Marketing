export type Platform = "meta" | "tiktok";
export type SourceType = "policy" | "help_centre" | "api_docs" | "announcements";

export const PLATFORMS: Platform[] = ["meta", "tiktok"];
export const PLATFORM_LABEL: Record<Platform, string> = { meta: "Meta", tiktok: "TikTok" };

/**
 * Official source domains (Settings → Official source domains). A page is only
 * stored as guidance if it matches one of its platform's rules. Third-party pages
 * can suggest leads but are never stored.
 */
export const OFFICIAL_DOMAINS: Record<Platform, { host: string; path?: string }[]> = {
  meta: [
    { host: "transparency.meta.com" },
    { host: "facebook.com", path: "/business" },
    { host: "developers.facebook.com" },
    { host: "about.fb.com", path: "/news" },
  ],
  tiktok: [
    { host: "ads.tiktok.com", path: "/help" },
    { host: "business-api.tiktok.com" },
    { host: "tiktok.com", path: "/business" },
  ],
};

export function domainLabels(platform: Platform): string[] {
  return OFFICIAL_DOMAINS[platform].map((d) => d.host + (d.path ?? ""));
}

/** Hostnames for Claude's web search/fetch tools; paths are enforced by platformForUrl. */
export function toolDomains(platform: Platform): string[] {
  return [...new Set(OFFICIAL_DOMAINS[platform].map((d) => d.host))];
}

export function platformForUrl(raw: string): Platform | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  for (const platform of PLATFORMS) {
    for (const rule of OFFICIAL_DOMAINS[platform]) {
      if (host !== rule.host) continue;
      if (!rule.path || url.pathname === rule.path || url.pathname.startsWith(`${rule.path}/`)) return platform;
    }
  }
  return null;
}

/** Canonical form for de-duplication: no fragment, no tracking params, no trailing slash. */
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

/** Display form used in the UI: no scheme, no www. */
export function displayUrl(raw: string): string {
  return raw.replace(/^https:\/\//, "").replace(/^www\./, "");
}

export interface SeedSource {
  platform: Platform;
  url: string;
  title: string;
  source_type: SourceType;
}

/**
 * Starting points for the initial research. Discovery (Claude web search limited
 * to the official domains) finds the specific policy, help-centre and changelog
 * pages beneath them. A seed that cannot be retrieved is reported as failed.
 */
export const SEED_SOURCES: SeedSource[] = [
  { platform: "meta", url: "https://transparency.meta.com/policies/ad-standards", title: "Advertising Standards", source_type: "policy" },
  { platform: "meta", url: "https://www.facebook.com/business/help", title: "Meta Business Help Centre", source_type: "help_centre" },
  { platform: "meta", url: "https://www.facebook.com/business/ads-guide", title: "Ads Guide: ad specifications", source_type: "help_centre" },
  { platform: "meta", url: "https://developers.facebook.com/docs/marketing-api", title: "Marketing API", source_type: "api_docs" },
  { platform: "meta", url: "https://developers.facebook.com/docs/graph-api/changelog", title: "Graph and Marketing API changelog", source_type: "api_docs" },
  { platform: "meta", url: "https://developers.facebook.com/docs/marketing-api/conversions-api", title: "Conversions API", source_type: "api_docs" },
  { platform: "meta", url: "https://developers.facebook.com/docs/meta-pixel", title: "Meta Pixel", source_type: "api_docs" },
  { platform: "meta", url: "https://www.facebook.com/business/news", title: "Meta for Business news", source_type: "announcements" },
  { platform: "meta", url: "https://about.fb.com/news", title: "Meta Newsroom", source_type: "announcements" },
  { platform: "tiktok", url: "https://ads.tiktok.com/help/article/tiktok-advertising-policies-industry-entry", title: "Advertising policies: industry entry", source_type: "policy" },
  { platform: "tiktok", url: "https://ads.tiktok.com/help/article/tiktok-advertising-policies-ad-creatives-landing-page", title: "Ad creative and landing page policy", source_type: "policy" },
  { platform: "tiktok", url: "https://ads.tiktok.com/help", title: "TikTok Ads Help Centre", source_type: "help_centre" },
  { platform: "tiktok", url: "https://business-api.tiktok.com/portal/docs", title: "TikTok API for Business docs", source_type: "api_docs" },
  { platform: "tiktok", url: "https://www.tiktok.com/business/en/blog", title: "TikTok for Business blog", source_type: "announcements" },
];

/** What discovery searches for, weighted toward Creative Academy's campaigns. */
export const DISCOVERY_TOPICS: Record<Platform, string[]> = {
  meta: [
    "advertising standards: prohibited and restricted content",
    "financial and income claims in ads, including courses and education",
    "ad review, rejected ads and appeals",
    "special ad categories and targeting restrictions",
    "Reels, Stories, carousel and image ad specifications and safe zones",
    "Advantage+ campaigns setup",
    "lead ads and instant forms setup",
    "Meta Pixel and Conversions API event setup",
    "business verification",
    "Marketing API version changes, deprecations and new features",
  ],
  tiktok: [
    "advertising policies: prohibited and restricted industries",
    "ad creative and landing page policy, including landing page language",
    "education and course ads, claims about results or earnings",
    "video ad specifications and safe zones",
    "Spark Ads authorisation",
    "Smart+ campaigns availability and setup",
    "lead generation instant forms",
    "TikTok Pixel and Events API setup",
    "API for Business changelog",
    "new TikTok ads features and discontinued features",
  ],
};
