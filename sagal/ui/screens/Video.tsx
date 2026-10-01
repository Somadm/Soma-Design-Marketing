import React from "react";
import { api } from "../api";
import { Empty, Kicker, LoadError, Loading, Tag, useAction, useFilePicker, useLoad, useRouter } from "../lib";

interface Job {
  id: number; title: string; script: { t: string; part: string; line: string }[]; script_status: string; voiceover_id: number | null; vo_filename: string | null; vo_size: number | null;
  render_asset_id: number | null; render_filename: string | null; final_asset_id: number | null; final_filename: string | null; platform_captions: Record<string, string>; due_at: string | null; sample: boolean;
  heygenState: "waiting" | "manual" | "made_by_hand" | "render_uploaded" | "ready"; captionsState: "waiting" | "manual" | "handed_off" | "final_uploaded" | "ready";
  heygenConnection: string; captionsConnection: string;
}
const WAVE = [6, 10, 16, 9, 20, 14, 8, 18, 12, 6, 15, 22];

export function VideoScreen() {
  const { path, go } = useRouter();
  const routeId = Number(path.split(/[/?]/)[2]) || null;
  const list = useLoad<{ jobs: { id: number; title: string }[] }>("/api/video");
  const id = routeId ?? list.data?.jobs[0]?.id ?? null;
  const one = useLoad<{ job: Job; links: { voiceover: string | null; render: string | null; final: string | null } }>(id ? `/api/video/${id}` : null, [id]);
  const { run, busy } = useAction();

  const vo = useFilePicker((f) => run(async () => { await api.upload(`/api/video/${id}/voiceover`, f); await one.reload(); }, "Voiceover received. Stored privately."), "audio/*");
  const render = useFilePicker((f) => run(async () => { await api.upload(`/api/video/${id}/render`, f); await one.reload(); }, "Render uploaded."), "video/*");
  const final = useFilePicker((f) => run(async () => { await api.upload(`/api/video/${id}/final`, f); await one.reload(); }, "Final edit uploaded."), "video/*");

  if (list.loading) return <div className="scroll"><div className="page w1400"><Loading /></div></div>;
  if (!id)
    return (
      <div className="scroll">
        <div className="page w1100">
          <Kicker>Video studio</Kicker>
          <Empty title="Nothing in production." body="When an avatar video is agreed, its script, your voiceover and every export will show up here." />
        </div>
      </div>
    );
  if (!one.data) return <div className="scroll"><div className="page w1400">{one.error ? <LoadError error={one.error} retry={one.reload} /> : <Loading />}</div></div>;
  const { job: j, links } = one.data;
  const hasVo = Boolean(j.voiceover_id);
  const handoff = (which: "heygen" | "captions", done: boolean) => run(async () => { await api.post(`/api/video/${j.id}/handoff`, { which, done }); await one.reload(); });

  const HG: Record<Job["heygenState"], [string, string, string]> = {
    waiting: ["Waiting for your voiceover", "Nothing has been sent. Once your voiceover is in, you'll get the HeyGen package (or Sagal sends it, once HeyGen is connected).", "warn"],
    manual: ["Manual handoff", "HeyGen isn't connected yet, so nothing has been sent. Download the package, make the avatar video in HeyGen with your own voiceover, then mark it done.", "warn"],
    made_by_hand: ["Done by hand", "Marked as made in HeyGen by you. Upload the finished render when you have it and Sagal carries on.", "warn"],
    render_uploaded: ["Render uploaded", "Your HeyGen render is stored privately and ready for the edit.", "ok"],
    ready: ["Ready to send", "HeyGen is connected. Automatic sending arrives in the next build; until then use the manual handoff.", "info"],
  };
  const CA: Record<Job["captionsState"], [string, string, string]> = {
    waiting: ["Waiting for the render", "Sagal sends the HeyGen render to Captions for trims and subtitles once it exists.", "idle"],
    manual: ["Manual handoff", "Captions isn't connected yet. Drop these files into Captions yourself. About two minutes.", "warn"],
    handed_off: ["Handed off by you", "Marked as uploaded to Captions by you. Upload the finished edit here when it's done.", "warn"],
    final_uploaded: ["Final edit uploaded", "The finished video is stored privately and attached to its posts.", "ok"],
    ready: ["Ready", "Captions is connected. Automatic sending arrives in the next build; until then use the manual handoff.", "info"],
  };
  const [hgT, hgText, hgTone] = HG[j.heygenState];
  const [caT, caText, caTone] = CA[j.captionsState];
  const steps: [string, string, string][] = [
    ["Script", j.script_status || "Draft", "ok"],
    ["Sabah's voiceover", hasVo ? "Received" : "Waiting for you", hasVo ? "ok" : "warn"],
    ["HeyGen avatar", hgT, hgTone],
    ["Edit in Captions", caT, caTone],
    ["Cover", "Drafted", "ok"],
    ["Platform captions", Object.keys(j.platform_captions ?? {}).length ? "Drafted" : "Not yet", Object.keys(j.platform_captions ?? {}).length ? "ok" : "idle"],
  ];
  const pkg = (file: string) => `/api/video/${j.id}/package/${file}`;

  return (
    <div className="scroll">
      <div className="page w1400" style={{ gap: 26 }}>
        <div className="head">
          <div className="stack g8">
            <Kicker>Video studio · avatar video{j.due_at ? ` · due ${new Date(j.due_at).toLocaleString("en-GB", { timeZone: "Europe/Helsinki", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : ""}</Kicker>
            <h1 className="title-xl">{j.title}</h1>
          </div>
          <div className="row g8 wrap">
            {j.sample && <Tag>Sample</Tag>}
            <div className={`chip ${hasVo ? "ok" : "warn"}`} style={{ padding: "10px 18px", fontSize: 15 }}>{hasVo ? "Voiceover received" : "Waiting for Sabah's voiceover"}</div>
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 6 }}>
          {steps.map(([name, status, tone], n) => (
            <div key={name} className="card stack g8" style={{ borderRadius: 14, padding: "12px 14px" }}>
              <span className="mono muted" style={{ fontSize: 10.5 }}>0{n + 1}</span>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{name}</span>
              <span className={`chip fit ${tone}`} style={{ alignSelf: "flex-start" }}>{status}</span>
            </div>
          ))}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,460px),1fr))", gap: 20, alignItems: "start" }}>
          <div className="stack g20">
            <div className="card strong stack g14" style={{ padding: 24 }}>
              <div className="row between g10 wrap">
                <span className="kicker" style={{ color: "var(--ink)" }}>Production asset · your own voice</span>
                <span className="chip plain">Not Sagal's voice</span>
              </div>
              <div className="serif" style={{ fontSize: 34, lineHeight: 1.05 }}>Upload Sabah's voiceover</div>
              <div style={{ fontSize: 15, lineHeight: 1.55 }} className="muted">Record the script below in your own voice. HeyGen uses this file for your avatar. Sagal's conversational voice is never used for your videos, and nothing is generated in your voice.</div>
              {!hasVo ? (
                <button className="drop" onClick={vo.open} disabled={busy}>
                  <span style={{ fontSize: 16, fontWeight: 600 }}>{busy ? "Uploading privately…" : "Choose an audio file"}</span>
                  <span className="small muted">.m4a, .mp3 or .wav · stored privately, never published on its own</span>
                </button>
              ) : (
                <div className="row g14 wrap note ok" style={{ borderRadius: 16 }}>
                  <div className="row" style={{ gap: 2, height: 26 }} aria-hidden>{WAVE.map((h, n) => <span key={n} style={{ width: 3, height: h, borderRadius: 2, background: "var(--ok)" }} />)}</div>
                  <div className="grow" style={{ minWidth: 160 }}>
                    <div style={{ fontWeight: 600, fontSize: 14.5, color: "var(--ink)" }}>{j.vo_filename}</div>
                    <div style={{ fontSize: 12.5 }}>{((j.vo_size ?? 0) / 1048576).toFixed(1)} MB · Sabah's voiceover · stored privately</div>
                  </div>
                  {links.voiceover && <audio controls src={links.voiceover} style={{ height: 36, maxWidth: 220 }} />}
                  <button className="btn sm" style={{ border: "1px solid var(--ok)", background: "#fff" }} onClick={() => run(async () => { await api.del(`/api/video/${j.id}/voiceover`); await one.reload(); })}>Replace</button>
                </div>
              )}
              {vo.input}
            </div>
            <div className="card soft stack g12" style={{ padding: 24, borderRadius: 24 }}>
              <div className="row between" style={{ alignItems: "baseline" }}><div className="title-s">Script</div><span className="muted" style={{ fontSize: 12.5 }}>{j.script_status}</span></div>
              {j.script.map((s, n) => (
                <div key={n} style={{ display: "grid", gridTemplateColumns: "56px minmax(0,1fr)", gap: 12, padding: "10px 0", borderTop: "1px solid var(--line)" }}>
                  <span className="mono xs muted" style={{ paddingTop: 4 }}>{s.t}</span>
                  <div><Kicker sm>{s.part}</Kicker><div style={{ fontSize: 17, lineHeight: 1.5 }}>{s.line || <span className="muted">Ask Sagal to write this line.</span>}</div></div>
                </div>
              ))}
            </div>
          </div>
          <div className="stack g20">
            <div className="card stack g14" style={{ padding: 22, borderRadius: 24 }}>
              <div className="row between g10 wrap"><div className="title-s">HeyGen</div><span className={`chip ${hgTone}`}>{hgT}</span></div>
              <div style={{ display: "grid", gridTemplateColumns: "120px minmax(0,1fr)", gap: 16, alignItems: "start" }}>
                <div style={{ aspectRatio: "9 / 16", borderRadius: 12, background: "#111", color: "#D9D6CF", display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", padding: 10, fontSize: 11, lineHeight: 1.35, fontFamily: "var(--mono)", overflow: "hidden" }}>
                  {links.render ? <video src={links.render} controls style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : hasVo ? "Not rendered yet" : <>No render.<br />Waits for your voiceover.</>}
                </div>
                <div className="stack g12">
                  <div style={{ fontSize: 14.5, lineHeight: 1.55 }}>{hgText}</div>
                  <div className="row g8 wrap">
                    {j.heygenState === "manual" && <button className="btn ink sm" onClick={() => handoff("heygen", true)}>I've made it in HeyGen</button>}
                    {(j.heygenState === "made_by_hand" || j.heygenState === "manual") && <button className="btn ghost sm" onClick={render.open}>Upload the render</button>}
                    {j.heygenState === "render_uploaded" && <button className="btn ghost sm" onClick={render.open}>Replace render</button>}
                    {j.heygenConnection !== "connected" && <button className="btn link" onClick={() => go("/memory/accounts")}>Connect HeyGen</button>}
                  </div>
                </div>
              </div>
              {(j.heygenState === "manual" || j.heygenState === "made_by_hand") && (
                <div className="note stone stack g6" style={{ fontSize: 13.5 }}>
                  <b>Manual handoff package</b>
                  <div>1. <a href={pkg("script.txt")}>script.txt</a> · final wording</div>
                  <div>2. {links.voiceover ? <a href={links.voiceover} download>{j.vo_filename}</a> : "your voiceover"} · your file, unchanged</div>
                  <div>3. In HeyGen, create the avatar video with your voiceover (audio upload, not a generated voice)</div>
                  <div>4. Come back and press “I've made it in HeyGen”, then upload the render</div>
                </div>
              )}
              {render.input}
            </div>
            <div className="card stack g14" style={{ padding: 22, borderRadius: 24 }}>
              <div className="row between g10 wrap"><div className="title-s">Captions · edit</div><span className={`chip ${caTone}`}>{caT}</span></div>
              <div style={{ fontSize: 14.5, lineHeight: 1.55 }}>{caText}</div>
              {(j.captionsState === "manual" || j.captionsState === "handed_off") && (
                <div className="note stone stack g6" style={{ fontSize: 13.5 }}>
                  <b>Files to drop into Captions</b>
                  <div>{links.render ? <a href={links.render} download>{j.render_filename}</a> : "heygen-render.mp4"} · the render</div>
                  <div><a href={pkg("subtitles.srt")}>subtitles.srt</a> · matches the script</div>
                  <div><a href={pkg("edit-notes.txt")}>edit-notes.txt</a> · trims and emphasis, from Sagal</div>
                  <div className="xs muted">Captioning only: never Mirage's generated voices or avatars.</div>
                </div>
              )}
              <div className="row g8 wrap">
                {j.captionsState === "manual" && <button className="btn ink sm" onClick={() => handoff("captions", true)}>I've uploaded it to Captions</button>}
                {(j.captionsState === "handed_off" || j.captionsState === "manual") && <button className="btn ghost sm" onClick={final.open}>Upload the final edit</button>}
                {j.captionsState === "final_uploaded" && links.final && <a className="btn ghost sm" href={links.final}>Watch the final edit</a>}
              </div>
              {final.input}
            </div>
            <div className="card" style={{ display: "grid", gridTemplateColumns: "140px minmax(0,1fr)", gap: 18, padding: 22, borderRadius: 24 }}>
              <div className="slide th-blue" style={{ aspectRatio: "9 / 16", borderRadius: 12, border: 0 }}>
                <div className="stack" style={{ position: "absolute", inset: 0, padding: "12cqw 10cqw 30cqw", justifyContent: "flex-end", gap: "6cqw" }}>
                  <div className="mono" style={{ fontSize: "7cqw", textTransform: "uppercase" }}>Soma</div>
                  <div className="serif" style={{ fontSize: "19cqw", lineHeight: 0.95 }}>{j.title}</div>
                </div>
              </div>
              <div className="stack g10" style={{ minWidth: 0 }}>
                <div className="serif" style={{ fontSize: 24 }}>Cover &amp; platform captions</div>
                {Object.entries(j.platform_captions ?? {}).map(([p, t]) => <div key={p} style={{ fontSize: 13.5, lineHeight: 1.5 }}><b>{p}</b> · {t}</div>)}
                {!Object.keys(j.platform_captions ?? {}).length && <div className="small muted">Sagal drafts these with the script.</div>}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
