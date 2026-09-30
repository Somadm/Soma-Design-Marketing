export type Platform = "meta" | "tiktok";
export type Tone = "ok" | "warn" | "fail" | "info";

export interface StatusView {
  now: string;
  headline: { tone: Tone; title: string; detail: string };
  lastSuccess: { at: string; code: string; triggerLabel: string } | null;
  next: { at: string | null; sub: string; overdue: boolean };
  latestRun: { code: string; status: string; checked: number; failed: number; total: number; spend: number; budget: number } | null;
  active: { code: string; trigger: string; stage: string | null; done: number; total: number; budget: number; lastLine: string | null } | null;
  activation: { label: string; detail: string; done: boolean }[];
  activationComplete: boolean;
  updateLabel: string;
  researchConfigured: boolean;
  worker: { seenAt: string | null; alive: boolean };
}

export interface BriefingItem {
  ref: string;
  kind: "New" | "Changed" | "Archived";
  title: string;
  what: string;
  means: string;
  scope: string | null;
  entry_id: number | null;
}

export interface BriefingView {
  id: number;
  runCode: string;
  kind: string;
  date: string;
  partial: boolean;
  summary: string;
  sections: { platform: Platform; items: BriefingItem[] }[];
  unverified: { platform: Platform; title: string; url: string; reason: string }[];
  pending: { platform: Platform; kind: string; title: string; what: string | null }[];
  recommendations: { id: number; text: string; status: "proposed" | "added_to_plan" | "dismissed" }[];
}

export interface SourceRowView {
  id: number;
  platform: Platform;
  title: string;
  url: string;
  display_url: string;
  source_type: "policy" | "help_centre" | "api_docs" | "announcements";
  status: "active" | "paused" | "discontinued";
  fetch_mode: "direct" | "rendered";
  consecutive_failures: number;
  escalated_at: string | null;
  last_verified_at: string | null;
  result: string | null;
  attempts: number | null;
  note: string | null;
  failure_reason: string | null;
  checked_at: string | null;
}

export interface RunListItem {
  code: string;
  trigger: string;
  kind: string;
  status: string;
  result: string;
  question: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  sources_total: number;
  sources_verified: number;
  sources_failed: number;
  spend_usd: number;
  budget_usd: number;
}

export interface RunDetail {
  run: RunListItem & {
    note: string | null;
    error: string | null;
    incomplete_reason: string | null;
    counts: Record<string, number>;
    liveSource: { title: string; platform: Platform; url: string } | null;
  };
  failures: { title: string; platform: Platform; reason: string }[];
  changes: { id: number; kind: "new" | "changed" | "archived"; title: string; platform: Platform; entry_id: number; version: string; old: string | null; new: string | null; hasDiff: boolean; what_changed: string | null }[];
  briefingId: number | null;
}

export interface EntryListItem {
  entry_id: number;
  title: string;
  category: string;
  version: number;
  verified_at: string;
  status: string;
}

export interface EntryDetail {
  entry: {
    id: number;
    platform: Platform;
    title: string;
    category: string;
    source_url: string;
    source_display: string;
    source_type: string;
    source_status: string;
    status: "current" | "archived";
    version: number;
    summary: string;
    body: string;
    relevance: string | null;
    limitations: { kind: string; text: string }[];
    verified_at: string;
    verified_by: string;
    archived_reason: string | null;
    unverified: boolean;
    unverified_reason: string | null;
  };
  latestChange: { what_changed: string | null; old: string | null; new: string | null; run_code: string } | null;
  versions: { version: number; date: string; status: string; note: string }[];
}

export interface Settings {
  interval_days: number;
  run_window_utc: string;
  run_window_hours: number;
  retries: number;
  backoff_minutes: number[];
  budget_refresh_usd: number;
  budget_initial_usd: number;
  budget_live_month_usd: number;
  on_limit: "stop" | "finish";
  alert_email: string | null;
  campaign_profile: string;
}

const TOKEN_KEY = "bilan.token";

export function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function writeToken(v: string | null) {
  try {
    if (v) localStorage.setItem(TOKEN_KEY, v);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {}
}

export class Unauthorized extends Error {}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${readToken() ?? ""}`, ...(init.body ? { "content-type": "application/json" } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  if (res.status === 401) throw new Unauthorized("unauthorized");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}
