import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildPdf } from "../ui/export/pdf.js";
import { buildZip, crc32 } from "../ui/export/zip.js";

const dir = mkdtempSync(path.join(tmpdir(), "sagal-export-"));

describe("design exports", () => {
  it("crc32 matches the standard check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("builds a valid ZIP of slide files", () => {
    const zip = buildZip([
      { name: "slide-01.png", data: new TextEncoder().encode("first") },
      { name: "slide-02.png", data: new Uint8Array([0, 1, 2, 3, 255]) },
    ]);
    const file = path.join(dir, "slides.zip");
    writeFileSync(file, zip);
    const out = execFileSync("python3", ["-c", `import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(z.namelist(), z.read('slide-01.png'))`, file]).toString();
    expect(out).toContain("['slide-01.png', 'slide-02.png'] b'first'");
  });

  it("builds a PDF with one page per slide at the slide's size", () => {
    // Smallest valid baseline JPEG (1×1 px) is enough to check structure.
    const jpeg = Uint8Array.from(Buffer.from(
      "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
      "base64",
    ));
    const pdf = buildPdf([{ jpeg, width: 1080, height: 1350 }, { jpeg, width: 1080, height: 1350 }], "The one-sentence homepage");
    const text = Buffer.from(pdf).toString("latin1");
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("/Count 2");
    expect(text.match(/\/MediaBox \[0 0 1080 1350\]/g)).toHaveLength(2);
    // Every xref offset points at the start of its object.
    const xref = Number(/startxref\n(\d+)/.exec(text)![1]);
    const lines = text.slice(xref).split("\n").slice(3, 3 + 9);
    lines.forEach((l, i) => expect(text.slice(Number(l.slice(0, 10)), Number(l.slice(0, 10)) + 10)).toMatch(new RegExp(`^${i + 1} 0 obj`)));
  });
});
