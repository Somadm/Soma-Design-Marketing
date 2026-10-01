import React, { useState } from "react";
import { api } from "../api";
import { Kicker, LoadError, Loading, PLATFORMS, Tag, dayDate, shiftWeek, useAction, useApp, useLoad, weekday } from "../lib";

interface Idea { id: number; title: string; story: string; audience: string; purpose: string; format: string; platforms: string[]; status: "board" | "agreed"; plan_date: string | null; sample: boolean }
interface PlanData { today: string; days: string[]; ideas: Idea[]; formats: string[]; defaultPostTime: string }

export function PlanScreen() {
  const { discuss, vw } = useApp();
  const [week, setWeek] = useState<string | null>(null);
  const { data, error, loading, reload } = useLoad<PlanData>(`/api/plan${week ? `?week=${week}` : ""}`, [week]);
  const { run } = useAction();
  const [pick, setPick] = useState<Record<number, { date?: string; time?: string }>>({});
  const [adding, setAdding] = useState(false);
  const wide = vw >= 1200;

  if (!data) return <div className="scroll"><div className="page w1480">{error ? <LoadError error={error} retry={reload} /> : loading && <Loading />}</div></div>;
  const board = data.ideas.filter((i) => i.status === "board");
  const inWeek = (d: string) => data.ideas.filter((i) => i.status === "agreed" && i.plan_date === d);
  const anySample = data.ideas.some((i) => i.sample);

  return (
    <div className="scroll">
      <div className="page w1480" style={{ gap: 28 }}>
        <div className="head">
          <div className="stack g8">
            <Kicker>Plan together · week of {dayDate(data.days[0])} · Europe/Helsinki</Kicker>
            <h1 className="title-xl">This week, <span className="italic">together.</span></h1>
            <p className="lede">Top: the plan we agreed. Below: ideas still on the table. Moving an idea into the plan lets Sagal produce and publish it within your publishing mode.</p>
          </div>
          <div className="row g8 wrap">
            {anySample && <Tag>Sample plan</Tag>}
            <button className="pill" onClick={() => setWeek(shiftWeek(data.days[0], -1))} aria-label="Previous week">‹ Week</button>
            <button className="pill" onClick={() => setWeek(null)}>This week</button>
            <button className="pill" onClick={() => setWeek(shiftWeek(data.days[0], 1))} aria-label="Next week">Week ›</button>
          </div>
        </div>
        <div style={{ overflowX: "auto", paddingBottom: 4 }}>
          <div style={{ display: "grid", gridTemplateColumns: wide ? "repeat(7,minmax(0,1fr))" : "repeat(7,minmax(180px,1fr))", gap: 8 }}>
            {data.days.map((d) => {
              const items = inWeek(d);
              const today = d === data.today;
              return (
                <div key={d} className={`day${today ? " today" : ""}`} style={{ minHeight: 220, padding: 12 }}>
                  <div className="row between wrap" style={{ alignItems: "baseline", columnGap: 6 }}>
                    <span style={{ fontWeight: 700, fontSize: 14 }}>{weekday(d)}{today ? " · today" : ""}</span>
                    <span className="xs muted">{dayDate(d)}</span>
                  </div>
                  {!items.length && <div className="small muted italic" style={{ paddingTop: 6 }}>Open</div>}
                  {items.map((i) => (
                    <div key={i.id} className="card stack g6" style={{ borderRadius: 12, padding: "10px 12px" }}>
                      <span className="kicker" style={{ fontSize: 10 }}>{i.format}</span>
                      <span className="serif" style={{ fontSize: 20, lineHeight: 1.1 }}>{i.title}</span>
                      <span className="xs muted">{i.platforms.join(" · ")}</span>
                      <button className="btn link" style={{ alignSelf: "flex-start", fontSize: 12 }} onClick={() => run(async () => { await api.post(`/api/ideas/${i.id}/board`); await reload(); }, "Back on the board. Its posts are off the calendar.")}>
                        Back to the board
                      </button>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>

        <div className="stack g14">
          <div className="row between g12 wrap" style={{ alignItems: "baseline" }}>
            <div className="serif" style={{ fontSize: 36, lineHeight: 1 }}>Idea board</div>
            <div className="row g12 wrap">
              <span className="small muted">Each idea: story, audience, purpose, format, platforms.</span>
              <button className="btn ghost sm" onClick={() => setAdding(!adding)}>{adding ? "Close" : "+ Add an idea"}</button>
            </div>
          </div>
          {adding && <NewIdea formats={data.formats} onDone={async () => { setAdding(false); await reload(); }} />}
          {board.length === 0 && !adding && <div className="card dashed" style={{ padding: 28, fontSize: 15, color: "var(--text-2)", borderRadius: 18 }}>{data.ideas.length ? "Everything is in the plan. Ask Sagal for more ideas when you're ready." : "No ideas on the board yet. Tell Sagal one thing you want people to understand this week. She'll turn it into ideas you can argue with."}</div>}
          <div className="grid-cards">
            {board.map((i) => {
              const p = pick[i.id] ?? {};
              const date = p.date ?? data.days.find((d) => d >= data.today) ?? data.days[0];
              return (
                <div key={i.id} className="card stack g14" style={{ borderRadius: 22 }}>
                  <div className="row between g8">
                    <Kicker sm>{i.format}</Kicker>
                    <span className="row g6">{i.sample && <Tag>Sample</Tag>}<span className="chip plain">On the table</span></span>
                  </div>
                  <div className="serif" style={{ fontSize: 30, lineHeight: 1.02, letterSpacing: "-.01em" }}>{i.title}</div>
                  <div style={{ fontSize: 15, lineHeight: 1.5 }}>{i.story}</div>
                  <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0,1fr)", gap: "6px 12px", fontSize: 13.5, lineHeight: 1.4 }}>
                    <span className="muted">Audience</span><span>{i.audience || "—"}</span>
                    <span className="muted">Purpose</span><span>{i.purpose || "—"}</span>
                  </div>
                  <div className="row g6 wrap">{i.platforms.map((x) => <span key={x} className="chip line" style={{ fontWeight: 400 }}>{x}</span>)}</div>
                  <div className="row g8 wrap" style={{ borderTop: "1px solid var(--line-soft)", paddingTop: 14, marginTop: "auto" }}>
                    <select className="input round" style={{ width: "auto", fontSize: 13 }} aria-label="Day" value={date} onChange={(e) => setPick({ ...pick, [i.id]: { ...p, date: e.target.value } })}>
                      {data.days.map((d) => <option key={d} value={d}>{weekday(d)} {dayDate(d)}</option>)}
                    </select>
                    <input className="input round" style={{ width: 124, fontSize: 13 }} type="time" aria-label="Time (Helsinki)" value={p.time ?? data.defaultPostTime} onChange={(e) => setPick({ ...pick, [i.id]: { ...p, time: e.target.value } })} />
                    <button className="btn blue" onClick={() => run(async () => { await api.post(`/api/ideas/${i.id}/plan`, { date, time: p.time ?? data.defaultPostTime }); await reload(); }, "In the plan. Sagal will produce it and publish within your mode.")}>
                      Move into the plan
                    </button>
                    <button className="btn link" onClick={() => discuss({ type: "idea", id: i.id, label: `Idea · ${i.title}` })}>Develop with Sagal</button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function NewIdea({ formats, onDone }: { formats: string[]; onDone: () => void }) {
  const [f, setF] = useState({ title: "", story: "", audience: "", purpose: "", format: formats[0] ?? "Carousel", platforms: ["Instagram"] as string[] });
  const { run, busy } = useAction();
  return (
    <form
      className="card soft stack g12"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => { await api.post("/api/ideas", f); onDone(); }, "Idea added to the board.");
      }}
    >
      <label className="field">Title<input required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
      <label className="field">Story<textarea rows={2} value={f.story} onChange={(e) => setF({ ...f, story: e.target.value })} /></label>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 12 }}>
        <label className="field">Audience<input value={f.audience} onChange={(e) => setF({ ...f, audience: e.target.value })} /></label>
        <label className="field">Purpose<input value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} /></label>
        <label className="field">Format<select value={f.format} onChange={(e) => setF({ ...f, format: e.target.value })}>{formats.map((x) => <option key={x}>{x}</option>)}</select></label>
      </div>
      <div className="row g6 wrap">
        {PLATFORMS.map((p) => (
          <button type="button" key={p} className={`pill sm${f.platforms.includes(p) ? " on" : ""}`} aria-pressed={f.platforms.includes(p)} onClick={() => setF({ ...f, platforms: f.platforms.includes(p) ? f.platforms.filter((x) => x !== p) : [...f.platforms, p] })}>
            {p}
          </button>
        ))}
      </div>
      <button className="btn ink" style={{ alignSelf: "flex-start" }} disabled={busy || !f.title.trim() || !f.platforms.length}>Add to the board</button>
    </form>
  );
}
