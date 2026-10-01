import React, { useEffect, useState } from "react";
import { Kicker, POST_STATUS, Tag, dayDate, useApp, useLoad, useRouter, weekday } from "../lib";
import { MiniSlide, SlideView, type Carousel } from "../slides";

export type WsTab = "carousel" | "script" | "idea" | "week";
export interface WsFocus {
  carousel?: number;
  script?: number;
  idea?: number;
}

export function Workspace({ tab, setTab, focus, wide, canExpand, onToggleWide, version }: { tab: WsTab; setTab: (t: WsTab) => void; focus: WsFocus; wide: boolean; canExpand: boolean; onToggleWide: () => void; version: number }) {
  const tabs: [WsTab, string][] = [["carousel", "Carousel"], ["script", "Script"], ["idea", "Idea"], ["week", "This week"]];
  return (
    <>
      <div className="ws-tabs">
        <div className="row g4 wrap grow" role="tablist">
          {tabs.map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={`pill${tab === k ? " on" : ""}`} onClick={() => setTab(k)}>
              {l}
            </button>
          ))}
        </div>
        <button className="pill" onClick={onToggleWide}>{wide || !canExpand ? "Back to chat" : "Expand"}</button>
      </div>
      <div className="ws-body">
        {tab === "carousel" && <WsCarousel id={focus.carousel} wide={wide} version={version} />}
        {tab === "script" && <WsScript id={focus.script} version={version} />}
        {tab === "idea" && <WsIdea id={focus.idea} version={version} />}
        {tab === "week" && <WsWeek version={version} />}
      </div>
    </>
  );
}

function Nothing({ title, body }: { title: string; body: string }) {
  return (
    <div className="stack g10">
      <div className="title-s">{title}</div>
      <div className="small muted" style={{ lineHeight: 1.5 }}>{body}</div>
    </div>
  );
}

function WsCarousel({ id, wide, version }: { id?: number; wide: boolean; version: number }) {
  const { go } = useRouter();
  const { discuss } = useApp();
  const list = useLoad<{ carousels: { id: number }[] }>(id ? null : "/api/carousels", [version]);
  const cid = id ?? list.data?.carousels[0]?.id;
  const one = useLoad<{ carousel: Carousel }>(cid ? `/api/carousels/${cid}` : null, [version]);
  const [i, setI] = useState(0);
  useEffect(() => setI(0), [cid]);
  if (!cid) return list.loading ? null : <Nothing title="No carousel yet." body="Ask Sagal to turn an idea or a project into a carousel. It opens here while you talk." />;
  const c = one.data?.carousel;
  if (!c) return null;
  const slides = c.slides;
  const cur = slides[Math.min(i, slides.length - 1)];
  const comments = c.comments.filter((x) => x.slide_index === i).length;
  return (
    <div className="stack g16">
      <div className="row between g12" style={{ alignItems: "flex-start" }}>
        <div>
          <Kicker sm>Carousel · {c.project || "Unsorted"} · draft {c.draft}</Kicker>
          <div className="title-s">{c.title}</div>
        </div>
        {c.sample && <Tag>Sample story</Tag>}
      </div>
      <div style={{ width: "100%", maxWidth: wide ? 620 : 460, margin: "0 auto" }}>
        <SlideView slide={cur} n={i + 1} count={slides.length} shadow />
      </div>
      <div className="row g14" style={{ justifyContent: "center" }}>
        <button className="circle-btn" aria-label="Previous slide" onClick={() => setI(Math.max(0, i - 1))}>‹</button>
        <div style={{ fontSize: 14, minWidth: 150, textAlign: "center" }}><b>Slide {i + 1}</b> · {cur.role}</div>
        <button className="circle-btn" aria-label="Next slide" onClick={() => setI(Math.min(slides.length - 1, i + 1))}>›</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(slides.length, 7)}, minmax(0,1fr))`, gap: 6 }}>
        {slides.map((s, n) => (
          <button key={n} className={`thumb-btn${n === i ? " on" : ""}`} style={{ borderRadius: 8 }} aria-label={`Slide ${n + 1}: ${s.role}`} onClick={() => setI(n)}>
            <MiniSlide slide={s} n={n + 1} numberOnly />
          </button>
        ))}
      </div>
      <div className="row g8 wrap">
        <button className="btn blue" onClick={() => discuss({ type: "slide", id: `${c.id}:${i}`, label: `Slide ${i + 1} · ${cur.role}` })}>Discuss slide {i + 1}</button>
        <button className="btn outline" onClick={() => go(`/carousel/${c.id}`)}>Open in Carousel studio</button>
      </div>
      <div className="small muted">{comments ? `${comments} comment${comments === 1 ? "" : "s"} on this slide · open the studio to reply` : "No comments on this slide yet"}</div>
    </div>
  );
}

interface VideoJob { id: number; title: string; script: { t: string; part: string; line: string }[]; voiceover_id: number | null; vo_filename: string | null; due_at: string | null; sample: boolean }

function WsScript({ id, version }: { id?: number; version: number }) {
  const { go } = useRouter();
  const list = useLoad<{ jobs: { id: number }[] }>(id ? null : "/api/video", [version]);
  const vid = id ?? list.data?.jobs[0]?.id;
  const one = useLoad<{ job: VideoJob }>(vid ? `/api/video/${vid}` : null, [version]);
  if (!vid) return list.loading ? null : <Nothing title="No script yet." body="When you agree an avatar video, Sagal writes the script here. You record it in your own voice." />;
  const j = one.data?.job;
  if (!j) return null;
  const last = j.script[j.script.length - 1]?.t;
  return (
    <div className="stack g18">
      <div>
        <Kicker sm>Video script · avatar video{last ? ` · ~${last}` : ""}</Kicker>
        <div className="title-s">{j.title}</div>
      </div>
      <div className={`row g10 wrap note ${j.voiceover_id ? "ok" : "warn"}`}>
        <span className="kicker" style={{ color: "inherit" }}>{j.voiceover_id ? "Voiceover received" : "Waiting for Sabah's voiceover"}</span>
        <span className="grow" style={{ minWidth: 180 }}>{j.voiceover_id ? `${j.vo_filename} · ready for HeyGen` : "Record it in your own voice and upload it in Video studio."}</span>
      </div>
      {j.script.map((s, n) => (
        <div key={n} style={{ display: "grid", gridTemplateColumns: "64px minmax(0,1fr)", gap: 12, paddingBottom: 14, borderBottom: "1px solid var(--line)" }}>
          <span className="mono xs muted" style={{ paddingTop: 4 }}>{s.t}</span>
          <div className="stack g4">
            <Kicker sm>{s.part}</Kicker>
            <span style={{ fontSize: 17, lineHeight: 1.5 }}>{s.line}</span>
          </div>
        </div>
      ))}
      <div className="small muted" style={{ lineHeight: 1.5 }}>You record this in your own voice. Sagal's conversational voice is never used for your avatar.</div>
      <button className="btn outline" style={{ alignSelf: "flex-start" }} onClick={() => go(`/video/${j.id}`)}>Upload Sabah's voiceover in Video studio</button>
    </div>
  );
}

interface Idea { id: number; title: string; story: string; audience: string; purpose: string; format: string; platforms: string[]; status: string; plan_date: string | null; sample: boolean }

function WsIdea({ id, version }: { id?: number; version: number }) {
  const { go } = useRouter();
  const { discuss } = useApp();
  const plan = useLoad<{ ideas: Idea[] }>("/api/plan", [version]);
  const ideas = plan.data?.ideas ?? [];
  const idea = (id ? ideas.find((x) => x.id === id) : undefined) ?? ideas.filter((x) => x.status === "board").slice(-1)[0] ?? ideas[0];
  if (!idea) return plan.loading ? null : <Nothing title="No ideas yet." body="Tell Sagal the messy version of an idea. She'll sketch it here so you're both looking at the same thing." />;
  return (
    <div className="stack g16">
      <div className="row between g8">
        <Kicker sm>Idea · {idea.format}</Kicker>
        <span className="chip plain">{idea.status === "agreed" ? `In the plan · ${idea.plan_date ? dayDate(idea.plan_date) : ""}` : "On the table"}</span>
      </div>
      <div className="serif" style={{ fontSize: 40, lineHeight: 1.02, letterSpacing: "-.015em" }}>{idea.title}</div>
      <div style={{ fontSize: 17, lineHeight: 1.55 }}>{idea.story}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(160px,1fr))", gap: 10 }}>
        {[["Audience", idea.audience], ["Purpose", idea.purpose], ["Platforms", idea.platforms.join(", ")]].map(([k, v]) => (
          <div key={k} className="card" style={{ borderRadius: 14, padding: "12px 14px" }}>
            <Kicker sm>{k}</Kicker>
            <div style={{ fontSize: 14.5, marginTop: 4 }}>{v || "—"}</div>
          </div>
        ))}
      </div>
      <div className="row g8 wrap">
        <button className="btn outline" onClick={() => go("/plan")}>See it on the idea board</button>
        <button className="btn link" onClick={() => discuss({ type: "idea", id: idea.id, label: `Idea · ${idea.title}` })}>Develop with Sagal</button>
      </div>
    </div>
  );
}

interface PubPost { id: number; date: string; time: string; title: string; platform: string; display: string }

function WsWeek({ version }: { version: number }) {
  const { go } = useRouter();
  const pub = useLoad<{ days: string[]; posts: PubPost[] }>("/api/publishing", [version]);
  const d = pub.data;
  if (!d) return null;
  return (
    <div className="stack g14">
      <div>
        <Kicker sm>This week · Europe/Helsinki</Kicker>
        <div className="title-s">{dayDate(d.days[0])} – {dayDate(d.days[6])}</div>
      </div>
      {d.days.map((day) => {
        const ps = d.posts.filter((p) => p.date === day);
        return (
          <div key={day} style={{ display: "grid", gridTemplateColumns: "70px minmax(0,1fr)", gap: 12, padding: "10px 0", borderBottom: "1px solid var(--line)" }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{weekday(day)}</div>
              <div className="xs muted">{dayDate(day)}</div>
            </div>
            <div className="stack g6">
              {!ps.length && <span className="muted italic" style={{ fontSize: 13.5 }}>Nothing. On purpose.</span>}
              {ps.map((p) => {
                const s = POST_STATUS[p.display] ?? POST_STATUS.scheduled;
                return (
                  <div key={p.id} className="row g8 wrap">
                    <span className="mono" style={{ fontSize: 11.5 }}>{p.time}</span>
                    <span style={{ fontSize: 14, fontWeight: 500 }}>{p.title}</span>
                    <span className={`chip fit ${s.cls}`} style={{ fontSize: 11.5, padding: "2px 8px" }}>{p.platform} · {s.label}</span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      <button className="btn outline" style={{ alignSelf: "flex-start" }} onClick={() => go("/publish")}>Open Publishing calendar</button>
    </div>
  );
}
