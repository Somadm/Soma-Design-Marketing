import type { Vault } from "../secrets/vault.js";

/**
 * Instagram (professional account) and Facebook Page publishing through Meta's Graph API.
 * Connecting swaps Facebook's short-lived sign-in for a long-lived one, then keeps the
 * Page's own token (which doesn't expire) and the linked Instagram account.
 */

export const GRAPH = "https://graph.facebook.com/v23.0";

export class MetaError extends Error {
  constructor(
    message: string,
    public code?: number,
  ) {
    super(message);
  }
}

type Fetch = typeof fetch;

/** One Graph API call. Errors come back in Meta's own words. */
export async function graph<T = Record<string, unknown>>(
  f: Fetch,
  method: "GET" | "POST",
  path: string,
  params: Record<string, string>,
  timeoutMs = 30_000,
): Promise<T> {
  const body = new URLSearchParams(params);
  const url = method === "GET" ? `${GRAPH}/${path}?${body}` : `${GRAPH}/${path}`;
  const res = await f(url, {
    method,
    headers: method === "POST" ? { "content-type": "application/x-www-form-urlencoded", accept: "application/json" } : { accept: "application/json" },
    body: method === "POST" ? body : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: number; error_user_msg?: string } } & Record<string, unknown>;
  if (!res.ok || json.error) {
    const e = json.error ?? {};
    throw new MetaError(e.error_user_msg || e.message || `Meta answered with an error (${res.status}).`, e.code);
  }
  return json as T;
}

export interface MetaAccount {
  pageId: string;
  pageName: string;
  igUserId: string | null;
  igUsername: string | null;
}

interface PageRow {
  id: string;
  name: string;
  access_token: string;
  instagram_business_account?: { id: string; username?: string };
}

/** After Facebook sign-in: long-lived token, then the Page (preferring one linked to Instagram). */
export async function connectMeta(f: Fetch, vault: Vault, shortToken: string): Promise<MetaAccount> {
  const clientId = (await vault.get("meta.client_id")) ?? "";
  const clientSecret = (await vault.get("meta.client_secret")) ?? "";
  const long = await graph<{ access_token: string }>(f, "GET", "oauth/access_token", {
    grant_type: "fb_exchange_token",
    client_id: clientId,
    client_secret: clientSecret,
    fb_exchange_token: shortToken,
  });
  const pages = await graph<{ data: PageRow[] }>(f, "GET", "me/accounts", {
    fields: "id,name,access_token,instagram_business_account{id,username}",
    access_token: long.access_token,
  });
  if (!pages.data?.length) {
    throw new MetaError("Facebook didn't share any Page with Sagal. Press Connect again and tick your Soma Page (and its Instagram account).");
  }
  const page = pages.data.find((p) => p.instagram_business_account) ?? pages.data[0];
  await vault.set("meta.access_token", long.access_token);
  await vault.set("meta.page_token", page.access_token);
  await vault.set("meta.page_id", page.id);
  await vault.set("meta.page_name", page.name);
  if (page.instagram_business_account) {
    await vault.set("meta.ig_user_id", page.instagram_business_account.id);
    await vault.set("meta.ig_username", page.instagram_business_account.username ?? "");
  } else {
    await vault.delete("meta.ig_user_id");
    await vault.delete("meta.ig_username");
  }
  return {
    pageId: page.id,
    pageName: page.name,
    igUserId: page.instagram_business_account?.id ?? null,
    igUsername: page.instagram_business_account?.username ?? null,
  };
}

export const accountLabel = (a: Pick<MetaAccount, "pageName" | "igUsername">) =>
  `Facebook: ${a.pageName}${a.igUsername ? ` · Instagram: @${a.igUsername}` : " · no Instagram account linked to this Page"}`;

export async function metaAccount(vault: Vault) {
  const pageToken = await vault.get("meta.page_token");
  const pageId = await vault.get("meta.page_id");
  if (!pageToken || !pageId) return null;
  return { pageToken, pageId, igUserId: await vault.get("meta.ig_user_id"), pageName: (await vault.get("meta.page_name")) ?? "" };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Instagram prepares each upload before it can be published; wait until it's ready. */
async function waitReady(f: Fetch, id: string, token: string, wait: (ms: number) => Promise<void>, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const s = await graph<{ status_code?: string; status?: string }>(f, "GET", id, { fields: "status_code,status", access_token: token });
    if (s.status_code === "FINISHED" || s.status_code === "PUBLISHED") return;
    if (s.status_code === "ERROR" || s.status_code === "EXPIRED") throw new MetaError(`Instagram couldn't use the picture (${s.status ?? s.status_code}).`);
    await wait(3000);
  }
  throw new MetaError("Instagram took too long to prepare the post.");
}

/** Feed post: one picture, or a carousel of up to 10. Returns the media id and its link. */
export async function publishInstagram(
  f: Fetch,
  acct: { igUserId: string; pageToken: string },
  imageUrls: string[],
  caption: string,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<{ id: string; permalink: string | null }> {
  const token = acct.pageToken;
  if (!imageUrls.length) throw new MetaError("There's no picture to post.");
  let creation: string;
  if (imageUrls.length === 1) {
    creation = (await graph<{ id: string }>(f, "POST", `${acct.igUserId}/media`, { image_url: imageUrls[0], caption, access_token: token })).id;
  } else {
    const children: string[] = [];
    for (const url of imageUrls.slice(0, 10)) {
      children.push((await graph<{ id: string }>(f, "POST", `${acct.igUserId}/media`, { image_url: url, is_carousel_item: "true", access_token: token })).id);
    }
    for (const c of children) await waitReady(f, c, token, wait);
    creation = (await graph<{ id: string }>(f, "POST", `${acct.igUserId}/media`, { media_type: "CAROUSEL", children: children.join(","), caption, access_token: token })).id;
  }
  await waitReady(f, creation, token, wait);
  const published = await graph<{ id: string }>(f, "POST", `${acct.igUserId}/media_publish`, { creation_id: creation, access_token: token }, 60_000);
  let permalink: string | null = null;
  try {
    permalink = (await graph<{ permalink?: string }>(f, "GET", published.id, { fields: "permalink", access_token: token })).permalink ?? null;
  } catch {
    // The post is up; the link is a nicety.
  }
  return { id: published.id, permalink };
}

/** Page post: one photo, or several photos in one post. */
export async function publishFacebook(
  f: Fetch,
  acct: { pageId: string; pageToken: string },
  imageUrls: string[],
  message: string,
): Promise<{ id: string; permalink: string | null }> {
  const token = acct.pageToken;
  if (!imageUrls.length) throw new MetaError("There's no picture to post.");
  if (imageUrls.length === 1) {
    const r = await graph<{ id: string; post_id?: string }>(f, "POST", `${acct.pageId}/photos`, { url: imageUrls[0], message, published: "true", access_token: token }, 60_000);
    const id = r.post_id ?? r.id;
    return { id, permalink: `https://www.facebook.com/${id}` };
  }
  const media: string[] = [];
  for (const url of imageUrls.slice(0, 10)) {
    media.push((await graph<{ id: string }>(f, "POST", `${acct.pageId}/photos`, { url, published: "false", access_token: token }, 60_000)).id);
  }
  const r = await graph<{ id: string }>(f, "POST", `${acct.pageId}/feed`, {
    message,
    attached_media: JSON.stringify(media.map((id) => ({ media_fbid: id }))),
    access_token: token,
  });
  return { id: r.id, permalink: `https://www.facebook.com/${r.id}` };
}
