import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClaudeBrain, BrainError } from "../src/agent/brain.js";
import { freshDb } from "./helpers.js";
import type { Db } from "../src/db/pool.js";

/** A stand-in for the Messages API that streams scripted responses and records requests. */
function sseMessage(id: string, blocks: ({ type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown })[], stop: string) {
  const ev: string[] = [];
  const send = (type: string, data: object) => ev.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send("message_start", { message: { id, type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  blocks.forEach((b, index) => {
    if (b.type === "text") {
      send("content_block_start", { index, content_block: { type: "text", text: "" } });
      for (const piece of b.text.match(/.{1,12}/g) ?? []) send("content_block_delta", { index, delta: { type: "text_delta", text: piece } });
    } else {
      send("content_block_start", { index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    send("content_block_stop", { index });
  });
  send("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } });
  send("message_stop", {});
  return ev.join("");
}

let server: Server;
let base = "";
let db: Db;
const requests: { headers: Record<string, unknown>; body: Record<string, unknown> }[] = [];
let script: (n: number) => { status?: number; body: string } = () => ({ body: "" });

beforeAll(async () => {
  db = await freshDb();
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      requests.push({ headers: req.headers, body: JSON.parse(raw) });
      const r = script(requests.length);
      res.writeHead(r.status ?? 200, { "content-type": r.status ? "application/json" : "text/event-stream" });
      res.end(r.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await db.end();
});

describe("ClaudeBrain (real SDK, local stand-in API)", () => {
  it("streams text, runs a tool, sends the result back, and finishes", async () => {
    requests.length = 0;
    script = (n) =>
      n === 1
        ? { body: sseMessage("m1", [{ type: "text", text: "Putting it on the board." }, { type: "tool_use", id: "tu1", name: "create_idea", input: { title: "Signs we keep photographing", story: "Shopfront lettering.", audience: "Diaspora", purpose: "Craft", format: "Carousel", platforms: ["Instagram"] } }], "tool_use") }
        : { body: sseMessage("m2", [{ type: "text", text: "Done. It's on the idea board." }], "end_turn") };
    const brain = new ClaudeBrain("sk-test", "claude-opus-5-5", "medium", new Anthropic({ apiKey: "sk-test", baseURL: base, maxRetries: 0 }));
    const deltas: string[] = [];
    const effects: unknown[] = [];
    const r = await brain.reply(
      { history: [{ role: "user", content: "Is there something in shopfront signs?" }], context: "Now: Thursday." },
      { db, conversationId: 1 },
      { onText: (d) => deltas.push(d), onEffect: (e) => effects.push(e) },
    );
    expect(r.text).toBe("Putting it on the board.\n\nDone. It's on the idea board.");
    expect(deltas.join("")).toBe(r.text);
    expect(effects).toHaveLength(1);
    expect((await db.query("SELECT title FROM sagal.ideas")).rows[0].title).toBe("Signs we keep photographing");

    // What we sent: cached stable system prompt first, per-turn context after it, tools, effort, fallback beta.
    const first = requests[0];
    const system = first.body.system as { text: string; cache_control?: unknown }[];
    expect(system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(system[0].text).toContain("You are Sagal");
    expect(system[1]).toEqual({ type: "text", text: "Now: Thursday." });
    expect(first.body.model).toBe("claude-opus-5-5");
    expect(first.body.output_config).toEqual({ effort: "medium" });
    expect(first.body.fallbacks).toBe("default");
    expect(String(first.headers["anthropic-beta"])).toContain("server-side-fallback-2026-07-01");
    expect((first.body.tools as { name: string }[]).map((t) => t.name)).toContain("create_idea");
    // Second request carries the assistant turn and our tool_result.
    const msgs = requests[1].body.messages as { role: string; content: unknown }[];
    expect(msgs[1].role).toBe("assistant");
    expect(JSON.stringify(msgs[2])).toContain('"tool_use_id":"tu1"');
  });

  it("turns a rejected key into a plain-language error", async () => {
    script = () => ({ status: 401, body: JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }) });
    const brain = new ClaudeBrain("bad", "claude-opus-5-5", "medium", new Anthropic({ apiKey: "bad", baseURL: base, maxRetries: 0 }));
    await expect(brain.reply({ history: [{ role: "user", content: "hi" }], context: "" }, { db, conversationId: 1 }, { onText() {}, onEffect() {} })).rejects.toMatchObject({
      kind: "auth",
      message: expect.stringMatching(/rejected the API key/),
    } satisfies Partial<BrainError>);
  });

  it("returns a tool error to Claude instead of running invalid input", async () => {
    requests.length = 0;
    script = (n) =>
      n === 1
        ? { body: sseMessage("m1", [{ type: "tool_use", id: "tu9", name: "create_idea", input: { title: "" } }], "tool_use") }
        : { body: sseMessage("m2", [{ type: "text", text: "Let me fix that." }], "end_turn") };
    const brain = new ClaudeBrain("sk-test", "claude-opus-5-5", "medium", new Anthropic({ apiKey: "sk-test", baseURL: base, maxRetries: 0 }));
    await brain.reply({ history: [{ role: "user", content: "x" }], context: "" }, { db, conversationId: 1 }, { onText() {}, onEffect() {} });
    const result = JSON.stringify(requests[1].body.messages);
    expect(result).toContain('"is_error":true');
    expect(result).toContain("INVALID_INPUT");
  });
});
