import { randomBytes } from "node:crypto";
import type { DbClient } from "../db/pool.js";
import { getCarousel } from "../domain/carousels.js";
import type { Post } from "../domain/posts.js";
import { metaAccount, publishFacebook, publishInstagram } from "../integrations/meta.js";
import type { Vault } from "../secrets/vault.js";
import type { Storages } from "../storage/storage.js";
import { renderSlidesJpeg } from "./render.js";

/** What an adapter needs to post: the database, private storage, saved tokens. */
export interface PublishContext {
  db: DbClient;
  storages: Storages;
  vault: Vault;
  /** Makes local-disk links absolute (cloud storage links already are). */
  appUrl?: string;
  fetchImpl?: typeof fetch;
  /** Tests skip Instagram's processing waits. */
  wait?: (ms: number) => Promise<void>;
}

export interface PublishAdapter {
  publish(post: Post, ctx: PublishContext): Promise<{ platformPostId: string; permalink?: string | null }>;
}

/** Can't be posted automatically (yet): goes to Sabah as a by-hand handoff, not a failure. */
export class ManualOnly extends Error {}

/**
 * The finished design as JPEGs at Instagram/Facebook feed size (4:5), uploaded to
 * private storage with links that work for one hour, long enough for Meta to fetch them.
 */
async function finishedImages(post: Post, ctx: PublishContext) {
  if (post.kind === "video") throw new ManualOnly("automatic video posting isn't built yet");
  if (!post.carousel_id) throw new ManualOnly("this post has no finished design attached");
  const c = await getCarousel(ctx.db, post.carousel_id);
  if (!c || !c.slides.length) throw new ManualOnly("its design is missing");
  const jpegs = await renderSlidesJpeg(ctx.db, ctx.storages, c.slides.slice(0, 10), "4:5");
  const batch = randomBytes(6).toString("hex");
  const keys: string[] = [];
  const urls: string[] = [];
  for (let i = 0; i < jpegs.length; i++) {
    const key = `renders/post-${post.id}-${batch}-${i + 1}.jpg`;
    await ctx.storages.media.put(key, jpegs[i], "image/jpeg");
    keys.push(key);
    urls.push(new URL(await ctx.storages.media.signedUrl(key, `slide-${i + 1}.jpg`, 3600), ctx.appUrl ?? "http://localhost").toString());
  }
  const caption = post.caption?.trim() || (c.captions?.[post.platform] ?? "").trim();
  const cleanup = async () => {
    for (const k of keys) await ctx.storages.media.delete(k).catch(() => {});
  };
  return { urls, caption, cleanup };
}

const instagram: PublishAdapter = {
  async publish(post, ctx) {
    const acct = await metaAccount(ctx.vault);
    if (!acct) throw new ManualOnly("Instagram needs connecting again (press Connect in Connected accounts)");
    if (!acct.igUserId) throw new ManualOnly("no Instagram account is linked to your Facebook Page");
    const img = await finishedImages(post, ctx);
    try {
      const r = await publishInstagram(ctx.fetchImpl ?? fetch, { igUserId: acct.igUserId, pageToken: acct.pageToken }, img.urls, img.caption.slice(0, 2200), ctx.wait);
      return { platformPostId: r.id, permalink: r.permalink };
    } finally {
      await img.cleanup();
    }
  },
};

const facebook: PublishAdapter = {
  async publish(post, ctx) {
    const acct = await metaAccount(ctx.vault);
    if (!acct) throw new ManualOnly("Facebook needs connecting again (press Connect in Connected accounts)");
    const img = await finishedImages(post, ctx);
    try {
      const r = await publishFacebook(ctx.fetchImpl ?? fetch, { pageId: acct.pageId, pageToken: acct.pageToken }, img.urls, img.caption);
      return { platformPostId: r.id, permalink: r.permalink };
    } finally {
      await img.cleanup();
    }
  },
};

/** Built-in adapters by platform. */
export const BUILT_IN: Partial<Record<string, PublishAdapter>> = { Instagram: instagram, Facebook: facebook };
