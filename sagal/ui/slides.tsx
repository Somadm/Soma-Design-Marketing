import React from "react";

export interface Slide {
  role: string;
  kicker: string;
  head: string;
  body: string;
  visual: string;
  theme: string;
}

export interface Carousel {
  id: number;
  title: string;
  project: string;
  draft: number;
  slides: Slide[];
  captions: Record<string, string>;
  sample: boolean;
  comments: { id: number; slide_index: number; who: "sabah" | "sagal"; text: string }[];
}

/** Headline size shrinks with length (and when there's a visual), like the prototype. */
export function headSize(s: Slide, base: number) {
  const L = s.head.length;
  let v = L > 52 ? base * 0.74 : L > 36 ? base * 0.86 : base;
  if (s.visual) v *= 0.8;
  return `${v.toFixed(1)}cqw`;
}

export const CROPS = {
  "4:5": { ratio: "4 / 5", label: "Instagram, Facebook & LinkedIn feed · 1080 × 1350", pad: "7.5cqw 8cqw", t: "6%", b: "6%", s: "6%", shade: "transparent", w: "min(100%, 500px)" },
  "1:1": { ratio: "1 / 1", label: "Square · 1080 × 1080 · Facebook & LinkedIn fallback", pad: "7cqw 7cqw", t: "6%", b: "6%", s: "6%", shade: "transparent", w: "min(100%, 540px)" },
  "9:16": { ratio: "9 / 16", label: "TikTok, Stories & YouTube Shorts · 1080 × 1920 · shaded = platform UI", pad: "23cqw 8cqw 38cqw", t: "13%", b: "21%", s: "7%", shade: "rgba(17,17,17,.10)", w: "min(100%, 360px)" },
} as const;
export type Crop = keyof typeof CROPS;

export function SlideView({ slide, n, count, crop = "4:5", safe = false, radius = 14, shadow = false }: { slide: Slide; n: number; count: number; crop?: Crop; safe?: boolean; radius?: number; shadow?: boolean }) {
  const c = CROPS[crop];
  return (
    <div
      className={`slide th-${slide.theme}`}
      style={{ aspectRatio: c.ratio, borderRadius: radius, boxShadow: shadow ? "0 30px 60px -36px rgba(0,0,0,.4)" : undefined }}
      role="img"
      aria-label={`Slide ${n}: ${slide.head || "empty"}`}
    >
      <div className="slide-in" style={{ padding: crop === "4:5" ? "8cqw" : c.pad }}>
        <div className="row between sub" style={{ fontFamily: "var(--mono)", fontSize: "3cqw", letterSpacing: ".06em", textTransform: "uppercase" }}>
          <span>{slide.kicker}</span>
          <span style={{ whiteSpace: "nowrap" }}>
            {n} / {count}
          </span>
        </div>
        <div className="stack" style={{ gap: "4cqw" }}>
          {slide.visual && (
            <div className="sub" style={{ aspectRatio: "16 / 10", borderRadius: "2cqw", border: "1px dashed currentColor", display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", padding: "4cqw", fontFamily: "var(--mono)", fontSize: "3cqw" }}>
              {slide.visual}
            </div>
          )}
          <div style={{ fontFamily: "var(--serif)", fontSize: headSize(slide, 11.5), lineHeight: 1.02, letterSpacing: "-.015em", textWrap: "balance" } as React.CSSProperties}>
            {slide.head || <span className="sub">Headline</span>}
          </div>
          {slide.body && <div className="sub" style={{ fontSize: "3.8cqw", lineHeight: 1.4, whiteSpace: "pre-line" }}>{slide.body}</div>}
        </div>
        <div className="row between" style={{ fontSize: "3cqw", fontWeight: 600 }}>
          <span>Soma</span>
          <span>{n < count ? "Swipe →" : "soma"}</span>
        </div>
      </div>
      {safe && (
        <>
          <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: c.t, background: c.shade, pointerEvents: "none" }} />
          <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: c.b, background: c.shade, pointerEvents: "none" }} />
          <div style={{ position: "absolute", top: c.t, bottom: c.b, left: c.s, right: c.s, border: "1.5px dashed #94ABF9", borderRadius: 6, pointerEvents: "none" }} />
          <div style={{ position: "absolute", bottom: `calc(${c.b} + 6px)`, right: `calc(${c.s} + 6px)`, background: "#94ABF9", color: "#111", fontFamily: "var(--mono)", fontSize: 10, padding: "2px 6px", borderRadius: 4, pointerEvents: "none" }}>
            Text-safe area
          </div>
        </>
      )}
    </div>
  );
}

/** Tiny slide for cards and navigators. */
export function MiniSlide({ slide, n, size = 15, numberOnly = false }: { slide: Slide; n: number; size?: number; numberOnly?: boolean }) {
  return (
    <div className={`slide th-${slide.theme}`} style={{ aspectRatio: "4 / 5", borderRadius: 8 }}>
      {numberOnly ? (
        <div style={{ position: "absolute", left: "10cqw", right: "10cqw", bottom: "12cqw", fontFamily: "var(--serif)", fontSize: "13cqw", lineHeight: 1 }}>{n}</div>
      ) : (
        <div className="slide-in" style={{ padding: "9cqw" }}>
          <div className="sub" style={{ fontFamily: "var(--mono)", fontSize: "6cqw", letterSpacing: ".05em", textTransform: "uppercase", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {slide.kicker || n}
          </div>
          <div style={{ fontFamily: "var(--serif)", fontSize: headSize(slide, size), lineHeight: 1.02, letterSpacing: "-.01em", overflow: "hidden" }}>{slide.head}</div>
        </div>
      )}
    </div>
  );
}
