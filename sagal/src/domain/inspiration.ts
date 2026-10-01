import type { DbClient } from "../db/pool.js";
import { checkUrl, fetchPreview, LinkError, type Preview } from "../inspiration/linkPreview.js";
import type { Storages } from "../storage/storage.js";
import { saveMedia } from "./assets.js";
import { getSettings } from "./settings.js";

export const REACTIONS = ["love", "like", "not_for_us"] as const;
export type Reaction = (typeof REACTIONS)[number];
export const REACTION_LABEL: Record<Reaction, string> = { love: "Love it", like: "Like it", not_for_us: "Not for us" };
export const CATEGORIES = ["Post style", "Carousel design", "Video", "Colours & type", "Ideas & topics", "Brooklyn / New York", "Somali / diaspora"];

export type Previewer = (url: string) => Promise<Preview>;

export interface ReferenceInput {
  url?: string | null;
  title?: string;
  category?: string;
  reaction?: Reaction;
  why?: string;
  noticed?: string;
  idea?: string;
  private?: boolean;
}

/**
 * Reads the link (title, description, picture) and stores the picture as a private,
 * never-publish reference image. A link that can't be read still saves; `note` says why.
 */
async function applyPreview(db: DbClient, storages: Storages, id: number, url: string, previewer: Previewer, replaceTitle: boolean): Promise<string | null> {
  try {
    const p = await previewer(url);
    let assetId: number | null = null;
    if (p.imageBytes) {
      const a = await saveMedia(db, storages, "inspiration", { filename: p.imageBytes.filename, mimetype: p.imageBytes.contentType, stream: p.imageBytes.data }, { doNotPublish: true, label: `Reference · ${p.site}` });
      assetId = a.id;
    }
    await db.query(
      `UPDATE sagal.inspiration SET
         title = CASE WHEN $7 THEN COALESCE(NULLIF($2, ''), title) ELSE title END,
         preview_text = $3, site = $4, source = CASE WHEN source = '' THEN $5 ELSE source END,
         image_asset_id = COALESCE($6, image_asset_id), updated_at = now()
       WHERE id = $1`,
      [id, p.title, p.description, p.site, url, assetId, replaceTitle],
    );
    if (!p.imageBytes) return "Saved the link, but the page didn't share a picture. You can add one on the card.";
    return null;
  } catch (err) {
    const why = err instanceof LinkError ? err.message : "The page couldn't be read.";
    return `Saved the link. ${why} Some sites (Instagram, private Pinterest boards) hide their pictures, so add a screenshot on the card.`;
  }
}

export async function saveReference(db: DbClient, storages: Storages, input: ReferenceInput, previewer: Previewer = fetchPreview) {
  const url = input.url?.trim() ? checkUrl(input.url).toString() : null;
  const title = input.title?.trim() || (url ? new URL(url).hostname.replace(/^www\./, "") : "");
  if (!title) throw new LinkError("Add a link or a title.");
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO sagal.inspiration (category, title, source, noticed, idea, private, url, reaction, why)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [input.category?.trim() || "Post style", title.slice(0, 160), url ?? "", input.noticed ?? "", input.idea ?? "", input.private ?? false, url, input.reaction ?? "like", input.why ?? ""],
  );
  const id = rows[0].id;
  const note = url ? await applyPreview(db, storages, id, url, previewer, !input.title?.trim()) : null;
  return { id, note };
}

export async function refreshReference(db: DbClient, storages: Storages, id: number, previewer: Previewer = fetchPreview) {
  const { rows } = await db.query<{ url: string | null }>("SELECT url FROM sagal.inspiration WHERE id = $1", [id]);
  if (!rows[0]) return { found: false as const };
  if (!rows[0].url) return { found: true as const, note: "This reference has no link to read." };
  return { found: true as const, note: await applyPreview(db, storages, id, rows[0].url, previewer, false) };
}

export async function updateReference(db: DbClient, id: number, patch: Omit<ReferenceInput, "url">) {
  const { rowCount } = await db.query(
    `UPDATE sagal.inspiration SET
       title = COALESCE($2, title), category = COALESCE($3, category), reaction = COALESCE($4, reaction),
       why = COALESCE($5, why), noticed = COALESCE($6, noticed), idea = COALESCE($7, idea), private = COALESCE($8, private),
       updated_at = now()
     WHERE id = $1`,
    [id, patch.title ?? null, patch.category ?? null, patch.reaction ?? null, patch.why ?? null, patch.noticed ?? null, patch.idea ?? null, patch.private ?? null],
  );
  return (rowCount ?? 0) > 0;
}

interface RefRow { id: number; title: string; category: string; reaction: Reaction; why: string; noticed: string; site: string; url: string | null; preview_text: string; private: boolean; sample: boolean }

/** Sabah's taste, in words and references, for Sagal's context every turn. */
export async function tasteDigest(db: DbClient, limit = 30): Promise<string> {
  const { taste } = await getSettings(db);
  const { rows } = await db.query<RefRow>(
    `SELECT id, title, category, reaction, why, noticed, site, url, preview_text, private, sample FROM sagal.inspiration
     ORDER BY CASE reaction WHEN 'love' THEN 0 WHEN 'not_for_us' THEN 1 ELSE 2 END, updated_at DESC, id DESC LIMIT $1`,
    [limit],
  );
  const lines: string[] = [];
  if (taste.love.trim()) lines.push(`What Sabah loves, in her words: ${taste.love.trim()}`);
  if (taste.avoid.trim()) lines.push(`What's not for Soma, in her words: ${taste.avoid.trim()}`);
  for (const r of rows) {
    const bits = [
      `- [reference ${r.id}] ${REACTION_LABEL[r.reaction]}: “${r.title}” (${r.category}${r.site ? ` · ${r.site}` : ""})`,
      r.why && `why: ${r.why}`,
      r.noticed && `you noticed: ${r.noticed}`,
      !r.why && !r.noticed && r.preview_text && `page says: ${r.preview_text.slice(0, 160)}`,
      r.private && "PRIVATE: learn from it, never post or reuse it",
      r.sample && "sample",
    ].filter(Boolean);
    lines.push(bits.join("; "));
  }
  return lines.length ? lines.join("\n") : "Nothing saved yet. Ask Sabah to save a few posts she loves (Pinterest, Instagram, any link) on the Inspiration page.";
}
