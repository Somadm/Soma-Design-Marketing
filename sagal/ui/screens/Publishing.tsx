import React, { useEffect, useState } from "react";
import { api } from "../api";
import { Kicker, LoadError, Loading, MarkS, POST_STATUS, Pills, Tag, dayDate, shiftWeek, useAction, useApp, useLoad, useRouter, weekday } from "../lib";
import { downloadPdf, downloadSlide, downloadZip } from "../export/render";
import { SlideView, type Carousel, type Crop } from "../slides";

interface Post { id: number; date: string; time: string; platform: string; account_label: string; title: string; format: string; kind: string; caption: string; note: string; status: string; display: string; held_by_sabah: boolean; globalPaused: boolean; needsVoiceover: boolean; needsApproval: boolean; approved_at: string | null; carousel_id: number | null; channelConnected: boolean; sample: boolean }
interface Pub { today: string; days: string[]; posts: Post[]; authorisation: { mode: "plan" | "review"; channels: string[]; spendLimitEur: number; paused: boolean }; spentThisMonth: number }
const FILTERS = ["All", "Instagram", "Facebook", "TikTok", "YouTube Shorts", "LinkedIn"] as const;

export function PublishingScreen() {
  const { go } = useRouter();
  const { vw } = useApp();
  const [week, setWeek] = useState<string | null>(null);
  const { data, error, loading, reload } = useLoad<Pub>(`/api/publishing${week ? `?week=${week}` : ""}`, [week]);
  const { run } = useAction();
  const [plat, setPlat] = useState<(typeof FILTERS)[number]>("All");
  const [sel, setSel] = useState<number | null>(null);
  const wide = vw >= 1500;
  const mid = vw >= 1200;
  if (!data) return <div className="scroll"><div className="page w1480">{error ? <LoadError error={error} retry={reload} /> : loading && <Loading />}</div></div>;
  const a = data.authorisation;
  const posts = data.posts.filter((p) => plat === "All" || p.platform === plat);
  const sp = data.posts.find((p) => p.id === sel) ?? data.posts[0];
  const act = (path: string, msg?: string) => run(async () => { await api.post(path); await reload(); }, msg);

  return (
    <div className="scroll">
      <div className="page w1480" style={{ gap: 22 }}>
        <div className="head">
          <div className="stack g8">
            <Kicker>Publishing · all times Europe/Helsinki</Kicker>
            <h1 className="title-xl">Publishing calendar</h1>
          </div>
          <button
            className="btn"
            aria-pressed={a.paused}
            onClick={() => run(async () => { await api.post("/api/publishing/pause", { paused: !a.paused }); await reload(); }, a.paused ? "Publishing resumed." : "All publishing paused.")}
            style={{ background: a.paused ? "var(--blue)" : "var(--ink)", color: a.paused ? "var(--ink)" : "#fff", padding: "14px 22px", fontSize: 15 }}
          >
            <span className="row" style={{ gap: 3 }} aria-hidden><span style={{ width: 4, height: 14, background: "currentColor", borderRadius: 1 }} /><span style={{ width: 4, height: 14, background: "currentColor", borderRadius: 1 }} /></span>
            {a.paused ? "Resume publishing" : "Pause all publishing"}
          </button>
        </div>
        {a.paused && <div className="note info" style={{ fontSize: 15 }}><b>Publishing is paused.</b> Nothing new goes out on any channel until you resume. Posts already sent to a platform can't be recalled. Sagal keeps producing, so nothing falls behind.</div>}
        <div className="row g10 wrap" style={{ background: "var(--surface)", borderRadius: 16, padding: "12px 16px", fontSize: 13.5, lineHeight: 1.5 }}>
          <Kicker sm>Authorised</Kicker>
          <span><b>{a.mode === "plan" ? "Publish within approved plan" : "Review each finished post"}</b> · {a.channels.join(", ") || "no channels"} · agreed plan only · production spend €{data.spentThisMonth.toFixed(0)} of €{a.spendLimitEur}/month</span>
          <button className="btn link" style={{ marginLeft: "auto", fontSize: 13 }} onClick={() => go("/memory/perms")}>Change permissions</button>
        </div>
        <div className="row between g12 wrap">
          <Pills options={FILTERS} value={plat} onChange={setPlat} />
          <div className="row g12 wrap">
            {["scheduled", "later", "publishing", "confirmed", "failed", "paused", "manual"].map((k) => (
              <span key={k} className="row g6 xs muted"><span className="dot" style={{ background: POST_STATUS[k].dot }} />{POST_STATUS[k].label}</span>
            ))}
          </div>
        </div>
        <div className="row g8 wrap">
          <button className="pill sm" onClick={() => setWeek(shiftWeek(data.days[0], -1))}>‹ Previous week</button>
          <button className="pill sm" onClick={() => setWeek(null)}>This week</button>
          <button className="pill sm" onClick={() => setWeek(shiftWeek(data.days[0], 1))}>Next week ›</button>
          <span className="small muted">{dayDate(data.days[0])} – {dayDate(data.days[6])}</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: wide ? "minmax(0,1fr) 380px" : "minmax(0,1fr)", gap: 20, alignItems: "start" }}>
          <div style={{ overflowX: "auto" }}>
            <div style={{ display: "grid", gridTemplateColumns: mid ? "repeat(7,minmax(0,1fr))" : "repeat(7,minmax(150px,1fr))", gap: 8 }}>
              {data.days.map((d) => (
                <div key={d} className={`day${d === data.today ? " today" : ""}`} style={{ minHeight: 300 }}>
                  <div className="row between wrap" style={{ alignItems: "baseline", padding: "2px 2px 4px", columnGap: 6 }}>
                    <span style={{ fontWeight: 700, fontSize: 14 }}>{weekday(d)}{d === data.today ? " · today" : ""}</span>
                    <span className="xs muted">{dayDate(d)}</span>
                  </div>
                  {posts.filter((p) => p.date === d).map((p) => {
                    const s = POST_STATUS[p.display] ?? POST_STATUS.scheduled;
                    return (
                      <button key={p.id} className={`post-btn${sp?.id === p.id ? " on" : ""}`} onClick={() => setSel(p.id)}>
                        <span className="row between g6"><span className="mono" style={{ fontSize: 11.5 }}>{p.time}</span><span className="dot" style={{ background: s.dot }} /></span>
                        <span style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.3 }}>{p.title}</span>
                        <span className="muted" style={{ fontSize: 11.5 }}>{p.platform}</span>
                        <span className={`chip fit ${s.cls}`} style={{ alignSelf: "flex-start", fontSize: 11, padding: "2px 8px" }}>{s.label}</span>
                        {p.needsVoiceover && <span style={{ fontSize: 11, fontWeight: 600, color: "var(--warn)" }}>Needs your voiceover</span>}
                        {p.sample && <span className="xs muted">Sample</span>}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
          {sp ? (
            <PostDetail p={sp} mode={a.mode} act={act} onCaption={(caption) => run(async () => { await api.patch(`/api/posts/${sp.id}`, { caption }); await reload(); }, "Caption saved.")} />
          ) : (
            <div className="card dashed stack g10" style={{ borderRadius: 24 }}>
              <div className="title-s">Nothing scheduled.</div>
              <div className="small muted" style={{ lineHeight: 1.5 }}>Once you agree a plan, posts appear here with their exact Helsinki time and status.</div>
              <button className="btn outline sm" style={{ alignSelf: "flex-start" }} onClick={() => go("/plan")}>Open Plan together</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PostDetail({ p, mode, act, onCaption }: { p: Post; mode: string; act: (path: string, msg?: string) => Promise<unknown>; onCaption: (c: string) => void }) {
  const s = POST_STATUS[p.display] ?? POST_STATUS.scheduled;
  const [editing, setEditing] = useState<string | null>(null);
  const vertical = p.platform === "TikTok" || p.kind === "video";
  const crop: Crop = vertical ? "9:16" : "4:5";
  const { toast } = useApp();
  const { run } = useAction();
  const [at, setAt] = useState(0);
  const { data: cd } = useLoad<{ carousel: Carousel }>(p.carousel_id ? `/api/carousels/${p.carousel_id}` : null, [p.carousel_id]);
  const c = p.carousel_id ? cd?.carousel ?? null : null;
  useEffect(() => setAt(0), [p.id]);
  const dl = (f: () => Promise<void>) => run(f, "Downloaded. Check your Downloads folder.");
  const long = new Date(`${p.date}T00:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "short" });
  return (
    <div className="card stack g16" style={{ borderRadius: 24 }}>
      <div className="row between g10 wrap">
        <Kicker sm>{p.platform} preview</Kicker>
        <span className="row g6">{p.sample && <Tag>Sample</Tag>}<span className={`chip ${s.cls}`}>{s.label}</span></span>
      </div>
      <div className="row" style={{ justifyContent: "center" }}>
        <div style={{ width: vertical ? 220 : 280, maxWidth: "100%", border: "1px solid var(--line)", borderRadius: 18, overflow: "hidden" }}>
          <div className="row g8" style={{ padding: "10px 12px" }}><span style={{ width: 26, height: 26, borderRadius: "50%", background: "#111" }} /><span style={{ fontSize: 12.5, fontWeight: 600 }}>{p.account_label}</span></div>
          {c && c.slides.length ? (
            <div style={{ position: "relative" }}>
              <SlideView slide={c.slides[Math.min(at, c.slides.length - 1)]} n={Math.min(at, c.slides.length - 1) + 1} count={c.slides.length} crop={crop} radius={0} />
              {c.slides.length > 1 && (
                <div className="row between" style={{ position: "absolute", left: 6, right: 6, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}>
                  <button className="pill sm" aria-label="Previous slide" style={{ pointerEvents: "auto", visibility: at > 0 ? "visible" : "hidden" }} onClick={() => setAt(at - 1)}>‹</button>
                  <button className="pill sm" aria-label="Next slide" style={{ pointerEvents: "auto", visibility: at < c.slides.length - 1 ? "visible" : "hidden" }} onClick={() => setAt(at + 1)}>›</button>
                </div>
              )}
            </div>
          ) : (
            <div className={`slide th-${p.kind === "image" ? "soft" : "ink"}`} style={{ aspectRatio: vertical ? "9 / 16" : "4 / 5", border: 0 }}>
              <div className="stack" style={{ position: "absolute", inset: 0, padding: p.kind === "video" ? "10cqw 9cqw 26cqw" : "9cqw", justifyContent: p.kind === "carousel" ? "space-between" : "flex-end", gap: "4cqw" }}>
                {p.kind === "video" && <span className="mono sub" style={{ fontSize: "5cqw" }}>AVATAR VIDEO</span>}
                {p.kind === "carousel" && <span className="mono sub" style={{ fontSize: "4.5cqw" }}>1 / …</span>}
                <span className="serif" style={{ fontSize: "12cqw", lineHeight: 1 }}>{p.title}</span>
              </div>
            </div>
          )}
          {p.caption && <div style={{ padding: "10px 12px 14px", fontSize: 12.5, lineHeight: 1.45, maxHeight: 86, overflow: "hidden", whiteSpace: "pre-line" }}>{p.caption}</div>}
        </div>
      </div>
      {c && c.slides.length > 0 && (
        <div className="stack g8" style={{ background: "var(--surface)", borderRadius: 14, padding: "12px 14px" }}>
          <b style={{ fontSize: 14 }}>Download to post by hand</b>
          <div className="row g8 wrap">
            {p.platform === "LinkedIn" ? (
              <button className="btn ink sm" onClick={() => dl(() => downloadPdf(c.title, c.slides))}>LinkedIn PDF</button>
            ) : (
              <button className="btn ink sm" onClick={() => dl(() => downloadZip(c.title, c.slides, crop, { [p.platform]: p.caption }))}>All slides (ZIP · {crop})</button>
            )}
            <button className="btn outline sm" onClick={() => dl(() => downloadSlide(c.title, c.slides, Math.min(at, c.slides.length - 1), crop))}>This slide (PNG)</button>
            {p.caption && <button className="btn ghost sm" onClick={() => navigator.clipboard?.writeText(p.caption).then(() => toast("Caption copied."))}>Copy caption</button>}
          </div>
          <span className="xs muted" style={{ lineHeight: 1.45 }}>Sized for {p.platform}: {crop === "9:16" ? "1080 × 1920" : "1080 × 1350"} px. To change the design, open it in Carousel studio.</span>
        </div>
      )}
      {!c && p.kind !== "video" && !p.carousel_id && <div className="xs muted" style={{ lineHeight: 1.45 }}>No design attached yet. Ask Sagal to make this post's design and it will appear here, ready to download.</div>}
      <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0,1fr)", gap: "8px 14px", fontSize: 14, lineHeight: 1.4 }}>
        <span className="muted">Post</span><b>{p.title}</b>
        <span className="muted">Account</span><span>{p.account_label} · {p.platform}{p.channelConnected ? "" : " (not connected)"}</span>
        <span className="muted">Time</span><span>{long}, {p.time} · Europe/Helsinki</span>
        <span className="muted">Format</span><span>{p.format}</span>
      </div>
      <div className="row g10" style={{ background: "var(--surface)", borderRadius: 14, padding: "12px 14px", fontSize: 14, lineHeight: 1.5, alignItems: "flex-start" }}>
        <MarkS size={22} />
        <span>{p.globalPaused ? "Held because all publishing is paused." : p.note}{!p.channelConnected && p.display === "later" ? ` ${p.platform} isn't connected yet, so at ${p.time} Sagal hands it to you to post by hand.` : ""}</span>
      </div>
      {editing !== null ? (
        <div className="stack g8">
          <textarea className="input" rows={5} value={editing} onChange={(e) => setEditing(e.target.value)} />
          <div className="row g8"><button className="btn ink sm" onClick={() => { onCaption(editing); setEditing(null); }}>Save caption</button><button className="btn ghost sm" onClick={() => setEditing(null)}>Cancel</button></div>
        </div>
      ) : null}
      <div className="row g8 wrap">
        {p.status === "failed" && <button className="btn ink sm" onClick={() => act(`/api/posts/${p.id}/retry`, "Retry queued for the next agreed slot.")}>Retry at next slot</button>}
        {p.needsApproval && !p.sample && <button className="btn blue sm" onClick={() => act(`/api/posts/${p.id}/approve`, "Approved.")}>Approve this post</button>}
        {mode === "review" && p.approved_at && <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ok)", padding: "8px 0" }}>Approved by you</span>}
        {p.status === "scheduled" && !p.globalPaused && <button className="btn ghost sm" onClick={() => act(`/api/posts/${p.id}/hold`, "Held. Sagal won't publish it until you resume.")}>Hold this post</button>}
        {p.status === "paused" && <button className="btn outline sm" onClick={() => act(`/api/posts/${p.id}/resume`, "Resumed.")}>Resume this post</button>}
        {p.status === "manual" && (
          <>
            {!c && <button className="btn ghost sm" onClick={() => navigator.clipboard?.writeText(p.caption).then(() => toast("Caption copied."))}>Copy caption</button>}
            <button className="btn ink sm" onClick={() => act(`/api/posts/${p.id}/posted`, "Marked as posted by you.")}>I've posted it</button>
          </>
        )}
        {["scheduled", "paused", "manual"].includes(p.status) && editing === null && <button className="btn link" onClick={() => setEditing(p.caption)}>Edit caption</button>}
      </div>
      <div className="xs muted" style={{ lineHeight: 1.45 }}>“Published · confirmed” only appears once the platform confirms it. Posts you publish by hand show as “Posted by you”.</div>
    </div>
  );
}
