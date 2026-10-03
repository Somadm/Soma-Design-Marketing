import { createRequire } from "node:module";
import path from "node:path";
import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";
import type { DbClient } from "../db/pool.js";
import { drawSlide, SIZES, type Crop, type Ctx2D, type SlideData } from "../shared/drawSlide.js";
import type { Storages } from "../storage/storage.js";

/**
 * Draws finished slides on the server (same drawing code as the downloads), so Sagal
 * can publish on her own without Sabah's browser open.
 */

let fontsDone = false;
function registerFonts() {
  if (fontsDone) return;
  const require = createRequire(import.meta.url);
  const dir = (pkg: string) => path.join(path.dirname(require.resolve(`${pkg}/package.json`)), "files");
  const fonts: [string, string, string][] = [
    ["@fontsource/instrument-serif", "instrument-serif", "Instrument Serif"],
    ["@fontsource/schibsted-grotesk", "schibsted-grotesk", "Schibsted Grotesk"],
    ["@fontsource/jetbrains-mono", "jetbrains-mono", "JetBrains Mono"],
  ];
  for (const [pkg, file, family] of fonts) {
    for (const subset of ["latin", "latin-ext"]) {
      for (const weight of family === "Schibsted Grotesk" ? ["400", "600"] : ["400"]) {
        GlobalFonts.registerFromPath(path.join(dir(pkg), `${file}-${subset}-${weight}-normal.woff2`), family);
      }
    }
  }
  // Arrows and other symbols the brand fonts don't carry (e.g. "Swipe →").
  // DejaVu Sans (free licence, see assets/fonts) ships with the app.
  const here = path.dirname(new URL(import.meta.url).pathname);
  const symbols = [path.resolve(here, "../../assets/fonts/DejaVuSans.ttf"), path.resolve(here, "../../../assets/fonts/DejaVuSans.ttf")];
  for (const f of symbols) if (GlobalFonts.registerFromPath(f, "Sagal Symbols")) break;
  fontsDone = true;
}

async function readAll(stream: AsyncIterable<unknown>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks);
}

/** One JPEG per slide (Instagram only accepts JPEG). */
export async function renderSlidesJpeg(db: DbClient, storages: Storages, slides: SlideData[], crop: Crop): Promise<Buffer[]> {
  registerFonts();
  const [W, H] = SIZES[crop];
  const images = new Map<number, Awaited<ReturnType<typeof loadImage>>>();
  const out: Buffer[] = [];
  for (let i = 0; i < slides.length; i++) {
    const s = slides[i];
    let img = null;
    if (s.imageAssetId) {
      if (!images.has(s.imageAssetId)) {
        const { rows } = await db.query<{ storage_key: string }>("SELECT storage_key FROM sagal.media_assets WHERE id = $1", [s.imageAssetId]);
        if (!rows[0]) throw new Error(`The picture on slide ${i + 1} is missing.`);
        images.set(s.imageAssetId, await loadImage(await readAll(await storages.media.read(rows[0].storage_key))));
      }
      const im = images.get(s.imageAssetId)!;
      img = { source: im, width: im.width, height: im.height };
    }
    const canvas = createCanvas(W, H);
    drawSlide(canvas.getContext("2d") as unknown as Ctx2D, s, i + 1, slides.length, crop, img);
    out.push(await canvas.encode("jpeg", 92));
  }
  return out;
}
