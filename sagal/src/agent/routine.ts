import type { DbClient } from "../db/pool.js";
import { addMessage, createConversation } from "../domain/conversations.js";
import { getSettings, setSetting, WEEKDAYS, type Settings } from "../domain/settings.js";
import { currentAuthorisation } from "../publishing/permissions.js";
import { addDays, helsinkiDate, helsinkiTime, longDate } from "../time.js";
import { anthropicKey, runTurn, type TurnDeps } from "./turn.js";

/**
 * Sagal's morning routine. Consistent posting is her first job, so every morning she
 * looks at the next week, finds posting days with nothing agreed, and prepares a post for
 * each: idea, finished draft, and a one-tap "plan it" request in Needs Sabah. She never
 * puts anything into the plan or publishes by herself: Sabah's tap is the authorisation.
 */

export const ROUTINE_FROM = "07:30";
export const ROUTINE_PROJECT = "Sagal's routine";
/** At most this many posts prepared per morning, so a long gap fills over a few days. */
export const MAX_PER_RUN = 2;

const dayName = (date: string) => WEEKDAYS[(new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7];

/** Posting days in the next 7 days (from tomorrow) with nothing agreed and nothing waiting on Sabah. */
export async function postingGaps(db: DbClient, routine: Settings["routine"], now = new Date()): Promise<string[]> {
  const today = helsinkiDate(now);
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i + 1)).filter((d) => routine.days.includes(dayName(d)));
  if (!days.length) return [];
  const planned = await db.query<{ d: string }>(
    "SELECT to_char(plan_date, 'YYYY-MM-DD') AS d FROM sagal.ideas WHERE status = 'agreed' AND NOT sample AND plan_date = ANY($1::date[])",
    [days],
  );
  const waiting = await db.query<{ key: string }>(
    "SELECT dedupe_key AS key FROM sagal.inbox_items WHERE resolved_at IS NULL AND dedupe_key = ANY($1::text[])",
    [days.map((d) => `plan-proposal:${d}`)],
  );
  const taken = new Set([...planned.rows.map((r) => r.d), ...waiting.rows.map((r) => r.key.slice("plan-proposal:".length))]);
  return days.filter((d) => !taken.has(d));
}

/** What Sagal is asked to do this morning. Written as an app note in her routine thread. */
export function routineBrief(gaps: string[], routine: Settings["routine"], channels: string[], postTime: string) {
  const todo = gaps.slice(0, MAX_PER_RUN);
  return [
    `Morning routine. Consistent posting is your first job. Sabah's posting days: ${routine.days.join(", ")}.`,
    `Nothing is planned yet for: ${gaps.map(longDate).join("; ")}.`,
    `Prepare a post for ${todo.map((d) => `${longDate(d)} (${d})`).join(" and ")}. For each one:`,
    "1. create_idea: an original idea in Soma's voice, shaped by Sabah's taste board and what's already planned (don't repeat this week's topics).",
    `   Platforms: choose from ${channels.join(", ") || "Instagram"}.`,
    "2. Make it ready to post: create_carousel with idea_id (use her uploaded images where they fit), or write_video_script for a video.",
    `3. propose_post with the idea_id and date (default time ${postTime}), and one plain sentence on why this post, this day.`,
    "Don't plan or publish anything yourself; Sabah's tap on the proposal is what plans it. Keep your reply to a short summary of what you prepared.",
  ].join("\n");
}

let inFlight: Promise<{ ran: boolean; gaps: string[] }> | null = null;

/**
 * Runs the routine once a day after 07:30 Helsinki (or now, when `force`). Skips quietly
 * when it's off, Claude isn't connected, or there's nothing to fill.
 */
export function maybeRunRoutine(deps: TurnDeps, opts: { force?: boolean; now?: Date } = {}) {
  if (inFlight) return inFlight;
  inFlight = run(deps, opts).finally(() => (inFlight = null));
  return inFlight;
}

async function run(deps: TurnDeps, { force = false, now = new Date() }: { force?: boolean; now?: Date }) {
  const { db } = deps;
  const s = await getSettings(db);
  const today = helsinkiDate(now);
  if (!force && (!s.routine.enabled || helsinkiTime(now) < ROUTINE_FROM || s.routine.lastRun === today)) return { ran: false, gaps: [] };
  if (!(await anthropicKey(deps))) return { ran: false, gaps: [] };
  // Mark the day first: a failure is retried tomorrow, never in a loop.
  await setSetting(db, "routine", { ...s.routine, lastRun: today });
  const gaps = await postingGaps(db, s.routine, now);
  if (!gaps.length) return { ran: false, gaps };

  const auth = await currentAuthorisation(db);
  const conv = await routineConversation(db);
  const note = await addMessage(db, conv, { sender: "system", text: routineBrief(gaps, s.routine, auth.channels, s.defaultPostTime) });
  await runTurn(deps, conv, note, () => {}, undefined, { deepReason: "morning planning" });
  return { ran: true, gaps };
}

async function routineConversation(db: DbClient): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `SELECT c.id FROM sagal.conversations c JOIN sagal.projects p ON p.id = c.project_id
     WHERE p.name = $1 AND c.title = 'Morning check' AND NOT c.sample ORDER BY c.id LIMIT 1`,
    [ROUTINE_PROJECT],
  );
  return rows[0]?.id ?? createConversation(db, ROUTINE_PROJECT, "Morning check");
}
