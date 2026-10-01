import type { Crop, Slide } from "../slides";
import { headSize } from "../slides";
import { buildPdf } from "./pdf";
import { buildZip } from "./zip";

/**
 * Finished designs, drawn at the exact size each platform wants. Mirrors SlideView
 * (container-query units: 1cqw = 1% of the slide width).
 */
export const SIZES: Record<Crop, [number, number]> = { "4:5": [1080, 1350], "1:1": [1080, 1080], "9:16": [1080, 1920] };
const PAD: Record<Crop, [number, number, number]> = { "4:5": [8, 8, 8], "1:1": [7, 7, 7], "9:16": [23, 8, 38] }; // top, sides, bottom (cqw)

export const THEME_COLORS: Record<string, { bg: string; fg: string; sub: string }> = {
  ink: { bg: "#111111", fg: "#FFFFFF", sub: "#D9D6CF" },
  paper: { bg: "#FFFFFF", fg: "#111111", sub: "#4A4843" },
  blue: { bg: "#94ABF9", fg: "#111111", sub: "#1E2440" },
  soft: { bg: "#F1EEE7", fg: "#111111", sub: "#4A4843" },
};
const FULL_IMAGE = { fg: "#FFFFFF", sub: "rgba(255,255,255,0.86)" };

export const imageUrl = (id: number) => `/api/assets/${id}/raw`;

const SERIF = '"Instrument Serif", Georgia, serif';
const SANS = '"Schibsted Grotesk", system-ui, sans-serif';
const MONO = '"JetBrains Mono", ui-monospace, monospace';

async function fontsReady(cq: number) {
  try {
    await Promise.all([
      document.fonts.load(`400 ${10 * cq}px ${SERIF}`),
      document.fonts.load(`400 ${4 * cq}px ${SANS}`),
      document.fonts.load(`600 ${4 * cq}px ${SANS}`),
      document.fonts.load(`400 ${3 * cq}px ${MONO}`),
    ]);
    await document.fonts.ready;
  } catch {}
}

const imageCache = new Map<number, Promise<HTMLImageElement>>();
export function loadImage(id: number): Promise<HTMLImageElement> {
  if (!imageCache.has(id)) {
    imageCache.set(
      id,
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => {
          imageCache.delete(id);
          reject(new Error("An image on this slide couldn't be loaded."));
        };
        img.src = imageUrl(id);
      }),
    );
  }
  return imageCache.get(id)!;
}

function setSpacing(ctx: CanvasRenderingContext2D, px: number) {
  if ("letterSpacing" in ctx) (ctx as unknown as { letterSpacing: string }).letterSpacing = `${px}px`;
}

function wrap(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
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

function cover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, w: number, h: number) {
  const s = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const sw = w / s, sh = h / s;
  ctx.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, x, y, w, h);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export async function renderSlide(slide: Slide, n: number, count: number, crop: Crop): Promise<HTMLCanvasElement> {
  const [W, H] = SIZES[crop];
  const cq = W / 100;
  await fontsReady(cq);
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const theme = THEME_COLORS[slide.theme] ?? THEME_COLORS.ink;
  const img = slide.imageAssetId ? await loadImage(slide.imageAssetId) : null;
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
  const hs = parseFloat(headSize({ ...slide, visual: showBox ? "x" : "" }, 11.5)) * cq;
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
  return canvas;
}

const toBytes = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Uint8Array>((resolve, reject) =>
    canvas.toBlob(async (b) => (b ? resolve(new Uint8Array(await b.arrayBuffer())) : reject(new Error("Couldn't make the image."))), type, quality),
  );

export function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "sagal";
}

export function save(bytes: Uint8Array | Blob, filename: string, type: string) {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes as Uint8Array<ArrayBuffer>], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const CROP_NAME: Record<Crop, string> = { "4:5": "4x5", "1:1": "1x1", "9:16": "9x16" };

export async function downloadSlide(title: string, slides: Slide[], i: number, crop: Crop) {
  const png = await toBytes(await renderSlide(slides[i], i + 1, slides.length, crop), "image/png");
  save(png, `${slug(title)}-${pad2(i + 1)}-${CROP_NAME[crop]}.png`, "image/png");
}

/** All slides as PNGs, plus every platform caption, in one ZIP. */
export async function downloadZip(title: string, slides: Slide[], crop: Crop, captions: Record<string, string> = {}) {
  const files: { name: string; data: Uint8Array }[] = [];
  for (let i = 0; i < slides.length; i++) {
    files.push({ name: `${pad2(i + 1)}-${slug(slides[i].role)}.png`, data: await toBytes(await renderSlide(slides[i], i + 1, slides.length, crop), "image/png") });
  }
  const caps = Object.entries(captions).filter(([, v]) => v.trim());
  if (caps.length) files.push({ name: "captions.txt", data: new TextEncoder().encode(caps.map(([k, v]) => `── ${k} ──\n${v}\n`).join("\n")) });
  save(buildZip(files), `${slug(title)}-${CROP_NAME[crop]}.zip`, "application/zip");
}

/** LinkedIn document post: one page per slide (4:5). */
export async function downloadPdf(title: string, slides: Slide[]) {
  const pages = [];
  for (let i = 0; i < slides.length; i++) {
    const c = await renderSlide(slides[i], i + 1, slides.length, "4:5");
    pages.push({ jpeg: await toBytes(c, "image/jpeg", 0.92), width: c.width, height: c.height });
  }
  save(buildPdf(pages, title), `${slug(title)}-linkedin.pdf`, "application/pdf");
}
