import type { DbClient } from "../db/pool.js";

export const ROLES = ["Hook", "Context", "Question", "Process", "Decision", "Trade-off", "Close"];
export const THEMES = ["ink", "paper", "blue", "soft"];
export const CAPTION_LIMITS: Record<string, number> = { Instagram: 2200, Facebook: 63206, TikTok: 4000, "YouTube Shorts": 100, LinkedIn: 3000 };

export interface Slide {
  role: string;
  kicker: string;
  head: string;
  body: string;
  visual: string;
  theme: string;
}

export function cleanSlide(s: Partial<Slide>, i = 0): Slide {
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
  return {
    role: ROLES.includes(s.role ?? "") ? s.role! : ROLES[Math.min(i, ROLES.length - 1)],
    kicker: str(s.kicker, 80),
    head: str(s.head, 240),
    body: str(s.body, 600),
    visual: str(s.visual, 200),
    theme: THEMES.includes(s.theme ?? "") ? s.theme! : THEMES[i % 2 ? 1 : 0],
  };
}

export async function listCarousels(db: DbClient) {
  const { rows } = await db.query("SELECT id, title, project, draft, sample, updated_at, jsonb_array_length(slides) AS slide_count FROM sagal.carousels ORDER BY updated_at DESC");
  return rows;
}

export async function getCarousel(db: DbClient, id: number) {
  const { rows } = await db.query("SELECT * FROM sagal.carousels WHERE id = $1", [id]);
  if (!rows[0]) return null;
  const comments = await db.query("SELECT id, slide_index, who, text, created_at FROM sagal.slide_comments WHERE carousel_id = $1 ORDER BY id", [id]);
  return { ...rows[0], comments: comments.rows };
}

export async function createCarousel(
  db: DbClient,
  c: { title: string; project?: string; ideaId?: number | null; slides: Partial<Slide>[]; captions?: Record<string, string> },
  sample = false,
) {
  const slides = c.slides.slice(0, 12).map(cleanSlide);
  const { rows } = await db.query<{ id: number }>(
    "INSERT INTO sagal.carousels (title, project, idea_id, slides, captions, sample) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
    [c.title, c.project ?? "", c.ideaId ?? null, JSON.stringify(slides), JSON.stringify(c.captions ?? {}), sample],
  );
  return rows[0].id;
}

export async function updateCarousel(db: DbClient, id: number, patch: { title?: string; slides?: Partial<Slide>[]; captions?: Record<string, string>; bumpDraft?: boolean }) {
  const slides = patch.slides ? JSON.stringify(patch.slides.slice(0, 12).map(cleanSlide)) : null;
  const captions = patch.captions
    ? JSON.stringify(Object.fromEntries(Object.entries(patch.captions).filter(([k]) => k in CAPTION_LIMITS).map(([k, v]) => [k, String(v).slice(0, CAPTION_LIMITS[k])])))
    : null;
  await db.query(
    `UPDATE sagal.carousels SET title = COALESCE($2, title), slides = COALESCE($3, slides), captions = COALESCE($4, captions),
       draft = draft + $5, updated_at = now() WHERE id = $1`,
    [id, patch.title ?? null, slides, captions, patch.bumpDraft ? 1 : 0],
  );
  // Captions flow through to posts that haven't gone out yet.
  if (patch.captions) {
    for (const [platform, caption] of Object.entries(patch.captions)) {
      await db.query("UPDATE sagal.posts SET caption = $3 WHERE carousel_id = $1 AND platform = $2 AND status IN ('scheduled','paused')", [id, platform, caption]);
    }
  }
}

export async function updateSlide(db: DbClient, id: number, index: number, patch: Partial<Slide>) {
  const c = await getCarousel(db, id);
  if (!c) throw new Error("Carousel not found.");
  const slides = c.slides as Slide[];
  if (index < 0 || index >= slides.length) throw new Error(`Slide ${index + 1} doesn't exist.`);
  slides[index] = cleanSlide({ ...slides[index], ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) }, index);
  await updateCarousel(db, id, { slides, bumpDraft: true });
  return slides[index];
}

export async function addComment(db: DbClient, id: number, slideIndex: number, who: "sabah" | "sagal", text: string) {
  const { rows } = await db.query(
    "INSERT INTO sagal.slide_comments (carousel_id, slide_index, who, text) VALUES ($1,$2,$3,$4) RETURNING *",
    [id, slideIndex, who, text.slice(0, 2000)],
  );
  return rows[0];
}
