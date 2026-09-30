import { z } from "zod";
import type { Budget } from "./budget.js";
import type { PageLink } from "./fetcher.js";
import type { Platform, SourceType } from "./sources.js";

export const CATEGORIES = ["policy", "feature_availability", "setup_steps", "specifications", "measurement", "announcement", "other"] as const;
export type Category = (typeof CATEGORIES)[number];
/** Categories whose guidance changes often enough that Bilan re-verifies them live before answering. */
export const CHANGEABLE: Category[] = ["policy", "feature_availability", "setup_steps"];

export const LimitationSchema = z.strictObject({
  kind: z.enum(["region", "account", "rollout", "placement", "other"]),
  text: z.string(),
});
export type Limitation = z.infer<typeof LimitationSchema>;

export const ExtractionSchema = z.strictObject({
  relevant_page: z.boolean().describe("false if the page has no advertising guidance for this platform (e.g. an index page)"),
  page_change: z.enum(["none", "cosmetic", "substantive"]).describe("versus the stored entries; 'cosmetic' = wording/layout only"),
  entries: z.array(
    z.strictObject({
      slug: z.string().describe("kebab-case id; reuse the stored slug for the same guidance"),
      title: z.string(),
      category: z.enum(CATEGORIES),
      summary: z.string().describe("1-2 sentences"),
      body: z.string().describe("the guidance, faithful to the source, 2-8 sentences"),
      limitations: z.array(LimitationSchema).describe("regional, account-specific, rollout and placement limits the source states"),
      relevance: z.string().describe("For Creative Academy: one or two sentences on what this means for its campaigns"),
      classification: z.enum(["new", "changed", "unchanged", "cosmetic"]),
      what_changed: z.string().nullable().describe("for changed entries: one sentence on what changed"),
    }),
  ),
  removed: z.array(z.strictObject({ slug: z.string(), reason: z.string() })).describe("stored entries no longer supported by the page"),
  follow_links: z.array(z.string()).describe("URLs from links_on_page that are specific official guidance pages worth indexing (max 10)"),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

export interface StoredEntry {
  slug: string;
  title: string;
  category: string;
  summary: string;
  body: string;
  limitations: Limitation[];
}

export interface ExtractInput {
  platform: Platform;
  url: string;
  title: string;
  sourceType: SourceType;
  pageText: string;
  links: PageLink[];
  stored: StoredEntry[];
  campaignProfile: string;
}

export const DiscoveredSchema = z.strictObject({
  pages: z.array(
    z.strictObject({
      url: z.string(),
      title: z.string(),
      source_type: z.enum(["policy", "help_centre", "api_docs", "announcements"]),
    }),
  ),
});
export type DiscoveredPage = z.infer<typeof DiscoveredSchema>["pages"][number];

export interface BriefingChangeInput {
  ref: string;
  platform: Platform;
  kind: "New" | "Changed" | "Archived";
  title: string;
  what_changed: string | null;
  summary: string;
  relevance: string | null;
  limitations: Limitation[];
  source_url: string;
}

export const BriefingSchema = z.strictObject({
  summary: z.string().describe("1-2 sentences: counts of changed/new/discontinued and which matter for current creative"),
  sections: z.array(
    z.strictObject({
      platform: z.enum(["meta", "tiktok"]),
      items: z.array(
        z.strictObject({
          ref: z.string(),
          kind: z.enum(["New", "Changed", "Archived"]),
          title: z.string(),
          what: z.string().describe("what changed, one sentence"),
          means: z.string().describe("what it means for Creative Academy, one sentence"),
          scope: z.string().nullable().describe("regional/account/rollout limitations, or null"),
        }),
      ),
    }),
  ),
  recommendations: z.array(z.string()).describe("proposed actions for Sabah to approve; never publishing or spend changes"),
});
export type BriefingOutput = z.infer<typeof BriefingSchema>;

export interface BriefingInput {
  runCode: string;
  sourcesVerified: number;
  changes: BriefingChangeInput[];
  campaignProfile: string;
}

export interface KnowledgeForAnswer {
  ref: string;
  platform: Platform;
  title: string;
  summary: string;
  body: string;
  relevance: string | null;
  limitations: Limitation[];
  source_url: string;
  verified_at: string;
  version: number;
  stale: boolean;
}

export interface AnswerInput {
  question: string;
  platform: Platform | null;
  knowledge: KnowledgeForAnswer[];
  liveCheckNotes: string[];
  campaignProfile: string;
}

export type ClaudeFetchResult = { ok: true; text: string; finalUrl: string } | { ok: false; error: string };

/** Everything that costs money goes through this interface (a fake implements it in tests). */
export interface ResearchModel {
  extract(input: ExtractInput, budget: Budget): Promise<Extraction>;
  discover(platform: Platform, topics: string[], knownUrls: string[], maxSearches: number, budget: Budget): Promise<DiscoveredPage[]>;
  fetchViaClaude(url: string, platform: Platform, budget: Budget): Promise<ClaudeFetchResult>;
  brief(input: BriefingInput, budget: Budget): Promise<BriefingOutput>;
  answer(input: AnswerInput, budget: Budget): Promise<string>;
}
