import { describe, expect, it } from "vitest";
import { passwordProblem, hashPassword, verifyPassword } from "../src/auth/passwords.js";
import { assertSabahVoiceover, AudioSeparationError, buildHeygenRequest, scriptToSrt } from "../src/integrations/production.js";
import { Vault } from "../src/secrets/vault.js";
import { addDays, helsinkiDate, helsinkiTime, helsinkiToUtc, inQuietHours, weekStart } from "../src/time.js";

describe("time: stored in UTC, shown in Europe/Helsinki", () => {
  it("converts Helsinki wall-clock to UTC across daylight saving", () => {
    expect(helsinkiToUtc("2026-10-01", "12:30").toISOString()).toBe("2026-10-01T09:30:00.000Z"); // EEST, UTC+3
    expect(helsinkiToUtc("2026-12-01", "12:30").toISOString()).toBe("2026-12-01T10:30:00.000Z"); // EET, UTC+2
    expect(helsinkiToUtc("2026-10-25", "02:30").toISOString()).toBe("2026-10-24T23:30:00.000Z"); // ambiguous hour on the DST change
  });
  it("formats UTC back to Helsinki", () => {
    const d = new Date("2026-09-30T21:30:00Z");
    expect(helsinkiDate(d)).toBe("2026-10-01");
    expect(helsinkiTime(d)).toBe("00:30");
  });
  it("finds the Monday of the week", () => {
    expect(weekStart("2026-10-01")).toBe("2026-09-28");
    expect(weekStart("2026-09-28")).toBe("2026-09-28");
    expect(weekStart("2026-10-04")).toBe("2026-09-28");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
  it("knows quiet hours (21:00–08:00 Helsinki)", () => {
    expect(inQuietHours(helsinkiToUtc("2026-10-01", "22:00"))).toBe(true);
    expect(inQuietHours(helsinkiToUtc("2026-10-01", "07:59"))).toBe(true);
    expect(inQuietHours(helsinkiToUtc("2026-10-01", "08:00"))).toBe(false);
    expect(inQuietHours(helsinkiToUtc("2026-10-01", "20:59"))).toBe(false);
  });
});

describe("passwords", () => {
  it("hashes with scrypt and verifies", async () => {
    const h = await hashPassword("a long enough password");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("a long enough password", h)).toBe(true);
    expect(await verifyPassword("wrong password here", h)).toBe(false);
  });
  it("explains weak passwords plainly", () => {
    expect(passwordProblem("short")).toMatch(/10 characters/);
    expect(passwordProblem("aaaaaaaaaaaa")).toMatch(/predictable/);
    expect(passwordProblem("a fine passphrase")).toBeNull();
  });
});

describe("vault encryption", () => {
  const vault = new Vault({} as never, Buffer.alloc(32, 9).toString("base64"));
  it("round-trips and never stores plaintext", () => {
    const enc = vault.encrypt("sk-ant-secret-value", "anthropic.api_key");
    expect(enc.ciphertext.toString("utf8")).not.toContain("secret");
    expect(vault.decrypt(enc, "anthropic.api_key")).toBe("sk-ant-secret-value");
  });
  it("binds each value to its name, so rows can't be swapped", () => {
    const enc = vault.encrypt("value", "heygen.api_key");
    expect(() => vault.decrypt(enc, "captions.api_key")).toThrow();
  });
});

describe("audio separation (hard rule)", () => {
  const vo = { table: "voiceovers" as const, id: 1, storage_key: "voiceovers/2026-10-01/abc-take1.m4a", content_type: "audio/mp4", uploaded_by: "sabah" as const };
  it("accepts only Sabah's uploaded voiceover", () => {
    const req = buildHeygenRequest({ title: "Why one sentence", scriptLines: ["Hi"], voiceover: vo, voiceoverUrl: "https://x/vo", avatarId: "a1" });
    expect(req.video_inputs[0].voice).toEqual({ type: "audio", audio_url: "https://x/vo" });
  });
  it("rejects conversation audio, media assets and anything else", () => {
    const bad = [
      { ...vo, table: "media_assets" },
      { ...vo, storage_key: "conversation-audio/2026-10-01/note.webm" },
      { ...vo, storage_key: "media/audio-reference/x.mp3" },
      { ...vo, uploaded_by: "sagal" },
      { ...vo, content_type: "video/mp4" },
      null,
      { kind: "tts", text: "Sagal speaking" },
    ];
    for (const b of bad) expect(() => assertSabahVoiceover(b)).toThrow(AudioSeparationError);
  });
  it("makes subtitles from the timed script", () => {
    const srt = scriptToSrt([{ t: "0:00", line: "One" }, { t: "0:04", line: "Two" }]);
    expect(srt).toContain("00:00:00,000 --> 00:00:04,000\nOne");
    expect(srt).toContain("2\n00:00:04,000 --> 00:00:40,000\nTwo");
  });
});

describe("master key", async () => {
  const { masterKey } = await import("../src/config.js");
  it("uses a 32-byte base64 key as-is and hashes anything else to 32 bytes", () => {
    const k = Buffer.alloc(32, 5).toString("base64");
    expect(masterKey(k)).toEqual(Buffer.alloc(32, 5));
    expect(masterKey("some long random value that is not base64!!")).toHaveLength(32);
  });
});

describe("storage file names", async () => {
  const { safeKey, storageFilename } = await import("../src/storage/storage.js");
  it("cleans awkward names (several dots, spaces, brackets) into safe keys", () => {
    for (const name of ["S...@3x (8).png", "../../etc/passwd", "...", "Screenshot 2026-10-01 at 12.30.45.png", "logo..png"]) {
      const clean = storageFilename(name);
      expect(clean).not.toContain("..");
      expect(() => safeKey(`media/brand/2026-10-01/abc-${clean}`)).not.toThrow();
    }
    expect(storageFilename("S...@3x (8).png")).toBe("S.-3x-8-.png");
  });
  it("still refuses keys that step out of their folder", () => {
    expect(() => safeKey("media/../secret")).toThrow();
    expect(() => safeKey("media/./x")).toThrow();
    expect(() => safeKey("media//x")).toThrow();
  });
});

describe("choosing Sonnet or Opus", async () => {
  const { chooseModel } = await import("../src/agent/models.js");
  const cfg = { SAGAL_MODEL_EVERYDAY: "claude-sonnet-5-5", SAGAL_MODEL_DEEP: "claude-opus-5-5" };
  const msg = (text: string, via = "text", attachmentKinds: string[] = []) => ({ text, via, attachmentKinds });
  it("automatic: everyday chat on Sonnet, heavier work on Opus", () => {
    expect(chooseModel(cfg, "auto", msg("Hi! How are you?"))).toMatchObject({ tier: "everyday", model: "claude-sonnet-5-5" });
    expect(chooseModel(cfg, "auto", msg("Can you fix the typo on slide 2?"))).toMatchObject({ tier: "everyday" });
    expect(chooseModel(cfg, "auto", msg("Let's plan this week."))).toMatchObject({ tier: "deep", model: "claude-opus-5-5", reason: "planning" });
    expect(chooseModel(cfg, "auto", msg("Turn this project into a story."))).toMatchObject({ tier: "deep" });
    expect(chooseModel(cfg, "auto", msg("Write the script for Thursday"))).toMatchObject({ tier: "deep" });
    expect(chooseModel(cfg, "auto", msg("think harder about this"))).toMatchObject({ tier: "deep", reason: "you asked her to think harder" });
    expect(chooseModel(cfg, "auto", msg("Have a look", "text", ["pdf"]))).toMatchObject({ tier: "deep", reason: "reading a document" });
    expect(chooseModel(cfg, "auto", msg("x".repeat(1500)))).toMatchObject({ tier: "deep" });
  });
  it("live voice stays on Sonnet for speed, unless set to always Opus", () => {
    expect(chooseModel(cfg, "auto", msg("Let's plan this week.", "voice"))).toMatchObject({ tier: "everyday" });
    expect(chooseModel(cfg, "deep", msg("hi", "voice"))).toMatchObject({ tier: "deep" });
  });
  it("respects the fixed settings", () => {
    expect(chooseModel(cfg, "everyday", msg("Let's plan this week."))).toMatchObject({ tier: "everyday" });
    expect(chooseModel(cfg, "deep", msg("hi"))).toMatchObject({ tier: "deep" });
  });
});
