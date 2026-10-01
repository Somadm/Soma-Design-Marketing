/**
 * Building requests for HeyGen and Captions.
 *
 * HARD RULE (audio separation): HeyGen only ever receives a Sabah voiceover, i.e. a row
 * from sagal.voiceovers. The input type below has no field that can carry anything
 * else: no media asset, no conversation audio, no text-to-speech. There is no code path
 * that sends Sagal's voice to HeyGen, and nothing clones Sabah's voice.
 */

export interface SabahVoiceover {
  readonly table: "voiceovers";
  id: number;
  storage_key: string;
  content_type: string;
  uploaded_by: "sabah";
}

export interface HeygenJobInput {
  title: string;
  scriptLines: string[];
  voiceover: SabahVoiceover;
  voiceoverUrl: string;
  /** Sabah's HeyGen avatar (her likeness, set up by her in HeyGen). */
  avatarId: string;
}

export class AudioSeparationError extends Error {}

export function assertSabahVoiceover(v: unknown): asserts v is SabahVoiceover {
  const x = v as Partial<SabahVoiceover> | null;
  if (
    !x ||
    x.table !== "voiceovers" ||
    x.uploaded_by !== "sabah" ||
    typeof x.storage_key !== "string" ||
    !x.storage_key.startsWith("voiceovers/") ||
    typeof x.content_type !== "string" ||
    !x.content_type.startsWith("audio/")
  ) {
    throw new AudioSeparationError("HeyGen can only use Sabah's own uploaded voiceover.");
  }
}

/**
 * The HeyGen request body (avatar video from an uploaded audio file). Phase 1 never
 * sends it; Video studio offers the manual handoff instead. Kept here so the rule is
 * enforced in one place when the real call is added.
 */
export function buildHeygenRequest(input: HeygenJobInput) {
  assertSabahVoiceover(input.voiceover);
  return {
    title: input.title,
    // Shape follows HeyGen's v2 video generate API; confirm against their docs when connecting.
    video_inputs: [{ character: { type: "avatar", avatar_id: input.avatarId }, voice: { type: "audio", audio_url: input.voiceoverUrl } }],
    dimension: { width: 1080, height: 1920 },
    // The script goes along for reference/captions only; HeyGen does not voice it.
    caption: false,
    script_reference: input.scriptLines.join("\n"),
  };
}

/** Captions (Mirage) is used for captioning and trims only. Never generated voices or avatars. */
export const CAPTIONS_ALLOWED_FEATURES = ["captions", "trim"] as const;

export function scriptText(script: { t: string; part: string; line: string }[]): string {
  return script.map((s) => `[${s.t}] ${s.part}\n${s.line}`).join("\n\n");
}

/** Subtitles from the timed script (each line runs until the next one starts). */
export function scriptToSrt(script: { t: string; line: string }[], totalSeconds = 40): string {
  const sec = (t: string) => {
    const [m, s] = t.split(":").map(Number);
    return (m || 0) * 60 + (s || 0);
  };
  const fmt = (n: number) => {
    const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), s = Math.floor(n % 60);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},000`;
  };
  return script
    .map((s, i) => `${i + 1}\n${fmt(sec(s.t))} --> ${fmt(i + 1 < script.length ? sec(script[i + 1].t) : Math.max(sec(s.t) + 3, totalSeconds))}\n${s.line}\n`)
    .join("\n");
}
