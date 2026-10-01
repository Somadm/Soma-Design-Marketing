import React, { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Empty, Kicker, LoadError, Loading, MarkS, Pills, Tag, THEMES, useAction, useApp, useLoad, useRouter } from "../lib";
import { CROPS, MiniSlide, SlideView, type Carousel, type Crop, type Slide } from "../slides";

const CAP_PLATS = ["Instagram", "Facebook", "TikTok", "YouTube Shorts", "LinkedIn"] as const;
const CAP_HINT: Record<string, string> = {
  Instagram: "First line shows before “more”.",
  Facebook: "Keep the key line under ~120 characters.",
  TikTok: "Lowercase matches how TikTok captions read.",
  "YouTube Shorts": "Title up to 100 characters; add #Shorts.",
  LinkedIn: "First two lines show before “see more”.",
};

export function CarouselScreen() {
  const { path, go } = useRouter();
  const routeId = Number(path.split(/[/?]/)[2]) || null;
  const list = useLoad<{ carousels: { id: number; title: string; draft: number; sample: boolean }[]; roles: string[]; captionLimits: Record<string, number> }>("/api/carousels");
  const id = routeId ?? list.data?.carousels[0]?.id ?? null;
  const one = useLoad<{ carousel: Carousel }>(id ? `/api/carousels/${id}` : null, [id]);
  const { run } = useAction();

  if (list.error) return <div className="scroll"><div className="page w1480"><LoadError error={list.error} retry={list.reload} /></div></div>;
  if (list.loading) return <div className="scroll"><div className="page w1480"><Loading /></div></div>;
  if (!id)
    return (
      <div className="scroll">
        <div className="page w1100">
          <Kicker>Carousel studio</Kicker>
          <Empty
            title="No carousel in progress."
            body="Start from an idea in Plan together, or ask Sagal to turn a project into a story."
            action={
              <div className="row g8 wrap">
                <button className="btn ink" onClick={() => go("/talk")}>Talk to Sagal about it</button>
                <button className="btn ghost" onClick={() => run(async () => { const r = await api.post<{ id: number }>("/api/carousels", { title: "Untitled carousel" }); go(`/carousel/${r.id}`); })}>Start a blank carousel</button>
              </div>
            }
          />
        </div>
      </div>
    );
  if (!one.data) return <div className="scroll"><div className="page w1480">{one.error ? <LoadError error={one.error} retry={one.reload} /> : <Loading />}</div></div>;
  return <Studio key={id} c={one.data.carousel} roles={list.data!.roles} limits={list.data!.captionLimits} others={list.data!.carousels} reload={one.reload} />;
}

function Studio({ c, roles, limits, others, reload }: { c: Carousel; roles: string[]; limits: Record<string, number>; others: { id: number; title: string }[]; reload: () => Promise<void> }) {
  const { go } = useRouter();
  const { discuss, vw } = useApp();
  const [slides, setSlides] = useState<Slide[]>(c.slides);
  const [captions, setCaptions] = useState<Record<string, string>>(c.captions ?? {});
  const [i, setI] = useState(0);
  const [crop, setCrop] = useState<Crop>("4:5");
  const [safe, setSafe] = useState(true);
  const [capPlat, setCapPlat] = useState<(typeof CAP_PLATS)[number]>("Instagram");
  const [comment, setComment] = useState("");
  const [saved, setSaved] = useState<"saved" | "saving" | "error">("saved");
  const { run } = useAction();
  const timer = useRef<number>(0);
  const wide = vw >= 1200;
  const cur = slides[Math.min(i, slides.length - 1)];

  // Edits save automatically, a moment after typing stops.
  const queueSave = (next: { slides?: Slide[]; captions?: Record<string, string> }) => {
    setSaved("saving");
    clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      try {
        await api.patch(`/api/carousels/${c.id}`, next);
        setSaved("saved");
      } catch {
        setSaved("error");
      }
    }, 600);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  const edit = (field: keyof Slide, v: string) => {
    const next = slides.map((s, n) => (n === i ? { ...s, [field]: v } : s));
    setSlides(next);
    queueSave({ slides: next, captions });
  };
  const cap = captions[capPlat] ?? "";
  const comments = c.comments.filter((x) => x.slide_index === i);

  return (
    <div className="scroll">
      <div className="page w1480" style={{ gap: 22, paddingBottom: 60 }}>
        <div className="head">
          <div>
            <Kicker>Carousel studio · {c.project || "Unsorted"} · draft {c.draft}</Kicker>
            <h1 className="title-xl" style={{ fontSize: "clamp(36px,4vw,56px)" }}>{c.title}</h1>
          </div>
          <div className="row g8 wrap">
            {c.sample && <Tag>Sample story · no client outcomes</Tag>}
            <span className="xs muted" aria-live="polite">{saved === "saving" ? "Saving…" : saved === "error" ? "Not saved. Check your connection." : "All changes saved"}</span>
            {others.length > 1 && (
              <select className="input round" style={{ width: "auto", fontSize: 13 }} value={c.id} onChange={(e) => go(`/carousel/${e.target.value}`)} aria-label="Open another carousel">
                {others.map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
              </select>
            )}
            <button className="btn blue" onClick={() => discuss({ type: "slide", id: `${c.id}:${i}`, label: `Slide ${i + 1} · ${cur.role}` })}>Discuss slide {i + 1} with Sagal</button>
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${slides.length},minmax(0,1fr))`, gap: 4 }} aria-label="Story progression">
          {slides.map((s, n) => (
            <button key={n} onClick={() => setI(n)} style={{ textAlign: "left", border: 0, borderTop: `3px solid ${n === i ? "#111" : n < i ? "#94ABF9" : "#E6E3DC"}`, background: "transparent", padding: "8px 2px 0", minWidth: 0 }}>
              <div className="mono muted" style={{ fontSize: 10.5 }}>{String(n + 1).padStart(2, "0")}</div>
              <div style={{ fontSize: 13, fontWeight: n === i ? 700 : 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.role}</div>
            </button>
          ))}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: wide ? "104px minmax(0,1fr) 360px" : "minmax(0,1fr)", gap: "clamp(16px,2vw,32px)", alignItems: "start" }}>
          <div style={{ display: "flex", flexDirection: wide ? "column" : "row", gap: 10, overflow: "auto", padding: 2 }}>
            {slides.map((s, n) => {
              const cc = c.comments.filter((x) => x.slide_index === n).length;
              return (
                <button key={n} className={`thumb-btn${n === i ? " on" : ""}`} style={{ width: wide ? "100%" : 84 }} aria-label={`Slide ${n + 1}: ${s.role}`} onClick={() => setI(n)}>
                  <MiniSlide slide={s} n={n + 1} size={12} />
                  {cc > 0 && <span className="count">{cc}</span>}
                </button>
              );
            })}
          </div>
          <div className="stack g14" style={{ alignItems: "center", minWidth: 0 }}>
            <div className="row g8 wrap" style={{ justifyContent: "center" }}>
              <Pills options={Object.keys(CROPS) as Crop[]} value={crop} onChange={setCrop} />
              <button className="pill" aria-pressed={safe} onClick={() => setSafe(!safe)}>{safe ? "Hide text-safe area" : "Show text-safe area"}</button>
            </div>
            <div style={{ width: CROPS[crop].w, maxWidth: "100%" }}>
              <SlideView slide={cur} n={i + 1} count={slides.length} crop={crop} safe={safe} radius={16} shadow />
            </div>
            <div className="small muted" style={{ textAlign: "center" }}>{CROPS[crop].label}</div>
            <div className="row g14">
              <button className="circle-btn" aria-label="Previous slide" onClick={() => setI(Math.max(0, i - 1))}>‹</button>
              <div style={{ fontSize: 14, minWidth: 150, textAlign: "center" }}><b>Slide {i + 1} of {slides.length}</b> · {cur.role}</div>
              <button className="circle-btn" aria-label="Next slide" onClick={() => setI(Math.min(slides.length - 1, i + 1))}>›</button>
            </div>
          </div>
          <div className="card soft stack g18" style={{ borderRadius: 20 }}>
            <div className="row between" style={{ alignItems: "baseline" }}>
              <div className="serif" style={{ fontSize: 26 }}>Slide {i + 1}</div>
              <Kicker>{cur.role}</Kicker>
            </div>
            <label className="field">Headline<textarea rows={3} value={cur.head} onChange={(e) => edit("head", e.target.value)} /></label>
            <label className="field">Supporting line<textarea rows={2} placeholder="Optional" value={cur.body} onChange={(e) => edit("body", e.target.value)} /></label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <label className="field">Kicker<input value={cur.kicker} onChange={(e) => edit("kicker", e.target.value)} /></label>
              <label className="field">Story role<select value={cur.role} onChange={(e) => edit("role", e.target.value)}>{roles.map((r) => <option key={r}>{r}</option>)}</select></label>
            </div>
            <label className="field">Visual<input placeholder="None: type only" value={cur.visual} onChange={(e) => edit("visual", e.target.value)} /></label>
            <div className="stack g8">
              <div style={{ fontSize: 13, fontWeight: 600 }}>Look</div>
              <div className="row g8">
                {Object.entries(THEMES).map(([k, label]) => (
                  <button key={k} className={`th-${k}`} aria-label={label} title={label} aria-pressed={cur.theme === k} onClick={() => edit("theme", k)} style={{ width: 40, height: 40, borderRadius: "50%", border: "1px solid var(--input)", outline: cur.theme === k ? "2px solid #111" : "none", outlineOffset: 2, fontFamily: "var(--serif)", fontSize: 18 }}>A</button>
                ))}
              </div>
            </div>
            <div className="stack g10" style={{ borderTop: "1px solid var(--line)", paddingTop: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>Comments on slide {i + 1}</div>
              {!comments.length && <div className="muted" style={{ fontSize: 13.5 }}>No comments on this slide yet.</div>}
              {comments.map((x) => (
                <div key={x.id} className="row g10" style={{ alignItems: "flex-start" }}>
                  {x.who === "sagal" ? <MarkS size={24} /> : <span className="mark-sa" style={{ width: 24, height: 24, fontSize: 10 }}>Sa</span>}
                  <div style={{ fontSize: 14, lineHeight: 1.45 }}><b>{x.who === "sagal" ? "Sagal" : "Sabah"}</b> {x.text}</div>
                </div>
              ))}
              <form className="row g6" onSubmit={(e) => { e.preventDefault(); if (comment.trim()) void run(async () => { await api.post(`/api/carousels/${c.id}/comments`, { slide: i, text: comment }); setComment(""); await reload(); }); }}>
                <input className="input round grow" placeholder="Comment on this slide" value={comment} onChange={(e) => setComment(e.target.value)} />
                <button className="btn ink sm">Add</button>
              </form>
              <div className="xs muted">Sagal reads these when you discuss the slide with her.</div>
            </div>
            <div className="stack g10" style={{ borderTop: "1px solid var(--line)", paddingTop: 16 }}>
              <div className="row between g8 wrap">
                <div style={{ fontSize: 13, fontWeight: 600 }}>Caption</div>
                <Pills sm options={CAP_PLATS} value={capPlat} onChange={setCapPlat} />
              </div>
              <textarea className="input" rows={5} value={cap} maxLength={limits[capPlat]} onChange={(e) => { const next = { ...captions, [capPlat]: e.target.value }; setCaptions(next); queueSave({ slides, captions: next }); }} />
              <div className="row between xs muted"><span>{CAP_HINT[capPlat]}</span><span className="mono">{cap.length.toLocaleString("en-GB")} / {limits[capPlat].toLocaleString("en-GB")}</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
