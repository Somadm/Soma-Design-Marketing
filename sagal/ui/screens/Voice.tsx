import React, { useCallback, useEffect, useRef, useState } from "react";
import { Tag } from "../lib";

/**
 * Talk live, phase 1: the browser's own speech recognition (listening) and speech
 * synthesis (speaking) around Claude. It's conversational audio only: nothing is
 * recorded or stored, and it is never used for Sabah's videos. A provider such as
 * ElevenLabs replaces both halves later without changing this screen's states.
 */

type VState = "connecting" | "listening" | "processing" | "speaking" | "reconnecting" | "mic";
type Line = { who: "Sabah" | "Sagal"; text: string; cut?: boolean; interim?: boolean };

// Minimal typing for the Web Speech API (not in TS's DOM lib everywhere).
interface SR extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  onspeechstart: (() => void) | null;
}
export const SpeechRecognitionCtor: (new () => SR) | undefined =
  (window as unknown as { SpeechRecognition?: new () => SR }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: new () => SR }).webkitSpeechRecognition;

export const SPEEDS = ["0.9×", "1.0×", "1.15×", "1.3×"] as const;

export function useBrowserVoices() {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const load = () => setVoices(speechSynthesis.getVoices().filter((v) => /^(en|so)/i.test(v.lang)));
    load();
    speechSynthesis.addEventListener("voiceschanged", load);
    return () => speechSynthesis.removeEventListener("voiceschanged", load);
  }, []);
  return voices;
}

function Orb({ state, muted, speed }: { state: VState; muted: boolean; speed: number }) {
  const dim = state === "reconnecting" || state === "mic";
  return (
    <div style={{ position: "relative", width: 76, height: 76 }} aria-hidden>
      {state === "listening" && !muted && <span style={{ position: "absolute", inset: 0, borderRadius: "50%", border: "2px solid #94ABF9", animation: "sgPulse 1.8s ease-out infinite" }} />}
      {state === "speaking" && <span style={{ position: "absolute", inset: -6, borderRadius: "50%", border: "4px solid #94ABF9" }} />}
      {(state === "processing" || state === "reconnecting" || state === "connecting") && (
        <span style={{ position: "absolute", inset: -6, borderRadius: "50%", border: `2px dashed ${state === "reconnecting" ? "#8C877E" : "#111"}`, animation: "sgSpin 2.4s linear infinite" }} />
      )}
      <span style={{ position: "absolute", inset: 0, borderRadius: "50%", background: dim ? "#8C877E" : "#111", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontFamily: "var(--serif)", fontSize: 41, lineHeight: 1 }}>S</span>
      {state === "speaking" && (
        <span style={{ position: "absolute", left: "50%", bottom: -24, transform: "translateX(-50%)", display: "flex", gap: 3, height: 16, alignItems: "center" }}>
          {[0, 1, 2, 3, 4].map((i) => (
            <span key={i} style={{ display: "block", width: 3, height: 16, borderRadius: 2, background: "#111", animation: `sgBar ${(0.8 / speed).toFixed(2)}s ${i * 0.11}s ease-in-out infinite` }} />
          ))}
        </span>
      )}
      {(state === "mic" || muted) && (
        <span style={{ position: "absolute", right: -4, top: -4, width: 28, height: 28, borderRadius: "50%", background: "#fff", border: "1.5px solid #111", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, fontWeight: 700 }}>×</span>
      )}
    </div>
  );
}

export function VoicePanel({
  speak,
  onEnd,
  initialSpeed = "1.0×",
  initialTranscript = true,
}: {
  /** Sends Sabah's spoken turn; resolves with Sagal's reply text and its message id (or null if she couldn't answer). */
  speak: (text: string) => Promise<{ text: string; id: number } | null>;
  onEnd: () => void;
  initialSpeed?: string;
  initialTranscript?: boolean;
}) {
  const [state, setState] = useState<VState>("connecting");
  const [muted, setMuted] = useState(false);
  const [transcript, setTranscript] = useState(initialTranscript);
  const [speed, setSpeed] = useState<string>(initialSpeed);
  const [voiceName, setVoiceName] = useState("");
  const [lang, setLang] = useState<"en-US" | "so-SO">("en-US");
  const [lines, setLines] = useState<Line[]>([]);
  const [secs, setSecs] = useState(0);
  const [micWhy, setMicWhy] = useState("");
  const voices = useBrowserVoices();

  const rec = useRef<SR | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const speaking = useRef<{ id: number } | null>(null);
  const alive = useRef(true);
  const speedF = parseFloat(speed) || 1;

  useEffect(() => {
    const t = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const stopRec = () => {
    try {
      rec.current?.abort();
    } catch {}
  };

  const startRec = useCallback(() => {
    if (!alive.current || mutedRef.current || !SpeechRecognitionCtor) return;
    stopRec();
    const r = new SpeechRecognitionCtor();
    r.lang = lang;
    r.continuous = false;
    r.interimResults = true;
    r.onresult = (e) => {
      let text = "";
      let final = false;
      for (let i = 0; i < e.results.length; i++) {
        text += e.results[i][0].transcript;
        if (e.results[i].isFinal) final = true;
      }
      text = text.trim();
      if (!text) return;
      // Barge-in: Sabah talks while Sagal speaks → Sagal stops mid-sentence and listens.
      if (stateRef.current === "speaking" && text.split(/\s+/).length >= 2) latest.current.interrupt();
      setLines((ls) => {
        const last = ls[ls.length - 1];
        const next = { who: "Sabah" as const, text, interim: !final };
        return last?.who === "Sabah" && last.interim ? [...ls.slice(0, -1), next] : [...ls, next];
      });
      if (final) void latest.current.turn(text);
    };
    r.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed" || e.error === "audio-capture") {
        setMicWhy(e.error === "audio-capture" ? "No microphone was found." : "Your browser blocked the microphone.");
        setState("mic");
      } else if (e.error === "network") setState("reconnecting");
    };
    r.onend = () => {
      // Keep listening between turns (recognition stops after each phrase).
      if (alive.current && !mutedRef.current && (stateRef.current === "listening" || stateRef.current === "speaking")) setTimeout(() => stateRef.current !== "mic" && startRec(), 250);
    };
    rec.current = r;
    try {
      r.start();
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang]);

  const sayIt = (text: string, id: number) =>
    new Promise<void>((resolve) => {
      if (!("speechSynthesis" in window)) return resolve();
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = speedF;
      u.lang = lang;
      const v = voices.find((x) => x.name === voiceName) ?? voices.find((x) => x.lang.toLowerCase().startsWith(lang.slice(0, 2)));
      if (v) u.voice = v;
      speaking.current = { id };
      u.onend = u.onerror = () => {
        speaking.current = null;
        resolve();
      };
      speechSynthesis.speak(u);
    });

  async function turn(text: string) {
    if (stateRef.current === "processing") return;
    setState("processing");
    stopRec();
    const reply = await speak(text);
    if (!alive.current) return;
    if (!reply) {
      setState(navigator.onLine ? "listening" : "reconnecting");
      startRec();
      return;
    }
    setLines((ls) => [...ls, { who: "Sagal", text: reply.text }]);
    setState("speaking");
    startRec(); // listen for barge-in while she speaks
    await sayIt(reply.text, reply.id);
    if (alive.current && stateRef.current === "speaking") setState("listening");
  }

  function interrupt() {
    const cur = speaking.current;
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    speaking.current = null;
    if (cur) {
      setLines((ls) => ls.map((l, i) => (i === ls.length - 1 && l.who === "Sagal" ? { ...l, cut: true } : l)));
      fetch(`/api/messages/${cur.id}/interrupted`, { method: "POST", headers: { "x-sagal": "1" } }).catch(() => {});
    }
    setState("listening");
  }

  const begin = useCallback(async () => {
    if (!SpeechRecognitionCtor) {
      setMicWhy("This browser can't do live speech recognition. Chrome, Edge or Safari can.");
      setState("mic");
      return;
    }
    try {
      // Ask for the microphone only now, when Sabah pressed Talk live.
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      setState(navigator.onLine ? "listening" : "reconnecting");
      startRec();
    } catch (e) {
      setMicWhy((e as Error).name === "NotFoundError" ? "No microphone was found." : "Your browser blocked the microphone.");
      setState("mic");
    }
  }, [startRec]);

  useEffect(() => {
    alive.current = true;
    void begin();
    const off = () => setState((s) => (s === "mic" ? s : "reconnecting"));
    const on = () => {
      setState((s) => (s === "reconnecting" ? "listening" : s));
      startRec();
    };
    addEventListener("offline", off);
    addEventListener("online", on);
    return () => {
      alive.current = false;
      stopRec();
      if ("speechSynthesis" in window) speechSynthesis.cancel();
      removeEventListener("offline", off);
      removeEventListener("online", on);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (muted) stopRec();
    else if (state === "listening") startRec();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [muted]);

  // Recognition callbacks outlive renders; route them to the latest speed/voice/speak.
  const latest = useRef({ turn, interrupt });
  latest.current = { turn, interrupt };

  const LABEL: Record<VState, string> = {
    connecting: "Connecting…",
    listening: muted ? "You're muted" : "Listening",
    processing: "Thinking…",
    speaking: "Sagal is speaking",
    reconnecting: "Reconnecting…",
    mic: "Microphone unavailable",
  };
  const HINT: Record<VState, string> = {
    connecting: "Asking your browser for the microphone.",
    listening: muted ? "Sagal can't hear you. Unmute when you're ready; she'll wait." : "Go ahead. Sagal waits for a natural pause before she answers.",
    processing: "Claude is working out what to say. Usually a second or two.",
    speaking: "Start talking or press Stop Sagal to interrupt. She stops mid-sentence and listens.",
    reconnecting: "The connection dropped. Sagal keeps what you said so far and picks up when it returns. You can type meanwhile.",
    mic: `${micWhy} Allow it in your browser's site settings, or keep typing: Sagal reads everything.`,
  };

  return (
    <div className="voice">
      <div className="stack g16" style={{ maxWidth: 760, margin: "0 auto" }}>
        <div className="row g20">
          <div style={{ width: 88, height: 88, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Orb state={state} muted={muted} speed={speedF} />
          </div>
          <div className="stack g4 grow" aria-live="polite">
            <div className="row g8 wrap">
              <span className="kicker">Live with Sagal · {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")}</span>
              <Tag>Browser voice · not Sagal's voice yet</Tag>
            </div>
            <div className="serif" style={{ fontSize: "clamp(28px,3vw,38px)", lineHeight: 1.05, letterSpacing: "-.01em" }}>{LABEL[state]}</div>
            <div className="small muted" style={{ fontSize: 14, lineHeight: 1.45, textWrap: "pretty" } as React.CSSProperties}>{HINT[state]}</div>
          </div>
        </div>
        {transcript && lines.length > 0 && (
          <div className="card" style={{ borderRadius: 16, padding: "12px 16px", maxHeight: 150, overflowY: "auto" }}>
            <div className="kicker sm" style={{ marginBottom: 6 }}>Live transcript</div>
            {lines.map((l, i) => (
              <div key={i} style={{ fontSize: 14.5, lineHeight: 1.5 }}>
                <b>{l.who}</b>{" "}
                <span style={{ color: l.who === "Sagal" ? "var(--ink)" : "var(--text-2)" }}>{l.cut ? `${l.text.split(" ").slice(0, 6).join(" ")}… (interrupted)` : l.text}</span>
              </div>
            ))}
          </div>
        )}
        {state === "mic" && (
          <div className="row g8 wrap">
            <button className="btn ink" onClick={() => void begin()}>Try the microphone again</button>
            <button className="btn ghost" onClick={onEnd}>Keep typing instead</button>
          </div>
        )}
        <div className="row g8 wrap">
          <button className="vbtn" aria-pressed={muted} onClick={() => setMuted(!muted)} style={muted ? { background: "var(--ink)", color: "#fff", borderColor: "var(--ink)" } : undefined}>
            {muted ? "Unmute" : "Mute mic"}
          </button>
          <button className="vbtn" onClick={interrupt} disabled={state !== "speaking"} style={{ borderColor: "var(--ink)", background: state === "speaking" ? "var(--blue)" : "#fff", opacity: state === "speaking" ? 1 : 0.4 }}>
            Stop Sagal
          </button>
          <button className="vbtn" aria-pressed={transcript} onClick={() => setTranscript(!transcript)}>
            {transcript ? "Transcript on" : "Transcript off"}
          </button>
          <label className="vbtn" style={{ fontWeight: 400, fontSize: 13, paddingRight: 6 }}>
            Speed
            <select value={speed} onChange={(e) => setSpeed(e.target.value)} style={{ border: 0, background: "transparent", fontSize: 14, fontWeight: 600, height: 40 }}>
              {SPEEDS.map((s) => <option key={s}>{s}</option>)}
            </select>
          </label>
          <label className="vbtn" style={{ fontWeight: 400, fontSize: 13, paddingRight: 6 }}>
            Voice
            <select value={voiceName} onChange={(e) => setVoiceName(e.target.value)} style={{ border: 0, background: "transparent", fontSize: 14, fontWeight: 600, height: 40, maxWidth: 170 }}>
              <option value="">Browser default</option>
              {voices.map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}
            </select>
          </label>
          <label className="vbtn" style={{ fontWeight: 400, fontSize: 13, paddingRight: 6 }}>
            Language
            <select value={lang} onChange={(e) => setLang(e.target.value as typeof lang)} style={{ border: 0, background: "transparent", fontSize: 14, fontWeight: 600, height: 40 }}>
              <option value="en-US">English</option>
              <option value="so-SO">Somali</option>
            </select>
          </label>
          <button className="vbtn" onClick={onEnd}>Type instead</button>
          <div className="grow" />
          <button className="vbtn" onClick={onEnd} style={{ background: "var(--ink)", color: "#fff", borderColor: "var(--ink)" }}>End conversation</button>
        </div>
      </div>
    </div>
  );
}
