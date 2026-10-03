import type { DbClient } from "../db/pool.js";
import type { Vault } from "../secrets/vault.js";

export type ServiceId = "anthropic" | "email" | "heygen" | "captions" | "meta" | "linkedin" | "youtube" | "tiktok";

export interface CredentialField {
  key: string;
  label: string;
  help: string;
  secret: boolean;
  optional?: boolean;
}

export interface ServiceDef {
  id: ServiceId;
  name: string;
  what: string;
  /** Plain-language steps Sabah follows when she sets it up. */
  steps: string[];
  gate?: string;
  fields: CredentialField[];
  oauth?: boolean;
  /** Platforms this service publishes to. */
  channels?: string[];
}

export const SERVICES: ServiceDef[] = [
  {
    id: "anthropic",
    name: "Claude (Sagal's thinking)",
    what: "Sagal reasons, writes and remembers with Claude. Without it she can't reply yet.",
    steps: ["Go to console.anthropic.com and sign in.", "Open API keys and create a key named “Sagal”.", "Add a little credit under Billing.", "Paste the key here."],
    fields: [{ key: "api_key", label: "API key", help: "Starts with sk-ant-", secret: true }],
  },
  {
    id: "email",
    name: "Email (Resend)",
    what: "Sends your sign-in codes and Needs Sabah alerts. Until it's set up, codes appear in the server log.",
    steps: ["Create a free account at resend.com.", "Add and verify your domain (or use their test sender for now).", "Create an API key and paste it here.", "Set the sender, e.g. Sagal <sagal@yourdomain.com>."],
    fields: [
      { key: "resend_api_key", label: "Resend API key", help: "Starts with re_", secret: true },
      { key: "from", label: "Send from", help: "Sagal <sagal@yourdomain.com>", secret: false, optional: true },
    ],
  },
  {
    id: "heygen",
    name: "HeyGen",
    what: "Makes your avatar video from your own uploaded voiceover and the script. Never Sagal's voice.",
    steps: ["In HeyGen, open Settings → API.", "Top up the API wallet (it's separate from the web plan).", "Copy the API key and paste it here."],
    gate: "Only your uploaded voiceover is ever sent. Until this is connected, Video studio gives you a manual handoff package.",
    fields: [{ key: "api_key", label: "API key", help: "From HeyGen → Settings → API", secret: true }],
  },
  {
    id: "captions",
    name: "Captions (Mirage)",
    what: "Trims the render and adds subtitles. Captioning only: never Mirage's generated voices or avatars.",
    steps: ["In Captions, open the API settings.", "Create an API key and paste it here."],
    fields: [{ key: "api_key", label: "API key", help: "Sent as x-api-key", secret: true }],
  },
  {
    id: "meta",
    name: "Instagram + Facebook Page",
    what: "Posts approved in your plan go out on their own, with their finished design and caption, to your Instagram professional account and Facebook Page. Videos are still handed to you for now.",
    steps: [
      "Make sure Instagram is a Business or Creator account linked to your Facebook Page.",
      "At developers.facebook.com create an app (type: Business).",
      "Add Instagram and Facebook Login products. Give yourself the developer or tester role.",
      "Add the redirect URL shown below, then paste the App ID and App secret here.",
      "Press Connect and approve the permissions.",
    ],
    gate: "Your own accounts work with a developer or tester role. App Review is only needed for accounts you don't own.",
    fields: [
      { key: "client_id", label: "App ID", help: "From the app dashboard", secret: false },
      { key: "client_secret", label: "App secret", help: "App settings → Basic", secret: true },
    ],
    oauth: true,
    channels: ["Instagram", "Facebook"],
  },
  {
    id: "linkedin",
    name: "LinkedIn (personal profile)",
    what: "Posts as you. Carousels go out as PDF document posts.",
    steps: [
      "At linkedin.com/developers create an app and associate it with a LinkedIn Page.",
      "Add a privacy policy URL and request “Share on LinkedIn” and “Sign In with LinkedIn using OpenID Connect”.",
      "Add the redirect URL shown below, then paste the Client ID and secret here.",
      "Press Connect.",
    ],
    gate: "No review needed to post as yourself. Company-page posting needs LinkedIn partner approval (weeks to months).",
    fields: [
      { key: "client_id", label: "Client ID", help: "Auth tab", secret: false },
      { key: "client_secret", label: "Client secret", help: "Auth tab", secret: true },
    ],
    oauth: true,
    channels: ["LinkedIn"],
  },
  {
    id: "youtube",
    name: "YouTube Shorts",
    what: "Uploads vertical videos under 60 seconds with #Shorts.",
    steps: [
      "At console.cloud.google.com create a project and enable “YouTube Data API v3”.",
      "Set up the OAuth consent screen and add yourself as a test user.",
      "Create an OAuth client (Web application) with the redirect URL shown below.",
      "Paste the Client ID and secret here, then press Connect.",
    ],
    gate: "Until Google's compliance audit passes, uploads land as private. Default limit: about 100 uploads a day.",
    fields: [
      { key: "client_id", label: "Client ID", help: "Ends with .apps.googleusercontent.com", secret: false },
      { key: "client_secret", label: "Client secret", help: "From the OAuth client", secret: true },
    ],
    oauth: true,
    channels: ["YouTube Shorts"],
  },
  {
    id: "tiktok",
    name: "TikTok",
    what: "Posts videos and photo carousels.",
    steps: [
      "At developers.tiktok.com create an app and add Login Kit and Content Posting API.",
      "Request the video.publish and video.upload scopes.",
      "Add the redirect URL shown below, then paste the Client key and secret here.",
      "Press Connect.",
    ],
    gate: "Unaudited apps can only post privately. Sagal uploads as drafts until TikTok's audit passes.",
    fields: [
      { key: "client_id", label: "Client key", help: "From the app page", secret: false },
      { key: "client_secret", label: "Client secret", help: "From the app page", secret: true },
    ],
    oauth: true,
    channels: ["TikTok"],
  },
];

export const serviceDef = (id: string) => SERVICES.find((s) => s.id === id);

export type ConnState = "not_connected" | "credentials_saved" | "connected" | "needs_reconnect";

export interface IntegrationRow {
  service: ServiceId;
  state: ConnState;
  account_label: string | null;
  connected_at: Date | null;
  last_error: string | null;
}

export async function integrationStates(db: DbClient): Promise<Record<string, IntegrationRow>> {
  const { rows } = await db.query<IntegrationRow>("SELECT service, state, account_label, connected_at, last_error FROM sagal.integrations");
  return Object.fromEntries(rows.map((r) => [r.service, r]));
}

export async function setState(db: DbClient, service: string, state: ConnState, extra: { account?: string | null; error?: string | null } = {}) {
  await db.query(
    `UPDATE sagal.integrations SET state = $2, account_label = COALESCE($3, account_label),
       last_error = $4, connected_at = CASE WHEN $2 = 'connected' THEN now() ELSE connected_at END, updated_at = now()
     WHERE service = $1`,
    [service, state, extra.account ?? null, extra.error ?? null],
  );
}

/** Saves pasted credentials (secret ones encrypted) and moves the service to "credentials saved". */
export async function saveCredentials(db: DbClient, vault: Vault, service: ServiceDef, values: Record<string, string>) {
  for (const f of service.fields) {
    const v = values[f.key]?.trim();
    if (v) await vault.set(`${service.id}.${f.key}`, v);
    else if (!f.optional && !(await vault.get(`${service.id}.${f.key}`))) throw new Error(`${f.label} is required.`);
  }
  const rows = await integrationStates(db);
  // Keys for API-key services are saved but not verified against the service yet: phase 1
  // connects nothing. OAuth services become "connected" only after the OAuth flow succeeds.
  if (rows[service.id]?.state !== "connected") await setState(db, service.id, "credentials_saved");
}

export async function disconnect(db: DbClient, vault: Vault, service: ServiceId) {
  await vault.deletePrefix(`${service}.`);
  await db.query("UPDATE sagal.integrations SET state = 'not_connected', account_label = NULL, connected_at = NULL, last_error = NULL, updated_at = now() WHERE service = $1", [service]);
}

/** The service that publishes to a channel, and whether it's actually connected. */
export function serviceForChannel(channel: string): ServiceDef | undefined {
  return SERVICES.find((s) => s.channels?.includes(channel));
}
