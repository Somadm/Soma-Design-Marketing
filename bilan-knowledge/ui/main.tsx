import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, readToken, Unauthorized, writeToken, type Platform, type StatusView } from "./api";
import { fmtDate, money } from "./lib";
import { BriefingsTab } from "./tabs/Briefings";
import { HistoryTab } from "./tabs/History";
import { KnowledgeTab } from "./tabs/Knowledge";
import { LogsTab } from "./tabs/Logs";
import { OverviewTab } from "./tabs/Overview";
import { SettingsTab } from "./tabs/Settings";
import { SourcesTab } from "./tabs/Sources";

export type TabKey = "overview" | "sources" | "history" | "briefings" | "kb" | "logs" | "settings";
export interface Nav {
  go: (tab: TabKey, sel?: Partial<Selection>) => void;
  sel: Selection;
  setSel: (s: Partial<Selection>) => void;
}
export interface Selection {
  run: string | null;
  briefing: number | null;
  log: string | null;
  kbPlatform: Platform;
  kbStatus: "current" | "archived";
  entry: number | null;
}

const TABS: [TabKey, string][] = [
  ["overview", "Overview"],
  ["sources", "Sources"],
  ["history", "Update history"],
  ["briefings", "Briefings"],
  ["kb", "Knowledge base"],
  ["logs", "Execution logs"],
  ["settings", "Settings"],
];

function Login({ onDone, error }: { onDone: () => void; error: string | null }) {
  const [value, setValue] = useState("");
  return (
    <form
      className="login"
      onSubmit={(e) => {
        e.preventDefault();
        writeToken(value.trim());
        onDone();
      }}
    >
      <div className="wordmark">BILAN<span>.</span></div>
      <div>
        <div style={{ fontWeight: 600 }}>Knowledge updates</div>
        <div className="muted">Enter the access token for this deployment.</div>
      </div>
      <input className="input" type="password" autoComplete="current-password" placeholder="Access token" value={value} onChange={(e) => setValue(e.target.value)} required />
      {error ? <div className="error-text">{error}</div> : null}
      <button className="btn btn-primary" type="submit">Continue</button>
    </form>
  );
}

function StatusStrip({ s }: { s: StatusView }) {
  const t = s.headline.tone;
  const lr = s.latestRun;
  return (
    <div className="strip">
      <div className={`bg-${t}`}>
        <div className={`strip-headline tone-${t}`}>
          <span className="dot" />
          {s.headline.title}
        </div>
        <div className="strip-detail">{s.headline.detail}</div>
      </div>
      <div>
        <div className="label">Last successful refresh</div>
        <div className="stat">{s.lastSuccess ? fmtDate(s.lastSuccess.at) : "Never"}</div>
        <div className="stat-sub">{s.lastSuccess ? `${s.lastSuccess.code} · ${s.lastSuccess.triggerLabel}` : "No complete refresh yet"}</div>
      </div>
      <div>
        <div className="label">Next scheduled refresh</div>
        <div className="stat">{s.next.at ? fmtDate(s.next.at) : "Not scheduled"}</div>
        <div className="stat-sub" style={s.next.overdue ? { color: "var(--fail)" } : undefined}>{s.next.sub}</div>
      </div>
      <div>
        <div className="label">Sources, latest run</div>
        {s.active ? (
          <>
            <div className="stat">{s.active.done} of {s.active.total || "?"} checked</div>
            <div className="stat-sub">Budget {money(s.active.budget)}</div>
          </>
        ) : (
          <>
            <div className="stat-row">
              <span className="stat">{lr ? lr.checked : 0} checked</span>
              <span className="stat" style={{ fontSize: 15, color: lr ? (lr.failed ? "var(--fail)" : "var(--ok)") : "var(--muted)" }}>{lr ? `${lr.failed} failed` : "—"}</span>
            </div>
            <div className="stat-sub">{lr ? `${money(lr.spend)} of ${money(lr.budget)} budget` : "No spend yet"}</div>
          </>
        )}
      </div>
    </div>
  );
}

function App() {
  const [authed, setAuthed] = useState(Boolean(readToken()));
  const [authError, setAuthError] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusView | null>(null);
  const [tab, setTab] = useState<TabKey>("overview");
  const [dup, setDup] = useState<string | null>(null);
  const [failedCount, setFailedCount] = useState(0);
  const [version, setVersion] = useState(0); // bumps when backend state moves, so tabs reload
  const [sel, setSelState] = useState<Selection>({ run: null, briefing: null, log: null, kbPlatform: "meta", kbStatus: "current", entry: null });

  const signOut = useCallback((msg?: string) => {
    writeToken(null);
    setAuthed(false);
    setAuthError(msg ?? null);
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const s = await api<StatusView>("/api/status");
      setStatus((prev) => {
        const key = (x: StatusView | null) => `${x?.active?.code}|${x?.active?.stage}|${x?.active?.done}|${x?.latestRun?.code}|${x?.lastSuccess?.code}`;
        if (key(prev) !== key(s)) setVersion((v) => v + 1);
        return s;
      });
      setFailedCount(s.active ? 0 : s.latestRun?.failed ?? 0);
      if (!s.active) setDup(null);
    } catch (e) {
      if (e instanceof Unauthorized) signOut("That token was not accepted.");
    }
  }, [signOut]);

  useEffect(() => {
    if (!authed) return;
    void loadStatus();
    const id = setInterval(loadStatus, status?.active ? 3000 : 20000);
    return () => clearInterval(id);
  }, [authed, loadStatus, status?.active]);

  if (!authed) return <Login onDone={() => { setAuthed(true); setAuthError(null); }} error={authError} />;

  const nav: Nav = {
    sel,
    setSel: (s) => setSelState((x) => ({ ...x, ...s })),
    go: (t, s) => {
      if (s) setSelState((x) => ({ ...x, ...s }));
      setTab(t);
      window.scrollTo({ top: 0 });
    },
  };

  const startRun = async () => {
    try {
      const r = await api<{ created: boolean; message: string }>("/api/refresh", { method: "POST" });
      setDup(r.created ? null : r.message);
      await loadStatus();
    } catch (e) {
      setDup((e as Error).message);
    }
  };

  const running = Boolean(status?.active);
  return (
    <div className="shell">
      <aside className="sidebar">
        <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: "0 8px" }}>
          <div className="wordmark">BILAN<span>.</span></div>
          <div className="brand-sub">Creative Academy ads</div>
        </div>
        <nav className="nav" aria-label="Bilan">
          {["Chat", "Campaigns", "Creatives"].map((n) => (
            <div key={n} className="nav-item soon" title="Not built yet">{n}</div>
          ))}
          <div className="nav-item active" aria-current="page">Knowledge updates</div>
          <div className="nav-item soon" title="Not built yet">Settings</div>
        </nav>
        <div className="sidebar-foot">
          <button className="linklike" onClick={() => signOut()}>Sign out</button>
        </div>
      </aside>

      <div className="main">
        <header className="page-header">
          <div>
            <h1>Knowledge updates</h1>
            <p>Meta and TikTok advertising guidance from official sources. Refreshed every 42 days from the last successful refresh.</p>
          </div>
          <div className="header-actions">
            {dup ? <span className="small muted">{dup}</span> : null}
            <button className="btn btn-primary" onClick={startRun} disabled={!status || running || !status.researchConfigured} title={status && !status.researchConfigured ? "Research is not configured on the server" : undefined}>
              {status ? status.updateLabel : "Update now"}
            </button>
          </div>
        </header>

        <div className="content">
          {status ? <StatusStrip s={status} /> : <div className="card muted">Loading…</div>}

          <nav className="tabs" role="tablist">
            {TABS.map(([k, label]) => (
              <button key={k} role="tab" aria-selected={tab === k} className={`tab${tab === k ? " active" : ""}`} onClick={() => nav.go(k)}>
                {label}
                {k === "sources" && failedCount > 0 && !running ? <span className="tab-badge">{failedCount} failed</span> : null}
              </button>
            ))}
          </nav>

          {status ? (
            <>
              {tab === "overview" && <OverviewTab status={status} version={version} nav={nav} onRetry={startRun} />}
              {tab === "sources" && <SourcesTab version={version} />}
              {tab === "history" && <HistoryTab version={version} nav={nav} />}
              {tab === "briefings" && <BriefingsTab version={version} nav={nav} />}
              {tab === "kb" && <KnowledgeTab version={version} nav={nav} />}
              {tab === "logs" && <LogsTab version={version} nav={nav} running={running} />}
              {tab === "settings" && <SettingsTab />}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
