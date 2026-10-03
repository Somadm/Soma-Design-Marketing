import type { Crop, Slide } from "../slides";
import { drawSlide, MONO, SANS, SERIF, SIZES, type Ctx2D } from "../../src/shared/drawSlide";
import { buildPdf } from "./pdf";
import { buildZip } from "./zip";

/** Finished designs at the exact size each platform wants (drawing shared with the server). */
export { SIZES, THEME_COLORS } from "../../src/shared/drawSlide";

export const imageUrl = (id: number) => `/api/assets/${id}/raw`;

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

export async function renderSlide(slide: Slide, n: number, count: number, crop: Crop): Promise<HTMLCanvasElement> {
  const [W, H] = SIZES[crop];
  await fontsReady(W / 100);
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const img = slide.imageAssetId ? await loadImage(slide.imageAssetId) : null;
  drawSlide(canvas.getContext("2d")! as unknown as Ctx2D, slide, n, count, crop, img ? { source: img, width: img.naturalWidth, height: img.naturalHeight } : null);
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
