import type { DbClient } from "../db/pool.js";

export const CHANNELS = ["Instagram", "Facebook", "TikTok", "YouTube Shorts", "LinkedIn"] as const;
export type Channel = (typeof CHANNELS)[number];

export interface Authorisation {
  id: number;
  mode: "plan" | "review";
  channels: string[];
  scope: string;
  spend_limit_eur: number;
  paused: boolean;
  granted_by: string;
  granted_at: Date;
}

export async function currentAuthorisation(db: DbClient): Promise<Authorisation> {
  const { rows } = await db.query<Authorisation>("SELECT * FROM sagal.authorisations ORDER BY id DESC LIMIT 1");
  if (!rows[0]) throw new Error("No publishing authorisation on record");
  return rows[0];
}

/** Every change Sabah makes is a new record (who, when, what), never an edit. */
export async function grantAuthorisation(
  db: DbClient,
  change: Partial<Pick<Authorisation, "mode" | "channels" | "spend_limit_eur" | "paused">>,
  note: string,
): Promise<Authorisation> {
  const cur = await currentAuthorisation(db);
  const next = { ...cur, ...change };
  next.channels = [...new Set(next.channels)].filter((c) => (CHANNELS as readonly string[]).includes(c));
  const { rows } = await db.query<Authorisation>(
    `INSERT INTO sagal.authorisations (mode, channels, scope, spend_limit_eur, paused, granted_by, note)
     VALUES ($1, $2, $3, $4, $5, 'sabah', $6) RETURNING *`,
    [next.mode, next.channels, cur.scope, next.spend_limit_eur, next.paused, note],
  );
  return rows[0];
}

export type Decision = { allowed: true; authorisation: Authorisation } | { allowed: false; reason: string; code: string; authorisation: Authorisation };

export interface PublishCandidate {
  id: number;
  platform: string;
  idea_id: number | null;
  approved_at: Date | null;
  held_by_sabah: boolean;
  sample: boolean;
}

async function record(db: DbClient, action: string, subject: string, d: Decision) {
  await db.query(
    "INSERT INTO sagal.permission_checks (action, subject, allowed, reason, authorisation_id) VALUES ($1,$2,$3,$4,$5)",
    [action, subject, d.allowed, d.allowed ? "allowed" : d.reason, d.authorisation.id],
  );
}

/**
 * The server-side check that runs before ANY publish. It reads the authorisation in
 * force at that moment, never a cached copy, and records its decision.
 */
export async function checkPublish(db: DbClient, post: PublishCandidate): Promise<Decision> {
  const a = await currentAuthorisation(db);
  const deny = (code: string, reason: string): Decision => ({ allowed: false, code, reason, authorisation: a });
  let d: Decision;
  if (post.sample) d = deny("sample", "Sample content is never published.");
  else if (a.paused) d = deny("paused", "All publishing is paused.");
  else if (post.held_by_sabah) d = deny("held", "Sabah is holding this post.");
  else if (!a.channels.includes(post.platform)) d = deny("channel", `${post.platform} isn't an authorised channel.`);
  else if (!(await inAgreedPlan(db, post.idea_id))) d = deny("scope", "This post isn't in the agreed plan, so it comes back to Sabah.");
  else if (a.mode === "review" && !post.approved_at) d = deny("approval", "Review mode: Sabah hasn't approved this post yet.");
  else d = { allowed: true, authorisation: a };
  await record(db, "publish", `post:${post.id}`, d);
  return d;
}

async function inAgreedPlan(db: DbClient, ideaId: number | null): Promise<boolean> {
  if (ideaId == null) return false;
  const { rowCount } = await db.query("SELECT 1 FROM sagal.ideas WHERE id = $1 AND status = 'agreed'", [ideaId]);
  return Boolean(rowCount);
}

/** Calendar-month production spend so far (Helsinki month boundaries are close enough to UTC here). */
export async function spentThisMonth(db: DbClient): Promise<number> {
  const { rows } = await db.query<{ total: number }>(
    "SELECT COALESCE(sum(amount_eur), 0)::numeric AS total FROM sagal.spend_ledger WHERE created_at >= date_trunc('month', now())",
  );
  return Number(rows[0].total);
}

/**
 * Checks and records production spend (HeyGen minutes, stock, tools). Anything that
 * would go over the monthly limit is refused and must come back to Sabah.
 */
export async function authoriseSpend(db: DbClient, service: string, purpose: string, amountEur: number): Promise<Decision> {
  const a = await currentAuthorisation(db);
  const spent = await spentThisMonth(db);
  let d: Decision;
  if (!(amountEur >= 0)) d = { allowed: false, code: "invalid", reason: "Invalid amount.", authorisation: a };
  else if (spent + amountEur > a.spend_limit_eur) {
    d = {
      allowed: false,
      code: "limit",
      reason: `€${amountEur.toFixed(2)} would take this month to €${(spent + amountEur).toFixed(2)}, over the €${a.spend_limit_eur} limit.`,
      authorisation: a,
    };
  } else {
    d = { allowed: true, authorisation: a };
    await db.query("INSERT INTO sagal.spend_ledger (service, purpose, amount_eur) VALUES ($1,$2,$3)", [service, purpose, amountEur]);
  }
  await record(db, "spend", `${service}:${purpose}`, d);
  return d;
}
