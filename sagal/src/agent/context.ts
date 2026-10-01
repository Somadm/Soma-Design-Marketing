import type { BetaContentBlockParam, BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { DbClient } from "../db/pool.js";
import type { Message } from "../domain/conversations.js";
import { listUsableImages } from "../domain/assets.js";
import { memoryDigest } from "../domain/memory.js";
import { tasteDigest } from "../domain/inspiration.js";
import { listIdeas, weekDays } from "../domain/plan.js";
import { listPosts } from "../domain/posts.js";
import { integrationStates, SERVICES } from "../integrations/registry.js";
import { currentAuthorisation, spentThisMonth } from "../publishing/permissions.js";
import { helsinkiDate, helsinkiTime } from "../time.js";
import { spokenNote } from "./prompt.js";

const WEEKDAY = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Helsinki", weekday: "long", day: "numeric", month: "long", year: "numeric" });

/** Everything Sagal needs to know this turn, read fresh from the database. */
/** What Sabah is pointing at (a slide, idea, post, reference or inbox item), in full. */
export async function focusText(db: DbClient, context: Message["context"]): Promise<string | null> {
  if (!context) return null;
  const [a, b] = String(context.id ?? "").split(":").map(Number);
  if (context.type === "slide" && a) {
    const { rows } = await db.query<{ title: string; slides: unknown[] }>("SELECT title, slides FROM sagal.carousels WHERE id = $1", [a]);
    if (!rows[0]) return null;
    const comments = await db.query<{ who: string; text: string }>("SELECT who, text FROM sagal.slide_comments WHERE carousel_id = $1 AND slide_index = $2 ORDER BY id", [a, b || 0]);
    return `Sabah is discussing slide ${(b || 0) + 1} of [carousel ${a}] “${rows[0].title}”: ${JSON.stringify(rows[0].slides[b || 0])}${
      comments.rows.length ? `\nComments on it: ${comments.rows.map((c) => `${c.who}: ${c.text}`).join(" | ")}` : ""
    }`;
  }
  const table = { idea: "sagal.ideas", post: "sagal.posts", reference: "sagal.inspiration", inbox: "sagal.inbox_items" }[context.type];
  if (table && a) {
    const { rows } = await db.query(`SELECT * FROM ${table} WHERE id = $1`, [a]);
    if (rows[0]) {
      const { created_at: _c, updated_at: _u, ...rest } = rows[0];
      if (context.type === "reference" && rest.private) return `Sabah is pointing at a PRIVATE reference (don't post, don't reuse its content): ${JSON.stringify(rest)}`;
      return `Sabah is pointing at this ${context.type}: ${JSON.stringify(rest)}`;
    }
  }
  return null;
}

export async function buildContext(db: DbClient, opts: { spoken: boolean; conversationTitle: string; project: string; focus?: string | null; now?: Date }): Promise<string> {
  const now = opts.now ?? new Date();
  const today = helsinkiDate(now);
  const days = weekDays(today);
  const [memory, ideas, posts, auth, spent, states, inbox, carousels, videos] = await Promise.all([
    memoryDigest(db),
    listIdeas(db),
    listPosts(db, days[0], days[6]),
    currentAuthorisation(db),
    spentThisMonth(db),
    integrationStates(db),
    db.query<{ kind: string; title: string }>("SELECT kind, title FROM sagal.inbox_items WHERE resolved_at IS NULL ORDER BY urgent DESC, id LIMIT 12"),
    db.query<{ id: number; title: string; draft: number }>("SELECT id, title, draft FROM sagal.carousels ORDER BY updated_at DESC LIMIT 8"),
    db.query<{ id: number; title: string; voiceover_id: number | null }>("SELECT id, title, voiceover_id FROM sagal.video_jobs ORDER BY updated_at DESC LIMIT 5"),
  ]);
  const images = await listUsableImages(db, 20);
  const taste = await tasteDigest(db);
  const agreed = ideas.filter((i) => i.status === "agreed");
  const board = ideas.filter((i) => i.status === "board");
  const lines = [
    `Now: ${WEEKDAY.format(now)}, ${helsinkiTime(now)} Europe/Helsinki.`,
    `Conversation: “${opts.conversationTitle}” in project “${opts.project}”.`,
    "",
    "<memory>",
    memory,
    "</memory>",
    "",
    "<taste>",
    "Sabah's Inspiration board: what she loves and what's not for Soma. Let it shape your ideas, layouts, colours and tone. Learn the why; never copy the work.",
    taste,
    "</taste>",
    "",
    `Publishing authorisation: ${auth.mode === "plan" ? "publish within the approved plan" : "review each finished post"}; channels: ${auth.channels.join(", ") || "none"}; ${auth.paused ? "ALL PUBLISHING IS PAUSED" : "not paused"}; production spend €${spent.toFixed(2)} of €${auth.spend_limit_eur} this month.`,
    `Connections: ${SERVICES.map((s) => `${s.name} ${(states[s.id]?.state ?? "not_connected").replace("_", " ")}`).join("; ")}. Nothing publishes automatically until a platform is connected: due posts are handed to Sabah to post by hand.`,
    "",
    `Agreed plan (${days[0]} to ${days[6]}):`,
    ...(agreed.length ? agreed.map((i) => `- [idea ${i.id}] ${i.plan_date}: ${i.title} (${i.format}; ${i.platforms.join(", ")})`) : ["- nothing agreed yet"]),
    "This week's posts:",
    ...(posts.length ? posts.map((p) => `- ${p.date} ${p.time} ${p.platform}: ${p.title} — ${p.display}${p.needsVoiceover ? " (needs Sabah's voiceover)" : ""}`) : ["- none"]),
    "Idea board:",
    ...(board.length ? board.map((i) => `- [idea ${i.id}] ${i.title} (${i.format})`) : ["- empty"]),
    "Carousels:",
    ...(carousels.rows.length ? carousels.rows.map((c) => `- [carousel ${c.id}] ${c.title} (draft ${c.draft})`) : ["- none"]),
    "Images Sabah has uploaded that can go on slides (use image_id):",
    ...(images.length ? images.map((i) => `- [image ${i.id}] ${i.label ? `${i.label} · ` : ""}${i.filename} (${i.kind === "brand" ? "brand asset" : "upload"}, ${helsinkiDate(i.created_at)})`) : ["- none yet"]),
    "Video scripts:",
    ...(videos.rows.length ? videos.rows.map((v) => `- [video ${v.id}] ${v.title}${v.voiceover_id ? " (voiceover received)" : " (waiting for Sabah's voiceover)"}`) : ["- none"]),
    "Needs Sabah (open):",
    ...(inbox.rows.length ? inbox.rows.map((r) => `- ${r.kind}: ${r.title}`) : ["- nothing"]),
  ];
  if (opts.focus) lines.push("", opts.focus);
  if (opts.spoken) lines.push("", spokenNote());
  return lines.join("\n");
}

function userText(m: Message): string {
  const parts: string[] = [];
  if (m.context?.label) parts.push(`[Re: ${m.context.label}]`);
  if (m.via === "voice_note") parts.push(m.text ? `[Voice note, transcribed] ${m.text}` : "[Voice note with no transcript: speech-to-text isn't connected, so Sagal can't hear it yet.]");
  else if (m.text) parts.push(m.via === "voice" ? `[Spoken] ${m.text}` : m.text);
  if (m.attachments?.length) parts.push(`[Attached: ${m.attachments.map((a) => `${a.kind} “${a.name}”${a.kind === "image" ? ` (image ${a.assetId})` : ""}`).join(", ")}]`);
  return parts.join("\n") || "(empty message)";
}

/**
 * Conversation history for Claude: Sabah → user, Sagal → assistant, app notes → user.
 * `extra` adds content blocks (e.g. attached images) to the newest user message.
 */
export function toHistory(msgs: Message[], extra: BetaContentBlockParam[] = []): BetaMessageParam[] {
  const out: BetaMessageParam[] = [];
  for (const m of msgs) {
    if (m.sender === "sagal") {
      if (!m.text.trim()) continue;
      out.push({ role: "assistant", content: m.text + (m.interrupted ? "\n[Sabah interrupted me here.]" : "") });
    } else if (m.sender === "system") {
      out.push({ role: "user", content: `[App note] ${m.text}` });
    } else if (m.status !== "failed" || m === msgs[msgs.length - 1]) {
      out.push({ role: "user", content: userText(m) });
    }
  }
  while (out.length && out[0].role !== "user") out.shift();
  if (extra.length) {
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i].role === "user") {
        const c = out[i].content;
        out[i] = { role: "user", content: [...extra, ...(typeof c === "string" ? [{ type: "text" as const, text: c }] : c)] };
        break;
      }
    }
  }
  return out;
}
