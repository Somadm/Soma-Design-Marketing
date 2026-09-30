import type { Db } from "../db/pool.js";
import { addSource, currentEntries, type SourceRow, type Staged } from "../kb/store.js";
import type { RunLog } from "../log.js";
import type { Budget } from "../research/budget.js";
import { hasVectorColumn, type Embedder } from "../research/embeddings.js";
import { contentHash, type FetchOutcome } from "../research/fetcher.js";
import type { ResearchModel } from "../research/model.js";
import { platformForUrl } from "../research/sources.js";

export interface StageDeps {
  db: Db;
  model: ResearchModel;
  embedder: Embedder | null;
  campaignProfile: string;
  log: RunLog;
}

export interface StageResult {
  staged: Staged;
  followLinks: string[];
}

export function tag(source: SourceRow): string {
  return `[${source.platform === "meta" ? "META" : "TIKTOK"}] ${source.url.replace(/^https:\/\/(www\.)?/, "")}`;
}

/**
 * Turns a successful retrieval into a staged result: compare → (if different)
 * extract and classify with Claude → embed new entry versions. Nothing is written
 * as current here.
 */
export async function stageRetrieved(deps: StageDeps, source: SourceRow, fetched: Exclude<FetchOutcome, { kind: "failed" }>, budget: Budget): Promise<StageResult> {
  if (fetched.kind === "discontinued") {
    let replacementSourceId: number | null = null;
    if (fetched.redirectTo && platformForUrl(fetched.redirectTo) === source.platform) {
      replacementSourceId = await addSource(deps.db, fetched.redirectTo, { origin: "redirect", platform: source.platform, sourceType: source.source_type });
    }
    return {
      staged: { kind: "discontinued", baseVersionId: source.current_version_id, reason: fetched.reason, redirectTo: fetched.redirectTo, replacementSourceId },
      followLinks: [],
    };
  }

  const hash = contentHash(fetched.text);
  if (source.current_hash === hash && source.current_version_id !== null) {
    return { staged: { kind: "unchanged", baseVersionId: source.current_version_id, hash, via: fetched.via }, followLinks: [] };
  }

  await deps.log.info("compare", `${tag(source)} · content differs from stored version; extracting and comparing entries`);
  const stored = await currentEntries(deps.db, source.id);
  const extraction = await deps.model.extract(
    {
      platform: source.platform,
      url: source.url,
      title: source.title,
      sourceType: source.source_type,
      pageText: fetched.text,
      links: fetched.links,
      stored: stored.map(({ slug, title, category, summary, body, limitations }) => ({ slug, title, category, summary, body, limitations })),
      campaignProfile: deps.campaignProfile,
    },
    budget,
  );

  let embeddings: Record<string, number[]> | null = null;
  const toEmbed = extraction.entries.filter((e) => e.classification === "new" || e.classification === "changed" || !stored.some((s) => s.slug === e.slug));
  if (deps.embedder && toEmbed.length && (await hasVectorColumn(deps.db))) {
    const vectors = await deps.embedder.embed(
      toEmbed.map((e) => `${e.title}\n${e.summary}\n${e.body}\n${e.limitations.map((l) => l.text).join(" ")}`),
      "document",
      budget,
    );
    embeddings = Object.fromEntries(toEmbed.map((e, i) => [e.slug, vectors[i]]));
  }

  return {
    staged: {
      kind: "content",
      baseVersionId: source.current_version_id,
      hash,
      text: fetched.text,
      finalUrl: fetched.finalUrl,
      via: fetched.via,
      fetchedAt: new Date().toISOString(),
      extraction,
      embeddings,
    },
    followLinks: extraction.follow_links,
  };
}
