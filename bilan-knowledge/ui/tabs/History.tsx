import { api, type RunDetail, type RunListItem } from "../api";
import { Badge, Diff, duration, Empty, fmtDate, fmtTime, money, PDot, PLATFORM_LABEL, useData } from "../lib";
import type { Nav } from "../main";

const KIND_LABEL = { new: "New", changed: "Changed", archived: "Archived" } as const;

export function HistoryTab({ version, nav }: { version: number; nav: Nav }) {
  const { data } = useData(() => api<{ runs: RunListItem[] }>("/api/runs"), [version]);
  const runs = data?.runs ?? [];
  const selCode = nav.sel.run && runs.some((r) => r.code === nav.sel.run) ? nav.sel.run : runs[0]?.code ?? null;
  const detail = useData(() => (selCode ? api<RunDetail>(`/api/runs/${selCode}`) : Promise.resolve(null)), [selCode, version]);

  if (!data) return <div className="card muted">Loading…</div>;
  if (!runs.length) return <Empty>No refreshes yet. Run initial research to build the knowledge base.</Empty>;

  return (
    <div className="md">
      <div className="mlist">
        {runs.map((r) => {
          const live = r.trigger === "live_check";
          return (
            <button key={r.code} className={`mrow${r.code === selCode ? " sel" : ""}`} onClick={() => nav.setSel({ run: r.code })}>
              <span className="code">{r.code}</span>
              <span className="grow">
                <div>{r.kind}</div>
                <div className="small muted">
                  {fmtDate(r.started_at ?? r.created_at)} · {live ? money(r.spend_usd) : `${r.sources_verified}/${r.sources_total} verified · ${money(r.spend_usd)}`}
                </div>
              </span>
              <Badge label={r.result} />
            </button>
          );
        })}
      </div>

      {detail.data ? <RunDetailView d={detail.data} nav={nav} /> : <div className="detail muted">Loading…</div>}
    </div>
  );
}

function RunDetailView({ d, nav }: { d: RunDetail; nav: Nav }) {
  const r = d.run;
  const live = r.trigger === "live_check";
  const c = (k: string) => r.counts[k] ?? 0;
  const stats = live
    ? [["Sources checked", "1"], ["Spend", money(r.spend_usd)], ["Duration", duration(r.started_at, r.finished_at)]]
    : [
        ["Checked", String(r.sources_total)],
        ["Failed", String(r.sources_failed)],
        ["Changed", String(c("changed"))],
        ["New", String(c("new"))],
        ["Discontinued", String(c("discontinued"))],
        ["Spend", `${money(r.spend_usd)} / ${money(r.budget_usd)}`],
        ["Duration", duration(r.started_at, r.finished_at)],
      ];
  return (
    <div className="detail">
      <div className="small muted">{r.code} · {fmtDate(r.started_at ?? r.created_at)} {fmtTime(r.started_at ?? r.created_at)} UTC</div>
      <h2 className="strong">{r.kind}{r.question ? `: “${r.question}”` : ""}</h2>
      <div><Badge label={r.result} /></div>
      {r.note ? <div>{r.note}</div> : null}
      {r.status === "failed" && r.error ? <div className="note-fail">{r.error}</div> : null}
      <div className="stats">
        {stats.map(([k, v]) => (
          <div key={k}>
            <div className="k">{k}</div>
            <div className="v" style={k === "Failed" && v !== "0" ? { color: "var(--fail)" } : undefined}>{v}</div>
          </div>
        ))}
      </div>

      {d.failures.length ? (
        <>
          <div className="section-title">Sources that could not be verified</div>
          <div className="diff">
            {d.failures.map((f, i) => (
              <div key={i} className="diff-head" style={{ justifyContent: "space-between", background: i % 2 ? "var(--surface)" : "var(--subtle)" }}>
                <span className="row"><PDot p={f.platform} /><strong>{f.title}</strong><span className="small muted">{PLATFORM_LABEL[f.platform]}</span></span>
                <span className="small" style={{ color: "var(--fail)" }}>{f.reason}</span>
              </div>
            ))}
          </div>
        </>
      ) : null}

      {d.changes.length ? (
        <>
          <div className="section-title">Changes and version diffs</div>
          {d.changes.map((ch) => (
            <div key={ch.id} className="diff">
              <div className="diff-head">
                <PDot p={ch.platform} />
                <Badge label={KIND_LABEL[ch.kind]} />
                <a href="#" style={{ fontWeight: 600, color: "var(--ink)", flex: 1 }} onClick={(e) => { e.preventDefault(); nav.go("kb", { kbPlatform: ch.platform, kbStatus: ch.kind === "archived" ? "archived" : "current", entry: ch.entry_id }); }}>
                  {ch.title}
                </a>
                <span className="small muted">{ch.version}</span>
              </div>
              {ch.hasDiff && ch.old && ch.new ? <Diff old={ch.old} new={ch.new} /> : ch.what_changed ? <div className="diff-line" style={{ paddingLeft: 12 }}>{ch.what_changed}</div> : null}
            </div>
          ))}
        </>
      ) : null}

      <div className="row">
        {d.briefingId ? <button className="btn btn-secondary btn-sm" onClick={() => nav.go("briefings", { briefing: d.briefingId })}>View briefing</button> : null}
        <button className="btn btn-secondary btn-sm" onClick={() => nav.go("logs", { log: r.code })}>View log</button>
      </div>
    </div>
  );
}
