import React, { useCallback, useEffect, useRef, useState } from "react";
import { api, stream } from "../api";
import { BrainSwitch, Kicker, MarkS, Tag, hhmm, useApp, useRouter, when } from "../lib";
import { MiniSlide, type Carousel } from "../slides";
import { SpeechRecognitionCtor, VoicePanel } from "./Voice";
import { Workspace, type WsFocus, type WsTab } from "./Workspace";

interface Msg {
  id: number;
  sender: "sabah" | "sagal" | "system";
  text: string;
  via: "text" | "voice" | "voice_note";
  context: { type: string; id?: number | string; label: string } | null;
  attachments: { assetId: number; kind: string; name: string }[];
  voice_note_id: number | null;
  voiceNoteUrl?: string | null;
  card: { type: "carousel" | "idea" | "week" | "script"; id?: number; title: string; sub: string } | null;
  quote: string | null;
  decision: { options: string[]; picked: string | null } | null;
  status: "sent" | "failed" | "queued" | "sending";
  error: string | null;
  interrupted: boolean;
  model?: string | null;
  model_reason?: string | null;
  created_at: string;
  sample?: boolean;
}
interface Project { id: number; name: string; threads: { id: number; title: string; updatedAt: string; sample: boolean }[] }
export interface ThreadNav {
  projects: { id: number; name: string; threads: { id: number; title: string; when: string }[] }[];
  current: number | null;
  open: (id: number) => void;
  newThread: () => void;
}
type Ctx = Msg["context"];
type Att = { id: number; kind: string; name: string };
interface Outgoing { text: string; via?: Msg["via"]; context?: Ctx; attachments?: Att[]; voiceNoteId?: number; voiceNoteUrl?: string }

const STARTERS = [
  ["Planning", "Let's plan this week."],
  ["New idea", "I have an idea—help me develop it."],
  ["Storytelling", "Turn this project into a story."],
  ["Your inbox", "Show me what needs my input."],
];
const ATTACH_KINDS: [string, string, string, string][] = [
  ["image", "Image", "Reference images, moodboards", "image/*"],
  ["pdf", "PDF", "Briefs, decks, research", "application/pdf"],
  ["footage", "Footage", "Video clips and b-roll", "video/*"],
  ["audio_reference", "Audio", "Sound references (not your voiceover)", "audio/*"],
];
const WAVE = [6, 10, 16, 9, 20, 14, 8, 18, 12, 6, 15, 22, 10, 7, 13, 19, 9, 5, 12, 16, 8, 11, 6, 14];
let tempId = -1;

function TypingDots() {
  return (
    <span className="row g4" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span key={i} style={{ width: 7, height: 7, borderRadius: "50%", background: "#111", animation: `sgBlink 1.2s ${i * 0.2}s infinite` }} />
      ))}
    </span>
  );
}

export function TalkScreen({ onThreads }: { onThreads: (n: ThreadNav | null) => void }) {
  const { path, go } = useRouter();
  const app = useApp();
  const { vw, overview } = app;
  const isMobile = vw < 880;
  const isDesktop = vw >= 1180;
  const routeId = Number(path.split(/[/?]/)[2]) || null;

  const [projects, setProjects] = useState<Project[] | null>(null);
  const [current, setCurrent] = useState<number | null>(routeId);
  const [conv, setConv] = useState<{ title: string; project: string; sample: boolean } | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [typing, setTyping] = useState(false);
  /** Which model is answering right now, e.g. "Opus 5.5 · planning". */
  const [thinkingWith, setThinkingWith] = useState<string | null>(null);
  const [live, setLive] = useState("");
  const [online, setOnline] = useState(navigator.onLine);

  const [draft, setDraft] = useState("");
  const [context, setContext] = useState<Ctx>(null);
  const [atts, setAtts] = useState<Att[]>([]);
  const [uploading, setUploading] = useState(false);
  const [attachMenu, setAttachMenu] = useState(false);
  const pendingKind = useRef<string>("image");
  const fileRef = useRef<HTMLInputElement>(null);
  const [accept, setAccept] = useState("image/*");

  const [voiceOn, setVoiceOn] = useState(false);
  const [wsOpen, setWsOpen] = useState(isDesktop);
  const [wsWide, setWsWide] = useState(false);
  const [wsTab, setWsTab] = useState<WsTab>("carousel");
  const [focus, setFocus] = useState<WsFocus>({});
  const [wsVersion, setWsVersion] = useState(0);
  const [mobileTab, setMobileTab] = useState<"chat" | "work">("chat");
  const scroller = useRef<HTMLDivElement>(null);
  /** A conversation the composer just created: its history is already on screen. */
  const justCreated = useRef<number | null>(null);

  // ── Threads ──
  const loadProjects = useCallback(async () => {
    const r = await api.get<{ projects: Project[] }>("/api/conversations");
    setProjects(r.projects);
    return r.projects;
  }, []);
  useEffect(() => {
    void loadProjects().then((ps) => {
      if (routeId) return;
      let last: number | null = null;
      try {
        last = Number(localStorage.getItem("sagal.thread")) || null;
      } catch {}
      const all = ps.flatMap((p) => p.threads);
      const pick = all.find((t) => t.id === last) ?? all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      if (pick) setCurrent(pick.id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (routeId && routeId !== current) setCurrent(routeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId]);

  const openThread = useCallback(
    (id: number) => {
      setCurrent(id);
      setMobileTab("chat");
      go(`/talk/${id}`);
    },
    [go],
  );
  const newThread = useCallback(async () => {
    const r = await api.post<{ id: number }>("/api/conversations", {});
    await loadProjects();
    setMsgs([]);
    openThread(r.id);
  }, [loadProjects, openThread]);

  useEffect(() => {
    onThreads(
      projects
        ? {
            projects: projects.map((p) => ({ id: p.id, name: p.name, threads: p.threads.map((t) => ({ id: t.id, title: t.title, when: when(t.updatedAt) })) })),
            current,
            open: openThread,
            newThread: () => void newThread(),
          }
        : null,
    );
  }, [projects, current, openThread, newThread, onThreads]);
  useEffect(() => () => onThreads(null), [onThreads]);

  // ── Messages ──
  useEffect(() => {
    if (!current) {
      setConv(null);
      setMsgs([]);
      return;
    }
    try {
      localStorage.setItem("sagal.thread", String(current));
    } catch {}
    if (justCreated.current === current) {
      justCreated.current = null;
      return;
    }
    setLoadingMsgs(true);
    setTyping(false);
    setLive("");
    api
      .get<{ conversation: { title: string; project: string; sample: boolean }; messages: Msg[] }>(`/api/conversations/${current}`)
      .then((r) => {
        setConv(r.conversation);
        setMsgs(r.messages);
        const lastCard = [...r.messages].reverse().find((m) => m.card);
        if (lastCard?.card) showCard(lastCard.card, false);
      })
      .catch(() => {
        setConv(null);
        setMsgs([]);
      })
      .finally(() => setLoadingMsgs(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  useEffect(() => {
    requestAnimationFrame(() => {
      const el = scroller.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, [msgs.length, typing, live, current]);

  // Context chips handed over from other screens ("Discuss slide 3", "Develop with Sagal").
  useEffect(() => {
    if (app.pending) {
      setContext(app.pending);
      app.clearPending();
      setVoiceOn(false);
      setMobileTab("chat");
      if (!isDesktop) setWsOpen(false);
    }
  }, [app.pending, app, isDesktop]);

  useEffect(() => {
    if (!isDesktop) setWsOpen(false);
  }, [isDesktop]);

  function showCard(card: NonNullable<Msg["card"]>, open = true) {
    setWsTab(card.type);
    if (card.id) setFocus((f) => ({ ...f, [card.type]: card.id }));
    setWsVersion((v) => v + 1);
    if (open) {
      if (isMobile) setMobileTab("work");
      else setWsOpen(true);
    }
  }

  /** Sends one message and streams Sagal's answer. Resolves with her reply (for voice). */
  const deliver = useCallback(
    async (convId: number, out: Outgoing, temp: number): Promise<{ text: string; id: number } | null> => {
      let reply: { text: string; id: number } | null = null;
      setTyping(true);
      setLive("");
      try {
        await stream(
          `/api/conversations/${convId}/messages`,
          { text: out.text, via: out.via ?? "text", context: out.context ?? null, attachments: (out.attachments ?? []).map((a) => a.id), voiceNoteId: out.voiceNoteId },
          (e) => {
            if (e.type === "sabah") {
              const m = e.message as Msg;
              setMsgs((ms) => ms.map((x) => (x.id === temp ? { ...m, voiceNoteUrl: out.voiceNoteUrl } : x)));
            } else if (e.type === "thinking" || e.type === "restart") {
              setThinkingWith(`${e.model}${e.tier === "deep" ? ` · ${e.reason}` : ""}`);
              if (e.type === "restart") setLive("");
            } else if (e.type === "delta") setLive((t) => t + (e.text as string));
            else if (e.type === "effect") {
              const card = (e.effect as { card?: Msg["card"] }).card;
              if (card) showCard(card, !isMobile);
            } else if (e.type === "sagal") {
              const m = e.message as Msg;
              setMsgs((ms) => [...ms, m]);
              setLive("");
              if (m.text) reply = { text: m.text, id: m.id };
            } else if (e.type === "failed") {
              const m = e.message as Msg;
              setMsgs((ms) => ms.map((x) => (x.id === m.id || x.id === temp ? { ...x, ...m, voiceNoteUrl: x.voiceNoteUrl } : x)));
              setLive("");
            }
          },
        );
      } catch (err) {
        setMsgs((ms) => ms.map((x) => (x.id === temp ? { ...x, status: navigator.onLine ? "failed" : "queued", error: (err as Error).message } : x)));
      } finally {
        setTyping(false);
        setLive("");
        void loadProjects();
        app.refreshOverview();
      }
      return reply;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loadProjects, isMobile],
  );

  const send = useCallback(
    async (out: Outgoing): Promise<{ text: string; id: number } | null> => {
      if (!out.text.trim() && !out.attachments?.length && !out.voiceNoteId) return null;
      let convId = current;
      if (!convId) {
        convId = (await api.post<{ id: number }>("/api/conversations", {})).id;
        justCreated.current = convId;
        setConv({ title: out.text.slice(0, 40) || "New conversation", project: "Unsorted", sample: false });
        setCurrent(convId);
        history.replaceState(null, "", `/talk/${convId}`);
      }
      const temp = tempId--;
      const optimistic: Msg = {
        id: temp, sender: "sabah", text: out.text, via: out.via ?? "text", context: out.context ?? null,
        attachments: (out.attachments ?? []).map((a) => ({ assetId: a.id, kind: a.kind, name: a.name })), voice_note_id: out.voiceNoteId ?? null,
        voiceNoteUrl: out.voiceNoteUrl, card: null, quote: null, decision: null, status: navigator.onLine ? "sending" : "queued", error: null, interrupted: false, created_at: new Date().toISOString(),
      };
      setMsgs((ms) => [...ms, optimistic]);
      if (!navigator.onLine) {
        queue.current.push({ convId, out, temp });
        return null;
      }
      return deliver(convId, out, temp);
    },
    [current, deliver],
  );

  // Offline: queue and send when the connection returns.
  const queue = useRef<{ convId: number; out: Outgoing; temp: number }[]>([]);
  useEffect(() => {
    const on = async () => {
      setOnline(true);
      const q = queue.current.splice(0);
      for (const item of q) await deliver(item.convId, item.out, item.temp);
    };
    const off = () => setOnline(false);
    addEventListener("online", on);
    addEventListener("offline", off);
    return () => {
      removeEventListener("online", on);
      removeEventListener("offline", off);
    };
  }, [deliver]);

  const sendDraft = () => {
    const out = { text: draft.trim(), context, attachments: atts };
    if (!out.text && !atts.length) return;
    setDraft("");
    setAtts([]);
    setContext(null);
    setAttachMenu(false);
    void send(out);
  };

  const retry = async (m: Msg) => {
    setMsgs((ms) => ms.map((x) => (x.id === m.id ? { ...x, status: "sending", error: null } : x)));
    setTyping(true);
    try {
      await stream(`/api/messages/${m.id}/retry`, {}, (e) => {
        if (e.type === "thinking" || e.type === "restart") {
          setThinkingWith(`${e.model}${e.tier === "deep" ? ` · ${e.reason}` : ""}`);
          if (e.type === "restart") setLive("");
        } else if (e.type === "delta") setLive((t) => t + (e.text as string));
        else if (e.type === "sagal") {
          setMsgs((ms) => [...ms.map((x) => (x.id === m.id ? { ...x, status: "sent" as const } : x)), e.message as Msg]);
          setLive("");
        } else if (e.type === "effect") {
          const card = (e.effect as { card?: Msg["card"] }).card;
          if (card) showCard(card, !isMobile);
        } else if (e.type === "failed") setMsgs((ms) => ms.map((x) => (x.id === m.id ? { ...x, status: "failed", error: e.error as string } : x)));
      });
    } catch (err) {
      setMsgs((ms) => ms.map((x) => (x.id === m.id ? { ...x, status: "failed", error: (err as Error).message } : x)));
    } finally {
      setTyping(false);
      setLive("");
    }
  };

  const pick = async (m: Msg, option: string) => {
    setMsgs((ms) => ms.map((x) => (x.id === m.id && x.decision ? { ...x, decision: { ...x.decision, picked: option } } : x)));
    setTyping(true);
    try {
      await stream(`/api/messages/${m.id}/pick`, { option }, (e) => {
        if (e.type === "sabah" || e.type === "sagal") setMsgs((ms) => [...ms, e.message as Msg]);
        if (e.type === "sagal") setLive("");
        else if (e.type === "thinking" || e.type === "restart") {
          setThinkingWith(`${e.model}${e.tier === "deep" ? ` · ${e.reason}` : ""}`);
          if (e.type === "restart") setLive("");
        } else if (e.type === "delta") setLive((t) => t + (e.text as string));
        else if (e.type === "effect") {
          const card = (e.effect as { card?: Msg["card"] }).card;
          if (card) showCard(card, !isMobile);
        } else if (e.type === "failed") setMsgs((ms) => ms.map((x) => (x.id === (e.message as Msg).id ? (e.message as Msg) : x)));
      });
    } catch (err) {
      app.toast((err as Error).message, true);
    } finally {
      setTyping(false);
      setLive("");
    }
  };

  // ── Attachments ──
  const pickAttach = (kind: string, acc: string) => {
    pendingKind.current = kind;
    setAccept(acc);
    setAttachMenu(false);
    setTimeout(() => fileRef.current?.click(), 0);
  };
  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    for (const f of Array.from(files)) {
      try {
        const a = await api.upload<{ id: number; kind: string; name: string }>(`/api/uploads/${pendingKind.current}`, f);
        setAtts((xs) => [...xs, { id: a.id, kind: a.kind, name: a.name }]);
      } catch (e) {
        app.toast((e as Error).message, true);
      }
    }
    setUploading(false);
  };

  // ── Voice note (recorded; conversational audio, never a voiceover) ──
  const rec = useVoiceNote(async (blob, secs, transcript) => {
    try {
      const ext = blob.type.includes("mp4") ? "m4a" : blob.type.includes("ogg") ? "ogg" : "webm";
      const a = await api.upload<{ id: number }>("/api/uploads/conversation_audio", blob, `voice-note-${Date.now()}.${ext}`);
      await send({ text: transcript, via: "voice_note", context, voiceNoteId: a.id, voiceNoteUrl: URL.createObjectURL(blob) });
      setContext(null);
      void secs;
    } catch (e) {
      app.toast((e as Error).message, true);
    }
  });

  const lastFailed = [...msgs].reverse().find((m) => m.sender === "sabah" && m.status === "failed");
  const empty = !loadingMsgs && msgs.length === 0;
  const chatHidden = (isMobile && mobileTab === "work") || (!isMobile && (wsWide || !isDesktop) && wsOpen);
  const wsShown = isMobile ? mobileTab === "work" : wsOpen;
  const tabLabel = { carousel: "Carousel", script: "Script", idea: "Idea", week: "Week" }[wsTab];

  return (
    <>
      {isMobile && (
        <div style={{ padding: "8px 14px", borderBottom: "1px solid var(--line)" }}>
          <div className="seg">
            <button className={mobileTab === "chat" ? "on" : ""} style={{ minHeight: 40, fontSize: 14 }} onClick={() => setMobileTab("chat")}>Chat</button>
            <button className={mobileTab === "work" ? "on" : ""} style={{ minHeight: 40, fontSize: 14 }} onClick={() => setMobileTab("work")}>Current work · {tabLabel}</button>
          </div>
        </div>
      )}
      <div className="row grow" style={{ minHeight: 0, alignItems: "stretch" }}>
        <section className="stack grow" style={{ display: chatHidden ? "none" : "flex", background: "var(--paper)", minHeight: 0 }} aria-label="Conversation">
          <div className="chat-head">
            <div style={{ minWidth: 0 }}>
              <Kicker>{conv?.project ?? "Unsorted"}</Kicker>
              <div className="chat-title">{conv?.title ?? "New conversation"}</div>
            </div>
            <div className="row g8" style={{ flexShrink: 0 }}>
              {conv?.sample && <Tag>Sample conversation</Tag>}
              {!isMobile && <button className="pill" onClick={() => { setWsOpen(!wsOpen); setWsWide(false); }}>{wsOpen ? "Hide workspace" : "Show workspace"}</button>}
            </div>
          </div>
          {!online && (
            <div className="banner warn" style={{ padding: "10px clamp(16px,3vw,32px)" }}>
              <span className="kicker" style={{ color: "inherit" }}>Sagal is offline</span>
              <span className="grow" style={{ minWidth: 220 }}>Messages you send now are queued and delivered when the connection returns. Voice will reconnect automatically.</span>
            </div>
          )}
          {online && lastFailed && (
            <div className="banner err" style={{ padding: "10px clamp(16px,3vw,32px)" }}>
              <span className="kicker" style={{ color: "inherit" }}>Not answered</span>
              <span className="grow" style={{ minWidth: 220 }}>{lastFailed.error ?? "Your last message didn't reach Sagal."} It's saved here.</span>
              {/Connected accounts/.test(lastFailed.error ?? "") && <button className="btn outline sm" onClick={() => go("/memory/accounts")}>Open Connected accounts</button>}
            </div>
          )}
          <div className="msgs" ref={scroller}>
            <div className="msgs-inner">
              {loadingMsgs && (
                <div className="stack g24" aria-busy="true">
                  <div className="row g14"><div className="skel" style={{ width: 30, height: 30, borderRadius: "50%" }} /><div className="stack g8 grow"><div className="skel" style={{ height: 14, width: "30%" }} /><div className="skel" style={{ height: 14, width: "90%" }} /></div></div>
                  <div className="skel" style={{ alignSelf: "flex-end", height: 44, width: "50%", borderRadius: 20 }} />
                  <div className="small muted">Loading your conversation with Sagal…</div>
                </div>
              )}
              {empty && (
                <div className="stack g24" style={{ padding: "24px 0 8px" }}>
                  <MarkS size={64} url={overview?.portraitUrl} />
                  <div className="title-xl" style={{ fontSize: "clamp(40px,5vw,64px)" }}>Hi Sabah. <span className="italic">What are we making?</span></div>
                  <div className="lede" style={{ fontSize: 17, maxWidth: 540 }}>Type, talk, or drop in a reference. I'll keep this conversation filed under its project so we can pick it up later.</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(min(100%,250px),1fr))", gap: 10 }}>
                    {STARTERS.map(([tag, text]) => (
                      <button key={text} className="starter" onClick={() => void send({ text })}>
                        <Kicker sm>{tag}</Kicker>
                        <span className="serif" style={{ fontSize: 24, lineHeight: 1.12 }}>“{text}”</span>
                      </button>
                    ))}
                  </div>
                  {!overview?.sample && (
                    <div className="small muted">
                      Want to see everything working first?{" "}
                      <button className="btn link" style={{ fontSize: 13 }} onClick={async () => { await api.post("/api/sample/load"); location.href = "/talk"; }}>
                        Load the sample week
                      </button>{" "}
                      (marked “Sample”, never published, removable in one click).
                    </div>
                  )}
                </div>
              )}
              {msgs.map((m) => (m.sender === "sabah" ? <SabahMsg key={m.id} m={m} onRetry={() => void retry(m)} /> : <SagalMsg key={m.id} m={m} portrait={overview?.portraitUrl} onOpen={(c) => showCard(c)} onPick={(o) => void pick(m, o)} />))}
              {typing && live && (
                <div className="msg-sagal" aria-live="polite">
                  <MarkS size={30} url={overview?.portraitUrl} />
                  <div className="stack g12 grow">
                    <div className="row g10"><b style={{ fontSize: 14 }}>Sagal</b><span className="mono xs muted">{hhmm(new Date())}{thinkingWith ? ` · ${thinkingWith}` : ""}</span></div>
                    <div className="msg-text">{live}</div>
                  </div>
                </div>
              )}
              {typing && !live && (
                <div className="row g14" aria-live="polite">
                  <MarkS size={30} url={overview?.portraitUrl} />
                  <TypingDots />
                  <span className="small muted">Sagal is thinking (constructively){thinkingWith ? ` · ${thinkingWith}` : ""}</span>
                </div>
              )}
            </div>
          </div>

          {voiceOn ? (
            <VoicePanel speak={(text) => send({ text, via: "voice" })} onEnd={() => setVoiceOn(false)} />
          ) : (
            <div className="composer-wrap">
              <div className="stack g10" style={{ maxWidth: 760, margin: "0 auto" }}>
                {context && (
                  <div className="row g8" style={{ alignSelf: "flex-start", background: "var(--blue-tint)", border: "1px solid var(--blue)", borderRadius: 999, padding: "5px 6px 5px 12px", fontSize: 13, fontWeight: 600 }}>
                    <span>Discussing {context.label}</span>
                    <button className="x" style={{ background: "#fff" }} aria-label="Remove context" onClick={() => setContext(null)}>×</button>
                  </div>
                )}
                {(atts.length > 0 || uploading) && (
                  <div className="row g6 wrap">
                    {atts.map((a, i) => (
                      <span key={a.id} className="att">
                        <span className="mono" style={{ fontSize: 10.5, textTransform: "uppercase", color: "var(--text-2)" }}>{a.kind.replace("_reference", "")}</span>
                        {a.name}
                        <button className="x" aria-label={`Remove ${a.name}`} onClick={() => setAtts((xs) => xs.filter((_, j) => j !== i))}>×</button>
                      </span>
                    ))}
                    {uploading && <span className="small muted">Uploading privately…</span>}
                  </div>
                )}
                {rec.recording ? (
                  <div className="row g12 wrap" style={{ border: "1px solid var(--ink)", borderRadius: 22, padding: "10px 10px 10px 18px" }}>
                    <span style={{ width: 12, height: 12, borderRadius: "50%", background: "#C4372A", animation: "sgBlink 1.2s infinite", flexShrink: 0 }} />
                    <span className="mono" style={{ fontSize: 14 }}>{Math.floor(rec.secs / 60)}:{String(rec.secs % 60).padStart(2, "0")}</span>
                    <span className="small muted grow" style={{ minWidth: 160 }}>Recording a voice note for Sagal{rec.transcript ? ` · “${rec.transcript.slice(-60)}”` : ""}</span>
                    <button className="btn ghost" onClick={rec.discard}>Discard</button>
                    <button className="btn blue" onClick={rec.stopAndSend}>Send voice note</button>
                  </div>
                ) : (
                  <div className="composer">
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                          e.preventDefault();
                          sendDraft();
                        }
                      }}
                      placeholder="Tell Sagal anything… (Enter to send)"
                      rows={2}
                      aria-label="Message Sagal"
                    />
                    <div className="row g6 wrap" style={{ position: "relative" }}>
                      <button className="cbtn" aria-label="Attach a file" aria-expanded={attachMenu} style={{ background: attachMenu ? "var(--stone-deep)" : undefined }} onClick={() => setAttachMenu(!attachMenu)}>+ Attach</button>
                      <button className="cbtn" onClick={() => void rec.start()}>
                        <svg width="12" height="16" viewBox="0 0 12 16" fill="none" stroke="#111" strokeWidth="1.6" aria-hidden><rect x="3" y="1" width="6" height="9" rx="3" /><path d="M1 7.5a5 5 0 0 0 10 0M6 12.5V15" /></svg>
                        Voice note
                      </button>
                      <BrainSwitch />
                      <div className="grow" />
                      <button className="cbtn dark" onClick={() => setVoiceOn(true)}>
                        <span className="row" style={{ gap: 2 }} aria-hidden>
                          {[8, 14, 10].map((h, i) => <span key={i} style={{ width: 2, height: h, background: "#94ABF9", borderRadius: 1 }} />)}
                        </span>
                        Talk live
                      </button>
                      <button className="cbtn" style={{ border: 0, background: draft.trim() || atts.length ? "var(--blue)" : "var(--stone-deep)" }} onClick={sendDraft} disabled={uploading}>Send</button>
                      {attachMenu && (
                        <div className="menu" role="menu">
                          {ATTACH_KINDS.map(([kind, label, sub, acc]) => (
                            <button key={kind} role="menuitem" onClick={() => pickAttach(kind, acc)}>
                              <span style={{ fontSize: 14, fontWeight: 600 }}>{label}</span>
                              <span style={{ fontSize: 12.5, color: "var(--text-2)" }}>{sub}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
                {rec.error && <div className="note warn small">{rec.error}</div>}
                <input ref={fileRef} type="file" multiple accept={accept} style={{ display: "none" }} onChange={(e) => { void onFiles(e.target.files); e.target.value = ""; }} />
              </div>
            </div>
          )}
        </section>

        {wsShown && (
          <aside className="workspace" style={{ width: isMobile || !isDesktop || wsWide ? "100%" : "clamp(380px, 38vw, 560px)" }} aria-label="Current work">
            <Workspace
              tab={wsTab}
              setTab={setWsTab}
              focus={focus}
              wide={wsWide}
              canExpand={isDesktop}
              version={wsVersion}
              onToggleWide={() => {
                if (isMobile) setMobileTab("chat");
                else if (!isDesktop) setWsOpen(false);
                else setWsWide(!wsWide);
              }}
            />
          </aside>
        )}
      </div>
    </>
  );
}

function SagalMsg({ m, portrait, onOpen, onPick }: { m: Msg; portrait?: string | null; onOpen: (c: NonNullable<Msg["card"]>) => void; onPick: (o: string) => void }) {
  if (m.sender === "system") {
    return <div className="small muted" style={{ textAlign: "center", fontStyle: "italic" }}>{m.text}</div>;
  }
  return (
    <div className="msg-sagal">
      <MarkS size={30} url={portrait} />
      <div className="stack g12 grow" style={{ minWidth: 0 }}>
        <div className="row g10 wrap">
          <b style={{ fontSize: 14 }}>Sagal</b>
          <span className="mono xs muted">{when(m.created_at)}{m.via === "voice" ? " · spoken" : ""}</span>
          {m.model && (
            <span className="mono xs muted" title={m.model_reason ? `Why: ${m.model_reason}` : undefined}>
              · {m.model}{m.model.startsWith("Opus") && m.model_reason ? ` · ${m.model_reason}` : ""}
            </span>
          )}
        </div>
        {m.text && <div className="msg-text">{m.text}</div>}
        {m.interrupted && <div className="mono xs muted" style={{ letterSpacing: ".04em" }}>— stopped when you started talking</div>}
        {m.quote && <div className="quote">“{m.quote}”</div>}
        {m.card?.type === "carousel" && <CarouselCard card={m.card} onOpen={() => onOpen(m.card!)} />}
        {m.card && m.card.type !== "carousel" && (
          <button className="msg-card row between g14" style={{ padding: "18px 20px", background: "var(--surface)" }} onClick={() => onOpen(m.card!)}>
            <span className="stack g4">
              <span className="kicker sm">{{ week: "This week", idea: "Idea", script: "Script" }[m.card.type]}</span>
              <span className="serif" style={{ fontSize: 26, lineHeight: 1.1 }}>{m.card.title}</span>
              <span className="small muted">{m.card.sub}</span>
            </span>
            <span className="small" style={{ fontWeight: 600, whiteSpace: "nowrap" }}>Open ↗</span>
          </button>
        )}
        {m.decision && (
          <div className="row g8 wrap">
            {m.decision.options.map((o) => (
              <button key={o} className="btn" disabled={!!m.decision!.picked} onClick={() => onPick(o)} style={{ border: `1px solid ${m.decision!.picked === o ? "var(--blue)" : "var(--ink)"}`, background: m.decision!.picked === o ? "var(--blue)" : "#fff", padding: "9px 16px", opacity: m.decision!.picked && m.decision!.picked !== o ? 0.5 : 1 }}>
                {o}
              </button>
            ))}
            {m.decision.picked && <span className="small muted">You chose “{m.decision.picked}”.</span>}
          </div>
        )}
      </div>
    </div>
  );
}

function CarouselCard({ card, onOpen }: { card: NonNullable<Msg["card"]>; onOpen: () => void }) {
  const [c, setC] = useState<Carousel | null>(null);
  useEffect(() => {
    if (card.id) api.get<{ carousel: Carousel }>(`/api/carousels/${card.id}`).then((r) => setC(r.carousel)).catch(() => {});
  }, [card.id]);
  return (
    <button className="msg-card stack g14" style={{ padding: 14 }} onClick={onOpen}>
      {c && (
        <span style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 8, width: "100%" }}>
          {c.slides.slice(0, 3).map((s, i) => <MiniSlide key={i} slide={s} n={i + 1} />)}
        </span>
      )}
      <span className="row between g12" style={{ padding: "0 4px 2px", width: "100%" }}>
        <span className="stack" style={{ textAlign: "left" }}>
          <span style={{ fontWeight: 600, fontSize: 15 }}>{card.title}</span>
          <span className="small muted">{card.sub}</span>
        </span>
        <span className="small" style={{ fontWeight: 600, whiteSpace: "nowrap" }}>Open on the right ↗</span>
      </span>
    </button>
  );
}

function SabahMsg({ m, onRetry }: { m: Msg; onRetry: () => void }) {
  const [playing, setPlaying] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const status = m.status === "failed" ? " · Not sent" : m.status === "queued" ? " · Queued, sends when Sagal reconnects" : m.status === "sending" ? " · Sending…" : "";
  return (
    <div className="msg-sabah">
      {m.context && <div className="ctx-chip">Re: {m.context.label}</div>}
      {m.via === "voice_note" && (
        <div style={{ maxWidth: "min(460px,90%)", background: "var(--stone-2)", borderRadius: "20px 20px 6px 20px", padding: "10px 14px 12px" }} className="stack g8">
          <div className="row g12">
            <button
              aria-label={playing ? "Pause voice note" : "Play voice note"}
              disabled={!m.voiceNoteUrl}
              onClick={() => {
                if (!m.voiceNoteUrl) return;
                if (!audio.current) {
                  audio.current = new Audio(m.voiceNoteUrl);
                  audio.current.onended = () => setPlaying(false);
                }
                if (playing) audio.current.pause();
                else void audio.current.play();
                setPlaying(!playing);
              }}
              style={{ width: 36, height: 36, borderRadius: "50%", border: 0, background: "#111", color: "#fff", fontSize: 12, flexShrink: 0 }}
            >
              {playing ? "❚❚" : "▶"}
            </button>
            <div className="row grow" style={{ gap: 2, height: 26 }} aria-hidden>
              {WAVE.map((h, i) => <span key={i} style={{ display: "block", width: 3, height: h, borderRadius: 2, background: playing ? "#111" : "#8C877E" }} />)}
            </div>
          </div>
          <div style={{ fontSize: 13.5, lineHeight: 1.45, color: "var(--text-2)" }}>{m.text ? `“${m.text}”` : "No transcript: speech-to-text isn't connected in this browser."}</div>
        </div>
      )}
      {m.via !== "voice_note" && m.text && <div className="bubble">{m.text}</div>}
      {m.attachments?.length > 0 && (
        <div className="row g6 wrap" style={{ justifyContent: "flex-end" }}>
          {m.attachments.map((a) => <span key={a.assetId} className="att" style={{ paddingRight: 10 }}><span className="mono" style={{ fontSize: 10.5, textTransform: "uppercase", color: "var(--text-2)" }}>{a.kind.replace("_reference", "")}</span>{a.name}</span>)}
        </div>
      )}
      <div className="row g8">
        <span className="mono xs" style={{ color: m.status === "failed" ? "var(--err)" : "var(--text-2)" }}>{when(m.created_at)}{m.via === "voice" ? " · spoken" : ""}{status}</span>
        {m.status === "failed" && <button className="btn xs" style={{ border: "1px solid var(--err)", color: "var(--err)", background: "#fff" }} onClick={onRetry}>Retry</button>}
      </div>
    </div>
  );
}

/** Records a voice note with MediaRecorder; transcribes in the browser where supported. */
function useVoiceNote(onDone: (blob: Blob, secs: number, transcript: string) => void) {
  const [recording, setRecording] = useState(false);
  const [secs, setSecs] = useState(0);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);
  const r = useRef<{ mr: MediaRecorder; chunks: Blob[]; stream: MediaStream; timer: number; sr?: { stop(): void }; send: boolean; text: string } | null>(null);

  const start = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      const state = { mr, chunks: [] as Blob[], stream, timer: 0, send: false, text: "" } as NonNullable<typeof r.current>;
      mr.ondataavailable = (e) => e.data.size && state.chunks.push(e.data);
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        clearInterval(state.timer);
        state.sr?.stop();
        setRecording(false);
        if (state.send && state.chunks.length) onDone(new Blob(state.chunks, { type: mr.mimeType }), secsRef.current, state.text.trim());
      };
      if (SpeechRecognitionCtor) {
        const sr = new SpeechRecognitionCtor();
        sr.continuous = true;
        sr.interimResults = true;
        sr.lang = "en-US";
        sr.onresult = (e) => {
          let t = "";
          for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
          state.text = t;
          setTranscript(t);
        };
        sr.onerror = () => {};
        try {
          sr.start();
          state.sr = sr;
        } catch {}
      }
      mr.start();
      secsRef.current = 0;
      setSecs(0);
      setTranscript("");
      state.timer = window.setInterval(() => setSecs(++secsRef.current), 1000);
      r.current = state;
      setRecording(true);
    } catch (e) {
      setError((e as Error).name === "NotFoundError" ? "No microphone was found. You can still type." : "Your browser blocked the microphone. Allow it in site settings, or keep typing.");
    }
  };
  const secsRef = useRef(0);
  const finish = (send: boolean) => {
    if (!r.current) return;
    r.current.send = send;
    r.current.mr.stop();
    r.current = null;
  };
  return { recording, secs, transcript, error, start, discard: () => finish(false), stopAndSend: () => finish(true) };
}
