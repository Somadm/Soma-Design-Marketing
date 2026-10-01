import type { Db } from "../db/pool.js";
import { createInboxItem } from "../domain/inbox.js";
import type { Notifier } from "../domain/notify.js";
import type { Post } from "../domain/posts.js";
import { getSettings, setSetting } from "../domain/settings.js";
import { integrationStates, serviceForChannel } from "../integrations/registry.js";
import { helsinkiDate, helsinkiTime } from "../time.js";
import { checkPublish } from "./permissions.js";

/**
 * Publishing adapters. Phase 1 connects nothing, so no adapter can publish yet: every
 * post that is due and allowed goes to a manual handoff (Sabah posts it herself). When
 * an adapter exists it must return a platform post id ONLY after the platform confirms.
 */
export interface PublishAdapter {
  publish(post: Post): Promise<{ platformPostId: string }>;
}
export const ADAPTERS: Partial<Record<string, PublishAdapter>> = {};

const when = (p: Post) => `${helsinkiDate(p.scheduled_at)} ${helsinkiTime(p.scheduled_at)}`;

export async function processDuePosts(db: Db, notifier?: Notifier, now = new Date()): Promise<number> {
  const client = await db.connect();
  let handled = 0;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<Post & { voiceover_id: number | null }>(
      `SELECT p.*, v.voiceover_id FROM sagal.posts p LEFT JOIN sagal.video_jobs v ON v.id = p.needs_voiceover_job
       WHERE p.status = 'scheduled' AND p.scheduled_at <= $1 AND NOT p.sample
       ORDER BY p.scheduled_at LIMIT 20 FOR UPDATE OF p SKIP LOCKED`,
      [now],
    );
    const states = await integrationStates(client);
    for (const post of rows) {
      handled++;
      const set = (status: string, note: string) =>
        client.query("UPDATE sagal.posts SET status = $2, note = $3, attempts = attempts + 1, updated_at = now() WHERE id = $1", [post.id, status, note]);

      if (post.needs_voiceover_job && !post.voiceover_id) {
        await set("paused", "Held: the voiceover didn't arrive in time. Nothing was posted.");
        await createInboxItem(client, {
          kind: "Missing audio", title: `Your voiceover for “${post.title}”`, urgent: true, dueLabel: "Overdue",
          body: `“${post.title}” was due on ${post.platform} at ${when(post)}, but I don't have your voiceover yet, so I held it. Upload it in Video studio and resume the post.`,
          primaryLabel: "Upload voiceover", primaryAction: "go:video", dedupeKey: `post-held:${post.id}`, ref: { postId: post.id },
        }, notifier);
        continue;
      }

      const d = await checkPublish(client, post);
      if (!d.allowed) {
        if (d.code === "paused") await set("paused", "Held: all publishing was paused at its time. Resume it when you're ready.");
        else if (d.code === "approval") {
          await set("paused", "Waiting for your approval (review mode). Nothing was posted.");
          await createInboxItem(client, {
            kind: "Approval needed", title: `Approve “${post.title}” for ${post.platform}?`, dueLabel: "Was due " + when(post),
            body: "You're in review mode, so nothing publishes until you approve it. Approve it in Publishing and I'll post it at the next agreed slot.",
            primaryLabel: "Open Publishing", primaryAction: "go:publish", dedupeKey: `post-approval:${post.id}`, ref: { postId: post.id },
          }, notifier);
        } else {
          await set("paused", `Held: ${d.reason}`);
          await createInboxItem(client, {
            kind: "Outside the plan", title: `“${post.title}” on ${post.platform} needs your call`, dueLabel: when(post),
            body: `${d.reason} I won't post it unless you change that.`,
            primaryLabel: "Open Publishing", primaryAction: "go:publish", dedupeKey: `post-held:${post.id}`, ref: { postId: post.id },
          }, notifier);
        }
        continue;
      }

      const svc = serviceForChannel(post.platform);
      const adapter = ADAPTERS[post.platform];
      if (!adapter || !svc || states[svc.id]?.state !== "connected") {
        const why = !svc || states[svc.id]?.state !== "connected" ? `${post.platform} isn't connected yet` : `automatic posting to ${post.platform} isn't built yet`;
        await set("manual", `Ready to post by hand: ${why}. Caption and files are in the post.`);
        await createInboxItem(client, {
          kind: "Production problem", title: `Post “${post.title}” on ${post.platform} by hand`, dueLabel: "Due now",
          body: `It's time for this post, and ${why}, so I can't send it myself. Copy the caption from Publishing, post it, then tell me it's done.`,
          primaryLabel: "I've posted it", primaryAction: `post_by_hand:${post.id}`, secondaryLabel: "Open Publishing", secondaryAction: "go:publish",
          dedupeKey: `post-manual:${post.id}`, ref: { postId: post.id },
        }, notifier);
        continue;
      }

      // Connected adapter (phase 2+): mark publishing, then confirm only on the platform's answer.
      await client.query("UPDATE sagal.posts SET status = 'publishing', attempts = attempts + 1, updated_at = now() WHERE id = $1", [post.id]);
      try {
        const { platformPostId } = await adapter.publish(post);
        await client.query(
          "UPDATE sagal.posts SET status = 'confirmed', platform_post_id = $2, confirmed_at = now(), note = $3, updated_at = now() WHERE id = $1",
          [post.id, platformPostId, `${post.platform} confirmed the post.`],
        );
        await notifier?.published(post.title, post.platform);
      } catch (err) {
        const msg = (err as Error).message;
        await client.query("UPDATE sagal.posts SET status = 'failed', error = $2, note = $3, updated_at = now() WHERE id = $1", [
          post.id, msg, `${post.platform} didn't accept it: ${msg}. Nothing was posted. Retry goes to the next agreed slot.`,
        ]);
        await createInboxItem(client, {
          kind: "Publishing failed", title: `“${post.title}” didn't go out on ${post.platform}`, dueLabel: when(post), urgent: true,
          body: `${post.platform} said: ${msg}. Nothing was posted. Retry and I'll try at the next agreed slot, never straight away.`,
          primaryLabel: "Open Publishing", primaryAction: "go:publish", dedupeKey: `post-failed:${post.id}`, ref: { postId: post.id },
        }, notifier);
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return handled;
}

/** One short summary a day at 17:00 Helsinki (includes anything held by quiet hours). */
export async function maybeDailySummary(db: Db, notifier: Notifier, now = new Date()) {
  const s = await getSettings(db);
  const today = helsinkiDate(now);
  if (!s.notifications.daily || helsinkiTime(now) < "17:00" || s.lastDailySummary === today) return;
  const { rows } = await db.query<{ title: string; kind: string }>("SELECT title, kind FROM sagal.inbox_items WHERE resolved_at IS NULL AND NOT sample ORDER BY urgent DESC, id");
  await setSetting(db, "lastDailySummary", today);
  if (!rows.length) return;
  await notifier.send(
    `${rows.length} thing${rows.length === 1 ? "" : "s"} need${rows.length === 1 ? "s" : ""} you`,
    rows.map((r) => `- ${r.kind}: ${r.title}`).join("\n"),
  );
}

export function startWorker(db: Db, notifier: Notifier, pollSeconds: number) {
  let stopped = false;
  let running: Promise<void> | null = null;
  const tick = async () => {
    try {
      await processDuePosts(db, notifier);
      await maybeDailySummary(db, notifier);
    } catch (err) {
      console.error("[sagal] worker tick failed:", (err as Error).message);
    }
  };
  const timer = setInterval(() => {
    if (!stopped && !running) running = tick().finally(() => (running = null));
  }, pollSeconds * 1000);
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
