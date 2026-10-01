import { afterEach, describe, expect, it } from "vitest";
import { BrainError } from "../src/agent/brain.js";
import { writeMemory } from "../src/domain/memory.js";
import { api, FakeBrain, makeApp, sse, upload, type TestApp } from "./helpers.js";

let t: TestApp;
afterEach(async () => {
  await t?.app.close();
  await t?.db.end();
});

async function newConv(t: TestApp) {
  return (await api(t).post("/api/conversations", {})).json().id as number;
}

describe("Talk to Sagal", () => {
  it("without a Claude key, saves Sabah's message and says plainly why Sagal can't answer", async () => {
    t = await makeApp();
    const id = await newConv(t);
    const r = await api(t).post(`/api/conversations/${id}/messages`, { text: "Let's plan this week." });
    const ev = sse(r.body);
    expect(ev.map((e) => e.type)).toEqual(["sabah", "failed", "done"]);
    expect(String(ev[1].error)).toMatch(/Claude isn't connected/);
    const conv = (await api(t).get(`/api/conversations/${id}`)).json();
    expect(conv.conversation.title).toBe("Let's plan this week.");
    expect(conv.messages[0]).toMatchObject({ sender: "sabah", status: "failed" });
  });

  it("streams Sagal's reply, runs her tools, and saves cards and choices on the message", async () => {
    const brain = new FakeBrain(() => ({
      text: "First draft is on the right: three slides, one idea each.",
      tools: [
        { name: "create_carousel", input: { title: "The one-sentence homepage", slides: [{ headline: "We cut our homepage to one sentence." }, { headline: "Before" }, { headline: "Your turn" }] } },
        { name: "offer_choices", input: { quote: "What does someone need to know in five seconds?", options: ["Use this", "Try another"] } },
      ],
    }));
    t = await makeApp({ cfg: { ANTHROPIC_API_KEY: "sk-ant-test" }, brain });
    const id = await newConv(t);
    const r = await api(t).post(`/api/conversations/${id}/messages`, { text: "Turn the homepage rewrite into a carousel.", context: { type: "idea", id: 1, label: "Idea · Homepage" } });
    const ev = sse(r.body);
    const types = ev.map((e) => e.type);
    expect(types[0]).toBe("sabah");
    expect(types).toContain("delta");
    expect(types).toContain("effect");
    const sagal = ev.find((e) => e.type === "sagal")!.message as Record<string, unknown>;
    expect(sagal).toMatchObject({ sender: "sagal", quote: "What does someone need to know in five seconds?", decision: { options: ["Use this", "Try another"], picked: null } });
    expect((sagal.card as { type: string }).type).toBe("carousel");
    expect((await t.db.query("SELECT jsonb_array_length(slides) AS n FROM sagal.carousels")).rows[0].n).toBe(3);
    expect((await t.db.query("SELECT state FROM sagal.integrations WHERE service = 'anthropic'")).rows[0].state).toBe("connected");

    // Context the model received: the per-turn state and the chip label.
    const input = brain.calls[0];
    expect(input.context).toContain("Europe/Helsinki");
    expect(JSON.stringify(input.history)).toContain("[Re: Idea · Homepage]");

    // Picking an option records it and sends it as Sabah's reply.
    const pick = await api(t).post(`/api/messages/${sagal.id}/pick`, { option: "Use this" });
    expect(sse(pick.body)[0]).toMatchObject({ type: "sabah", message: { text: "Use this" } });
    expect((await api(t).post(`/api/messages/${sagal.id}/pick`, { option: "Try another" })).statusCode).toBe(409);
  });

  it("marks the message Not sent when Claude fails, and Retry answers it", async () => {
    let n = 0;
    const brain = new FakeBrain(() => (n++ === 0 ? { text: "", error: new BrainError("Claude is overloaded right now. Press Retry in a moment.", "overloaded") } : { text: "Back. Where were we?" }));
    t = await makeApp({ cfg: { ANTHROPIC_API_KEY: "sk-ant-test" }, brain });
    const id = await newConv(t);
    const first = sse((await api(t).post(`/api/conversations/${id}/messages`, { text: "Hello?" })).body);
    const failed = first.find((e) => e.type === "failed")!;
    expect(failed.error).toMatch(/overloaded/);
    const mid = (failed.message as { id: number }).id;
    const retry = sse((await api(t).post(`/api/messages/${mid}/retry`)).body);
    expect(retry.find((e) => e.type === "sagal")).toBeTruthy();
    const msgs = (await api(t).get(`/api/conversations/${id}`)).json().messages;
    expect(msgs.map((m: { sender: string; status: string }) => `${m.sender}:${m.status}`)).toEqual(["sabah:sent", "sagal:sent"]);
  });

  it("Sagal can't overwrite facts Sabah owns, but can add her own notes", async () => {
    const brain = new FakeBrain(() => ({ text: "Noted.", tools: [{ name: "remember", input: { section: "notes", key: "tone", value: "Sabah likes plain first slides" } }] }));
    t = await makeApp({ cfg: { ANTHROPIC_API_KEY: "sk-ant-test" }, brain });
    await writeMemory(t.db, "facts", "name", "Soma", "sabah");
    await expect(writeMemory(t.db, "facts", "name", "Soma Studio", "sagal")).rejects.toThrow(/belongs to Sabah/);
    const id = await newConv(t);
    await api(t).post(`/api/conversations/${id}/messages`, { text: "Remember I like plain first slides." });
    const mem = (await api(t).get("/api/memory")).json();
    expect(mem.entries.find((e: { key: string }) => e.key === "tone")).toMatchObject({ owner: "sagal", section: "notes" });
    expect(mem.entries.find((e: { key: string }) => e.key === "name")).toMatchObject({ value: "Soma", owner: "sabah" });
    expect(mem.history.length).toBeGreaterThanOrEqual(2);
  });

  it("uses Sonnet for chat, Opus for planning, and re-runs on Opus when Sonnet hands over", async () => {
    const brain = new FakeBrain((input) => (/develop/.test(JSON.stringify(input.history)) ? { text: "Let's dig in.", escalate: "developing an idea" } : { text: "Sure." }));
    t = await makeApp({ cfg: { ANTHROPIC_API_KEY: "sk-ant-test" }, brain });
    const id = await newConv(t);
    const chat = sse((await api(t).post(`/api/conversations/${id}/messages`, { text: "Morning!" })).body);
    expect(chat.find((e) => e.type === "thinking")).toMatchObject({ model: "Sonnet 5.5", reason: "everyday chat" });
    expect(chat.find((e) => e.type === "sagal")!.message).toMatchObject({ model: "Sonnet 5.5", model_reason: "everyday chat" });
    expect(brain.calls[0]).toMatchObject({ model: "claude-sonnet-5-5", allowEscalate: true });

    sse((await api(t).post(`/api/conversations/${id}/messages`, { text: "Let's plan this week." })).body);
    expect(brain.calls[1]).toMatchObject({ model: "claude-opus-5-5", allowEscalate: false });

    const handed = sse((await api(t).post(`/api/conversations/${id}/messages`, { text: "I have an idea, help me develop it" })).body);
    expect(handed.map((e) => e.type)).toContain("restart");
    expect(brain.calls.slice(-2).map((c) => c.model)).toEqual(["claude-sonnet-5-5", "claude-opus-5-5"]);
    expect(handed.find((e) => e.type === "sagal")!.message).toMatchObject({ model: "Opus 5.5", model_reason: "developing an idea" });

    // The switch: always Sonnet.
    expect((await api(t).patch("/api/settings/brain", { mode: "everyday" })).statusCode).toBe(200);
    expect((await api(t).get("/api/overview")).json().brainMode).toBe("everyday");
    sse((await api(t).post(`/api/conversations/${id}/messages`, { text: "Let's plan this week." })).body);
    expect(brain.calls[brain.calls.length - 1]).toMatchObject({ model: "claude-sonnet-5-5", allowEscalate: false });
  });

  it("Discuss slide gives Sagal the slide and its comments", async () => {
    t = await makeApp({ cfg: { ANTHROPIC_API_KEY: "sk-ant-test" } });
    await api(t).post("/api/sample/load");
    const c = (await t.db.query("SELECT id FROM sagal.carousels")).rows[0];
    await api(t).post(`/api/conversations/${await newConv(t)}/messages`, { text: "Plainer?", context: { type: "slide", id: `${c.id}:2`, label: "Slide 3 · Question" } });
    expect(t.brain.calls[0].context).toContain("discussing slide 3");
    expect(t.brain.calls[0].context).toContain("make the question plainer");
  });

  it("writing a video script asks Sabah for her voiceover", async () => {
    const brain = new FakeBrain(() => ({
      text: "Script's on the right.",
      tools: [{ name: "write_video_script", input: { title: "Why one sentence", lines: [{ t: "0:00", part: "Hook", line: "We cut our homepage down to one sentence." }, { t: "0:34", part: "Close", line: "What would yours say?" }] } }],
    }));
    t = await makeApp({ cfg: { ANTHROPIC_API_KEY: "sk-ant-test" }, brain });
    // Quiet hours (Helsinki night) hold emails back; this test must pass at any hour.
    await api(t).patch("/api/settings/notifications", { quiet: false });
    await api(t).post(`/api/conversations/${await newConv(t)}/messages`, { text: "Write the script." });
    const inbox = (await api(t).get("/api/inbox")).json().open;
    expect(inbox[0]).toMatchObject({ kind: "Missing audio", primary_action: "go:video" });
    expect(t.mailer.sent.some((m) => m.subject.includes("Your voiceover"))).toBe(true);
  });
});

describe("uploads and the voiceover separation", () => {
  it("voiceovers go only to the voiceovers table and area; voice notes and references never do", async () => {
    t = await makeApp();
    const job = (await api(t).post("/api/video", { title: "Why one sentence" })).json().id;
    const vo = await upload(t, `/api/video/${job}/voiceover`, "take1.m4a", "audio/mp4", "AUDIO");
    expect(vo.statusCode).toBe(200);
    const row = (await t.db.query("SELECT storage_key, uploaded_by FROM sagal.voiceovers")).rows[0];
    expect(row.storage_key).toMatch(/^voiceovers\//);
    expect(row.uploaded_by).toBe("sabah");
    expect((await t.db.query("SELECT count(*)::int AS n FROM sagal.media_assets")).rows[0].n).toBe(0);

    const note = await upload(t, "/api/uploads/conversation_audio", "note.webm", "audio/webm", "NOTE");
    expect(note.statusCode).toBe(200);
    const asset = (await t.db.query("SELECT kind, storage_key, do_not_publish FROM sagal.media_assets")).rows[0];
    expect(asset).toMatchObject({ kind: "conversation_audio", do_not_publish: true });
    expect(asset.storage_key).toMatch(/^conversation-audio\//);

    // The database itself refuses anything but a voiceovers/ audio file in that table.
    await expect(t.db.query("INSERT INTO sagal.voiceovers (storage_key, filename, content_type, size_bytes) VALUES ('conversation-audio/x.webm','x','audio/webm',1)")).rejects.toThrow();
    await expect(t.db.query("INSERT INTO sagal.voiceovers (storage_key, filename, content_type, size_bytes, uploaded_by) VALUES ('voiceovers/x.mp3','x','audio/mpeg',1,'sagal')")).rejects.toThrow();

    // Wrong file types are refused with a plain message.
    expect((await upload(t, `/api/video/${job}/voiceover`, "x.png", "image/png")).statusCode).toBe(400);
    expect((await upload(t, "/api/uploads/image", "x.mp3", "audio/mpeg")).statusCode).toBe(400);

    // Video studio state follows real files only.
    const v = (await api(t).get(`/api/video/${job}`)).json();
    expect(v.job.heygenState).toBe("manual"); // HeyGen not connected → manual handoff
    expect(v.links.voiceover).toMatch(/^\/media\/voiceovers\/.*sig=/);
    const media = await t.app.inject({ url: v.links.voiceover });
    expect(media.statusCode).toBe(200);
    expect(media.body).toBe("AUDIO");
    expect((await t.app.inject({ url: v.links.voiceover.replace(/sig=[^&]+/, "sig=forged") })).statusCode).toBe(403);
    expect((await api(t).get(`/api/video/${job}/package/subtitles.srt`)).body).toContain("-->");
  });

  it("passes Sabah's web switch to Sagal (not in live voice) and turns it off if Claude can't search", async () => {
    let n = 0;
    const brain = new FakeBrain(() => ({ text: "Looked it up.", webUnavailable: n++ === 1 }));
    t = await makeApp({ cfg: { ANTHROPIC_API_KEY: "sk-ant-test" }, brain });
    const a = api(t);
    const conv = await newConv(t);
    await a.post(`/api/conversations/${conv}/messages`, { text: "What's trending?" });
    expect(brain.calls[0].web).toBe(false);
    expect((await a.patch("/api/settings/web", { enabled: true })).statusCode).toBe(200);
    expect(brain.calls.length).toBe(1);
    await a.post(`/api/conversations/${conv}/messages`, { text: "What's trending now?" });
    expect(brain.calls[1].web).toBe(true);
    expect(brain.calls[1].context).toContain("Web search: on");
    // Claude refused the web tools: the switch goes off and the thread says why.
    const ov = (await a.get("/api/overview")).json();
    expect(ov).toMatchObject({ webSearch: false, webError: expect.stringMatching(/doesn't allow web search/) });
    const msgs = (await a.get(`/api/conversations/${conv}`)).json().messages;
    expect(msgs.some((m: { sender: string; text: string }) => m.sender === "system" && /couldn't search the web/.test(m.text))).toBe(true);
    await a.patch("/api/settings/web", { enabled: true });
    await a.post(`/api/conversations/${conv}/messages`, { text: "Tell me quickly", via: "voice" });
    expect(brain.calls[2].web).toBe(false);
  });
});
