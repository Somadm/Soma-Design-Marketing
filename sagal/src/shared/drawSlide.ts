/**
 * Draws one finished slide onto a 2D canvas at an exact posting size. Shared by the
 * browser (downloads) and the server (automatic publishing), so what's posted is
 * exactly what Sabah downloaded and approved. Mirrors SlideView (1cqw = 1% of width).
 */

export type Crop = "4:5" | "1:1" | "9:16";
export interface SlideData {
  role: string;
  kicker: string;
  head: string;
  body: string;
  visual: string;
  theme: string;
  imageAssetId?: number | null;
  imageLayout?: "frame" | "full";
}
/** A loaded picture plus its natural size (browser Image or server Image). */
export interface DrawImage {
  source: unknown;
  width: number;
  height: number;
}
/** The parts of CanvasRenderingContext2D we use (browser and @napi-rs/canvas both fit). */
export interface Ctx2D {
  fillStyle: unknown;
  strokeStyle: unknown;
  font: string;
  textAlign: string;
  textBaseline: string;
  lineWidth: number;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(t: string, x: number, y: number): void;
  measureText(t: string): { width: number };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  drawImage(img: any, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void;
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): { addColorStop(o: number, c: string): void };
  save(): void;
  restore(): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void;
  closePath(): void;
  clip(): void;
  stroke(): void;
  setLineDash(segments: number[]): void;
}

export const SIZES: Record<Crop, [number, number]> = { "4:5": [1080, 1350], "1:1": [1080, 1080], "9:16": [1080, 1920] };
const PAD: Record<Crop, [number, number, number]> = { "4:5": [8, 8, 8], "1:1": [7, 7, 7], "9:16": [23, 8, 38] }; // top, sides, bottom (cqw)

export const THEME_COLORS: Record<string, { bg: string; fg: string; sub: string }> = {
  ink: { bg: "#111111", fg: "#FFFFFF", sub: "#D9D6CF" },
  paper: { bg: "#FFFFFF", fg: "#111111", sub: "#4A4843" },
  blue: { bg: "#94ABF9", fg: "#111111", sub: "#1E2440" },
  soft: { bg: "#F1EEE7", fg: "#111111", sub: "#4A4843" },
};
const FULL_IMAGE = { fg: "#FFFFFF", sub: "rgba(255,255,255,0.86)" };

// "Sagal Symbols" fills in arrows on the server; browsers fall back on their own.
export const SERIF = '"Instrument Serif", "Sagal Symbols", Georgia, serif';
export const SANS = '"Schibsted Grotesk", "Sagal Symbols", system-ui, sans-serif';
export const MONO = '"JetBrains Mono", "Sagal Symbols", ui-monospace, monospace';

/** Headline size in cqw: shrinks with length, and when there's a picture or picture note. */
export function headSizeCqw(s: Pick<SlideData, "head" | "visual">, base: number): number {
  const L = s.head.length;
  let v = L > 52 ? base * 0.74 : L > 36 ? base * 0.86 : base;
  if (s.visual) v *= 0.8;
  return Number(v.toFixed(1));
}

function setSpacing(ctx: Ctx2D, px: number) {
  if ("letterSpacing" in ctx) (ctx as unknown as { letterSpacing: string }).letterSpacing = `${px}px`;
}

function wrap(ctx: Ctx2D, text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) {
      out.push("");
      continue;
    }
    let line = "";
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (ctx.measureText(next).width <= width || !line) line = next;
      else {
        out.push(line);
        line = w;
      }
    }
    out.push(line);
  }
  return out;
}

function cover(ctx: Ctx2D, img: DrawImage, x: number, y: number, w: number, h: number) {
  const s = Math.max(w / img.width, h / img.height);
  const sw = w / s, sh = h / s;
  ctx.drawImage(img.source, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, h);
}

function roundRect(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Draws the slide; the canvas must already be SIZES[crop]. */
export function drawSlide(ctx: Ctx2D, slide: SlideData, n: number, count: number, crop: Crop, img: DrawImage | null) {
  const [W, H] = SIZES[crop];
  const cq = W / 100;
  const theme = THEME_COLORS[slide.theme] ?? THEME_COLORS.ink;
  const full = Boolean(img && slide.imageLayout === "full");
  const fg = full ? FULL_IMAGE.fg : theme.fg;
  const sub = full ? FULL_IMAGE.sub : theme.sub;

  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, W, H);
  if (full && img) {
    cover(ctx, img, 0, 0, W, H);
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "rgba(17,17,17,0.35)");
    g.addColorStop(0.45, "rgba(17,17,17,0.15)");
    g.addColorStop(1, "rgba(17,17,17,0.72)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  const [pt, ps, pb] = PAD[crop].map((v) => v * cq);
  const innerW = W - 2 * ps;
  ctx.textBaseline = "top";

  // Top row: kicker and slide number.
  const small = 3 * cq;
  ctx.font = `400 ${small}px ${MONO}`;
  setSpacing(ctx, 0.06 * small);
  ctx.fillStyle = sub;
  ctx.textAlign = "left";
  ctx.fillText(slide.kicker.toUpperCase(), ps, pt);
  ctx.textAlign = "right";
  ctx.fillText(`${n} / ${count}`, W - ps, pt);
  const rowH = small * 1.25;

  // Bottom row.
  ctx.font = `600 ${small}px ${SANS}`;
  setSpacing(ctx, 0);
  ctx.fillStyle = fg;
  ctx.textAlign = "left";
  ctx.fillText("Soma", ps, H - pb - rowH);
  ctx.textAlign = "right";
  ctx.fillText(n < count ? "Swipe →" : "soma", W - ps, H - pb - rowH);
  ctx.textAlign = "left";

  // Middle block, centred between the rows (like flex space-between).
  const gap = 4 * cq;
  const showBox = !full && Boolean(img || slide.visual);
  const boxH = showBox ? (innerW * 10) / 16 : 0;
  const hs = (headSizeCqw({ ...slide, visual: showBox ? "x" : "" }, 11.5)) * cq;
  ctx.font = `400 ${hs}px ${SERIF}`;
  setSpacing(ctx, -0.015 * hs);
  const headLines = slide.head ? wrap(ctx, slide.head, innerW) : [];
  const headLH = hs * 1.02;
  const bodySize = 3.8 * cq;
  ctx.font = `400 ${bodySize}px ${SANS}`;
  setSpacing(ctx, 0);
  const bodyLines = slide.body ? wrap(ctx, slide.body, innerW) : [];
  const bodyLH = bodySize * 1.4;
  const blocks = [boxH, headLines.length * headLH, bodyLines.length * bodyLH].filter((h) => h > 0);
  const midH = blocks.reduce((a, b) => a + b, 0) + gap * Math.max(0, blocks.length - 1);
  const top = pt + rowH, bottom = H - pb - rowH;
  let y = top + Math.max(0, (bottom - top - midH) / 2);

  if (showBox) {
    ctx.save();
    roundRect(ctx, ps, y, innerW, boxH, 2 * cq);
    if (img) {
      ctx.clip();
      cover(ctx, img, ps, y, innerW, boxH);
    } else {
      ctx.setLineDash([1.2 * cq, 0.8 * cq]);
      ctx.lineWidth = Math.max(2, 0.2 * cq);
      ctx.strokeStyle = sub;
      ctx.stroke();
      ctx.font = `400 ${3 * cq}px ${MONO}`;
      ctx.fillStyle = sub;
      ctx.textAlign = "center";
      const lines = wrap(ctx, slide.visual, innerW - 8 * cq);
      lines.forEach((l, i) => ctx.fillText(l, W / 2, y + boxH / 2 - (lines.length * 3.6 * cq) / 2 + i * 3.6 * cq));
      ctx.textAlign = "left";
    }
    ctx.restore();
    y += boxH + gap;
  }
  if (headLines.length) {
    ctx.font = `400 ${hs}px ${SERIF}`;
    setSpacing(ctx, -0.015 * hs);
    ctx.fillStyle = fg;
    headLines.forEach((l, i) => ctx.fillText(l, ps, y + i * headLH));
    y += headLines.length * headLH + gap;
  }
  if (bodyLines.length) {
    ctx.font = `400 ${bodySize}px ${SANS}`;
    setSpacing(ctx, 0);
    ctx.fillStyle = sub;
    bodyLines.forEach((l, i) => ctx.fillText(l, ps, y + i * bodyLH));
  }
}
