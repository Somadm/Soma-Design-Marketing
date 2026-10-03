import React, { useEffect, useState } from "react";
import { api } from "../api";
import { BRAIN_MODES, ImageSlot, Kicker, LoadError, Loading, MarkS, PLATFORMS, Switch, Tag, useAction, useApp, useLoad, useRouter, when } from "../lib";
import { SPEEDS } from "./Voice";

const TABS = [
  ["facts", "Business facts"],
  ["brand", "Brand assets"],
  ["language", "Approved language"],
  ["prefs", "Creative preferences"],
  ["thinking", "Sagal's thinking"],
  ["voice", "Voice"],
  ["accounts", "Connected accounts"],
  ["notif", "Notifications"],
  ["perms", "Publishing permissions"],
  ["look", "Sagal's appearance"],
] as const;
type Tab = (typeof TABS)[number][0];

interface Entry { id: number; section: string; key: string; value: unknown; owner: string; updated_by: string; sample: boolean; updated_at: string }
interface MemoryData { entries: Entry[]; factFields: [string, string, string][]; history: { id: number; section: string; key: string; changed_by: string; changed_at: string }[] }
interface Settings {
  settings: { notifications: Record<string, boolean>; voice: { voice: string; speed: string; transcript: boolean }; appearance: { portraitAssetId: number | null; approved: boolean } };
  brandLinks: Record<string, string | null>;
  portraitUrl: string | null;
}

export function MemoryScreen() {
  const { path, go } = useRouter();
  const { vw } = useApp();
  const tab = (path.split(/[/?]/)[2] as Tab) || "facts";
  const isMobile = vw < 880;
  return (
    <div className="scroll">
      <div className="page w1280">
        <div className="stack g8">
          <Kicker>Memory &amp; settings · shared by Sagal and Bilan where marked</Kicker>
          <h1 className="title-xl">What Sagal knows</h1>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "minmax(0,1fr)" : "220px minmax(0,1fr)", gap: 28, alignItems: "start" }}>
          <div className={isMobile ? "row g6 wrap" : "stack g4"} style={{ position: isMobile ? "static" : "sticky", top: 0 }} role="tablist">
            {TABS.map(([k, l]) => (
              <button key={k} role="tab" aria-selected={tab === k} className={isMobile ? `pill sm${tab === k ? " on" : ""}` : `nav-item${tab === k ? " on" : ""}`} onClick={() => go(`/memory/${k}`)}>
                {l}
              </button>
            ))}
          </div>
          <div className="stack g18" style={{ minWidth: 0 }}>
            {tab === "facts" && <Facts />}
            {tab === "brand" && <Brand />}
            {tab === "language" && <Language />}
            {tab === "prefs" && <Prefs />}
            {tab === "thinking" && <Thinking />}
            {tab === "voice" && <VoiceSettings />}
            {tab === "accounts" && <Accounts />}
            {tab === "notif" && <Notifications />}
            {tab === "perms" && <Permissions />}
            {tab === "look" && <Appearance />}
          </div>
        </div>
      </div>
    </div>
  );
}

const SharedTag = () => <Tag>Shared with Bilan</Tag>;

function useMemory() {
  return useLoad<MemoryData>("/api/memory");
}

function Facts() {
  const { data, error, reload } = useMemory();
  const [vals, setVals] = useState<Record<string, string>>({});
  const { run, busy } = useAction();
  useEffect(() => {
    if (data) setVals(Object.fromEntries(data.entries.filter((e) => e.section === "facts").map((e) => [e.key, String(e.value)])));
  }, [data]);
  if (error) return <LoadError error={error} retry={reload} />;
  if (!data) return <Loading />;
  const sample = data.entries.some((e) => e.section === "facts" && e.sample);
  return (
    <>
      <div className="row g10 wrap"><div className="title-m">Business facts</div><SharedTag />{sample && <Tag>Sample values</Tag>}</div>
      <div className="muted" style={{ fontSize: 14.5 }}>Sagal checks every post against these and never invents what's missing. You own these: Sagal and Bilan can't change them without asking.</div>
      <form className="stack g14" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api.put("/api/memory/facts", vals); await reload(); }, "Saved to shared memory."); }}>
        <div className="grid-cards">
          {data.factFields.map(([k, label, ph]) => (
            <label key={k} className="field">{label}<input value={vals[k] ?? ""} placeholder={ph} onChange={(e) => setVals({ ...vals, [k]: e.target.value })} /></label>
          ))}
        </div>
        <button className="btn ink" style={{ alignSelf: "flex-start" }} disabled={busy}>Save facts</button>
      </form>
      {data.history.length > 0 && (
        <details className="small">
          <summary className="muted" style={{ cursor: "pointer" }}>Edit history</summary>
          <div className="stack g4" style={{ marginTop: 8 }}>
            {data.history.map((h) => <div key={h.id} className="muted">{when(h.changed_at)} · {h.changed_by} changed {h.section} / {h.key}</div>)}
          </div>
        </details>
      )}
    </>
  );
}

function Brand() {
  const { data, reload } = useLoad<Settings>("/api/settings");
  const { run } = useAction();
  const slot = (k: string, label: string, ph: string) => (
    <div className="stack g8">
      <div style={{ aspectRatio: "1 / 1" }}><ImageSlot url={data?.brandLinks[k]} placeholder={ph} onFile={(f) => run(async () => { await api.upload(`/api/brand/${k}`, f); await reload(); }, "Saved privately.")} /></div>
      <span style={{ fontSize: 13, fontWeight: 600 }}>{label}</span>
    </div>
  );
  return (
    <>
      <div className="row g10 wrap"><div className="title-m">Brand assets</div><SharedTag /></div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(200px,1fr))", gap: 14 }}>
        {slot("logo", "Logo", "Drop your logo")}
        {slot("wordmark", "Wordmark", "Drop your wordmark")}
        {slot("photo", "Approved photography", "Drop an approved photo")}
      </div>
      <div className="row g10 wrap">
        {[["#111", "Ink #111111"], ["#fff", "Paper #FFFFFF"], ["#F5F3EE", "Stone #F5F3EE"], ["#94ABF9", "Soma blue #94ABF9 · accent only, never small text"]].map(([c, l]) => (
          <div key={l} className="row g8" style={{ fontSize: 13 }}><span style={{ width: 36, height: 36, borderRadius: 10, background: c, border: "1px solid var(--input-2)" }} />{l}</div>
        ))}
      </div>
    </>
  );
}

function Language() {
  const { data, reload } = useMemory();
  const [f, setF] = useState({ say: "", not: "", note: "" });
  const { run } = useAction();
  const items = data?.entries.filter((e) => e.section === "language") ?? [];
  return (
    <>
      <div className="row g10 wrap"><div className="title-m">Approved language</div><SharedTag /></div>
      <div className="muted" style={{ fontSize: 14.5 }}>Sentences you've approved. Sagal copies the tone, not the words.</div>
      <div className="grid-cards">
        {items.map((e) => {
          const v = e.value as { say?: string; not?: string; note?: string };
          return (
            <div key={e.id} className="card stack g8" style={{ borderRadius: 18 }}>
              <div className="row between"><span style={{ fontSize: 12, fontWeight: 700, color: "var(--ok)" }}>We say</span>{e.sample ? <Tag>Sample</Tag> : <span className="xs muted">by {e.owner}</span>}</div>
              <span className="serif" style={{ fontSize: 22 }}>“{v.say}”</span>
              {v.not && <><span style={{ fontSize: 12, fontWeight: 700, color: "var(--err)" }}>Not</span><span className="muted" style={{ fontSize: 14 }}>“{v.not}”</span></>}
              {v.note && <span className="muted" style={{ fontSize: 14 }}>{v.note}</span>}
              <button className="btn link" style={{ alignSelf: "flex-start", fontSize: 12 }} onClick={() => run(async () => { await api.del(`/api/memory/${e.id}`); await reload(); })}>Remove</button>
            </div>
          );
        })}
      </div>
      <form className="card soft stack g10" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api.post("/api/memory/language", { say: f.say, not: f.not || undefined, note: f.note || undefined }); setF({ say: "", not: "", note: "" }); await reload(); }, "Added."); }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 10 }}>
          <label className="field">We say<input required value={f.say} onChange={(e) => setF({ ...f, say: e.target.value })} /></label>
          <label className="field">Not (optional)<input value={f.not} onChange={(e) => setF({ ...f, not: e.target.value })} /></label>
          <label className="field">Note (optional)<input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
        </div>
        <button className="btn ink sm" style={{ alignSelf: "flex-start" }}>Add sentence</button>
      </form>
    </>
  );
}

function Prefs() {
  const { data, reload } = useMemory();
  const [text, setText] = useState("");
  const { run } = useAction();
  const items = data?.entries.filter((e) => e.section === "preferences") ?? [];
  const notes = data?.entries.filter((e) => e.section === "notes") ?? [];
  return (
    <>
      <div className="row g10 wrap"><div className="title-m">Creative preferences</div><SharedTag /></div>
      <div className="row g8 wrap">
        {items.map((e) => (
          <span key={e.id} className="row g8" style={{ border: `1px ${String(e.value).startsWith("Avoid") ? "dashed var(--dash)" : "solid var(--ink)"}`, borderRadius: 999, padding: "6px 6px 6px 14px", fontSize: 14 }}>
            {String(e.value)}
            <button className="x" aria-label={`Remove ${String(e.value)}`} onClick={() => run(async () => { await api.del(`/api/memory/${e.id}`); await reload(); })}>×</button>
          </span>
        ))}
        {!items.length && <span className="muted small">None yet.</span>}
      </div>
      <form className="row g8" onSubmit={(e) => { e.preventDefault(); if (text.trim()) void run(async () => { await api.post("/api/memory/preferences", { text }); setText(""); await reload(); }); }}>
        <input className="input round grow" placeholder="e.g. Show the work, not the result" value={text} onChange={(e) => setText(e.target.value)} />
        <button className="btn ink sm">Add</button>
      </form>
      {notes.length > 0 && (
        <div className="stack g8">
          <div className="title-s" style={{ fontSize: 22 }}>Notes Sagal and Bilan saved</div>
          <div className="list">
            {notes.map((e) => (
              <div key={e.id} className="li">
                <div><div style={{ fontWeight: 600, fontSize: 14 }}>{e.key}</div><div className="small muted">{String(e.value)} · {e.owner}</div></div>
                <button className="btn link" style={{ fontSize: 12 }} onClick={() => run(async () => { await api.del(`/api/memory/${e.id}`); await reload(); })}>Remove</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function Thinking() {
  const { overview, refreshOverview } = useApp();
  const { run } = useAction();
  const mode = overview?.brainMode ?? "auto";
  return (
    <>
      <div className="title-m">Sagal's thinking</div>
      <div className="muted" style={{ fontSize: 14.5, lineHeight: 1.55, maxWidth: 720 }}>
        Sagal thinks with Claude. <b>Sonnet 5.5</b> is quick and costs about half as much. <b>Opus 5.5</b> is her deepest thinking, for the work that matters most. Each reply shows which one wrote it.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,240px),1fr))", gap: 12 }}>
        {BRAIN_MODES.map((m) => (
          <button
            key={m.id}
            aria-pressed={mode === m.id}
            onClick={() => run(async () => { await api.patch("/api/settings/brain", { mode: m.id }); refreshOverview(); }, `Saved: ${m.title}.`)}
            className="stack g8"
            style={{ textAlign: "left", border: `1.5px solid ${mode === m.id ? "var(--blue)" : "var(--input-2)"}`, background: mode === m.id ? "var(--blue-tint)" : "#fff", borderRadius: 20, padding: "18px 20px" }}
          >
            <span className="row g10"><span style={{ width: 18, height: 18, borderRadius: "50%", border: "1.5px solid #111", background: mode === m.id ? "#111" : "#fff", boxShadow: "inset 0 0 0 3px #fff" }} /><b style={{ fontSize: 16 }}>{m.title}</b></span>
            <span style={{ fontSize: 14, lineHeight: 1.5 }}>{m.body}</span>
          </button>
        ))}
      </div>
      <div className="card stack g10" style={{ borderRadius: 20 }}>
        <div className="row between g12">
          <div className="stack g4" style={{ maxWidth: 640 }}>
            <b style={{ fontSize: 16 }}>Let Sagal search the web</b>
            <span style={{ fontSize: 14, lineHeight: 1.5 }}>
              She can look up what people are talking about this week, check a fact or date, find trends and formats, and read links you share. She credits sources and never copies anyone's work.
            </span>
            <span className="small muted" style={{ lineHeight: 1.5 }}>
              Costs: each search is about 1 cent on your Claude bill (reading a page only costs the usual thinking). She searches a few times at most per reply, and never during live voice so she answers fast.
            </span>
          </div>
          <Switch
            on={Boolean(overview?.webSearch)}
            label="Let Sagal search the web"
            onChange={(on) => run(async () => { await api.patch("/api/settings/web", { enabled: on }); refreshOverview(); }, on ? "Web search is on. Sagal can look things up from her next reply." : "Web search is off.")}
          />
        </div>
        {overview?.webError && !overview.webSearch && <div className="note warn small">{overview.webError}</div>}
      </div>
      <div className="list">
        <div style={{ padding: "12px 18px", fontSize: 13, fontWeight: 700, borderBottom: "1px solid var(--line-soft)" }}>In Automatic, Sagal uses Opus 5.5 for…</div>
        {[
          ["Planning", "a week, a month, a launch or a series"],
          ["Strategy", "positioning, campaigns, brand voice, messaging"],
          ["Whole drafts", "a full carousel, a video script, a story"],
          ["Careful work", "rewrites, critiques, reading results"],
          ["Long material", "PDFs, several reference images, long messages"],
          ["When you ask", "“think harder”, “take your time”, “deep dive”"],
        ].map(([k, v]) => (
          <div key={k} className="li"><div><div style={{ fontSize: 14.5, fontWeight: 600 }}>{k}</div><div className="small muted">{v}</div></div></div>
        ))}
        <div className="li"><div><div style={{ fontSize: 14.5, fontWeight: 600 }}>…and Sonnet 5.5 for everything else</div><div className="small muted">Quick questions, small edits, chat, and live voice (so she answers fast). If Sonnet sees a request needs more depth, she hands it to Opus before answering.</div></div></div>
      </div>
      <div className="small muted">The same switch sits at the top of Talk to Sagal, so you can change it mid-conversation.</div>

    </>
  );
}

function VoiceSettings() {
  const { go } = useRouter();
  const { data, reload } = useLoad<Settings>("/api/settings");
  const { run } = useAction();
  if (!data) return <Loading />;
  const v = data.settings.voice;
  const save = (patch: Partial<typeof v>) => run(async () => { await api.patch("/api/settings/voice", patch); await reload(); });
  return (
    <>
      <div className="title-m">Voice</div>
      <div className="grid-cards">
        <label className="field">Sagal's voice<select value={v.voice} onChange={(e) => save({ voice: e.target.value })}>{["Warm · lightly Brooklyn", "Warm · neutral", "Brighter · quicker", "Somali · warm"].map((o) => <option key={o}>{o}</option>)}</select></label>
        <label className="field">Playback speed<select value={v.speed} onChange={(e) => save({ speed: e.target.value })}>{SPEEDS.map((o) => <option key={o}>{o}</option>)}</select></label>
      </div>
      <div className="list">
        <div className="li"><span style={{ fontSize: 14.5 }}>Live transcript</span><Switch on={v.transcript} onChange={(t) => save({ transcript: t })} label="Live transcript" /></div>
        <div className="li"><span style={{ fontSize: 14.5 }}>Turn length</span><span className="muted" style={{ fontSize: 14 }}>Stops after about 20 seconds unless you ask for more</span></div>
        <div className="li"><span style={{ fontSize: 14.5 }}>Interrupting</span><span className="muted" style={{ fontSize: 14 }}>Start talking and she stops mid-sentence</span></div>
      </div>
      <div className="note stone" style={{ fontSize: 14.5, lineHeight: 1.55 }}>
        <b>Two different kinds of audio.</b> “Talk to Sagal” is conversational audio, generated live and not stored. “Sabah's voiceover” is a production asset you record and upload in Video studio. Sagal's voice is never used for your avatar, and nothing clones your voice.
      </div>
      <div className="note warn small">Until a speech provider is connected, Talk live uses your browser's built-in voice. The voice name above is what Sagal will use once a provider is chosen in Test Sagal's voice.</div>
      <button className="btn outline" style={{ alignSelf: "flex-start" }} onClick={() => go("/voicetest")}>Open Test Sagal's voice</button>
    </>
  );
}

interface Service { id: string; name: string; what: string; steps: string[]; gate?: string; fields: { key: string; label: string; help: string; secret: boolean; optional?: boolean }[]; oauth?: boolean; state: string; account: string | null; lastError: string | null; saved: Record<string, string | null>; envFallback: boolean; redirectUri: string | null }
const STATE: Record<string, [string, string]> = {
  not_connected: ["Not connected", "idle"],
  credentials_saved: ["Key saved · not connected yet", "warn"],
  connected: ["Connected", "ok"],
  needs_reconnect: ["Needs reconnecting", "err"],
};

function Accounts() {
  const { path } = useRouter();
  const { toast } = useApp();
  const { data, error, reload } = useLoad<{ services: Service[] }>("/api/accounts");
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (q.get("message")) {
      toast(q.get("message")!, q.get("ok") !== "1");
      setOpen(q.get("service"));
      history.replaceState(null, "", "/memory/accounts");
    }
  }, [path, toast]);
  if (error) return <LoadError error={error} retry={reload} />;
  if (!data) return <Loading />;
  return (
    <>
      <div className="title-m">Connected accounts</div>
      <div className="muted" style={{ fontSize: 14.5, lineHeight: 1.55 }}>
        Nothing is connected yet, and everything still works: Sagal hands you anything she can't do herself (posting by hand, making the HeyGen video, the Captions edit). When you're ready, paste each key here. Keys are encrypted on the server and never shown again; you'll only see the last four characters.
      </div>
      <div className="list">
        {data.services.map((s) => {
          const [label, tone] = STATE[s.state] ?? STATE.not_connected;
          return (
            <div key={s.id} className="stack" style={{ borderBottom: "1px solid var(--line-soft)" }}>
              <div className="li" style={{ borderBottom: 0 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>{s.name}</div>
                  <div className="muted" style={{ fontSize: 12.5 }}>{s.what}</div>
                </div>
                <div className="row g8">
                  <span className={`chip ${tone}`}>{s.envFallback && s.state === "not_connected" ? "Set on the server" : label}</span>
                  <button className="btn ghost xs" aria-expanded={open === s.id} onClick={() => setOpen(open === s.id ? null : s.id)}>{open === s.id ? "Close" : s.state === "not_connected" ? "Set up" : "Manage"}</button>
                </div>
              </div>
              {open === s.id && <ServiceForm s={s} onChange={reload} />}
            </div>
          );
        })}
        <div className="li">
          <div><div style={{ fontSize: 15, fontWeight: 600 }}>Bilan</div><div className="muted" style={{ fontSize: 12.5 }}>Shared workspace</div></div>
          <span className="chip info">Shared memory and tasks</span>
        </div>
      </div>
    </>
  );
}

function ServiceForm({ s, onChange }: { s: Service; onChange: () => Promise<void> }) {
  const [vals, setVals] = useState<Record<string, string>>({});
  const { run, busy } = useAction();
  const { toast } = useApp();
  return (
    <div className="stack g14" style={{ padding: "4px 18px 18px" }}>
      <ol className="small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>{s.steps.map((x) => <li key={x}>{x}</li>)}</ol>
      {s.gate && <div className="note warn small">{s.gate}</div>}
      {s.redirectUri && (
        <div className="small">
          Redirect URL to paste into the developer app: <code className="mono" style={{ background: "var(--stone-2)", padding: "2px 6px", borderRadius: 6, wordBreak: "break-all" }}>{s.redirectUri}</code>
        </div>
      )}
      {s.lastError && <div className="note err small">Last problem: {s.lastError}</div>}
      <form
        className="stack g10"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const r = await api.put<{ ok: boolean; test?: { ok: boolean; message: string } }>(`/api/accounts/${s.id}`, vals);
            setVals({});
            await onChange();
            toast(r.test ? `Saved and encrypted. ${r.test.message}` : "Saved and encrypted.", r.test ? !r.test.ok : false);
          });
        }}
      >
        <div className="grid-cards">
          {s.fields.map((f) => (
            <label key={f.key} className="field">
              {f.label}{f.optional ? " (optional)" : ""}
              <input type={f.secret ? "password" : "text"} autoComplete="off" spellCheck={false} placeholder={s.saved[f.key] ? `Saved ${s.saved[f.key] === "saved" ? "" : s.saved[f.key]} · paste to replace` : f.help} value={vals[f.key] ?? ""} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} />
            </label>
          ))}
        </div>
        <div className="row g8 wrap">
          <button className="btn ink sm" disabled={busy || !Object.values(vals).some((v) => v.trim())}>Save</button>
          {s.oauth && <a className="btn blue sm" href={`/api/oauth/${s.id}/start`}>{s.state === "connected" ? "Reconnect" : "Connect"}</a>}
          {(s.id === "anthropic" || s.id === "email" || s.id === "heygen" || (s.id === "meta" && s.state === "connected")) && (s.saved[s.fields[0].key] || s.envFallback) && (
            <button type="button" className="btn ghost sm" disabled={busy} onClick={() => run(async () => { const r = await api.post<{ ok: boolean; message: string }>(`/api/accounts/${s.id}/test`); toast(r.message, !r.ok); await onChange(); })}>Test it</button>
          )}
          {s.state !== "not_connected" && (
            <button type="button" className="btn link" onClick={() => confirm(`Remove ${s.name}? Its saved keys are deleted.`) && run(async () => { await api.del(`/api/accounts/${s.id}`); await onChange(); }, "Removed.")}>Disconnect and delete keys</button>
          )}
        </div>
      </form>
    </div>
  );
}

const NOTIF: [string, string, string][] = [
  ["inbox", "Needs Sabah items", "Email, as they happen"],
  ["fail", "Publishing failures", "Immediately, even during quiet hours"],
  ["daily", "Daily summary", "17:00 Helsinki, one short message"],
  ["published", "Every confirmed post", "Off by default; it gets noisy"],
  ["quiet", "Quiet hours", "21:00–08:00 Helsinki. Only failures break through"],
];

function Notifications() {
  const { data, reload } = useLoad<Settings>("/api/settings");
  const { run } = useAction();
  if (!data) return <Loading />;
  const n = data.settings.notifications;
  return (
    <>
      <div className="title-m">Notifications</div>
      <div className="list">
        {NOTIF.map(([k, l, sub]) => (
          <div key={k} className="li">
            <div><div style={{ fontSize: 15, fontWeight: 600 }}>{l}</div><div className="small muted">{sub}</div></div>
            <Switch on={n[k]} label={l} onChange={(v) => run(async () => { await api.patch("/api/settings/notifications", { [k]: v }); await reload(); })} />
          </div>
        ))}
      </div>
      <div className="small muted">Emails go out once Email (Resend) is set up in Connected accounts.</div>
    </>
  );
}

function Permissions() {
  const { data, reload } = useLoad<{ authorisation: { mode: "plan" | "review"; channels: string[]; spendLimitEur: number; paused: boolean }; spentThisMonth: number }>("/api/publishing");
  const hist = useLoad<{ authorisations: { id: number; mode: string; channels: string[]; spend_limit_eur: number; paused: boolean; granted_at: string; note: string }[] }>("/api/publishing/history", [data]);
  const { run } = useAction();
  const [spend, setSpend] = useState<string | null>(null);
  if (!data) return <Loading />;
  const a = data.authorisation;
  const save = (patch: object, msg = "Saved. This is now what Sagal is allowed to do.") => run(async () => { await api.post("/api/publishing/permissions", patch); await reload(); }, msg);
  const modes: ["plan" | "review", string, string][] = [
    ["plan", "Publish within an approved plan", "Sagal produces and publishes anything in the agreed weekly plan, on the channels below, without asking again. Anything outside the plan comes back to you."],
    ["review", "Review each finished post", "Sagal prepares every post and waits. Nothing publishes until you approve it in Publishing."],
  ];
  return (
    <>
      <div className="title-m">Publishing permissions</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,280px),1fr))", gap: 12 }}>
        {modes.map(([k, t, b]) => (
          <button key={k} onClick={() => save({ mode: k })} aria-pressed={a.mode === k} className="stack g8" style={{ textAlign: "left", border: `1.5px solid ${a.mode === k ? "var(--blue)" : "var(--input-2)"}`, background: a.mode === k ? "var(--blue-tint)" : "#fff", borderRadius: 20, padding: "18px 20px" }}>
            <span className="row g10"><span style={{ width: 18, height: 18, borderRadius: "50%", border: "1.5px solid #111", background: a.mode === k ? "#111" : "#fff", boxShadow: "inset 0 0 0 3px #fff" }} /><b style={{ fontSize: 16 }}>{t}</b></span>
            <span style={{ fontSize: 14, lineHeight: 1.5 }}>{b}</span>
          </button>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,300px),1fr))", gap: 14 }}>
        <div className="list">
          <div style={{ padding: "12px 18px", fontSize: 13, fontWeight: 700, borderBottom: "1px solid var(--line-soft)" }}>Authorised channels</div>
          {PLATFORMS.map((c) => {
            const on = a.channels.includes(c);
            return (
              <div key={c} className="li">
                <div><div style={{ fontSize: 14.5, fontWeight: 600 }}>{c}</div><div className="muted" style={{ fontSize: 12.5 }}>{c === "LinkedIn" ? "Personal profile · company page needs LinkedIn approval" : c === "YouTube Shorts" ? "Organic Shorts in the agreed plan" : "Organic posts in the agreed plan"}</div></div>
                <Switch on={on} label={c} onChange={(v) => save({ channels: v ? [...a.channels, c] : a.channels.filter((x) => x !== c) })} />
              </div>
            );
          })}
        </div>
        <div className="stack g12">
          <div className="card stack g6" style={{ borderRadius: 18, padding: "16px 18px" }}>
            <b className="small">Content scope</b>
            <span style={{ fontSize: 14, lineHeight: 1.5 }}>Only items in the agreed weekly plan. Sagal may shorten captions for each platform and pick crops. She may not change the topic, add a post, or change the day.</span>
          </div>
          <form className="card stack g8" style={{ borderRadius: 18, padding: "16px 18px" }} onSubmit={(e) => { e.preventDefault(); if (spend !== null) void save({ spendLimitEur: Number(spend) || 0 }).then(() => setSpend(null)); }}>
            <b className="small">Production spending limit</b>
            <span className="row g8 wrap" style={{ fontSize: 15 }}>
              €<input className="input" inputMode="numeric" style={{ width: 90 }} value={spend ?? String(a.spendLimitEur)} onChange={(e) => setSpend(e.target.value.replace(/[^0-9]/g, ""))} aria-label="Monthly limit in euros" /> per month · HeyGen minutes, stock, tools
              {spend !== null && <button className="btn ink xs">Save</button>}
            </span>
            <span className="muted" style={{ fontSize: 12.5 }}>€{data.spentThisMonth.toFixed(2)} used this month. Anything that would go over comes back to you first. No ad spend: that's Bilan's side.</span>
          </form>
        </div>
      </div>
      <div className="note stone stack g6" style={{ fontSize: 14.5 }}>
        <b>Always comes back to you</b>
        <span>A new topic or a post that isn't in the plan · moving a post by more than a day · a new platform · anything using your likeness or voice in a new way · spending over the limit · replying publicly to criticism.</span>
      </div>
      {hist.data && (
        <details className="small">
          <summary className="muted" style={{ cursor: "pointer" }}>Authorisation record</summary>
          <div className="stack g4" style={{ marginTop: 8 }}>
            {hist.data.authorisations.map((h) => (
              <div key={h.id} className="muted">{when(h.granted_at)} · {h.note} · {h.mode === "plan" ? "plan" : "review"} · {h.channels.length} channels · €{h.spend_limit_eur}{h.paused ? " · paused" : ""}</div>
            ))}
          </div>
        </details>
      )}
    </>
  );
}

function Appearance() {
  const { data, reload } = useLoad<Settings>("/api/settings");
  const { refreshOverview } = useApp();
  const { run } = useAction();
  if (!data) return <Loading />;
  const ap = data.settings.appearance;
  return (
    <>
      <div className="row between g10 wrap">
        <div className="title-m">Sagal's appearance</div>
        <span className={`chip ${ap.approved ? "ok" : "warn"}`}>{ap.approved ? "Approved portrait in use" : "Pending your approval"}</span>
      </div>
      <div className="muted" style={{ fontSize: 15, lineHeight: 1.55, maxWidth: 680 }}>Until you approve a portrait, Sagal appears as the “S” monogram everywhere. When you have one you're happy with, drop it in the slot and approve it.</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,240px),1fr))", gap: 18, alignItems: "start" }}>
        <div className="stack g10" style={{ alignItems: "flex-start" }}><MarkS size={180} url={ap.approved ? data.portraitUrl : null} /><span style={{ fontSize: 13, fontWeight: 600 }}>In use now</span></div>
        <div className="stack g10" style={{ alignItems: "flex-start" }}>
          <div style={{ width: 180, height: 180 }}><ImageSlot round url={data.portraitUrl} placeholder="Drop Sagal's approved portrait" onFile={(f) => run(async () => { await api.upload("/api/appearance/portrait", f); await reload(); })} /></div>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Proposed portrait</span>
          {data.portraitUrl && (
            <button className="btn ink sm" onClick={() => run(async () => { await api.post("/api/appearance/approve", { approved: !ap.approved }); await reload(); refreshOverview(); })}>{ap.approved ? "Go back to the monogram" : "Approve this portrait"}</button>
          )}
        </div>
      </div>
      <div className="card stack g8" style={{ borderRadius: 18, fontSize: 14.5, lineHeight: 1.55 }}>
        <b>Appearance brief (for an illustrator or photographer)</b>
        <span>A Black Somali woman in her late twenties with warm brown skin and East African features. Black hijab worn close, black rectangular glasses. Oversized black blazer over a crisp white shirt with a slim black tie, wide light-wash jeans, black heeled ankle boots. Plain warm-grey studio backdrop. Pose: relaxed in a low armchair, a laptop balanced in each hand, looking just off-camera. The multitasker, but calm about it.</span>
      </div>
    </>
  );
}
