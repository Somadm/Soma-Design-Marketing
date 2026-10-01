import type { DbClient } from "../db/pool.js";
import type { Notifier } from "./notify.js";

export type InboxKind =
  | "Missing audio" | "Decision" | "Outside the plan" | "Production problem"
  | "Publishing failed" | "Approval needed" | "Reconnect needed" | "Spend limit";

export interface NewInboxItem {
  kind: InboxKind;
  title: string;
  body: string;
  primaryLabel: string;
  primaryAction?: string;
  secondaryLabel?: string;
  secondaryAction?: string;
  dueLabel?: string;
  urgent?: boolean;
  ref?: Record<string, unknown>;
  /** Same key → same item: repeated problems don't pile up. */
  dedupeKey?: string;
  createdBy?: string;
  sample?: boolean;
}

export async function createInboxItem(db: DbClient, item: NewInboxItem, notifier?: Notifier) {
  const { rows } = await db.query<{ id: number; inserted: boolean }>(
    `INSERT INTO sagal.inbox_items (kind, due_label, title, body, primary_label, primary_action, secondary_label, secondary_action,
       urgent, ref, dedupe_key, created_by, sample)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (dedupe_key) DO UPDATE SET body = EXCLUDED.body, resolution = NULL, resolved_at = NULL
       WHERE sagal.inbox_items.resolved_at IS NOT NULL OR sagal.inbox_items.body <> EXCLUDED.body
     RETURNING id, (xmax = 0) AS inserted`,
    [
      item.kind, item.dueLabel ?? "", item.title, item.body, item.primaryLabel, item.primaryAction ?? "resolve",
      item.secondaryLabel ?? null, item.secondaryAction ?? (item.secondaryLabel ? "resolve" : null),
      item.urgent ?? false, JSON.stringify(item.ref ?? {}), item.dedupeKey ?? null, item.createdBy ?? "sagal", item.sample ?? false,
    ],
  );
  const row = rows[0];
  if (row?.inserted && notifier && !item.sample) await notifier.inboxItem({ id: row.id, kind: item.kind, title: item.title, body: item.body, urgent: item.urgent ?? false });
  return row?.id ?? null;
}

export async function resolveByKey(db: DbClient, dedupeKey: string, resolution: string) {
  await db.query("UPDATE sagal.inbox_items SET resolution = $2, resolved_at = now() WHERE dedupe_key = $1 AND resolved_at IS NULL", [dedupeKey, resolution]);
}

export async function listInbox(db: DbClient) {
  const open = await db.query("SELECT * FROM sagal.inbox_items WHERE resolved_at IS NULL ORDER BY urgent DESC, id");
  const handled = await db.query("SELECT * FROM sagal.inbox_items WHERE resolved_at IS NOT NULL ORDER BY resolved_at DESC LIMIT 20");
  return { open: open.rows, handled: handled.rows };
}
