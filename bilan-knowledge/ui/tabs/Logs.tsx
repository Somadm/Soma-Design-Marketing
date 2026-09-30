import { api, type RunListItem } from "../api";
import { Empty, fmtDate, useData } from "../lib";
import type { Nav } from "../main";

interface Line {
  t: string;
  level: "INFO" | "WARN" | "ERROR";
  stage: string;
  message: string;
}

export function LogsTab({ version, nav, running }: { version: number; nav: Nav; running: boolean }) {
  const runs = useData(() => api<{ runs: RunListItem[] }>("/api/runs"), [version]);
  const list = runs.data?.runs ?? [];
  const code = nav.sel.log && list.some((r) => r.code === nav.sel.log) ? nav.sel.log : list[0]?.code ?? null;
  const logs = useData(() => (code ? api<{ lines: Line[] }>(`/api/runs/${code}/logs`) : Promise.resolve({ lines: [] })), [code, version, running]);

  if (!runs.data) return <div className="card muted">Loading…</div>;
  if (!list.length) return <Empty>No runs yet.</Empty>;
  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <select className="select" value={code ?? ""} onChange={(e) => nav.setSel({ log: e.target.value })} aria-label="Run">
          {list.map((r) => (
            <option key={r.code} value={r.code}>
              {r.code} · {r.kind} · {fmtDate(r.started_at ?? r.created_at)}{r.status === "running" ? " · running" : ""}
            </option>
          ))}
        </select>
        <span className="small muted">Stored with the run record.</span>
      </div>
      <div className="log" role="log">
        {logs.data?.lines.length ? (
          logs.data.lines.map((l, i) => (
            <div key={i} className="ln">
              <span className="t">{l.t}</span>
              <span className={l.level}>{l.level}</span>
              <span className="t stage-col">{l.stage}</span>
              <span className={l.level === "ERROR" ? "msg-ERROR" : l.stage === "done" ? "msg-done" : ""}>{l.message}</span>
            </div>
          ))
        ) : (
          <span className="t">No log lines for this run.</span>
        )}
      </div>
    </>
  );
}
