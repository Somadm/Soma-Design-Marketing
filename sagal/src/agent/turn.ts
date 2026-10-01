import type { BetaContentBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Config } from "../config.js";
import type { Db } from "../db/pool.js";
import { addMessage, getConversation, messages, type Message } from "../domain/conversations.js";
import type { Notifier } from "../domain/notify.js";
import { setState } from "../integrations/registry.js";
import type { Vault } from "../secrets/vault.js";
import type { Storages } from "../storage/storage.js";
import { ClaudeBrain, BrainError, type Brain } from "./brain.js";
import { buildContext, focusText, toHistory } from "./context.js";
import type { ToolEffect } from "./tools.js";
import { getSettings } from "../domain/settings.js";
import { chooseModel, TIER_LABEL } from "./models.js";

export type TurnEvent =
  | { type: "sabah"; message: Message }
  | { type: "thinking"; model: string; tier: string; reason: string }
  | { type: "restart"; model: string; tier: string; reason: string }
  | { type: "delta"; text: string }
  | { type: "effect"; effect: ToolEffect }
  | { type: "sagal"; message: Message }
  | { type: "failed"; message: Message; error: string }
  | { type: "done" };

export interface TurnDeps {
  db: Db;
  cfg: Config;
  vault: Vault;
  storages: Storages;
  notifier?: Notifier;
  /** Tests inject a fake brain; production builds Claude from the saved key. */
  brain?: (apiKey: string) => Brain;
}

export async function anthropicKey(deps: Pick<TurnDeps, "vault" | "cfg">): Promise<string | null> {
  return (await deps.vault.get("anthropic.api_key")) ?? deps.cfg.ANTHROPIC_API_KEY ?? null;
}

async function attachmentBlocks(deps: TurnDeps, m: Message): Promise<BetaContentBlockParam[]> {
  const blocks: BetaContentBlockParam[] = [];
  for (const a of (m.attachments ?? []).slice(0, 4)) {
    const { rows } = await deps.db.query<{ storage_key: string; content_type: string; size_bytes: number }>(
      "SELECT storage_key, content_type, size_bytes FROM sagal.media_assets WHERE id = $1",
      [a.assetId],
    );
    const r = rows[0];
    if (!r || r.size_bytes > 5 * 1024 * 1024) continue;
    const isImage = /^image\/(png|jpeg|gif|webp)$/.test(r.content_type);
    const isPdf = r.content_type === "application/pdf";
    if (!isImage && !isPdf) continue;
    const chunks: Buffer[] = [];
    for await (const c of await deps.storages.media.read(r.storage_key)) chunks.push(c as Buffer);
    const data = Buffer.concat(chunks).toString("base64");
    blocks.push(
      isImage
        ? { type: "image", source: { type: "base64", media_type: r.content_type as "image/png", data } }
        : { type: "document", source: { type: "base64", media_type: "application/pdf", data } },
    );
  }
  return blocks;
}

/**
 * Sagal answers the newest Sabah message in a conversation. Sabah's message is already
 * saved; if Sagal can't answer, it's marked "Not sent" with the reason, and Retry runs
 * this again.
 */
export async function runTurn(deps: TurnDeps, conversationId: number, sabahMessage: Message, emit: (e: TurnEvent) => void, signal?: AbortSignal) {
  const { db } = deps;
  const fail = async (error: string) => {
    const { rows } = await db.query<Message>("UPDATE sagal.messages SET status = 'failed', error = $2 WHERE id = $1 RETURNING *", [sabahMessage.id, error]);
    emit({ type: "failed", message: rows[0], error });
  };
  const key = await anthropicKey(deps);
  if (!key) {
    await fail("Sagal can't think yet: Claude isn't connected. Add the Claude key in Memory & settings → Connected accounts, then press Retry.");
    return;
  }
  const conv = await getConversation(db, conversationId);
  if (!conv) return fail("Conversation not found.");
  const mode = (await getSettings(db)).brain.mode;
  let choice = chooseModel(deps.cfg, mode, {
    text: sabahMessage.text,
    via: sabahMessage.via,
    attachmentKinds: (sabahMessage.attachments ?? []).map((a) => a.kind),
  });
  emit({ type: "thinking", model: TIER_LABEL[choice.tier], tier: choice.tier, reason: choice.reason });
  const brain = deps.brain ? deps.brain(key) : new ClaudeBrain(key, deps.cfg.SAGAL_EFFORT);
  const history = await messages(db, conversationId, 60);
  try {
    const input = {
      history: toHistory(history, await attachmentBlocks(deps, sabahMessage)),
      context: await buildContext(db, {
        spoken: sabahMessage.via === "voice",
        conversationTitle: conv.title,
        project: conv.project,
        focus: await focusText(db, sabahMessage.context),
      }),
    };
    const callbacks = { onText: (text: string) => emit({ type: "delta", text }), onEffect: (effect: ToolEffect) => emit({ type: "effect", effect }) };
    const tools = { db, conversationId, notifier: deps.notifier };
    let result = await brain.reply(
      { ...input, model: choice.model, allowEscalate: mode === "auto" && choice.tier === "everyday" && sabahMessage.via !== "voice" },
      tools,
      callbacks,
      signal,
    );
    if (result.escalate) {
      // Sagal decided this needs her deeper mode: start the reply again on Opus.
      choice = { tier: "deep", model: deps.cfg.SAGAL_MODEL_DEEP, reason: result.escalate };
      emit({ type: "restart", model: TIER_LABEL.deep, tier: "deep", reason: choice.reason });
      result = await brain.reply({ ...input, model: choice.model, allowEscalate: false }, tools, callbacks, signal);
    }
    await db.query("UPDATE sagal.messages SET status = 'sent', error = NULL WHERE id = $1", [sabahMessage.id]);
    const cards = result.effects.filter((e) => e.card).map((e) => e.card!);
    const quote = result.effects.find((e) => e.quote)?.quote ?? null;
    const decision = result.effects.find((e) => e.decision)?.decision ?? null;
    const saved = await addMessage(db, conversationId, {
      sender: "sagal",
      text: result.text || (cards.length ? "Here it is." : "…"),
      via: sabahMessage.via === "voice" ? "voice" : "text",
      card: cards[0] ?? null,
      quote,
      decision,
      model: TIER_LABEL[choice.tier],
      model_reason: choice.reason,
    });
    emit({ type: "sagal", message: saved });
    for (const card of cards.slice(1)) emit({ type: "sagal", message: await addMessage(db, conversationId, { sender: "sagal", text: "", card }) });
    await setState(db, "anthropic", "connected", { account: "Sonnet 5.5 + Opus 5.5" });
  } catch (err) {
    if (err instanceof BrainError && err.kind === "auth") await setState(db, "anthropic", "needs_reconnect", { error: err.message });
    await fail(err instanceof BrainError ? err.message : `Something went wrong: ${(err as Error).message}`);
  }
}
