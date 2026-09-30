import type { DbClient } from "../db/pool.js";
import type { Platform } from "../research/sources.js";

export interface KnowledgeHit {
  id: number;
  platform: Platform;
  source_id: number;
  source_url: string;
  topic: string;
  title: string;
  guidance: string;
  regions: string[];
  account_scope: string | null;
  rollout_status: string | null;
  limitations: string | null;
  effective_date: string | null;
  verified_at: Date;
  source_last_verified_at: Date | null;
  rank: number;
}

/**
 * Full-text search over CURRENT guidance only (archived items are never returned).
 * Terms are OR-ed so natural-language questions still match; ranking favours items
 * matching more terms, in the title first.
 */
export async function searchKnowledge(
  db: DbClient,
  query: string,
  opts: { platform?: Platform | null; limit?: number } = {},
): Promise<KnowledgeHit[]> {
  const { rows } = await db.query<KnowledgeHit>(
    `WITH q AS (
       SELECT to_tsquery('english', coalesce(nullif(string_agg(lexeme, ' | '), ''), 'zzzznomatch')) AS tsq
       FROM unnest(to_tsvector('english', $1))
     )
     SELECT k.id::int, k.platform, k.source_id::int, s.url AS source_url, k.topic, k.title, k.guidance, k.regions,
            k.account_scope, k.rollout_status, k.limitations, k.effective_date, k.verified_at,
            s.last_verified_at AS source_last_verified_at, ts_rank_cd(k.search_tsv, q.tsq) AS rank
     FROM knowledge_items k JOIN sources s ON s.id = k.source_id, q
     WHERE k.status = 'current' AND k.search_tsv @@ q.tsq AND ($2::text IS NULL OR k.platform = $2)
     ORDER BY rank DESC, k.verified_at DESC
     LIMIT $3`,
    [query, opts.platform ?? null, opts.limit ?? 12],
  );
  return rows;
}

export function detectPlatform(question: string): Platform | null {
  const meta = /\b(meta|facebook|fb|instagram|ig|advantage\+?|reels on instagram|whatsapp)\b/i.test(question);
  const tiktok = /\b(tik ?tok|spark ads?|smart\+)\b/i.test(question);
  if (meta && !tiktok) return "meta";
  if (tiktok && !meta) return "tiktok";
  return null;
}

/** Questions about things that change: policies, features, availability, setup steps, APIs, limits. */
export function involvesChangeableGuidance(question: string): boolean {
  return /(polic|allow|prohibit|restrict|rule|require|approv|reject|disapprov|review|set ?up|configur|install|how (do|to|can)|step|feature|availab|launch|new|deprecat|discontinu|sunset|api|pixel|conversions|events api|targeting|audience|age|minimum|limit|eligib|verif|special ad|categor|beta|rollout|region|country|countries|compliance|claim|lead (ad|form)|instant form|advantage|smart\+)/i.test(
    question,
  );
}
