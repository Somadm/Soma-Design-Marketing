import type { DbClient } from "../db/pool.js";
import { CHANNELS } from "../publishing/permissions.js";
import { addDays, helsinkiDate, helsinkiToUtc, isValidDate, isValidTime, weekStart } from "../time.js";
import { getSettings } from "./settings.js";

export interface Idea {
  id: number;
  title: string;
  story: string;
  audience: string;
  purpose: string;
  format: string;
  platforms: string[];
  status: "board" | "agreed";
  plan_date: string | null;
  sample: boolean;
}

export const FORMATS = ["Carousel", "Avatar video", "Short video", "Single image", "Text + image"];

export function kindForFormat(format: string): "carousel" | "video" | "image" {
  const f = format.toLowerCase();
  if (f.includes("video") || f.includes("short")) return "video";
  if (f.includes("carousel")) return "carousel";
  return "image";
}

export function cleanPlatforms(p: string[]): string[] {
  return [...new Set(p)].filter((x) => (CHANNELS as readonly string[]).includes(x));
}

export async function createIdea(
  db: DbClient,
  i: { title: string; story?: string; audience?: string; purpose?: string; format?: string; platforms?: string[] },
  by = "sagal",
  sample = false,
): Promise<Idea> {
  const { rows } = await db.query<Idea>(
    `INSERT INTO sagal.ideas (title, story, audience, purpose, format, platforms, created_by, sample)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [i.title, i.story ?? "", i.audience ?? "", i.purpose ?? "", i.format ?? "Carousel", cleanPlatforms(i.platforms ?? ["Instagram"]), by, sample],
  );
  return rows[0];
}

const ACCOUNT: Record<string, string> = {
  Instagram: "Instagram account",
  Facebook: "Facebook Page",
  TikTok: "TikTok account",
  "YouTube Shorts": "YouTube channel",
  LinkedIn: "Sabah (personal profile)",
};

function formatFor(platform: string, format: string): string {
  const kind = kindForFormat(format);
  if (platform === "LinkedIn" && kind === "carousel") return "Document post (PDF) · 4:5";
  if (platform === "TikTok" && kind === "carousel") return "Photo carousel · 9:16";
  if (platform === "YouTube Shorts") return "Short · 9:16 · under 60s";
  return kind === "carousel" ? `${format} · 4:5` : kind === "video" ? `${format} · 9:16` : `${format} · 4:5`;
}

/**
 * Sabah moves an idea into the plan. This is her authorisation for Sagal to produce it
 * and publish it on the chosen day, within the publishing mode. One post per platform.
 */
export async function moveIntoPlan(db: DbClient, ideaId: number, date: string, time?: string) {
  if (!isValidDate(date)) throw new Error("Pick a valid day.");
  const settings = await getSettings(db);
  const at = time && isValidTime(time) ? time : settings.defaultPostTime;
  const { rows } = await db.query<Idea>(
    "UPDATE sagal.ideas SET status = 'agreed', plan_date = $2, agreed_at = now(), updated_at = now() WHERE id = $1 RETURNING *",
    [ideaId, date],
  );
  const idea = rows[0];
  if (!idea) throw new Error("Idea not found.");
  await db.query("DELETE FROM sagal.posts WHERE idea_id = $1 AND status IN ('scheduled','paused','manual')", [ideaId]);
  const carousel = await db.query<{ id: number; captions: Record<string, string> }>("SELECT id, captions FROM sagal.carousels WHERE idea_id = $1 ORDER BY id DESC LIMIT 1", [ideaId]);
  const video = await db.query<{ id: number; voiceover_id: number | null; platform_captions: Record<string, string> }>(
    "SELECT id, voiceover_id, platform_captions FROM sagal.video_jobs WHERE idea_id = $1 ORDER BY id DESC LIMIT 1",
    [ideaId],
  );
  const kind = kindForFormat(idea.format);
  for (const platform of idea.platforms) {
    const caption = (kind === "video" ? video.rows[0]?.platform_captions?.[platform] : carousel.rows[0]?.captions?.[platform]) ?? "";
    await db.query(
      `INSERT INTO sagal.posts (idea_id, platform, account_label, title, format, kind, caption, note, scheduled_at, needs_voiceover_job, carousel_id, sample)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        ideaId, platform, ACCOUNT[platform] ?? platform, idea.title, formatFor(platform, idea.format), kind, caption,
        "Inside the approved plan.", helsinkiToUtc(date, at),
        kind === "video" ? (video.rows[0]?.id ?? null) : null, carousel.rows[0]?.id ?? null, idea.sample,
      ],
    );
  }
  return idea;
}

export async function backToBoard(db: DbClient, ideaId: number) {
  await db.query("UPDATE sagal.ideas SET status = 'board', plan_date = NULL, agreed_at = NULL, updated_at = now() WHERE id = $1", [ideaId]);
  await db.query("DELETE FROM sagal.posts WHERE idea_id = $1 AND status IN ('scheduled','paused','manual')", [ideaId]);
}

export async function listIdeas(db: DbClient): Promise<Idea[]> {
  const { rows } = await db.query<Idea>("SELECT * FROM sagal.ideas ORDER BY status, plan_date NULLS LAST, id");
  return rows;
}

export function weekDays(anyDate: string): string[] {
  const start = weekStart(anyDate);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export const todayHelsinki = () => helsinkiDate(new Date());
