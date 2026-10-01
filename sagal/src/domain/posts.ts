import type { DbClient } from "../db/pool.js";
import { integrationStates, serviceForChannel } from "../integrations/registry.js";
import { currentAuthorisation } from "../publishing/permissions.js";
import { addDays, helsinkiDate, helsinkiTime, helsinkiToUtc } from "../time.js";
import { resolveByKey } from "./inbox.js";

export interface Post {
  id: number;
  idea_id: number | null;
  platform: string;
  account_label: string;
  title: string;
  format: string;
  kind: string;
  caption: string;
  note: string;
  scheduled_at: Date;
  status: string;
  held_by_sabah: boolean;
  approved_at: Date | null;
  needs_voiceover_job: number | null;
  carousel_id: number | null;
  error: string | null;
  sample: boolean;
}

/** What the calendar shows. "Published · confirmed" only ever comes from status=confirmed. */
export async function listPosts(db: DbClient, fromDate: string, toDate: string) {
  const { rows } = await db.query<Post & { voiceover_ready: boolean | null }>(
    `SELECT p.*, (v.voiceover_id IS NOT NULL) AS voiceover_ready FROM sagal.posts p
     LEFT JOIN sagal.video_jobs v ON v.id = p.needs_voiceover_job
     WHERE p.scheduled_at >= $1 AND p.scheduled_at < $2 ORDER BY p.scheduled_at, p.id`,
    [helsinkiToUtc(fromDate, "00:00"), helsinkiToUtc(addDays(toDate, 1), "00:00")],
  );
  const auth = await currentAuthorisation(db);
  const states = await integrationStates(db);
  return rows.map((p) => {
    const svc = serviceForChannel(p.platform);
    const connected = svc ? states[svc.id]?.state === "connected" : false;
    let display = p.status;
    if (p.status === "scheduled" && auth.paused) display = "paused";
    else if (p.status === "scheduled" && !connected) display = "later";
    return {
      ...p,
      date: helsinkiDate(p.scheduled_at),
      time: helsinkiTime(p.scheduled_at),
      display,
      globalPaused: auth.paused && p.status === "scheduled",
      channelConnected: connected,
      needsVoiceover: p.needs_voiceover_job != null && !p.voiceover_ready,
      needsApproval: auth.mode === "review" && !p.approved_at && ["scheduled", "paused"].includes(p.status) && !p.sample,
    };
  });
}

async function getPost(db: DbClient, id: number): Promise<Post> {
  const { rows } = await db.query<Post>("SELECT * FROM sagal.posts WHERE id = $1", [id]);
  if (!rows[0]) throw new Error("Post not found.");
  return rows[0];
}

/**
 * The next slot already agreed for this platform (another planned post's time). If
 * nothing later is planned, the same Helsinki time the next day. Never "right now".
 */
export async function nextAgreedSlot(db: DbClient, post: Post, now = new Date()): Promise<Date> {
  const { rows } = await db.query<{ scheduled_at: Date }>(
    `SELECT scheduled_at FROM sagal.posts WHERE platform = $1 AND id <> $2 AND status = 'scheduled' AND scheduled_at > $3
     ORDER BY scheduled_at LIMIT 1`,
    [post.platform, post.id, now],
  );
  if (rows[0]) return rows[0].scheduled_at;
  let d = helsinkiDate(now);
  const t = helsinkiTime(post.scheduled_at);
  let slot = helsinkiToUtc(addDays(d, 1), t);
  while (slot <= now) slot = helsinkiToUtc((d = addDays(d, 1)), t);
  return slot;
}

export async function holdPost(db: DbClient, id: number) {
  await db.query(
    "UPDATE sagal.posts SET status = 'paused', held_by_sabah = true, note = 'Held by Sabah. Sagal will not publish this until you resume it.', updated_at = now() WHERE id = $1 AND status IN ('scheduled','paused')",
    [id],
  );
}

export async function resumePost(db: DbClient, id: number) {
  const p = await getPost(db, id);
  const when = p.scheduled_at > new Date() ? p.scheduled_at : await nextAgreedSlot(db, p);
  await db.query(
    "UPDATE sagal.posts SET status = 'scheduled', held_by_sabah = false, scheduled_at = $2, note = 'Resumed. Back inside the approved plan.', updated_at = now() WHERE id = $1 AND status = 'paused'",
    [id, when],
  );
  await resolveByKey(db, `post-held:${id}`, "Resumed");
}

export async function retryPost(db: DbClient, id: number) {
  const p = await getPost(db, id);
  if (p.status !== "failed") throw new Error("Only a failed post can be retried.");
  const when = await nextAgreedSlot(db, p);
  await db.query(
    "UPDATE sagal.posts SET status = 'scheduled', error = NULL, scheduled_at = $2, note = $3, updated_at = now() WHERE id = $1",
    [id, when, `Retry queued for the next agreed slot (${helsinkiDate(when)} ${helsinkiTime(when)}). Nothing has been posted yet.`],
  );
  await resolveByKey(db, `post-failed:${id}`, "Retry at next slot");
}

export async function approvePost(db: DbClient, id: number) {
  await db.query("UPDATE sagal.posts SET approved_by = 'sabah', approved_at = now(), updated_at = now() WHERE id = $1", [id]);
  await resolveByKey(db, `post-approval:${id}`, "Approved");
}

/** Sabah posted it herself (manual handoff). Recorded as hers, never as platform-confirmed. */
export async function markPostedByHand(db: DbClient, id: number) {
  await db.query(
    "UPDATE sagal.posts SET status = 'posted_by_hand', note = 'Posted by Sabah by hand. Not platform-confirmed, so no results come in automatically.', updated_at = now() WHERE id = $1 AND status IN ('manual','failed','scheduled','paused')",
    [id],
  );
  await resolveByKey(db, `post-manual:${id}`, "I've posted it");
}

export async function updateCaption(db: DbClient, id: number, caption: string) {
  await db.query("UPDATE sagal.posts SET caption = $2, updated_at = now() WHERE id = $1", [id, caption]);
}
