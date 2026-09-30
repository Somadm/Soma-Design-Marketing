import { z } from "zod";
import type { Budget } from "./budget.js";
import type { PageLink } from "./fetcher.js";
import type { Platform, SourceCategory } from "./sources.js";

export const AnalyzedItemSchema = z.strictObject({
  previous_item_id: z.number().nullable().describe("id of the stored item this corresponds to, or null if new"),
  change: z.enum(["new", "changed", "unchanged"]),
  topic: z.string().describe("short topic label, e.g. 'education ads', 'lead forms', 'pixel setup'"),
  title: z.string(),
  guidance: z.string().describe("the guidance itself, faithful to the source, 1-6 sentences"),
  regions: z.array(z.string()).describe("regions/countries it applies to or is limited to; empty if global/unspecified"),
  account_scope: z.string().nullable().describe("account-specific limits (e.g. 'only some advertisers', 'business verification required')"),
  rollout_status: z.string().nullable().describe("e.g. 'beta', 'gradual rollout', 'generally available', 'deprecated from v22'"),
  limitations: z.string().nullable().describe("any other caveats the source states"),
  effective_date: z.string().nullable().describe("date the guidance takes/took effect if the source states one"),
});

export const SourceAnalysisSchema = z.strictObject({
  relevant: z.boolean().describe("false if the page contains no advertising guidance for this platform"),
  material_change: z.boolean().describe("true if the guidance differs in substance from the stored items"),
  page_summary: z.string(),
  items: z.array(AnalyzedItemSchema).describe("ALL guidance on the page as it stands now, including unchanged items"),
  discontinued: z
    .array(z.strictObject({ previous_item_id: z.number(), reason: z.string() }))
    .describe("stored items that are no longer current (removed from page, or the page says they are discontinued/replaced)"),
  changes: z
    .array(
      z.strictObject({
        kind: z.enum(["new", "changed", "discontinued"]),
        title: z.string(),
        summary: z.string(),
        relevance: z.enum(["high", "medium", "low", "none"]).describe("relevance to the advertiser_context campaigns"),
        relevance_note: z.string().describe("one sentence: why it matters (or not) for the advertiser's campaigns"),
      }),
    )
    .describe("human-readable list of substantive changes versus the stored items; empty if none"),
  follow_links: z
    .array(z.string())
    .describe("URLs from the provided link list that are specific official guidance pages worth indexing (max 15)"),
});

export type AnalyzedItem = z.infer<typeof AnalyzedItemSchema>;
export type SourceAnalysis = z.infer<typeof SourceAnalysisSchema>;

export interface StoredItem {
  id: number;
  topic: string;
  title: string;
  guidance: string;
  regions: string[];
  account_scope: string | null;
  rollout_status: string | null;
  limitations: string | null;
  effective_date: string | null;
}

export interface AnalyzeInput {
  platform: Platform;
  url: string;
  title: string | null;
  pageText: string;
  links: PageLink[];
  previousItems: StoredItem[];
  campaignProfile: string;
}

export const DiscoveredSchema = z.strictObject({
  pages: z.array(
    z.strictObject({
      url: z.string(),
      title: z.string(),
      category: z.enum(["policy", "help", "api", "announcement", "other"]),
      why: z.string(),
    }),
  ),
});

export interface DiscoveredPage {
  url: string;
  title: string;
  category: SourceCategory;
}

export interface BriefingChange {
  platform: Platform;
  kind: "new" | "changed" | "discontinued";
  title: string;
  summary: string;
  relevance: "high" | "medium" | "low" | "none";
  relevance_note: string | null;
  sourceUrl: string | null;
}

export interface BriefingInput {
  complete: boolean;
  changes: BriefingChange[];
  failedSources: { platform: Platform; url: string; error: string }[];
  campaignProfile: string;
  runDate: string;
}

export interface KnowledgeForAnswer {
  ref: string;
  platform: Platform;
  title: string;
  guidance: string;
  regions: string[];
  account_scope: string | null;
  rollout_status: string | null;
  limitations: string | null;
  source_url: string;
  verified_at: string;
}

export interface AnswerInput {
  question: string;
  platform: Platform | null;
  knowledge: KnowledgeForAnswer[];
  liveCheckNotes: string[];
  campaignProfile: string;
  allowWebSearch: boolean;
}

export interface AnswerOutput {
  answer: string;
  /** Official URLs found by web search during answering (candidates to save as sources). */
  searchedUrls: { url: string; title: string; platform: Platform }[];
}

export type ClaudeFetchResult = { ok: true; text: string; finalUrl: string } | { ok: false; error: string };

/** Everything that costs money or needs the network beyond plain HTTP goes through this interface. */
export interface ResearchModel {
  analyzeSource(input: AnalyzeInput, budget: Budget): Promise<SourceAnalysis>;
  discoverSources(
    platform: Platform,
    topics: string[],
    knownUrls: string[],
    maxSearches: number,
    budget: Budget,
  ): Promise<DiscoveredPage[]>;
  fetchViaClaude(url: string, platform: Platform, budget: Budget): Promise<ClaudeFetchResult>;
  writeBriefing(input: BriefingInput, budget: Budget): Promise<string>;
  answer(input: AnswerInput, budget: Budget): Promise<AnswerOutput>;
}
