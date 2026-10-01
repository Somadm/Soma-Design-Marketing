import React, { useEffect } from "react";
import { useLoad, when } from "../lib";

interface Img { id: number; kind: string; filename: string; label: string | null; created_at: string; url: string }

/** Your uploaded images and brand assets. Private references aren't offered. */
export function ImagePicker({ onPick, onClose }: { onPick: (id: number) => void; onClose: () => void }) {
  const { data, loading } = useLoad<{ images: Img[] }>("/api/assets/images");
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <div className="backdrop" style={{ display: "grid", placeItems: "center", padding: 16, zIndex: 60 }} onClick={onClose}>
      <div role="dialog" aria-label="Choose an image" className="card stack g14" style={{ width: "min(760px, 100%)", maxHeight: "86vh", overflowY: "auto", borderRadius: 24 }} onClick={(e) => e.stopPropagation()}>
        <div className="row between g10">
          <div className="title-s">Choose an image</div>
          <button className="circle-btn" style={{ width: 36, height: 36 }} aria-label="Close" onClick={onClose}>×</button>
        </div>
        <div className="small muted">Images you've uploaded (in chat or here) and your brand assets. Inspiration references stay private and aren't shown.</div>
        {loading && <div className="small muted">Loading…</div>}
        {data && !data.images.length && <div className="card dashed small muted" style={{ borderRadius: 16 }}>No images yet. Use “Upload image” on the slide, or attach images when you talk to Sagal.</div>}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(150px,1fr))", gap: 10 }}>
          {data?.images.map((i) => (
            <button key={i.id} onClick={() => onPick(i.id)} className="stack g6" style={{ border: "1px solid var(--line)", borderRadius: 14, padding: 6, background: "#fff", textAlign: "left" }}>
              <img src={i.url} alt="" style={{ width: "100%", aspectRatio: "1 / 1", objectFit: "cover", borderRadius: 10, background: "var(--stone-2)" }} />
              <span className="xs" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{i.label ?? i.filename}</span>
              <span className="xs muted">{i.kind === "brand" ? "Brand asset" : "Upload"} · {when(i.created_at)}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
