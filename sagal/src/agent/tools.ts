import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { DbClient } from "../db/pool.js";
import { createCarousel, getCarousel, updateSlide, ROLES, THEMES } from "../domain/carousels.js";
import { createInboxItem } from "../domain/inbox.js";
import { OwnershipError, writeMemory } from "../domain/memory.js";
import type { Notifier } from "../domain/notify.js";
import { createIdea, FORMATS } from "../domain/plan.js";
import { createVideoJob } from "../domain/video.js";
import { CHANNELS } from "../publishing/permissions.js";

export interface ToolContext {
  db: DbClient;
  conversationId: number;
  notifier?: Notifier;
}

export interface ToolEffect {
  card?: { type: "carousel" | "idea" | "week" | "script"; id?: number; title: string; sub: string };
  quote?: string;
  decision?: { options: string[]; picked: null };
}

export interface ToolOutcome {
  result: string;
  isError?: boolean;
  effect?: ToolEffect;
}

const Platform = z.enum(CHANNELS);
const Slide = z.object({
  role: z.enum(ROLES as [string, ...string[]]).optional(),
  kicker: z.string().max(80).optional(),
  headline: z.string().min(1).max(240),
  supporting_line: z.string().max(600).optional(),
  visual: z.string().max(200).optional(),
  look: z.enum(THEMES as [string, ...string[]]).optional(),
});

const schemas = {
  create_idea: z.object({
    title: z.string().min(1).max(160),
    story: z.string().max(1200),
    audience: z.string().max(200),
    purpose: z.string().max(200),
    format: z.enum(FORMATS as [string, ...string[]]),
    platforms: z.array(Platform).min(1),
  }),
  create_carousel: z.object({
    title: z.string().min(1).max(160),
    project: z.string().max(80).optional(),
    idea_id: z.number().int().optional(),
    slides: z.array(Slide).min(1).max(12),
    captions: z.record(z.string(), z.string()).optional(),
  }),
  update_slide: z.object({
    carousel_id: z.number().int(),
    slide_number: z.number().int().min(1),
    headline: z.string().max(240).optional(),
    supporting_line: z.string().max(600).optional(),
    kicker: z.string().max(80).optional(),
    visual: z.string().max(200).optional(),
  }),
  write_video_script: z.object({
    title: z.string().min(1).max(160),
    idea_id: z.number().int().optional(),
    lines: z.array(z.object({ t: z.string().regex(/^\d{1,2}:\d{2}$/), part: z.string().max(40), line: z.string().min(1).max(400) })).min(1).max(30),
    platform_captions: z.record(z.string(), z.string()).optional(),
  }),
  offer_choices: z.object({ quote: z.string().max(300).optional(), options: z.array(z.string().min(1).max(60)).min(2).max(4) }),
  ask_sabah: z.object({
    kind: z.enum(["Decision", "Outside the plan", "Production problem", "Missing audio"]),
    title: z.string().min(1).max(160),
    explanation: z.string().min(1).max(1200),
    primary_option: z.string().min(1).max(60),
    secondary_option: z.string().max(60).optional(),
    due: z.string().max(60).optional(),
  }),
  remember: z.object({
    section: z.enum(["facts", "language", "preferences", "notes"]),
    key: z.string().min(1).max(80),
    value: z.string().min(1).max(1000),
  }),
  propose_for_paid: z.object({ title: z.string().min(1).max(200), evidence: z.string().min(1).max(300) }),
  show_this_week: z.object({}),
};

export type ToolName = keyof typeof schemas;

const desc: Record<ToolName, string> = {
  create_idea: "Put a new idea on the idea board in Plan together. Sabah decides whether it goes into the plan. Use it when an idea is concrete enough to discuss (story, audience, purpose, format, platforms).",
  create_carousel: "Draft a carousel (usually 5–8 slides, one idea per slide, roles from Hook to Close) and open it in the workspace. Optionally include captions keyed by platform name.",
  update_slide: "Change one slide of an existing carousel (only the fields you pass). The workspace updates immediately.",
  write_video_script: "Write a timed script for an avatar video that Sabah records in her own voice. Opens in the workspace; Sabah is asked for her voiceover.",
  offer_choices: "Show two to four short option buttons under your reply (optionally with a quoted line, e.g. a proposed headline). Sabah's pick comes back as her next message.",
  ask_sabah: "Add an item to Needs Sabah for something that needs her decision outside this chat, or anything outside the agreed plan. Keep the explanation plain and short and say which option you'd pick.",
  remember: "Save something to the memory Sagal and Bilan share: a business fact Sabah told you, an approved sentence (language), a creative preference, or a note. Never overwrite Sabah's own entries.",
  propose_for_paid: "Propose an organic post to Bilan for a paid test. It goes to Sabah first in Results & Bilan; nothing goes to Bilan without her.",
  show_this_week: "Show the agreed plan for this week in the workspace.",
};

/** Only offered on Sonnet in automatic mode: hand this turn to Opus. */
export const ESCALATE_TOOL = "use_deeper_thinking";
const EscalateInput = z.object({ reason: z.string().min(1).max(120) });
export const parseEscalation = (input: unknown) => EscalateInput.safeParse(input);

/** JSON schemas for Claude, generated from the same Zod schemas used to validate inputs. */
export function toolDefinitions(allowEscalate = false): Anthropic.Beta.Messages.BetaTool[] {
  const escalate: Anthropic.Beta.Messages.BetaTool[] = allowEscalate
    ? [
        {
          name: ESCALATE_TOOL,
          description:
            "Hand this turn to your deeper-thinking model (Opus 5.5). Call it FIRST, before writing anything, when the request needs real depth: planning a week or a series, strategy or positioning, drafting a whole carousel or script, a careful rewrite or critique, weighing a hard trade-off, or reading a long document. Don't use it for quick questions, small edits, or chat. Give a short plain reason, e.g. \"planning the week\".",
          input_schema: (({ $schema: _s, ...rest }) => rest)(z.toJSONSchema(EscalateInput) as Record<string, unknown>) as Anthropic.Beta.Messages.BetaTool["input_schema"],
        },
      ]
    : [];
  return [...escalate, ...(Object.keys(schemas) as ToolName[]).map((name) => {
    const { $schema: _omit, ...input_schema } = z.toJSONSchema(schemas[name]) as Record<string, unknown>;
    return {
      name,
      description: desc[name],
      input_schema: input_schema as Anthropic.Beta.Messages.BetaTool["input_schema"],
      eager_input_streaming: true,
    };
  })];
}

export async function runTool(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const schema = schemas[name as ToolName];
  if (!schema) return { result: `Unknown tool ${name}`, isError: true };
  const parsed = schema.safeParse(rawInput);
  if (!parsed.success) return { result: `INVALID_INPUT: ${parsed.error.message.slice(0, 400)}`, isError: true };
  const { db } = ctx;
  try {
    switch (name as ToolName) {
      case "create_idea": {
        const i = parsed.data as z.infer<typeof schemas.create_idea>;
        const idea = await createIdea(db, i, "sagal");
        return { result: `Idea ${idea.id} is on the board.`, effect: { card: { type: "idea", id: idea.id, title: idea.title, sub: `Idea · ${idea.format} · ${idea.platforms.join(", ")}` } } };
      }
      case "create_carousel": {
        const c = parsed.data as z.infer<typeof schemas.create_carousel>;
        const id = await createCarousel(db, {
          title: c.title, project: c.project, ideaId: c.idea_id ?? null, captions: c.captions,
          slides: c.slides.map((s) => ({ role: s.role, kicker: s.kicker, head: s.headline, body: s.supporting_line, visual: s.visual, theme: s.look })),
        });
        return { result: `Carousel ${id} created with ${c.slides.length} slides and opened in the workspace.`, effect: { card: { type: "carousel", id, title: c.title, sub: `${c.slides.length} slides · 4:5 · draft 1` } } };
      }
      case "update_slide": {
        const u = parsed.data as z.infer<typeof schemas.update_slide>;
        const s = await updateSlide(db, u.carousel_id, u.slide_number - 1, { head: u.headline, body: u.supporting_line, kicker: u.kicker, visual: u.visual });
        const c = await getCarousel(db, u.carousel_id);
        return {
          result: `Slide ${u.slide_number} updated: “${s.head}”.`,
          effect: { card: { type: "carousel", id: u.carousel_id, title: c?.title ?? "Carousel", sub: `Slide ${u.slide_number} updated · draft ${c?.draft ?? ""}` } },
        };
      }
      case "write_video_script": {
        const v = parsed.data as z.infer<typeof schemas.write_video_script>;
        const id = await createVideoJob(db, { title: v.title, ideaId: v.idea_id ?? null, script: v.lines, platformCaptions: v.platform_captions });
        const last = v.lines[v.lines.length - 1].t;
        await createInboxItem(db, {
          kind: "Missing audio", title: `Your voiceover for “${v.title}”`, urgent: false, dueLabel: "When the script is approved",
          body: `The script is in Video studio. Record it in your own voice, somewhere quiet; your phone is fine. About ${last} long.`,
          primaryLabel: "Upload voiceover", primaryAction: "go:video", dedupeKey: `voiceover:${id}`, ref: { videoJobId: id },
        }, ctx.notifier);
        return { result: `Script saved as video job ${id}; Sabah has been asked for her voiceover.`, effect: { card: { type: "script", id, title: v.title, sub: `Script · avatar video · ~${last}` } } };
      }
      case "offer_choices": {
        const o = parsed.data as z.infer<typeof schemas.offer_choices>;
        return { result: "Options shown under your reply.", effect: { quote: o.quote, decision: { options: o.options, picked: null } } };
      }
      case "ask_sabah": {
        const a = parsed.data as z.infer<typeof schemas.ask_sabah>;
        await createInboxItem(db, {
          kind: a.kind, title: a.title, body: a.explanation, primaryLabel: a.primary_option, secondaryLabel: a.secondary_option,
          dueLabel: a.due ?? "", ref: { conversationId: ctx.conversationId },
        }, ctx.notifier);
        return { result: "Added to Needs Sabah." };
      }
      case "remember": {
        const r = parsed.data as z.infer<typeof schemas.remember>;
        const value = r.section === "language" ? { say: r.value } : r.value;
        await writeMemory(db, r.section, r.key, value, "sagal");
        return { result: `Saved to shared memory (${r.section}: ${r.key}).` };
      }
      case "propose_for_paid": {
        const p = parsed.data as z.infer<typeof schemas.propose_for_paid>;
        await db.query(
          "INSERT INTO shared.tasks (type, title, status, owner, evidence, next_step, created_by) VALUES ('Proposed for paid', $1, 'Needs Sabah', 'Sabah decides', $2, 'Approve before Sagal sends it to Bilan', 'sagal')",
          [p.title, p.evidence],
        );
        return { result: "Proposed. It waits for Sabah in Results & Bilan." };
      }
      case "show_this_week":
        return { result: "Showing this week.", effect: { card: { type: "week", title: "This week", sub: "The agreed plan · Europe/Helsinki" } } };
    }
  } catch (err) {
    if (err instanceof OwnershipError) return { result: err.message, isError: true };
    return { result: `Tool failed: ${(err as Error).message}`, isError: true };
  }
  return { result: "No-op" };
}
