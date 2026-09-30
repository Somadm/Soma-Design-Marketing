import type pg from "pg";
import type { Db, DbClient } from "../db/pool.js";
import { withTransaction } from "../db/pool.js";
import type { SourceAnalysis, StoredItem } from "../research/model.js";
import { SEED_SOURCES, normalizeUrl, platformForUrl, type Platform, type SourceCategory } from "../research/sources.js";

export interface SourceRow {
  id: number;
  platform: Platform;
  url: string;
  title: string | null;
  category: SourceCategory;
  origin: string;
  enabled: boolean;
  status: "active" | "discontinued";
  consecutive_misses: number;
  last_verified_at: Date | null;
  current_version_id: number | null;
  current_hash: string | null;
}

export const DEFAULT_CAMPAIGN_PROFILE = `Creative Academy – edit this profile in the dashboard so briefings are specific.
- What we sell: creative courses and training programmes.
- Platforms: Meta (Facebook, Instagram) and TikTok.
- Typical objectives: lead generation (course enquiries, sign-ups), traffic to course pages, awareness.
- Audiences/regions: (fill in countries and age ranges).
- Measurement: (fill in: Meta Pixel / Conversions API, TikTok Pixel / Events API).`;

export async function seedSources(db: DbClient): Promise<number> {
  let inserted = 0;
  for (const s of SEED_SOURCES) {
    const r = await db.query(
      `INSERT INTO sources (platform, url, title, category, origin) VALUES ($1,$2,$3,$4,'seed')
       ON CONFLICT (url) DO NOTHING`,
      [s.platform, normalizeUrl(s.url), s.title, s.category],
    );
    inserted += r.rowCount ?? 0;
  }
  return inserted;
}

export async function getCampaignProfile(db: DbClient): Promise<string> {
  const { rows } = await db.query<{ value: { text: string } }>("SELECT value FROM settings WHERE key = 'campaign_profile'");
  return rows[0]?.value.text ?? DEFAULT_CAMPAIGN_PROFILE;
}

export async function setCampaignProfile(db: DbClient, text: string): Promise<void> {
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('campaign_profile', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify({ text })],
  );
}

/** Adds an official URL as a source. Returns the new id, or null if it exists or is not official. */
export async function addSource(
  db: DbClient,
  raw: string,
  opts: { title?: string | null; category?: SourceCategory; origin: "discovered" | "live_check" | "manual"; platform?: Platform },
): Promise<number | null> {
  const platform = platformForUrl(raw);
  if (!platform || (opts.platform && opts.platform !== platform)) return null;
  const url = normalizeUrl(raw);
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO sources (platform, url, title, category, origin) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (url) DO NOTHING RETURNING id`,
    [platform, url, opts.title ?? null, opts.category ?? "other", opts.origin],
  );
  return rows[0] ? Number(rows[0].id) : null;
}

const SOURCE_SELECT = `
  SELECT s.id::int, s.platform, s.url, s.title, s.category, s.origin, s.enabled, s.status,
         s.consecutive_misses, s.last_verified_at, s.current_version_id::int, v.content_hash AS current_hash
  FROM sources s LEFT JOIN source_versions v ON v.id = s.current_version_id`;

export async function listMonitoredSources(db: DbClient): Promise<SourceRow[]> {
  const { rows } = await db.query<SourceRow>(
    `${SOURCE_SELECT} WHERE s.enabled AND s.status = 'active'
     ORDER BY (s.origin = 'seed') DESC, s.id`,
  );
  return rows;
}

export async function getSource(db: DbClient, id: number): Promise<SourceRow | null> {
  const { rows } = await db.query<SourceRow>(`${SOURCE_SELECT} WHERE s.id = $1`, [id]);
  return rows[0] ?? null;
}

export async function currentItems(db: DbClient, sourceId: number): Promise<StoredItem[]> {
  const { rows } = await db.query<StoredItem>(
    `SELECT id::int, topic, title, guidance, regions, account_scope, rollout_status, limitations, effective_date
     FROM knowledge_items WHERE source_id = $1 AND status = 'current' ORDER BY id`,
    [sourceId],
  );
  return rows;
}

export async function recordCheck(
  db: DbClient,
  c: {
    runId: number;
    sourceId: number;
    outcome: "unchanged" | "changed" | "new" | "discontinued" | "missing" | "failed" | "skipped";
    httpStatus?: number | null;
    attempts?: number;
    via?: string | null;
    error?: string | null;
    versionId?: number | null;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO source_checks (run_id, source_id, outcome, http_status, attempts, fetched_via, error, version_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [c.runId, c.sourceId, c.outcome, c.httpStatus ?? null, c.attempts ?? 0, c.via ?? null, c.error ?? null, c.versionId ?? null],
  );
  const failedLike = c.outcome === "failed" || c.outcome === "missing" || c.outcome === "skipped";
  await db.query(
    `UPDATE sources SET last_checked_at = now(), last_check_status = $2,
       last_error = CASE WHEN $3 THEN $4 ELSE NULL END
     WHERE id = $1`,
    [c.sourceId, c.outcome, failedLike, c.error ?? null],
  );
}

/** The page was retrieved and is byte-identical (after normalization) to the stored version. */
export async function markVerifiedUnchanged(db: DbClient, source: SourceRow): Promise<void> {
  await db.query("UPDATE source_versions SET last_verified_at = now() WHERE id = $1", [source.current_version_id]);
  await db.query("UPDATE sources SET last_verified_at = now(), consecutive_misses = 0 WHERE id = $1", [source.id]);
  await db.query("UPDATE knowledge_items SET verified_at = now() WHERE source_id = $1 AND status = 'current'", [source.id]);
}

export interface ApplyResult {
  versionId: number;
  itemsAdded: number;
  itemsArchived: number;
  changesRecorded: number;
  materialChange: boolean;
  unaccountedItemIds: number[];
}

/**
 * Stores a new version of a source and reconciles its knowledge items in one
 * transaction: unchanged items are re-verified, changed items are archived and
 * superseded, discontinued items are archived with the reason. Archived items are
 * never returned as current advice.
 */
export async function applyAnalysis(
  db: Db,
  p: {
    runId: number;
    source: SourceRow;
    text: string;
    hash: string;
    finalUrl: string;
    via: "direct" | "claude_web_fetch";
    title: string | null;
    analysis: SourceAnalysis;
    recordChanges: boolean;
  },
): Promise<ApplyResult> {
  return withTransaction(db, async (c: pg.PoolClient) => {
    await c.query("SELECT id FROM sources WHERE id = $1 FOR UPDATE", [p.source.id]);
    // Read after acquiring the lock, in a new statement, so a concurrent writer's commit is visible.
    const { rows: locked } = await c.query<{ current_version_id: number | null; hash: string | null }>(
      `SELECT s.current_version_id, v.content_hash AS hash FROM sources s
       LEFT JOIN source_versions v ON v.id = s.current_version_id WHERE s.id = $1`,
      [p.source.id],
    );
    // Another writer (a live check or refresh) stored this exact content while we were analyzing.
    if (locked[0]?.hash === p.hash && locked[0].current_version_id !== null) {
      await c.query("UPDATE source_versions SET last_verified_at = now() WHERE id = $1", [locked[0].current_version_id]);
      await c.query("UPDATE sources SET last_verified_at = now(), consecutive_misses = 0 WHERE id = $1", [p.source.id]);
      return { versionId: locked[0].current_version_id, itemsAdded: 0, itemsArchived: 0, changesRecorded: 0, materialChange: false, unaccountedItemIds: [] };
    }
    const prev = await currentItems(c, p.source.id);
    const prevById = new Map(prev.map((i) => [i.id, i]));

    const { rows: vrows } = await c.query<{ id: number }>(
      `INSERT INTO source_versions (source_id, content_hash, content_text, final_url, fetched_via, page_summary, run_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id::int`,
      [p.source.id, p.hash, p.text, p.finalUrl, p.via, p.analysis.page_summary, p.runId],
    );
    const versionId = vrows[0].id;
    const handled = new Set<number>();
    let itemsAdded = 0;
    let itemsArchived = 0;

    const insertItem = async (it: SourceAnalysis["items"][number]) => {
      const { rows } = await c.query<{ id: number }>(
        `INSERT INTO knowledge_items (platform, source_id, source_version_id, topic, title, guidance, regions,
           account_scope, rollout_status, limitations, effective_date, created_run_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id::int`,
        [
          p.source.platform, p.source.id, versionId, it.topic, it.title, it.guidance, it.regions,
          it.account_scope, it.rollout_status, it.limitations, it.effective_date, p.runId,
        ],
      );
      itemsAdded++;
      return rows[0].id;
    };
    const archive = async (id: number, reason: string, supersededBy: number | null) => {
      await c.query(
        `UPDATE knowledge_items SET status = 'archived', archived_at = now(), archived_reason = $2, superseded_by = $3
         WHERE id = $1 AND status = 'current'`,
        [id, reason, supersededBy],
      );
      itemsArchived++;
      handled.add(id);
    };

    if (p.analysis.relevant) {
      for (const it of p.analysis.items) {
        const prevId = it.previous_item_id !== null && prevById.has(it.previous_item_id) ? it.previous_item_id : null;
        if (prevId !== null && handled.has(prevId)) continue;
        if (prevId !== null && it.change === "unchanged") {
          await c.query("UPDATE knowledge_items SET verified_at = now(), source_version_id = $2 WHERE id = $1", [prevId, versionId]);
          handled.add(prevId);
          continue;
        }
        const newId = await insertItem(it);
        if (prevId !== null) await archive(prevId, "superseded by updated guidance", newId);
      }
    }
    for (const d of p.analysis.discontinued) {
      if (prevById.has(d.previous_item_id) && !handled.has(d.previous_item_id)) {
        await archive(d.previous_item_id, `discontinued: ${d.reason}`, null);
      }
    }
    // Page no longer carries advertising guidance at all: archive everything from it.
    if (!p.analysis.relevant) {
      for (const it of prev) if (!handled.has(it.id)) await archive(it.id, "source page no longer contains this guidance", null);
    }
    const unaccountedItemIds = prev.filter((i) => !handled.has(i.id)).map((i) => i.id);

    let changesRecorded = 0;
    if (p.recordChanges) {
      for (const ch of p.analysis.changes) {
        await c.query(
          `INSERT INTO knowledge_changes (run_id, platform, source_id, kind, title, summary, relevance, relevance_note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [p.runId, p.source.platform, p.source.id, ch.kind, ch.title, ch.summary, ch.relevance, ch.relevance_note],
        );
        changesRecorded++;
      }
    }

    await c.query(
      `UPDATE sources SET current_version_id = $2, last_verified_at = now(), consecutive_misses = 0,
         title = COALESCE($3, title) WHERE id = $1`,
      [p.source.id, versionId, p.title],
    );
    return {
      versionId,
      itemsAdded,
      itemsArchived,
      changesRecorded,
      materialChange: p.analysis.material_change,
      unaccountedItemIds,
    };
  });
}

/**
 * A page returned "not found". After DISCONTINUE_AFTER_MISSES consecutive misses
 * (or immediately if we never had content for it) the source is discontinued and
 * its guidance archived. Returns true if the source was discontinued.
 */
export async function registerMiss(
  db: Db,
  p: { runId: number; source: SourceRow; reason: string; threshold: number; recordChanges: boolean },
): Promise<{ discontinued: boolean; itemsArchived: number }> {
  return withTransaction(db, async (c) => {
    const { rows } = await c.query<{ consecutive_misses: number }>(
      "UPDATE sources SET consecutive_misses = consecutive_misses + 1 WHERE id = $1 RETURNING consecutive_misses",
      [p.source.id],
    );
    const misses = rows[0].consecutive_misses;
    // A discovered page that 404s on first sight was never real guidance; seeds must be confirmed.
    const neverIndexed = p.source.current_version_id === null && p.source.origin !== "seed";
    if (misses < p.threshold && !neverIndexed) return { discontinued: false, itemsArchived: 0 };

    await c.query("UPDATE sources SET status = 'discontinued' WHERE id = $1", [p.source.id]);
    const r = await c.query(
      `UPDATE knowledge_items SET status = 'archived', archived_at = now(), archived_reason = $2
       WHERE source_id = $1 AND status = 'current'`,
      [p.source.id, `source discontinued by publisher (${p.reason})`],
    );
    if (p.recordChanges && p.source.current_version_id !== null) {
      await c.query(
        `INSERT INTO knowledge_changes (run_id, platform, source_id, kind, title, summary) VALUES ($1,$2,$3,'discontinued',$4,$5)`,
        [
          p.runId, p.source.platform, p.source.id, p.source.title ?? p.source.url,
          `The official page ${p.source.url} is no longer available (${p.reason}); its ${r.rowCount} guidance item(s) were archived.`,
        ],
      );
    }
    return { discontinued: true, itemsArchived: r.rowCount ?? 0 };
  });
}
