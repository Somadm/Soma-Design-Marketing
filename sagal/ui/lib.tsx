import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { api } from "./api";

// ───── Router (History API) ─────
type Nav = { path: string; go: (to: string) => void };
export const RouterCtx = createContext<Nav>({ path: "/", go: () => {} });
export const useRouter = () => useContext(RouterCtx);

export function useRouterState(): Nav {
  const [path, setPath] = useState(location.pathname + location.search);
  useEffect(() => {
    const on = () => setPath(location.pathname + location.search);
    addEventListener("popstate", on);
    return () => removeEventListener("popstate", on);
  }, []);
  const go = useCallback((to: string) => {
    if (to !== location.pathname + location.search) history.pushState(null, "", to);
    setPath(to);
  }, []);
  return { path, go };
}

// ───── App-wide state shared between screens ─────
export interface Ctx {
  /** A context chip for the Talk composer ("Discussing Slide 3 · The question"). */
  discuss: (c: { type: string; id?: number | string; label: string }) => void;
  pending: { type: string; id?: number | string; label: string } | null;
  clearPending: () => void;
  overview: { inboxCount: number; sample: boolean; email: string | null; portraitUrl: string | null } | null;
  refreshOverview: () => void;
  toast: (msg: string, err?: boolean) => void;
  vw: number;
}
export const AppCtx = createContext<Ctx>(null as unknown as Ctx);
export const useApp = () => useContext(AppCtx);

export function useViewport() {
  const [vw, setVw] = useState(innerWidth);
  useEffect(() => {
    const on = () => setVw(innerWidth);
    addEventListener("resize", on);
    return () => removeEventListener("resize", on);
  }, []);
  return vw;
}

/** Load data from the API; `reload` refetches; errors shown inline. */
export function useLoad<T>(url: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    if (!url) return;
    const n = ++seq.current;
    try {
      const d = await api.get<T>(url);
      if (n === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (n === seq.current) setError((e as Error).message);
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [url]);
  useEffect(() => {
    setLoading(true);
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload, ...deps]);
  return { data, error, loading, reload, setData };
}

/** Run an action, report errors with a toast, then refresh. */
export function useAction() {
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async <T,>(fn: () => Promise<T>, done?: string): Promise<T | undefined> => {
      setBusy(true);
      try {
        const r = await fn();
        if (done) toast(done);
        return r;
      } catch (e) {
        toast((e as Error).message, true);
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );
  return { run, busy };
}

// ───── Time (always Europe/Helsinki) ─────
export const TZ = "Europe/Helsinki";
const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, ...o });
export const hhmm = (d: string | Date) => fmt({ hour: "2-digit", minute: "2-digit" }).format(new Date(d));
export const dayDate = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short" }).format(new Date(Date.UTC(y, m - 1, d)));
};
export const weekday = (iso: string, long = false) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: long ? "long" : "short" }).format(new Date(Date.UTC(y, m - 1, d)));
};
export function shiftWeek(iso: string, weeks: number) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + weeks * 7)).toISOString().slice(0, 10);
}
/** "Today 09:12", "Mon 08:40", "24 Sep" */
export function when(ts: string) {
  const d = new Date(ts);
  const today = fmt({ year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const that = fmt({ year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  if (today === that) return hhmm(d);
  if (Date.now() - d.getTime() < 6 * 86400000) return `${fmt({ weekday: "short" }).format(d)} ${hhmm(d)}`;
  return fmt({ day: "numeric", month: "short" }).format(d);
}
export function useClock() {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);
  return hhmm(new Date());
}

// ───── Small components ─────
export function MarkS({ size = 30, url }: { size?: number; url?: string | null }) {
  return (
    <span className="mark-s" style={{ width: size, height: size, fontSize: size * 0.58 }} aria-hidden>
      {url ? <img src={url} alt="" /> : "S"}
    </span>
  );
}
export function MarkB({ size = 26 }: { size?: number }) {
  return (
    <span className="mark-b" style={{ width: size, height: size, fontSize: size * 0.46 }} aria-hidden>
      B
    </span>
  );
}
export function MarkSa({ size = 26 }: { size?: number }) {
  return (
    <span className="mark-sa" style={{ width: size, height: size, fontSize: size * 0.42 }} aria-hidden>
      Sa
    </span>
  );
}

export const Tag = ({ children }: { children: React.ReactNode }) => <span className="tag">{children}</span>;
export const Kicker = ({ children, sm }: { children: React.ReactNode; sm?: boolean }) => <div className={`kicker${sm ? " sm" : ""}`}>{children}</div>;

export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button className={`switch${on ? " on" : ""}`} role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}>
      <span />
    </button>
  );
}

export function Pills<T extends string>({ options, value, onChange, sm, label }: { options: readonly T[] | T[]; value: T; onChange: (v: T) => void; sm?: boolean; label?: (v: T) => string }) {
  return (
    <div className="row g6 wrap" role="group">
      {options.map((o) => (
        <button key={o} className={`pill${sm ? " sm" : ""}${o === value ? " on" : ""}`} aria-pressed={o === value} onClick={() => onChange(o)}>
          {label ? label(o) : o}
        </button>
      ))}
    </div>
  );
}

export function Loading({ label = "Sagal is pulling this together…" }: { label?: string }) {
  return (
    <div className="stack g18" aria-busy="true">
      <div className="skel" style={{ height: 44, width: "min(420px,80%)" }} />
      <div className="skel" style={{ height: 16, width: "min(560px,90%)" }} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(240px,1fr))", gap: 16, marginTop: 12 }}>
        {[0, 1, 2].map((i) => (
          <div key={i} className="skel" style={{ height: 220, borderRadius: 16 }} />
        ))}
      </div>
      <div className="small muted">{label}</div>
    </div>
  );
}

export function LoadError({ error, retry }: { error: string; retry: () => void }) {
  return (
    <div className="banner err" role="alert" style={{ borderRadius: 16, border: 0 }}>
      <span className="kicker" style={{ color: "var(--err)" }}>Failed</span>
      <span className="grow">{error}</span>
      <button className="btn outline sm" onClick={retry}>Try again</button>
    </div>
  );
}

export function Empty({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  const { go } = useRouter();
  return (
    <div className="empty">
      <MarkS size={48} />
      <div className="title-l" style={{ maxWidth: 720 }}>{title}</div>
      <div className="lede" style={{ fontSize: 17, maxWidth: 560 }}>{body}</div>
      {action ?? <button className="btn ink" onClick={() => go("/talk")}>Talk to Sagal about it</button>}
    </div>
  );
}

/** Hidden file input + trigger. */
export function useFilePicker(onFile: (f: File) => void, accept: string) {
  const ref = useRef<HTMLInputElement>(null);
  const input = (
    <input
      ref={ref}
      type="file"
      accept={accept}
      style={{ display: "none" }}
      onChange={(e) => {
        const f = e.target.files?.[0];
        e.target.value = "";
        if (f) onFile(f);
      }}
    />
  );
  return { input, open: () => ref.current?.click() };
}

/** Image slot: shows the image when there is one, otherwise a dashed drop target. */
export function ImageSlot({ url, placeholder, onFile, round, style }: { url?: string | null; placeholder: string; onFile?: (f: File) => void; round?: boolean; style?: React.CSSProperties }) {
  const picker = useFilePicker((f) => onFile?.(f), "image/*");
  const [over, setOver] = useState(false);
  return (
    <button
      type="button"
      className="slot"
      style={{ borderRadius: round ? "50%" : undefined, borderColor: over ? "var(--ink)" : undefined, cursor: onFile ? "pointer" : "default", ...style }}
      onClick={() => onFile && picker.open()}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f && onFile) onFile(f);
      }}
      aria-label={placeholder}
    >
      {url ? <img src={url} alt="" /> : <span>{placeholder}</span>}
      {picker.input}
    </button>
  );
}

// ───── Status vocabulary (shared by Publishing, Talk workspace, Plan) ─────
export const POST_STATUS: Record<string, { cls: string; label: string; dot: string }> = {
  scheduled: { cls: "info", label: "Scheduled", dot: "#94ABF9" },
  later: { cls: "line", label: "Later · not connected", dot: "#BDB8AE" },
  publishing: { cls: "warn", label: "Publishing…", dot: "#C98A00" },
  confirmed: { cls: "ok", label: "Published · confirmed", dot: "#2F8A57" },
  failed: { cls: "err", label: "Failed", dot: "#C4372A" },
  paused: { cls: "idle", label: "Paused", dot: "#8C877E" },
  manual: { cls: "warn", label: "Post by hand", dot: "#C98A00" },
  posted_by_hand: { cls: "ok", label: "Posted by you", dot: "#2F8A57" },
};
export const PLATFORMS = ["Instagram", "Facebook", "TikTok", "YouTube Shorts", "LinkedIn"] as const;
export const THEMES: Record<string, string> = { ink: "Ink", paper: "Paper", blue: "Soma blue", soft: "Stone" };
