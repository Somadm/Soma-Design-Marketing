import { concat } from "./zip";

/**
 * Minimal PDF writer: one JPEG per page, page size = image size. LinkedIn shows a PDF
 * uploaded as a document post as a swipeable carousel.
 */
export function buildPdf(pages: { jpeg: Uint8Array; width: number; height: number }[], title = "Carousel"): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let size = 0;
  const push = (p: Uint8Array | string) => {
    const b = typeof p === "string" ? enc.encode(p) : p;
    parts.push(b);
    size += b.length;
  };
  const obj = (n: number, body: (string | Uint8Array)[]) => {
    offsets[n] = size;
    push(`${n} 0 obj\n`);
    body.forEach(push);
    push("\nendobj\n");
  };
  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  const n = pages.length;
  // Object numbers: 1 catalog, 2 pages, 3 info, then 3 per page (page, content, image).
  const pageObj = (i: number) => 4 + i * 3;
  obj(1, ["<< /Type /Catalog /Pages 2 0 R >>"]);
  obj(2, [`<< /Type /Pages /Count ${n} /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(" ")}] >>`]);
  const safeTitle = title.replace(/[\\()]/g, "").replace(/[^\x20-\x7E]/g, "");
  obj(3, [`<< /Title (${safeTitle}) /Producer (Sagal) >>`]);
  pages.forEach((p, i) => {
    const content = `q ${p.width} 0 0 ${p.height} 0 0 cm /Im${i} Do Q`;
    obj(pageObj(i), [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.width} ${p.height}] /Resources << /XObject << /Im${i} ${pageObj(i) + 2} 0 R >> >> /Contents ${pageObj(i) + 1} 0 R >>`]);
    obj(pageObj(i) + 1, [`<< /Length ${content.length} >>\nstream\n${content}\nendstream`]);
    obj(pageObj(i) + 2, [
      `<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`,
      p.jpeg,
      "\nendstream",
    ]);
  });
  const total = 4 + n * 3;
  const xref = size;
  push(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let i = 1; i < total; i++) push(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${total} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return concat(parts);
}
