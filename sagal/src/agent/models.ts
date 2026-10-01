import type { Config } from "../config.js";
import type { BrainMode } from "../domain/settings.js";

export type Tier = "everyday" | "deep";

export interface ModelChoice {
  tier: Tier;
  model: string;
  /** Plain-language reason, shown to Sabah under the reply. */
  reason: string;
}

export const TIER_LABEL: Record<Tier, string> = { everyday: "Sonnet 5.5", deep: "Opus 5.5" };

/** Work that benefits from the stronger model: planning, strategy, whole drafts, scripts. */
const DEEP_WORK: [RegExp, string][] = [
  [/\b(think (harder|deeper|it through)|take your time|deep dive|really think|use opus)\b/i, "you asked her to think harder"],
  [/\bplan\b.*\b(week|month|quarter|launch|series|calendar)\b|\b(weekly|monthly|content) plan\b|\bcontent calendar\b/i, "planning"],
  [/\b(strategy|strategic|positioning|campaign|launch plan|brand voice|tone of voice|messaging)\b/i, "strategy"],
  [/\b(carousel|slides?\b.*\b(draft|write|make|create))|\b(write|draft|make|create)\b.*\b(carousel|slides)\b/i, "drafting a carousel"],
  [/\b(script|voiceover text|video idea)\b/i, "writing a script"],
  [/\b(story|storytelling|narrative)\b/i, "shaping a story"],
  [/\b(rewrite|restructure|critique|review (this|my|the))\b/i, "a careful rewrite or review"],
  [/\b(results?|analy[sz]e|insights?|what (did|have) we learn)\b/i, "reading results"],
];

/**
 * Which model answers this turn. In auto mode Sagal stays on Sonnet for everyday chat
 * and spoken turns (faster), and uses Opus for heavier work. Sonnet can also hand a
 * turn up to Opus herself (the use_deeper_thinking tool).
 */
export function chooseModel(
  cfg: Pick<Config, "SAGAL_MODEL_EVERYDAY" | "SAGAL_MODEL_DEEP">,
  mode: BrainMode,
  msg: { text: string; via: string; attachmentKinds: string[] },
): ModelChoice {
  const pick = (tier: Tier, reason: string): ModelChoice => ({ tier, reason, model: tier === "deep" ? cfg.SAGAL_MODEL_DEEP : cfg.SAGAL_MODEL_EVERYDAY });
  if (mode === "deep") return pick("deep", "set to always use Opus");
  if (mode === "everyday") return pick("everyday", "set to always use Sonnet");
  if (msg.via === "voice") return pick("everyday", "live voice stays quick");
  if (msg.attachmentKinds.includes("pdf")) return pick("deep", "reading a document");
  if (msg.attachmentKinds.filter((k) => k === "image").length >= 3) return pick("deep", "looking at several references");
  if (msg.text.length > 1200) return pick("deep", "a long, detailed message");
  for (const [re, reason] of DEEP_WORK) if (re.test(msg.text)) return pick("deep", reason);
  return pick("everyday", "everyday chat");
}
