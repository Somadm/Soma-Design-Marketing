import { useState } from "react";
import { api, type SourceRowView } from "../api";
import { Badge, fmtDate, PName, PLATFORMS, resultLabel, SOURCE_TYPE, useData } from "../lib";

interface SourcesResponse {
  run: { code: string; trigger: string; finishedAt: string } | null;
  sources: SourceRowView[];
}

const CHIPS = ["All", "Changed", "New", "Discontinued", "Failed", "Unchanged", "Paused"];

export function SourcesTab({ version }: { version: number }) {
  const { data, reload } = useData(() => api<SourcesResponse>("/api/sources"), [version]);
  const [filter, setFilter] = useState("All");
  const [newUrl, setNewUrl] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  if (!data) return <div className="card muted">Loading…</div>;

  const rows = data.sources.map((s) => {
    const label = s.status === "paused" ? "Paused" : resultLabel(s.result, data.run?.trigger);
    const verifiedHere = s.result && !["failed", "skipped"].includes(s.result);
    const verified =
      s.status === "paused"
        ? s.last_verified_at ? `Last verified ${fmtDate(s.last_verified_at)}` : "Never verified"
        : !s.result
          ? "—"
          : verifiedHere
            ? fmtDate(s.checked_at)
            : s.last_verified_at ? `Last verified ${fmtDate(s.last_verified_at)}` : "Never verified";
    const note =
      label === "Failed" ? s.failure_reason : label === "Discontinued" ? "Archived, not current" : s.status === "paused" ? "Paused: excluded from refreshes; entries shown as stale" : s.note;
    return { ...s, label, verified, note };
  });
  const count = (c: string) => (c === "All" ? rows.length : rows.filter((r) => r.label === c).length);
  const shown = rows.filter((r) => filter === "All" || r.label === filter);

  const act = async (id: number, body: Record<string, unknown>) => {
    try {
      await api(`/api/sources/${id}`, { method: "PATCH", body });
      reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="chips">
          {CHIPS.filter((c) => c === "All" || c === "Failed" || count(c) > 0).map((c) => (
            <button key={c} className={`chip${filter === c ? " active" : ""}`} onClick={() => setFilter(c)}>
              {c} {count(c)}
            </button>
          ))}
        </div>
        <span className="small muted">{data.run ? `From ${data.run.code} · ${fmtDate(data.run.finishedAt)}` : "No run yet"}</span>
      </div>

      {PLATFORMS.map((p) => {
        const g = shown.filter((r) => r.platform === p);
        return (
          <div key={p} className="table-card">
            <div className="table-title"><PName p={p} extra={`${g.length} sources`} /></div>
            {g.length === 0 ? <div className="empty">No sources match this filter.</div> : null}
            {g.map((r) => (
              <div key={r.id} className={`trow${r.escalated_at || r.status === "paused" ? " show-actions" : ""}`}>
                <div>
                  <div className="src-title">{r.title}</div>
                  <a className="src-url" href={r.url} target="_blank" rel="noopener noreferrer">{r.display_url}</a>
                  {r.escalated_at && r.status !== "paused" ? (
                    <div className="small" style={{ color: "var(--fail)", marginTop: 4 }}>Failed in {r.consecutive_failures} consecutive runs. Fix the URL or pause it.</div>
                  ) : null}
                  {r.status !== "discontinued" ? (
                    <div className="src-actions">
                      <button className="linklike" onClick={() => act(r.id, { status: r.status === "paused" ? "active" : "paused" })}>{r.status === "paused" ? "Resume" : "Pause"}</button>
                      <button
                        className="linklike"
                        onClick={() => {
                          const url = window.prompt("New official URL for this source", r.url);
                          if (url && url !== r.url) void act(r.id, { url });
                        }}
                      >
                        Edit URL
                      </button>
                      <button className="linklike" onClick={() => act(r.id, { fetch_mode: r.fetch_mode === "direct" ? "rendered" : "direct" })} title="Rendered fetch uses Firecrawl for JavaScript-rendered pages">
                        {r.fetch_mode === "direct" ? "Use rendered fetch" : "Use direct fetch"}
                      </button>
                    </div>
                  ) : null}
                </div>
                <div className="muted col-type">{SOURCE_TYPE[r.source_type]}</div>
                <div><Badge label={r.label} /></div>
                <div className="small col-verified">
                  <div>{r.verified}</div>
                  {r.note ? <div style={{ color: r.label === "Failed" ? "var(--fail)" : "var(--muted)" }}>{r.note}</div> : null}
                </div>
              </div>
            ))}
          </div>
        );
      })}

      <form
        className="card row"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api("/api/sources", { method: "POST", body: { url: newUrl } });
            setNewUrl("");
            setMsg("Added. It will be checked in the next refresh.");
            reload();
          } catch (err) {
            setMsg((err as Error).message);
          }
        }}
      >
        <input className="input" style={{ flex: "1 1 280px", width: "auto" }} type="url" placeholder="Add an official page, e.g. https://ads.tiktok.com/help/article/…" value={newUrl} onChange={(e) => setNewUrl(e.target.value)} required />
        <button className="btn btn-secondary btn-sm" type="submit">Add source</button>
        {msg ? <span className="small muted">{msg}</span> : null}
      </form>
    </>
  );
}
