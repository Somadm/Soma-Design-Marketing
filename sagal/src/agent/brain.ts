import Anthropic from "@anthropic-ai/sdk";
import type { BetaContentBlockParam, BetaMessage, BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { SAGAL_SYSTEM } from "./prompt.js";
import { ESCALATE_TOOL, parseEscalation, runTool, toolDefinitions, type ToolContext, type ToolEffect } from "./tools.js";

/** Server-side refusal fallback: the API re-runs a declined request on a recommended model. */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export interface TurnInput {
  history: BetaMessageParam[];
  /** Per-turn context (memory, plan, date). Goes after the cached system prompt. */
  context: string;
  /** Which Claude model answers this turn. */
  model: string;
  /** Offer the hand-over-to-Opus tool (Sonnet in automatic mode). */
  allowEscalate?: boolean;
  /** Let Claude search the web and read pages this turn (Sabah's switch). */
  web?: boolean;
}

export interface TurnCallbacks {
  onText(delta: string): void;
  onEffect(effect: ToolEffect): void;
}

export interface TurnResult {
  text: string;
  effects: ToolEffect[];
  model: string;
  /** Set when Sonnet handed the turn to Opus; the caller re-runs it on the deeper model. */
  escalate?: string;
  /** The web switch is on, but this Claude account doesn't allow web search yet. */
  webUnavailable?: boolean;
}

export interface Brain {
  reply(input: TurnInput, tools: ToolContext, cb: TurnCallbacks, signal?: AbortSignal): Promise<TurnResult>;
}

export class BrainError extends Error {
  constructor(
    message: string,
    public kind: "auth" | "rate" | "overloaded" | "refusal" | "other",
  ) {
    super(message);
  }
}

/**
 * Claude is Sagal's reasoning. Streams text to the caller, runs Sagal's tools
 * (validated, permission-checked server-side) and loops until she's done.
 */
export class ClaudeBrain implements Brain {
  private client: Anthropic;

  constructor(
    apiKey: string,
    private effort: "low" | "medium" | "high" | "xhigh" | "max",
    client?: Anthropic,
  ) {
    this.client = client ?? new Anthropic({ apiKey, maxRetries: 2 });
  }

  async reply(input: TurnInput, tools: ToolContext, cb: TurnCallbacks, signal?: AbortSignal): Promise<TurnResult> {
    const messages: BetaMessageParam[] = [...input.history];
    const effects: ToolEffect[] = [];
    const texts: string[] = [];
    let model = input.model;
    let jsonRetries = 0;
    let web = Boolean(input.web);
    let webUnavailable = false;
    try {
      for (let turn = 0; turn < 8; turn++) {
        if (texts.length && !texts[texts.length - 1].endsWith("\n")) {
          // Separate text from successive loop turns.
          texts.push("\n\n");
          cb.onText("\n\n");
        }
        const stream = this.client.beta.messages.stream(
          {
            model: input.model,
            max_tokens: 16000,
            system: [
              { type: "text", text: SAGAL_SYSTEM, cache_control: { type: "ephemeral" } },
              { type: "text", text: input.context },
            ],
            messages,
            tools: toolDefinitions(input.allowEscalate, web),
            output_config: { effort: this.effort },
            betas: [FALLBACK_BETA],
            fallbacks: "default",
          },
          { signal },
        );
        stream.on("text", (delta) => {
          texts.push(delta);
          cb.onText(delta);
        });
        let msg: BetaMessage;
        try {
          msg = await stream.finalMessage();
          jsonRetries = 0;
        } catch (err) {
          // Web tools not allowed on this Claude account: carry on without them and say so once.
          if (web && err instanceof Anthropic.BadRequestError && /web[ _]?(search|fetch)/i.test(err.message)) {
            web = false;
            webUnavailable = true;
            continue;
          }
          // Eager tool-input streaming: re-issue only when a tool input wasn't parseable JSON.
          if (err instanceof Anthropic.APIError || signal?.aborted || jsonRetries++ >= 2) throw err;
          continue;
        }
        model = msg.model ?? model;
        if (msg.stop_reason === "refusal") {
          if (!texts.join("").trim()) {
            const t = "I can't help with that one. Want to try it from a different angle?";
            texts.push(t);
            cb.onText(t);
          }
          break;
        }
        if (msg.stop_reason === "pause_turn") {
          messages.push({ role: "assistant", content: msg.content as BetaContentBlockParam[] });
          continue;
        }
        const uses = msg.content.filter((b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use");
        if (!uses.length) break;
        const handover = input.allowEscalate ? uses.find((u) => u.name === ESCALATE_TOOL) : undefined;
        // Hand-over only at the very start of a turn, before anything was created.
        if (handover && turn === 0 && !effects.length) {
          const parsed = parseEscalation(handover.input);
          return { text: "", effects, model, escalate: parsed.success ? parsed.data.reason : "needs deeper thinking" };
        }
        if (msg.stop_reason === "max_tokens") throw new BrainError("My reply got cut off. Try asking for something smaller.", "other");
        messages.push({ role: "assistant", content: msg.content as BetaContentBlockParam[] });
        const results: BetaContentBlockParam[] = [];
        for (const u of uses) {
          if (u.name === ESCALATE_TOOL) {
            results.push({ type: "tool_result", tool_use_id: u.id, content: "Too late to hand over mid-turn. Carry on and finish this one yourself.", is_error: true });
            continue;
          }
          const out = await runTool(u.name, u.input, tools);
          if (out.effect) {
            effects.push(out.effect);
            cb.onEffect(out.effect);
          }
          results.push({ type: "tool_result", tool_use_id: u.id, content: out.result, ...(out.isError ? { is_error: true } : {}) });
        }
        messages.push({ role: "user", content: results });
      }
    } catch (err) {
      if (err instanceof BrainError) throw err;
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        throw new BrainError("Claude rejected the API key. Check it in Connected accounts.", "auth");
      }
      if (err instanceof Anthropic.RateLimitError) throw new BrainError("Claude is rate-limiting us. Give it a minute and press Retry.", "rate");
      if (err instanceof Anthropic.InternalServerError) throw new BrainError("Claude is overloaded right now. Press Retry in a moment.", "overloaded");
      if (err instanceof Anthropic.APIError) throw new BrainError(`Claude returned an error (${err.status ?? "network"}). Press Retry.`, "other");
      throw new BrainError(`Something went wrong reaching Claude: ${(err as Error).message}`, "other");
    }
    return { text: texts.join("").trim(), effects, model, ...(webUnavailable ? { webUnavailable: true } : {}) };
  }
}
