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
