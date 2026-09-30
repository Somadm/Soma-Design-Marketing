import type { DbClient } from "../db/pool.js";
import type { Budget } from "../research/budget.js";
import { hasVectorColumn, toVectorLiteral, type Embedder } from "../research/embeddings.js";
import type { Limitation } from "../research/model.js";
import type { Platform } from "../research/sources.js";

export interface SearchHit {
  entry_id: number;
  version_id: number;
  version: number;
  platform: Platform;
  source_id: number;
  source_url: string;
  slug: string;
  title: string;
  category: string;
  summary: string;
  body: string;
  relevance: string | null;
  limitations: Limitation[];
  verified_at: Date;
  origin: string;
  /** The source failed in the latest refresh, is paused, or is escalated: guidance may be out of date. */
  stale: boolean;
  score: number;
}

const SELECT = `
  SELECT e.id AS entry_id, ev.id AS version_id, ev.version, e.platform, e.source_id, s.url AS source_url, e.slug,
         e.title, e.category, ev.summary, ev.body, ev.relevance, ev.limitations, ev.verified_at, ev.origin,
         (s.status = 'paused' OR s.escalated_at IS NOT NULL OR EXISTS (
            SELECT 1 FROM run_sources rs WHERE rs.source_id = s.id AND rs.result IN ('failed','skipped')
              AND rs.run_id = (SELECT max(id) FROM refresh_runs WHERE trigger <> 'live_check' AND status NOT IN ('queued','running'))
         )) AS stale
  FROM entry_versions ev JOIN entries e ON e.id = ev.entry_id JOIN sources s ON s.id = e.source_id`;

/**
 * Hybrid search over CURRENT entry versions only (archived versions are never
 * returned as advice): full-text rank fused with vector similarity when embeddings
 * are available (reciprocal rank fusion). Filtered by platform when known.
 */
export async function searchKb(
  db: DbClient,
  query: string,
  opts: { platform?: Platform | null; limit?: number; embedder?: Embedder | null; budget?: Budget | null } = {},
): Promise<SearchHit[]> {
  const limit = opts.limit ?? 8;
  const platform = opts.platform ?? null;
  const { rows: fts } = await db.query<SearchHit>(
    `WITH q AS (
       SELECT to_tsquery('english', coalesce(nullif(string_agg(lexeme, ' | '), ''), 'zzzznomatch')) AS tsq
       FROM unnest(to_tsvector('english', $1))
     )
     ${SELECT}, q
     WHERE ev.status = 'current' AND ev.tsv @@ q.tsq AND ($2::text IS NULL OR e.platform = $2)
     ORDER BY ts_rank_cd(ev.tsv, q.tsq) DESC, ev.verified_at DESC LIMIT 40`,
    [query, platform],
  );
  let vec: SearchHit[] = [];
  if (opts.embedder && (await hasVectorColumn(db))) {
    try {
      const [qv] = await opts.embedder.embed([query], "query", opts.budget ?? null);
      ({ rows: vec } = await db.query<SearchHit>(
        `${SELECT} WHERE ev.status = 'current' AND ev.embedding IS NOT NULL AND ($2::text IS NULL OR e.platform = $2)
         ORDER BY ev.embedding <=> $1::vector LIMIT 40`,
        [toVectorLiteral(qv), platform],
      ));
    } catch (err) {
      console.error(JSON.stringify({ level: "WARN", message: "vector search unavailable, using full-text only", err: String(err) }));
    }
  }
  const byId = new Map<number, SearchHit>();
  const add = (list: SearchHit[]) =>
    list.forEach((h, i) => {
      const cur = byId.get(h.version_id) ?? { ...h, score: 0 };
      cur.score += 1 / (60 + i + 1);
      byId.set(h.version_id, cur);
    });
  add(fts);
  add(vec);
  return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

export function detectPlatform(question: string): Platform | null {
  const meta = /\b(meta|facebook|fb|instagram|ig|reels|advantage\+?|messenger|whatsapp)\b/i.test(question);
  const tiktok = /\b(tik ?tok|spark ads?|smart\+)\b/i.test(question);
  if (meta && !tiktok) return "meta";
  if (tiktok && !meta) return "tiktok";
  return null;
}
