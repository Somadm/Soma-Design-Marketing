import React, { useState } from "react";
import { api } from "../api";
import { ImageSlot, Kicker, LoadError, Loading, Pills, Tag, useAction, useApp, useLoad } from "../lib";

interface Item { id: number; category: string; title: string; source: string; noticed: string; idea: string; private: boolean; imageUrl: string | null; sample: boolean }
const CATS = ["All", "Brooklyn / New York", "Somali / diaspora"] as const;
const TONES = ["#F1EEE7", "#EAF0FF", "#FFFFFF"];

export function InspirationScreen() {
  const { discuss } = useApp();
  const { data, error, loading, reload } = useLoad<{ items: Item[] }>("/api/inspiration");
  const { run } = useAction();
  const [cat, setCat] = useState<(typeof CATS)[number]>("All");
  const [adding, setAdding] = useState(false);
  const items = (data?.items ?? []).filter((i) => cat === "All" || i.category === cat);

  return (
    <div className="scroll">
      <div className="page w1480">
        <div className="head">
          <div className="stack g8">
            <Kicker>Inspiration · references, not content</Kicker>
            <h1 className="title-xl">Things we <span className="italic">noticed.</span></h1>
            <p className="lede">Each reference keeps its source, what Sagal noticed, and an original Soma idea it sparked. We credit, we learn, we never repost someone else's work as ours.</p>
          </div>
          <div className="row g8 wrap">
            <Pills options={CATS} value={cat} onChange={setCat} />
            <button className="btn ghost sm" onClick={() => setAdding(!adding)}>{adding ? "Close" : "+ Save a reference"}</button>
          </div>
        </div>
        {adding && <NewRef onDone={async () => { setAdding(false); await reload(); }} />}
        {error && <LoadError error={error} retry={reload} />}
        {loading && <Loading />}
        {data && !data.items.length && !adding && (
          <div className="empty">
            <div className="title-l">Your board is empty.</div>
            <div className="lede" style={{ fontSize: 17 }}>Save a link or image. Sagal will note what's worth learning from it, credit the source, and suggest an original Soma idea.</div>
            <button className="btn ink" onClick={() => setAdding(true)}>Save a reference</button>
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(min(100%,320px),1fr))", gap: 18, alignItems: "start" }}>
          {items.map((r, n) => (
            <div key={r.id} className="stack" style={{ border: "1px solid var(--line)", borderRadius: 24, overflow: "hidden", background: TONES[n % 3] }}>
              <div style={{ aspectRatio: "16 / 10" }}>
                <ImageSlot url={r.imageUrl} placeholder="Drop the reference image" style={{ borderRadius: 0, border: 0, borderBottom: "1px dashed var(--dash-2)" }} onFile={(f) => run(async () => { await api.upload(`/api/inspiration/${r.id}/image`, f); await reload(); })} />
              </div>
              <div className="stack g12" style={{ padding: "18px 20px 20px" }}>
                <div className="row between g8">
                  <Kicker sm>{r.category}</Kicker>
                  <span className="row g6">
                    {r.sample && <Tag>Sample</Tag>}
                    <span className={`chip ${r.private ? "err" : "line"}`} style={{ fontSize: 11, padding: "2px 8px" }}>{r.private ? "Private · don't post" : "Reference only"}</span>
                  </span>
                </div>
                <div className="serif" style={{ fontSize: 28, lineHeight: 1.05 }}>{r.title}</div>
                <div className="muted" style={{ fontSize: 12.5 }}>Source: {r.source || "add the source"}</div>
                {r.noticed && <div className="stack g4"><b className="xs">What Sagal noticed</b><span style={{ fontSize: 14.5, lineHeight: 1.5 }}>{r.noticed}</span></div>}
                {r.idea && (
                  <div className="card stack g4" style={{ borderRadius: 14, padding: "12px 14px" }}>
                    <b className="xs">Original Soma idea</b>
                    <span className="serif" style={{ fontSize: 20, lineHeight: 1.2 }}>{r.idea}</span>
                  </div>
                )}
                <div className="row g8 wrap">
                  <button className="btn outline sm" onClick={() => discuss({ type: "reference", id: r.id, label: `Reference · ${r.title}` })}>Develop with Sagal</button>
                  <button className="btn link" style={{ fontSize: 12.5 }} onClick={() => confirm("Remove this reference?") && run(async () => { await api.del(`/api/inspiration/${r.id}`); await reload(); })}>Remove</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function NewRef({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ category: "Brooklyn / New York", title: "", source: "", noticed: "", idea: "", private: false });
  const { run, busy } = useAction();
  return (
    <form className="card soft stack g12" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api.post("/api/inspiration", f); onDone(); }, "Saved. Add the image on its card."); }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 12 }}>
        <label className="field">Title<input required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
        <label className="field">Category<select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option>Brooklyn / New York</option><option>Somali / diaspora</option></select></label>
        <label className="field">Source (link or who made it)<input value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} /></label>
      </div>
      <label className="field">What you noticed (optional; Sagal can fill this in)<textarea rows={2} value={f.noticed} onChange={(e) => setF({ ...f, noticed: e.target.value })} /></label>
      <label className="row g10" style={{ fontSize: 14 }}><input type="checkbox" checked={f.private} onChange={(e) => setF({ ...f, private: e.target.checked })} /> Private (e.g. family archive): never post, never reuse</label>
      <button className="btn ink" style={{ alignSelf: "flex-start" }} disabled={busy}>Save reference</button>
    </form>
  );
}
