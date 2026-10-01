import React, { useEffect, useState } from "react";
import { api } from "../api";
import { ImageSlot, Kicker, LoadError, Loading, Pills, Tag, useAction, useApp, useFilePicker, useLoad } from "../lib";

type Reaction = "love" | "like" | "not_for_us";
interface Item { id: number; category: string; title: string; source: string; url: string | null; site: string; preview_text: string; reaction: Reaction; why: string; noticed: string; idea: string; private: boolean; imageUrl: string | null; sample: boolean }
interface Board { taste: { love: string; avoid: string }; categories: string[]; items: Item[] }

const REACTIONS: Reaction[] = ["love", "like", "not_for_us"];
const REACTION_LABEL: Record<Reaction, string> = { love: "♥ Love it", like: "Like it", not_for_us: "Not for us" };
const REACTION_CHIP: Record<Reaction, string> = { love: "blue", like: "line", not_for_us: "err" };
const FILTERS = ["All", "Love it", "Like it", "Not for us"] as const;
const FILTER_REACTION: Record<(typeof FILTERS)[number], Reaction | null> = { All: null, "Love it": "love", "Like it": "like", "Not for us": "not_for_us" };
const TONES = ["#F1EEE7", "#EAF0FF", "#FFFFFF"];

/** Only real web links become clickable. */
const safeHref = (u: string | null) => (u && /^https?:\/\//i.test(u) ? u : null);

export function InspirationScreen() {
  const { discuss, toast } = useApp();
  const { data, error, loading, reload } = useLoad<Board>("/api/inspiration");
  const { run } = useAction();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("All");
  const [cat, setCat] = useState("All");
  const [adding, setAdding] = useState(false);
  const want = FILTER_REACTION[filter];
  const items = (data?.items ?? []).filter((i) => (!want || i.reaction === want) && (cat === "All" || i.category === cat));
  const cats = ["All", ...Array.from(new Set([...(data?.categories ?? []), ...(data?.items ?? []).map((i) => i.category)]))];
  const patch = (id: number, body: Partial<Item>, msg?: string) => run(async () => { await api.patch(`/api/inspiration/${id}`, body); await reload(); }, msg);

  return (
    <div className="scroll">
      <div className="page w1480">
        <div className="head">
          <div className="stack g8">
            <Kicker>Inspiration · teach Sagal your taste</Kicker>
            <h1 className="title-xl">Things we <span className="italic">love.</span></h1>
            <p className="lede">Save posts, pins and pages you love (or don't). Sagal reads this board every time she works, learns why you like things, and makes original Soma work in that spirit. She credits, learns, and never reposts anyone's work as ours.</p>
          </div>
          <button className="btn ink" onClick={() => setAdding(!adding)}>{adding ? "Close" : "+ Add inspiration"}</button>
        </div>
        {adding && data && <NewRef categories={data.categories} onDone={async () => { setAdding(false); await reload(); }} />}
        {data && <TasteNotes taste={data.taste} onSaved={reload} />}
        {error && <LoadError error={error} retry={reload} />}
        {loading && !data && <Loading />}
        {data && (
          <div className="row between g12 wrap">
            <Pills options={FILTERS} value={filter} onChange={setFilter} />
            <label className="row g8 small">Category
              <select className="input" style={{ padding: "6px 10px", width: "auto" }} value={cat} onChange={(e) => setCat(e.target.value)}>
                {cats.map((c) => <option key={c}>{c}</option>)}
              </select>
            </label>
          </div>
        )}
        {data && !data.items.length && !adding && (
          <div className="empty">
            <div className="title-l">Your board is empty.</div>
            <div className="lede" style={{ fontSize: 17 }}>Paste a Pinterest pin, an Instagram or TikTok post, or any web page. Say what you like about it. Sagal learns your style from it.</div>
            <button className="btn ink" onClick={() => setAdding(true)}>Add your first inspiration</button>
          </div>
        )}
        {data && data.items.length > 0 && !items.length && <div className="small muted">Nothing matches this filter.</div>}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(min(100%,320px),1fr))", gap: 18, alignItems: "start" }}>
          {items.map((r, n) => (
            <RefCard
              key={r.id}
              r={r}
              tone={TONES[n % 3]}
              onReaction={(reaction) => patch(r.id, { reaction })}
              onWhy={(why) => patch(r.id, { why }, "Saved. Sagal will take that into account.")}
              onImage={(f) => run(async () => { await api.upload(`/api/inspiration/${r.id}/image`, f); await reload(); }, "Picture added.")}
              onRefresh={() => run(async () => { const x = await api.post<{ note: string | null }>(`/api/inspiration/${r.id}/refresh`); await reload(); toast(x.note ?? "Got the picture from the link.", Boolean(x.note)); })}
              onDiscuss={() => discuss({ type: "reference", id: r.id, label: `Inspiration · ${r.title}` })}
              onRemove={() => confirm("Remove this from your board?") && run(async () => { await api.del(`/api/inspiration/${r.id}`); await reload(); })}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function TasteNotes({ taste, onSaved }: { taste: Board["taste"]; onSaved: () => void }) {
  const [t, setT] = useState(taste);
  const [open, setOpen] = useState(!taste.love && !taste.avoid);
  const { run, busy } = useAction();
  useEffect(() => setT(taste), [taste.love, taste.avoid]);
  const dirty = t.love !== taste.love || t.avoid !== taste.avoid;
  return (
    <div className="card soft stack g12" style={{ borderRadius: 20 }}>
      <div className="row between g10 wrap">
        <div className="stack g4">
          <b style={{ fontSize: 16 }}>Your taste, in your words</b>
          <span className="small muted">Sagal reads this with the board every time she makes something.</span>
        </div>
        <button className="btn link" onClick={() => setOpen(!open)}>{open ? "Hide" : taste.love || taste.avoid ? "Edit" : "Write it"}</button>
      </div>
      {!open && (taste.love || taste.avoid) && (
        <div className="stack g6" style={{ fontSize: 14, lineHeight: 1.5 }}>
          {taste.love && <span><b>Love:</b> {taste.love}</span>}
          {taste.avoid && <span><b>Not for us:</b> {taste.avoid}</span>}
        </div>
      )}
      {open && (
        <form className="stack g12" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api.patch("/api/settings/taste", t); onSaved(); setOpen(false); }, "Saved. Sagal will use this from her next message."); }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,280px),1fr))", gap: 12 }}>
            <label className="field">What I love (styles, colours, fonts, tone, ideas)
              <textarea rows={4} maxLength={2000} placeholder="e.g. Calm, editorial layouts with lots of space. Warm neutrals with one strong blue. Big serif headlines. Honest, behind-the-scenes stories." value={t.love} onChange={(e) => setT({ ...t, love: e.target.value })} />
            </label>
            <label className="field">Not for Soma
              <textarea rows={4} maxLength={2000} placeholder="e.g. Stock photos, neon gradients, too many emojis, hype words like “game-changer”." value={t.avoid} onChange={(e) => setT({ ...t, avoid: e.target.value })} />
            </label>
          </div>
          <button className="btn ink sm" style={{ alignSelf: "flex-start" }} disabled={busy || !dirty}>Save my taste</button>
        </form>
      )}
    </div>
  );
}

function RefCard({ r, tone, onReaction, onWhy, onImage, onRefresh, onDiscuss, onRemove }: {
  r: Item; tone: string; onReaction: (x: Reaction) => void; onWhy: (why: string) => void; onImage: (f: File) => void; onRefresh: () => void; onDiscuss: () => void; onRemove: () => void;
}) {
  const [why, setWhy] = useState<string | null>(null);
  const href = safeHref(r.url);
  return (
    <div className="stack" style={{ border: "1px solid var(--line)", borderRadius: 24, overflow: "hidden", background: tone }}>
      <div style={{ aspectRatio: "16 / 10" }}>
        <ImageSlot url={r.imageUrl} placeholder={href ? "No picture from the link. Drop a screenshot here" : "Drop the reference image"} style={{ borderRadius: 0, border: 0, borderBottom: "1px dashed var(--dash-2)" }} onFile={onImage} />
      </div>
      <div className="stack g12" style={{ padding: "18px 20px 20px" }}>
        <div className="row between g8 wrap">
          <Kicker sm>{r.category}</Kicker>
          <span className="row g6">
            {r.sample && <Tag>Sample</Tag>}
            {r.private && <span className="chip err" style={{ fontSize: 11, padding: "2px 8px" }}>Private · don't post</span>}
            <span className={`chip ${REACTION_CHIP[r.reaction]}`} style={{ fontSize: 11, padding: "2px 8px" }}>{REACTION_LABEL[r.reaction]}</span>
          </span>
        </div>
        <div className="serif" style={{ fontSize: 26, lineHeight: 1.08, overflowWrap: "anywhere" }}>{r.title}</div>
        <div className="muted" style={{ fontSize: 12.5, overflowWrap: "anywhere" }}>
          {href ? (
            <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: "inherit" }}>{r.site || new URL(href).hostname} ↗</a>
          ) : (
            <>Source: {r.source || "add the source"}</>
          )}
        </div>
        {r.preview_text && !r.why && !r.noticed && <div className="small muted" style={{ lineHeight: 1.45, maxHeight: 62, overflow: "hidden" }}>{r.preview_text}</div>}
        <div className="row g6 wrap" role="group" aria-label="How you feel about it">
          {REACTIONS.map((x) => (
            <button key={x} className={`pill sm${r.reaction === x ? " on" : ""}`} aria-pressed={r.reaction === x} onClick={() => r.reaction !== x && onReaction(x)}>{REACTION_LABEL[x]}</button>
          ))}
        </div>
        {why !== null ? (
          <div className="stack g8">
            <textarea className="input" rows={3} maxLength={800} autoFocus placeholder="What do you like (or not) about it? The colours, the layout, the tone, the idea…" value={why} onChange={(e) => setWhy(e.target.value)} />
            <div className="row g8"><button className="btn ink sm" onClick={() => { onWhy(why); setWhy(null); }}>Save</button><button className="btn ghost sm" onClick={() => setWhy(null)}>Cancel</button></div>
          </div>
        ) : r.why ? (
          <div className="stack g4"><b className="xs">Why, in your words</b><span style={{ fontSize: 14.5, lineHeight: 1.5 }}>{r.why}</span><button className="btn link" style={{ alignSelf: "flex-start", fontSize: 12.5 }} onClick={() => setWhy(r.why)}>Edit</button></div>
        ) : (
          <button className="btn outline sm" style={{ alignSelf: "flex-start" }} onClick={() => setWhy("")}>Say what you like about it</button>
        )}
        {r.noticed && <div className="stack g4"><b className="xs">What Sagal noticed</b><span style={{ fontSize: 14.5, lineHeight: 1.5 }}>{r.noticed}</span></div>}
        {r.idea && (
          <div className="card stack g4" style={{ borderRadius: 14, padding: "12px 14px" }}>
            <b className="xs">Original Soma idea</b>
            <span className="serif" style={{ fontSize: 20, lineHeight: 1.2 }}>{r.idea}</span>
          </div>
        )}
        <div className="row g8 wrap">
          <button className="btn outline sm" onClick={onDiscuss}>Ask Sagal about it</button>
          {href && !r.imageUrl && <button className="btn link" style={{ fontSize: 12.5 }} onClick={onRefresh}>Try the link again</button>}
          <button className="btn link" style={{ fontSize: 12.5 }} onClick={onRemove}>Remove</button>
        </div>
      </div>
    </div>
  );
}

function NewRef({ categories, onDone }: { categories: string[]; onDone: () => void }) {
  const [f, setF] = useState({ url: "", title: "", category: categories[0] ?? "Post style", reaction: "love" as Reaction, why: "", private: false });
  const [newCat, setNewCat] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const picker = useFilePicker(setFile, "image/*");
  const { run, busy } = useAction();
  const { toast } = useApp();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const title = f.title.trim() || (file && !f.url.trim() ? file.name.replace(/\.[^.]+$/, "").slice(0, 160) : "");
      const body = { ...f, title, url: f.url.trim() || null, category: f.category === "__new" ? newCat.trim() || "Post style" : f.category };
      const r = await api.post<{ id: number; note: string | null }>("/api/inspiration", body);
      if (file) await api.upload(`/api/inspiration/${r.id}/image`, file);
      toast(r.note && !file ? r.note : "Saved to your board. Sagal will learn from it.", Boolean(r.note && !file));
      onDone();
    });
  };
  return (
    <form className="card soft stack g12" onSubmit={submit}>
      <label className="field">Link (Pinterest, Instagram, TikTok, a website…)
        <input type="url" inputMode="url" placeholder="https://pin.it/… or https://www.pinterest.com/pin/…" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} />
      </label>
      <div className="row g10 wrap small">
        {picker.input}
        <button type="button" className="btn ghost sm" onClick={picker.open}>{file ? "Change picture" : "Or upload a picture / screenshot"}</button>
        {file && <span className="muted">{file.name}</span>}
      </div>
      <div className="stack g6">
        <span className="small" style={{ fontWeight: 600 }}>How do you feel about it?</span>
        <Pills sm options={REACTIONS} value={f.reaction} onChange={(reaction) => setF({ ...f, reaction })} label={(x) => REACTION_LABEL[x]} />
      </div>
      <label className="field">What do you like about it? (this is what teaches Sagal most)
        <textarea rows={2} maxLength={800} placeholder="e.g. The calm colours and the huge headline. One idea per slide." value={f.why} onChange={(e) => setF({ ...f, why: e.target.value })} />
      </label>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,220px),1fr))", gap: 12 }}>
        <label className="field">Title (optional, taken from the link)<input maxLength={160} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
        <label className="field">Category
          <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
            {categories.map((c) => <option key={c}>{c}</option>)}
            <option value="__new">New category…</option>
          </select>
        </label>
        {f.category === "__new" && <label className="field">New category<input maxLength={60} value={newCat} onChange={(e) => setNewCat(e.target.value)} /></label>}
      </div>
      <label className="row g10" style={{ fontSize: 14 }}><input type="checkbox" checked={f.private} onChange={(e) => setF({ ...f, private: e.target.checked })} /> Private (e.g. family archive): learn from it, never post or reuse it</label>
      <button className="btn ink" style={{ alignSelf: "flex-start" }} disabled={busy || (!f.url.trim() && !f.title.trim() && !file)}>{busy ? "Saving…" : "Save to my board"}</button>
    </form>
  );
}
