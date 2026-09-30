import { api, type BriefingView, type Platform, type StatusView } from "../api";
import { Badge, fmtDate, money, PDot, PName, PLATFORM_LABEL, PLATFORMS, useData } from "../lib";
import type { Nav } from "../main";

const STAGES: [string, string][] = [
  ["lock", "Lock"],
  ["discover", "Discover"],
  ["fetch", "Fetch"],
  ["compare", "Compare"],
  ["index", "Index"],
  ["archive", "Archive"],
  ["brief", "Brief"],
  ["verify", "Verify storage"],
];

interface Overview {
  incomplete: { code: string; status: string; failures: { title: string; platform: Platform; reason: string }[]; error: string | null } | null;
  briefing: BriefingView | null;
  recentChanges: BriefingView | null;
}

export function OverviewTab({ status, version, nav, onRetry }: { status: StatusView; version: number; nav: Nav; onRetry: () => void }) {
  const { data } = useData(() => api<Overview>("/api/overview"), [version]);
  const a = status.active;
  const curIdx = a ? STAGES.findIndex(([k]) => k === (a.stage === "budget" ? "lock" : a.stage === "done" ? "verify" : a.stage)) : -1;
  const showChecklist = !status.activationComplete;
  const preview = data?.briefing;
  const sections = preview?.sections.length ? preview.sections : data?.recentChanges?.sections ?? [];

  return (
    <>
      {a ? (
        <div className="card">
          <div className="card-head">
            <h3>Refresh {a.code} {a.stage === "queued" ? "queued" : "in progress"}</h3>
            <span className="small muted">{a.done}/{a.total || "?"} sources · budget {money(a.budget)}</span>
          </div>
          <div className="stages">
            {STAGES.map(([k, label], i) => (
              <div key={k} className={`stage${i < curIdx ? " done" : i === curIdx ? " cur" : ""}`}>
                <div className="bar" />
                {k === "fetch" ? `Fetch ${a.done}/${a.total || "?"}` : label}
              </div>
            ))}
          </div>
          {a.lastLine ? <div className="last-line">{a.lastLine}</div> : null}
        </div>
      ) : null}

      {!a && data?.incomplete ? (
        <div className="banner-fail">
          <div>
            <h3>{data.incomplete.code} did not complete. It has not been marked successful.</h3>
            <div style={{ marginTop: 4 }}>
              Nothing from this run replaced current guidance. Sources that couldn't be reached are treated as unverified, not unchanged.
              {status.lastSuccess ? ` Last verified versions from ${fmtDate(status.lastSuccess.at)} stay in use.` : ""}
            </div>
          </div>
          {data.incomplete.failures.length ? (
            <div className="list-box">
              {data.incomplete.failures.map((f, i) => (
                <div key={i} className="list-row">
                  <span className="row">
                    <PDot p={f.platform} />
                    <strong>{f.title}</strong>
                    <span className="small muted">{PLATFORM_LABEL[f.platform]}</span>
                  </span>
                  <span className="small" style={{ color: "var(--fail)", textAlign: "right" }}>{f.reason}</span>
                </div>
              ))}
            </div>
          ) : data.incomplete.error ? (
            <div className="list-box"><div className="list-row"><span className="small" style={{ color: "var(--fail)" }}>{data.incomplete.error}</span></div></div>
          ) : null}
          <div className="row">
            <button className="btn btn-primary btn-sm" onClick={onRetry} disabled={!status.researchConfigured}>Retry refresh</button>
            <button className="btn btn-secondary btn-sm" onClick={() => nav.go("logs", { log: data.incomplete!.code })}>View log</button>
          </div>
        </div>
      ) : null}

      {showChecklist ? (
        <div className="card">
          <h3>Before automatic updates can be called active</h3>
          <div className="muted" style={{ margin: "4px 0 14px" }}>Each step is confirmed by the backend, not by this screen.</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {status.activation.map((s) => (
              <div key={s.label} className="check">
                <span className="mark" style={{ background: s.done ? "var(--ok-bg)" : "var(--neutral-bg)", color: s.done ? "var(--ok)" : "var(--faint)" }}>{s.done ? "✓" : ""}</span>
                <div>
                  <div style={{ fontWeight: 600 }}>{s.label}</div>
                  <div className="small muted">{s.detail}</div>
                </div>
              </div>
            ))}
          </div>
          {!status.researchConfigured ? <div className="note-fail" style={{ marginTop: 14 }}>Research is not configured on the server (ANTHROPIC_API_KEY). Refreshes cannot run.</div> : null}
          {!status.worker.alive ? (
            <div className="small muted" style={{ marginTop: 10 }}>
              Worker last checked in: {status.worker.seenAt ? new Date(status.worker.seenAt).toUTCString() : "never"}.
            </div>
          ) : null}
        </div>
      ) : null}

      {preview ? (
        <div className="card">
          <div className="card-head">
            <span className="label">What changed and what it means for us</span>
            <span className="small muted">{preview.runCode} · {fmtDate(preview.date)}</span>
          </div>
          <div className="lead">
            {preview.summary}
            {!preview.sections.length && data?.recentChanges ? ` Most recent changes below are from ${data.recentChanges.runCode}.` : ""}
          </div>
          {sections.length ? (
            <div className="grid-2">
              {PLATFORMS.map((p) => {
                const sec = sections.find((s) => s.platform === p);
                if (!sec) return null;
                return (
                  <div key={p} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <PName p={p} />
                    {sec.items.map((it) => (
                      <div key={it.ref} className="item-card">
                        <div className="row">
                          <Badge label={it.kind} />
                          {it.entry_id ? (
                            <a className="item-title" style={{ color: "var(--ink)" }} href="#" onClick={(e) => { e.preventDefault(); nav.go("kb", { kbPlatform: p, kbStatus: it.kind === "Archived" ? "archived" : "current", entry: it.entry_id }); }}>{it.title}</a>
                          ) : (
                            <span className="item-title">{it.title}</span>
                          )}
                        </div>
                        <div className="small" style={{ color: "var(--ink-2)" }}>{it.means}</div>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          ) : null}
          <div style={{ marginTop: 16 }}>
            <a href="#" style={{ fontWeight: 600 }} onClick={(e) => { e.preventDefault(); nav.go("briefings", { briefing: preview.id }); }}>Read full briefing</a>
          </div>
        </div>
      ) : !a && !showChecklist ? (
        <div className="card muted">No briefing yet.</div>
      ) : null}
    </>
  );
}
