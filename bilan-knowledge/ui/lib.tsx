import { useEffect, useRef, useState } from "react";
import type { Platform } from "./api";

export const PLATFORM_LABEL: Record<Platform, string> = { meta: "Meta", tiktok: "TikTok" };
export const PLATFORMS: Platform[] = ["meta", "tiktok"];

export const fmtDate = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—";
export const fmtTime = (d: string | null | undefined) => (d ? new Date(d).toISOString().slice(11, 16) : "");
export const money = (n: number | null | undefined) => `$${Number(n ?? 0).toFixed(2)}`;

export function duration(a: string | null, b: string | null): string {
  if (!a || !b) return "—";
  const s = Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export const SOURCE_TYPE: Record<string, string> = { policy: "Policy", help_centre: "Help Centre", api_docs: "API docs", announcements: "Announcements" };
export const CATEGORY: Record<string, string> = {
  policy: "Policy",
  feature_availability: "Feature availability",
  setup_steps: "Setup steps",
  specifications: "Specifications",
  measurement: "Measurement",
  announcement: "Announcement",
  other: "Other",
};

/** Result/status → tone (from the prototype's RT map). */
const TONE: Record<string, string> = {
  Changed: "info", New: "info", Indexed: "ok", Unchanged: "neutral", Discontinued: "warn", Failed: "fail", Skipped: "fail",
  "Not checked": "neutral", Paused: "neutral", Complete: "ok", Incomplete: "fail", Running: "info", Queued: "info",
  "Verified current": "ok", Archived: "warn", Current: "ok", "Not verified": "fail", "Source discontinued": "warn",
};
export const toneOf = (label: string) => TONE[label] ?? (label.startsWith("Saved") ? "info" : "neutral");

export function Badge({ label }: { label: string }) {
  const t = toneOf(label);
  return <span className={`badge tone-${t} bg-${t}`}>{label}</span>;
}

export function PDot({ p }: { p: Platform }) {
  return <span className="pdot" style={{ background: p === "meta" ? "var(--meta)" : "var(--tiktok)" }} />;
}

export function PName({ p, extra }: { p: Platform; extra?: string }) {
  return (
    <span className="pname">
      <PDot p={p} />
      {PLATFORM_LABEL[p]}
      {extra ? <span className="muted small" style={{ fontWeight: 400 }}>{extra}</span> : null}
    </span>
  );
}

/** Run-source result → UI label. */
export function resultLabel(result: string | null, trigger?: string): string {
  if (!result) return "Not checked";
  if (result === "new" && trigger === "initial") return "Indexed";
  return { unchanged: "Unchanged", cosmetic: "Unchanged", changed: "Changed", new: "New", discontinued: "Discontinued", failed: "Failed", skipped: "Failed", pending: "Not checked" }[result] ?? result;
}

/** Sentence-level diff: removed sentences (−) and added sentences (+); shared ones omitted. */
export function Diff({ old: a, new: b }: { old: string; new: string }) {
  const split = (s: string) => s.match(/[^.!?]+[.!?]*/g)?.map((x) => x.trim()).filter(Boolean) ?? [s];
  const A = split(a);
  const B = split(b);
  const removed = A.filter((x) => !B.includes(x));
  const added = B.filter((x) => !A.includes(x));
  return (
    <>
      {(removed.length ? removed : [a]).map((l, i) => <div key={`d${i}`} className="diff-line del">{l}</div>)}
      {(added.length ? added : [b]).map((l, i) => <div key={`a${i}`} className="diff-line add">{l}</div>)}
    </>
  );
}

/** Loads data and reloads when `deps` change or `reloadKey` bumps. */
export function useData<T>(load: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    load()
      .then((d) => live.current && (setData(d), setError(null)))
      .catch((e: Error) => live.current && setError(e.message));
    return () => {
      live.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { data, error, reload: () => setN((x) => x + 1) };
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="card empty">{children}</div>;
}
