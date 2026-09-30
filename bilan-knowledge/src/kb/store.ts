import type pg from "pg";
import type { DbClient } from "../db/pool.js";
import { toVectorLiteral } from "../research/embeddings.js";
import type { Extraction, Limitation, StoredEntry } from "../research/model.js";
import { SEED_SOURCES, normalizeUrl, platformForUrl, type Platform, type SourceType } from "../research/sources.js";

export interface SourceRow {
  id: number;
  platform: Platform;
  title: string;
  url: string;
  source_type: SourceType;
  status: "active" | "discontinued" | "paused";
  fetch_mode: "direct" | "rendered";
  origin: string;
  consecutive_failures: number;
  current_version_id: number | null;
  current_hash: string | null;
  current_length: number | null;
  current_verified_at: Date | null;
}

const SOURCE_SELECT = `
  SELECT s.id, s.platform, s.title, s.url, s.source_type, s.status, s.fetch_mode, s.origin, s.consecutive_failures,
         s.current_version_id, v.content_hash AS current_hash, length(v.normalised_text) AS current_length,
         v.verified_at AS current_verified_at
  FROM sources s LEFT JOIN source_versions v ON v.id = s.current_version_id`;

export async function getSource(db: DbClient, id: number): Promise<SourceRow | null> {
  const { rows } = await db.query<SourceRow>(`${SOURCE_SELECT} WHERE s.id = $1`, [id]);
  return rows[0] ?? null;
}

export async function activeSources(db: DbClient): Promise<SourceRow[]> {
  const { rows } = await db.query<SourceRow>(`${SOURCE_SELECT} WHERE s.status = 'active' ORDER BY s.platform, s.id`);
  return rows;
}

export async function seedSources(db: DbClient): Promise<number> {
  let n = 0;
  for (const s of SEED_SOURCES) {
    const r = await db.query(
      `INSERT INTO sources (platform, title, url, source_type, origin) VALUES ($1,$2,$3,$4,'seed') ON CONFLICT (url) DO NOTHING`,
      [s.platform, s.title, normalizeUrl(s.url), s.source_type],
    );
    n += r.rowCount ?? 0;
  }
  return n;
}

/** Adds an official page as a source. Returns its id if newly added; null if not official or already tracked. */
export async function addSource(
  db: DbClient,
  raw: string,
  opts: { title?: string | null; sourceType?: SourceType; origin: "discovered" | "redirect" | "live_check" | "manual"; platform?: Platform },
): Promise<number | null> {
  const platform = platformForUrl(raw);
  if (!platform || (opts.platform && opts.platform !== platform)) return null;
  const url = normalizeUrl(raw);
  const fromPath = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() ?? url).replace(/[-_]/g, " ");
  const title = opts.title?.trim() || fromPath.charAt(0).toUpperCase() + fromPath.slice(1);
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO sources (platform, title, url, source_type, origin) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (url) DO NOTHING RETURNING id`,
    [platform, title.slice(0, 200), url, opts.sourceType ?? "help_centre", opts.origin],
  );
  return rows[0]?.id ?? null;
}

export interface CurrentEntry extends StoredEntry {
  entry_id: number;
  version_id: number;
  version: number;
  relevance: string | null;
}

export async function currentEntries(db: DbClient, sourceId: number): Promise<CurrentEntry[]> {
  const { rows } = await db.query<CurrentEntry>(
    `SELECT e.id AS entry_id, ev.id AS version_id, ev.version, e.slug, e.title, e.category, ev.summary, ev.body,
            ev.limitations, ev.relevance
     FROM entries e JOIN entry_versions ev ON ev.entry_id = e.id AND ev.status = 'current'
     WHERE e.source_id = $1 ORDER BY e.id`,
    [sourceId],
  );
  return rows;
}

// ---------- Staging (held in run_sources.staged_source_version until finalize) ----------

export type Staged =
  | { kind: "unchanged"; baseVersionId: number; hash: string; via: string }
  | {
      kind: "content";
      baseVersionId: number | null;
      hash: string;
      text: string;
      finalUrl: string;
      via: "direct" | "rendered" | "claude_web_fetch";
      fetchedAt: string;
      extraction: Extraction;
      /** Embeddings for entries that get a new version, keyed by slug. */
      embeddings: Record<string, number[]> | null;
    }
  | { kind: "discontinued"; baseVersionId: number | null; reason: string; redirectTo: string | null; replacementSourceId: number | null };

export type RunResult = "unchanged" | "cosmetic" | "changed" | "new" | "discontinued";

export function resultOf(staged: Staged): RunResult {
  if (staged.kind === "unchanged") return "unchanged";
  if (staged.kind === "discontinued") return "discontinued";
  if (staged.baseVersionId === null) return "new";
  const x = staged.extraction;
  const substantive =
    x.page_change === "substantive" &&
    (x.removed.length > 0 || x.entries.some((e) => e.classification === "changed" || e.classification === "new") || !x.relevant_page);
  return substantive ? "changed" : "cosmetic";
}

export interface PromoteContext {
  runId: number;
  runCode: string;
  origin: "refresh" | "live_check";
  vectors: boolean;
}

export interface PromotedChange {
  ref: string;
  entryId: number;
  kind: "new" | "changed" | "archived";
}

export class PromotionConflict extends Error {}

/**
 * Promotes one source's staged result inside the caller's transaction:
 * new source version, new entry versions, archived superseded/removed entries,
 * change records. Throws PromotionConflict if the source changed since staging.
 */
export async function promoteSource(c: pg.PoolClient, ctx: PromoteContext, source: SourceRow, staged: Staged): Promise<PromotedChange[]> {
  await c.query("SELECT id FROM sources WHERE id = $1 FOR UPDATE", [source.id]);
  // New statement after the lock so a concurrent writer's commit is visible.
  const { rows: cur } = await c.query<{ current_version_id: number | null; hash: string | null }>(
    `SELECT s.current_version_id, v.content_hash AS hash FROM sources s
     LEFT JOIN source_versions v ON v.id = s.current_version_id WHERE s.id = $1`,
    [source.id],
  );
  const currentId = cur[0]?.current_version_id ?? null;
  let effective = staged;
  if (staged.baseVersionId !== currentId) {
    // A live check promoted this page while the refresh was running.
    if (staged.kind === "content" && cur[0]?.hash === staged.hash && currentId !== null) {
      effective = { kind: "unchanged", baseVersionId: currentId, hash: staged.hash, via: staged.via };
    } else if (!(staged.kind === "unchanged" && cur[0]?.hash === staged.hash && currentId !== null)) {
      throw new PromotionConflict(`${source.url} changed during the run; it will be re-checked`);
    } else {
      effective = { ...staged, baseVersionId: currentId! } as Staged;
    }
  }

  const changes: PromotedChange[] = [];
  const archive = async (versionId: number, reason: string) => {
    await c.query(
      "UPDATE entry_versions SET status = 'archived', archived_at = now(), archived_reason = $2 WHERE id = $1 AND status = 'current'",
      [versionId, reason],
    );
  };
  const recordChange = async (entryId: number, kind: PromotedChange["kind"], from: number | null, to: number | null, what: string | null, ref: string) => {
    await c.query(
      `INSERT INTO changes (run_id, platform, entry_id, kind, from_version_id, to_version_id, what_changed) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [ctx.runId, source.platform, entryId, kind, from, to, what],
    );
    changes.push({ ref, entryId, kind });
  };

  if (effective.kind === "unchanged") {
    await c.query("UPDATE source_versions SET verified_at = now() WHERE id = $1", [effective.baseVersionId]);
    await c.query(
      `UPDATE entry_versions ev SET verified_at = now() FROM entries e
       WHERE ev.entry_id = e.id AND e.source_id = $1 AND ev.status = 'current'`,
      [source.id],
    );
    await c.query("UPDATE sources SET consecutive_failures = 0, escalated_at = NULL WHERE id = $1", [source.id]);
    return changes;
  }

  if (effective.kind === "discontinued") {
    await c.query(
      `UPDATE sources SET status = 'discontinued', discontinued_at = now(), replaced_by = $2, consecutive_failures = 0, escalated_at = NULL WHERE id = $1`,
      [source.id, effective.replacementSourceId],
    );
    await c.query("UPDATE source_versions SET status = 'discontinued', superseded_at = now() WHERE source_id = $1 AND status = 'current'", [source.id]);
    const entries = await currentEntries(c, source.id);
    const reason = `Source discontinued in ${ctx.runCode}${effective.redirectTo ? `; redirects to ${effective.redirectTo}` : ""}. Not used as current advice.`;
    for (const e of entries) {
      await archive(e.version_id, reason);
      await recordChange(e.entry_id, "archived", e.version_id, null, effective.reason, `${source.platform}:${e.slug}`);
    }
    return changes;
  }

  // New content.
  const { rows: vr } = await c.query<{ next: number }>("SELECT COALESCE(max(version), 0) + 1 AS next FROM source_versions WHERE source_id = $1", [source.id]);
  await c.query("UPDATE source_versions SET status = 'superseded', superseded_at = now() WHERE source_id = $1 AND status = 'current'", [source.id]);
  const { rows: sv } = await c.query<{ id: number }>(
    `INSERT INTO source_versions (source_id, version, content_hash, normalised_text, final_url, fetched_via, fetched_at, verified_at, run_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8) RETURNING id`,
    [source.id, vr[0].next, effective.hash, effective.text, effective.finalUrl, effective.via, effective.fetchedAt, ctx.runId],
  );
  const svId = sv[0].id;
  await c.query("UPDATE sources SET current_version_id = $2, consecutive_failures = 0, escalated_at = NULL WHERE id = $1", [source.id, svId]);

  const x = effective.extraction;
  const existing = await currentEntries(c, source.id);
  const bySlug = new Map(existing.map((e) => [e.slug, e]));
  const handled = new Set<number>();

  const insertVersion = async (entryId: number, version: number, e: Extraction["entries"][number]) => {
    const emb = effective.embeddings?.[e.slug];
    const { rows } = await c.query<{ id: number }>(
      `INSERT INTO entry_versions (entry_id, version, source_version_id, title_cache, summary, body, relevance, limitations,
         origin, run_id, verified_at${ctx.vectors && emb ? ", embedding" : ""})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()${ctx.vectors && emb ? ", $11" : ""}) RETURNING id`,
      [entryId, version, svId, e.title, e.summary, e.body, e.relevance, JSON.stringify(e.limitations), ctx.origin, ctx.runId,
        ...(ctx.vectors && emb ? [toVectorLiteral(emb)] : [])],
    );
    return rows[0].id;
  };

  if (x.relevant_page) {
    for (const e of x.entries) {
      const ref = `${source.platform}:${e.slug}`;
      const prev = bySlug.get(e.slug);
      if (prev && !handled.has(prev.entry_id) && (e.classification === "unchanged" || e.classification === "cosmetic")) {
        await c.query("UPDATE entry_versions SET verified_at = now(), source_version_id = $2 WHERE id = $1", [prev.version_id, svId]);
        handled.add(prev.entry_id);
        continue;
      }
      if (prev && !handled.has(prev.entry_id)) {
        const { rows: nv } = await c.query<{ next: number }>("SELECT max(version) + 1 AS next FROM entry_versions WHERE entry_id = $1", [prev.entry_id]);
        await archive(prev.version_id, `Superseded by v${nv[0].next} in ${ctx.runCode}`);
        const newId = await insertVersion(prev.entry_id, nv[0].next, e);
        await c.query("UPDATE entries SET title = $2, category = $3 WHERE id = $1", [prev.entry_id, e.title, e.category]);
        await recordChange(prev.entry_id, "changed", prev.version_id, newId, e.what_changed, ref);
        handled.add(prev.entry_id);
        continue;
      }
      // New entry (or an archived entry of this source coming back).
      const { rows: same } = await c.query<{ id: number; source_id: number }>(
        "SELECT id, source_id FROM entries WHERE platform = $1 AND slug = $2",
        [source.platform, e.slug],
      );
      let entryId: number;
      let version = 1;
      if (same[0] && same[0].source_id === source.id && !handled.has(same[0].id)) {
        entryId = same[0].id;
        const { rows: nv } = await c.query<{ next: number }>("SELECT max(version) + 1 AS next FROM entry_versions WHERE entry_id = $1", [entryId]);
        version = nv[0].next;
        await c.query("UPDATE entries SET title = $2, category = $3 WHERE id = $1", [entryId, e.title, e.category]);
      } else {
        const slug = same[0] ? `${e.slug}-s${source.id}` : e.slug;
        const { rows: ne } = await c.query<{ id: number }>(
          `INSERT INTO entries (platform, source_id, slug, title, category) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (platform, slug) DO UPDATE SET title = EXCLUDED.title RETURNING id`,
          [source.platform, source.id, slug, e.title, e.category],
        );
        entryId = ne[0].id;
      }
      const newId = await insertVersion(entryId, version, e);
      await recordChange(entryId, "new", null, newId, e.what_changed, ref);
      handled.add(entryId);
    }
  }
  const removedReason = new Map(x.removed.map((r) => [r.slug, r.reason]));
  for (const prev of existing) {
    if (handled.has(prev.entry_id)) continue;
    const reason = !x.relevant_page ? "Source page no longer carries this guidance" : removedReason.get(prev.slug);
    if (!reason) continue; // not mentioned: left current, not re-verified
    await archive(prev.version_id, `Removed from source in ${ctx.runCode}: ${reason}`);
    await recordChange(prev.entry_id, "archived", prev.version_id, null, reason, `${source.platform}:${prev.slug}`);
  }
  return changes;
}

export function limitationsText(ls: Limitation[]): string | null {
  return ls.length ? ls.map((l) => l.text).join(" ") : null;
}
