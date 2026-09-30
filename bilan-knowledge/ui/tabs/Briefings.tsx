import { api, type BriefingView } from "../api";
import { Badge, Empty, fmtDate, PName, PLATFORM_LABEL, PLATFORMS, useData } from "../lib";
import type { Nav } from "../main";

interface BriefingListItem {
  id: number;
  run_code: string;
  kind: string;
  date: string;
  partial: boolean;
}

export function BriefingsTab({ version, nav }: { version: number; nav: Nav }) {
  const list = useData(() => api<{ briefings: BriefingListItem[] }>("/api/briefings"), [version]);
  const items = list.data?.briefings ?? [];
  const selId = nav.sel.briefing && items.some((b) => b.id === nav.sel.briefing) ? nav.sel.briefing : items[0]?.id ?? null;
  const detail = useData(() => (selId ? api<BriefingView>(`/api/briefings/${selId}`) : Promise.resolve(null)), [selId, version]);

  if (!list.data) return <div className="card muted">Loading…</div>;
  if (!items.length) return <Empty>No briefings yet. One is saved after every refresh.</Empty>;

  return (
    <div className="md narrow">
      <div className="brief-list">
        {items.map((b) => (
          <button key={b.id} className={`brow${b.id === selId ? " sel" : ""}`} onClick={() => nav.setSel({ briefing: b.id })}>
            <div className="small muted">{b.run_code} · {fmtDate(b.date)}</div>
            <div>{b.kind}</div>
            {b.partial ? <div className="small" style={{ color: "var(--fail)", fontWeight: 600 }}>Incomplete run</div> : null}
          </button>
        ))}
      </div>
      {detail.data ? <Article b={detail.data} nav={nav} reload={detail.reload} /> : <div className="detail muted">Loading…</div>}
    </div>
  );
}

function Article({ b, nav, reload }: { b: BriefingView; nav: Nav; reload: () => void }) {
  const decide = async (id: number, status: "added_to_plan" | "dismissed") => {
    await api(`/api/recommendations/${id}`, { method: "PATCH", body: { status } });
    reload();
  };
  return (
    <article className="detail">
      <div className="small muted">{b.runCode} · {fmtDate(b.date)}</div>
      <h2>What changed and what it means for us</h2>
      <div style={{ color: "var(--ink-2)", maxWidth: 680 }}>{b.summary}</div>

      {b.partial && b.unverified.length ? (
        <div className="note-fail">
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Not verified in this run</div>
          {b.unverified.map((u, i) => (
            <div key={i}>{PLATFORM_LABEL[u.platform]} · {u.title}: {u.reason}</div>
          ))}
        </div>
      ) : null}
      {b.partial && b.pending.length ? (
        <div className="relevance">
          <div className="small muted" style={{ marginBottom: 4 }}>Found in verified sources but not applied, because the run did not complete</div>
          {b.pending.map((p, i) => (
            <div key={i} className="small">{PLATFORM_LABEL[p.platform]} · {p.kind}: {p.title}{p.what ? `. ${p.what}` : ""}</div>
          ))}
        </div>
      ) : null}

      {PLATFORMS.map((p) => {
        const sec = b.sections.find((s) => s.platform === p);
        if (!sec) return null;
        return (
          <div key={p}>
            <div style={{ padding: "6px 0 10px", borderBottom: "1px solid var(--divider)" }}><PName p={p} /></div>
            {sec.items.map((it) => (
              <div key={it.ref} className="brief-item">
                <div>
                  <div className="row" style={{ marginBottom: 4 }}>
                    <Badge label={it.kind} />
                    {it.entry_id ? (
                      <a href="#" style={{ fontWeight: 600, color: "var(--ink)" }} onClick={(e) => { e.preventDefault(); nav.go("kb", { kbPlatform: p, kbStatus: it.kind === "Archived" ? "archived" : "current", entry: it.entry_id }); }}>{it.title}</a>
                    ) : (
                      <strong>{it.title}</strong>
                    )}
                  </div>
                  <div style={{ color: "var(--ink-2)" }}>{it.what}</div>
                  {it.scope ? <div className="scope" style={{ marginTop: 4 }}>{it.scope}</div> : null}
                </div>
                <div className="means">
                  <div className="small muted">For Creative Academy</div>
                  <div>{it.means}</div>
                </div>
              </div>
            ))}
          </div>
        );
      })}

      {b.recommendations.length ? (
        <div className="recs">
          <div>
            <div style={{ fontWeight: 600 }}>Proposed actions</div>
            <div className="small muted">Recommendations only. Knowledge updates cannot publish ads, edit campaigns or change spend.</div>
          </div>
          {b.recommendations.map((r) => (
            <div key={r.id} className="rec">
              <div style={{ flex: "1 1 320px" }}>
                <div style={{ color: r.status === "dismissed" ? "var(--faint)" : "var(--ink)" }}>{r.text}</div>
                <div className="small muted">
                  {r.status === "added_to_plan" ? "Added to campaign plan. Nothing published." : r.status === "dismissed" ? "Dismissed" : "Proposed. Needs your approval."}
                </div>
              </div>
              {r.status === "proposed" ? (
                <div className="row">
                  <button className="btn btn-primary btn-sm" onClick={() => decide(r.id, "added_to_plan")}>Add to campaign plan</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => decide(r.id, "dismissed")}>Dismiss</button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </article>
  );
}
