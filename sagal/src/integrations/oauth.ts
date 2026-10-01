import { createHash, randomBytes } from "node:crypto";
import type { Config } from "../config.js";
import type { Db } from "../db/pool.js";
import type { Vault } from "../secrets/vault.js";
import { setState, type ServiceId } from "./registry.js";

interface Provider {
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  clientParam: "client_id" | "client_key";
  scopeSeparator: string;
  extraAuthParams?: Record<string, string>;
  pkce?: boolean;
}

/**
 * OAuth for the publishing platforms. These scopes match the handoff's integration table.
 * Re-check each platform's docs before going live: endpoints and scope names change.
 */
export const PROVIDERS: Partial<Record<ServiceId, Provider>> = {
  meta: {
    authorizeUrl: "https://www.facebook.com/v23.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v23.0/oauth/access_token",
    scopes: ["pages_show_list", "pages_read_engagement", "pages_manage_posts", "instagram_basic", "instagram_content_publish", "business_management"],
    clientParam: "client_id",
    scopeSeparator: ",",
  },
  linkedin: {
    authorizeUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    scopes: ["openid", "profile", "w_member_social"],
    clientParam: "client_id",
    scopeSeparator: " ",
  },
  youtube: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"],
    clientParam: "client_id",
    scopeSeparator: " ",
    extraAuthParams: { access_type: "offline", prompt: "consent" },
  },
  tiktok: {
    authorizeUrl: "https://www.tiktok.com/v2/auth/authorize/",
    tokenUrl: "https://open.tiktokapis.com/v2/oauth/token/",
    scopes: ["user.info.basic", "video.upload", "video.publish"],
    clientParam: "client_key",
    scopeSeparator: ",",
    pkce: true,
  },
};

export const redirectUri = (cfg: Config, service: string) => `${cfg.APP_URL.replace(/\/$/, "")}/api/oauth/${service}/callback`;

export async function startOAuth(db: Db, cfg: Config, vault: Vault, service: ServiceId): Promise<string> {
  const p = PROVIDERS[service];
  if (!p) throw new Error("This service uses an API key, not OAuth.");
  const clientId = await vault.get(`${service}.client_id`);
  if (!clientId || !(await vault.get(`${service}.client_secret`))) throw new Error("Save the app's client ID and secret first.");
  const state = randomBytes(24).toString("base64url");
  const verifier = p.pkce ? randomBytes(48).toString("base64url") : null;
  await db.query("DELETE FROM sagal.oauth_states WHERE created_at < now() - interval '1 hour'");
  await db.query("INSERT INTO sagal.oauth_states (state, service, code_verifier) VALUES ($1,$2,$3)", [state, service, verifier]);
  const q = new URLSearchParams({
    [p.clientParam]: clientId,
    redirect_uri: redirectUri(cfg, service),
    response_type: "code",
    scope: p.scopes.join(p.scopeSeparator),
    state,
    ...(p.extraAuthParams ?? {}),
    ...(verifier ? { code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" } : {}),
  });
  return `${p.authorizeUrl}?${q}`;
}

/** Exchanges the code for tokens and stores them encrypted. Returns a message for the UI. */
export async function finishOAuth(
  db: Db,
  cfg: Config,
  vault: Vault,
  service: ServiceId,
  params: { code?: string; state?: string; error?: string; error_description?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; message: string }> {
  const p = PROVIDERS[service];
  if (!p) return { ok: false, message: "Unknown service." };
  const { rows } = await db.query<{ code_verifier: string | null }>(
    "DELETE FROM sagal.oauth_states WHERE state = $1 AND service = $2 AND created_at > now() - interval '1 hour' RETURNING code_verifier",
    [params.state ?? "", service],
  );
  if (!rows[0]) return { ok: false, message: "That sign-in link expired or didn't come from this app. Press Connect again." };
  if (params.error || !params.code) {
    await setState(db, service, "needs_reconnect", { error: params.error_description ?? params.error ?? "No code returned" });
    return { ok: false, message: `The platform said no: ${params.error_description ?? params.error ?? "no code returned"}.` };
  }
  const body = new URLSearchParams({
    [p.clientParam]: (await vault.get(`${service}.client_id`)) ?? "",
    client_secret: (await vault.get(`${service}.client_secret`)) ?? "",
    code: params.code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri(cfg, service),
    ...(rows[0].code_verifier ? { code_verifier: rows[0].code_verifier } : {}),
  });
  try {
    const res = await fetchImpl(p.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
      signal: AbortSignal.timeout(20000),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof json.access_token !== "string") throw new Error(`HTTP ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
    await vault.set(`${service}.access_token`, json.access_token);
    if (typeof json.refresh_token === "string") await vault.set(`${service}.refresh_token`, json.refresh_token);
    if (typeof json.expires_in === "number") await vault.set(`${service}.expires_at`, new Date(Date.now() + json.expires_in * 1000).toISOString());
    await setState(db, service, "connected", { account: "Connected account" });
    return { ok: true, message: "Connected." };
  } catch (err) {
    await setState(db, service, "needs_reconnect", { error: (err as Error).message });
    return { ok: false, message: `Couldn't finish connecting: ${(err as Error).message}` };
  }
}
