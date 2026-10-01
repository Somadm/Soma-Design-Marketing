import React, { useState } from "react";
import { api } from "../api";
import { Kicker, Pills, Tag, useAction, when } from "../lib";
import { SPEEDS, useBrowserVoices } from "./Voice";

const GROUPS = [
  {
    g: "English",
    note: "Personality, pacing, knowing when to stop",
    items: [
      { id: "e1", text: "Okay. I have three ideas, and one of them is slightly unhinged. Want the sensible ones first?", tests: "wit, warmth", lang: "en-US" },
      { id: "e2", text: "Quick one: Thursday's video needs your voiceover. Everything else is ready.", tests: "plain request, brevity", lang: "en-US" },
      { id: "e3", text: "Honestly? Slide three is trying too hard. Let's make it plainer.", tests: "kind critique", lang: "en-US" },
      { id: "e4", text: "I'll stop there. Your turn.", tests: "giving you space", lang: "en-US" },
    ],
  },
  {
    g: "Somali",
    note: "Drafted by Claude · check with a native speaker first",
    items: [
      { id: "s1", text: "Subax wanaagsan, Sabah. Maanta maxaan samaynaa?", gloss: "Good morning, Sabah. What are we doing today?", tests: "greeting, names", lang: "so-SO" },
      { id: "s2", text: "Waan ku maqlayaa. Sii wad.", gloss: "I hear you. Go on.", tests: "short turn-taking", lang: "so-SO" },
      { id: "s3", text: "Fikraddani aad bay u fiican tahay.", gloss: "This idea is really good.", tests: "warmth, intonation", lang: "so-SO" },
      { id: "s4", text: "Codkaaga ayaan u baahanahay si aan fiidiyowga u dhammeeyo.", gloss: "I need your voice to finish the video.", tests: "longer sentence", lang: "so-SO" },
    ],
  },
];
const RATES = ["Too fast", "Right pace", "Too flat", "Love it"] as const;

export function VoiceTestScreen() {
  const voices = useBrowserVoices();
  const [playing, setPlaying] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [rates, setRates] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [overall, setOverall] = useState("");
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>("1.0×");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const { run } = useAction();

  const play = (p: { id: string; text: string; lang: string }) => {
    try {
      speechSynthesis.cancel();
      if (playing === p.id) return setPlaying(null);
      const u = new SpeechSynthesisUtterance(p.text);
      u.lang = p.lang;
      u.rate = parseFloat(speed) || 1;
      const match = voices.find((v) => v.lang.toLowerCase().startsWith(p.lang.slice(0, 2)));
      if (match) u.voice = match;
      setNotice(p.lang.startsWith("so") && !match ? "Your browser has no Somali voice, so this plays with a non-Somali voice and will sound wrong. That's exactly what the real provider test is for." : "");
      u.onend = () => setPlaying(null);
      setPlaying(p.id);
      speechSynthesis.speak(u);
    } catch {
      setNotice("This browser can't play speech. Read the phrases aloud in Sagal's voice in your head. Seriously, it helps.");
    }
  };

  return (
    <div className="scroll">
      <div className="page w1280" style={{ gap: 28 }}>
        <div className="stack g10">
          <Kicker>Voice · Talk to Sagal (conversational audio)</Kicker>
          <h1 className="title-xl">Test Sagal's voice</h1>
          <p className="lede" style={{ fontSize: 17, maxWidth: 680 }}>Warm, expressive, a little witty, with a subtle New York lilt and never a caricature. She should know when to stop and leave you room. This screen is where you judge that before we commit to a provider.</p>
        </div>
        <div className="row g14 wrap note stone" style={{ alignItems: "flex-start", borderRadius: 18, padding: "16px 20px" }}>
          <span style={{ background: "#fff", borderRadius: 999 }}><Tag>Not Sagal's voice yet</Tag></span>
          <div className="grow" style={{ fontSize: 14.5, lineHeight: 1.5, minWidth: 260 }}>The play buttons use your browser's built-in voice so you can judge wording and pacing. It will not sound like Sagal. The real test runs once a provider is connected. This is also separate from your HeyGen videos: those always use your own uploaded voiceover.</div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,320px),1fr))", gap: 16 }}>
          <div className="card strong stack g12" style={{ padding: 22, borderRadius: 22 }}>
            <div className="row between g8"><span className="kicker" style={{ color: "var(--ink)" }}>Recommended</span><span className="chip" style={{ background: "var(--blue)" }}>Claude stays the brain</span></div>
            <div className="serif" style={{ fontSize: 30, lineHeight: 1.05 }}>ElevenLabs Agents + Claude</div>
            <div style={{ fontSize: 14.5, lineHeight: 1.55 }}>ElevenLabs listens, handles turn-taking and interruptions, and speaks. Claude does all the thinking and holds Sagal's memory, through a custom-LLM endpoint on this server. It's a speech → Claude → speech pipeline, not one speech-to-speech model.</div>
            <div className="stack g6" style={{ fontSize: 13.5, lineHeight: 1.45 }}>
              <div><b>Somali:</b> listed for Eleven v3/v4 speech and Scribe transcription. Scribe rates Somali accuracy "moderate", so quality needs testing.</div>
              <div><b>Cost:</b> $0.08 per agent minute, plus Claude usage billed separately.</div>
              <div><b>Latency:</b> roughly 1–2 s to first word with Claude in the loop (estimate, to be measured).</div>
            </div>
            <div className="xs muted">Prices checked 30 Sep 2026 · elevenlabs.io/pricing · re-check before signing up</div>
          </div>
          <div className="card stack g12" style={{ padding: 22, borderRadius: 22 }}>
            <div className="row between g8"><span className="kicker" style={{ color: "var(--ink)" }}>Lower cost</span><span className="chip idle">More to build</span></div>
            <div className="serif" style={{ fontSize: 30, lineHeight: 1.05 }}>Azure Speech + Claude</div>
            <div style={{ fontSize: 14.5, lineHeight: 1.55 }}>Separate transcription and text-to-speech around Claude. Has dedicated Somali neural voices (Ubax, Muuse). Less expressive, and we'd build turn-taking and interruption handling ourselves.</div>
            <div className="stack g6" style={{ fontSize: 13.5, lineHeight: 1.45 }}>
              <div><b>Somali:</b> documented voices for so-SO. Transcription support to confirm.</div>
              <div><b>Cost:</b> around $16 per million characters of speech, about $1 per audio hour to transcribe (third-party figures, confirm on Azure).</div>
            </div>
            <div className="xs muted">Checked 30 Sep 2026 · azure.microsoft.com/pricing/details/speech</div>
          </div>
          <div className="card soft stack g12" style={{ padding: 22, borderRadius: 22, border: "1px dashed var(--dash)" }}>
            <span className="kicker" style={{ color: "var(--ink)" }}>Evaluated, not recommended</span>
            <div className="serif" style={{ fontSize: 30, lineHeight: 1.05 }}>A live speech-to-speech model</div>
            <div style={{ fontSize: 14.5, lineHeight: 1.55 }}>For example OpenAI's gpt-realtime. The fastest, most natural turn-taking, but that model would be doing the thinking, not Claude. We'd lose Sagal's reasoning and memory setup, so it's only worth revisiting as a front end that hands off to Claude.</div>
            <div style={{ fontSize: 13.5 }}><b>Cost:</b> $32 / $64 per million audio tokens in / out.</div>
            <div className="xs muted">Checked 30 Sep 2026 · openai.com/api/pricing</div>
          </div>
        </div>
        <div className="row g10 wrap"><span className="small muted">Playback speed</span><Pills sm options={SPEEDS} value={speed} onChange={setSpeed} /></div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,420px),1fr))", gap: 22 }}>
          {GROUPS.map((g) => (
            <div key={g.g} className="stack g12">
              <div className="row between g8" style={{ alignItems: "baseline" }}><div className="serif" style={{ fontSize: 30 }}>{g.g}</div><div className="muted" style={{ fontSize: 12.5 }}>{g.note}</div></div>
              {g.items.map((p) => (
                <div key={p.id} className="card stack g12" style={{ borderRadius: 18, padding: "16px 18px" }}>
                  <div className="row g14" style={{ alignItems: "flex-start" }}>
                    <button aria-label={playing === p.id ? "Stop" : "Play phrase"} onClick={() => play(p)} style={{ width: 44, height: 44, borderRadius: "50%", border: 0, background: playing === p.id ? "var(--blue)" : "#111", color: playing === p.id ? "#111" : "#fff", flexShrink: 0, fontSize: 13 }}>{playing === p.id ? "■" : "▶"}</button>
                    <div className="stack g4" style={{ minWidth: 0 }}>
                      <div className="serif" style={{ fontSize: 23, lineHeight: 1.2 }}>“{p.text}”</div>
                      {"gloss" in p && <div className="muted" style={{ fontSize: 13.5 }}>{(p as { gloss: string }).gloss}</div>}
                      <Kicker sm>Tests: {p.tests}</Kicker>
                    </div>
                  </div>
                  <Pills sm options={RATES} value={(rates[p.id] ?? "") as (typeof RATES)[number]} onChange={(r) => setRates({ ...rates, [p.id]: r })} />
                  <input className="input round" placeholder="What would you change?" value={notes[p.id] ?? ""} onChange={(e) => setNotes({ ...notes, [p.id]: e.target.value })} />
                </div>
              ))}
            </div>
          ))}
        </div>
        {notice && <div className="note warn">{notice}</div>}
        <div className="card soft stack g12" style={{ borderRadius: 22, padding: 22 }}>
          <div className="title-s">Overall, how should Sagal sound?</div>
          <textarea className="input" rows={3} placeholder="Warmer? Slower? Less Brooklyn, more Brooklyn? Tell her." value={overall} onChange={(e) => setOverall(e.target.value)} />
          <div className="row g10 wrap">
            <button
              className="btn ink"
              onClick={() =>
                run(async () => {
                  const named = Object.fromEntries(Object.entries(rates).map(([k, v]) => [GROUPS.flatMap((g) => g.items).find((x) => x.id === k)!.text.slice(0, 40), v]));
                  const namedNotes = Object.fromEntries(Object.entries(notes).filter(([, v]) => v).map(([k, v]) => [GROUPS.flatMap((g) => g.items).find((x) => x.id === k)!.text.slice(0, 40), v]));
                  const r = await api.post<{ savedAt: string }>("/api/memory/voice-feedback", { overall, ratings: named, notes: namedNotes });
                  setSavedAt(r.savedAt);
                }, "Saved to Memory. Sagal will remember it.")
              }
            >
              Save feedback to Memory
            </button>
            <span className="small muted">{savedAt ? `Saved ${when(savedAt)} · shared memory` : "Ratings and notes above are saved with it."}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
