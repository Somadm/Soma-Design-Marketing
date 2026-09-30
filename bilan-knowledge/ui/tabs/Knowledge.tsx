import { useEffect, useState } from "react";
import { api, type EntryDetail, type EntryListItem, type Platform } from "../api";
import { Badge, CATEGORY, Diff, fmtDate, PDot, PLATFORM_LABEL, PLATFORMS, useData } from "../lib";
import type { Nav } from "../main";

export function KnowledgeTab({ version, nav }: { version: number; nav: Nav }) {
  const { kbPlatform: p, kbStatus: status } = nav.sel;
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const list = useData(
    () => api<{ counts: { current: number; archived: number }; items: EntryListItem[] }>(`/api/entries?platform=${p}&status=${status}&q=${encodeURIComponent(debounced)}`),
    [p, status, debounced, version],
  );
  const items = list.data?.items ?? [];
  const selId = nav.sel.entry && items.some((i) => i.entry_id === nav.sel.entry) ? nav.sel.entry : items[0]?.entry_id ?? null;
  const detail = useData(() => (selId ? api<EntryDetail>(`/api/entries/${selId}`) : Promise.resolve(null)), [selId, version]);

  return (
    <>
      <div className="row">
        <div className="segmented" role="group" aria-label="Platform">
          {PLATFORMS.map((x: Platform) => (
            <button key={x} className={x === p ? "active" : ""} onClick={() => nav.setSel({ kbPlatform: x, entry: null })}>
              <PDot p={x} />
              {PLATFORM_LABEL[x]}
            </button>
          ))}
        </div>
        {(["current", "archived"] as const).map((s) => (
          <button key={s} className={`chip${status === s ? " active" : ""}`} onClick={() => nav.setSel({ kbStatus: s, entry: null })}>
            {s === "current" ? "Current" : "Archived"} {list.data ? list.data.counts[s] : ""}
          </button>
        ))}
        <input className="input" style={{ maxWidth: 280 }} placeholder="Search entries" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search entries" />
      </div>

      <div className="md">
        <div className="mlist">
          {!list.data ? <div className="empty">Loading…</div> : null}
          {list.data && !items.length ? <div className="empty">{debounced ? "No entries match." : status === "current" ? "No current entries yet." : "Nothing archived."}</div> : null}
          {items.map((e) => (
            <button key={e.entry_id} className={`mrow${e.entry_id === selId ? " sel" : ""}`} onClick={() => nav.setSel({ entry: e.entry_id })}>
              <span className="grow">
                <div>{e.title}</div>
                <div className="small muted">{CATEGORY[e.category] ?? e.category} · v{e.version} · verified {fmtDate(e.verified_at)}</div>
              </span>
            </button>
          ))}
        </div>
        {detail.data ? <EntryView d={detail.data} /> : selId ? <div className="detail muted">Loading…</div> : <div />}
      </div>
    </>
  );
}

function EntryView({ d }: { d: EntryDetail }) {
  const e = d.entry;
  const statusLabel = e.status === "current" ? "Current" : "Archived";
  return (
    <div className="detail">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="row small muted"><PDot p={e.platform} />{PLATFORM_LABEL[e.platform]} · {CATEGORY[e.category] ?? e.category}</span>
        <Badge label={statusLabel} />
      </div>
      <h2>{e.title}</h2>
      {e.unverified ? (
        <div className="note-fail">The latest refresh couldn't reach this source ({e.unverified_reason}). This is the last verified version from {fmtDate(e.verified_at)}.</div>
      ) : null}
      {e.source_status === "paused" ? <div className="note-fail">This source is paused. The guidance may be out of date.</div> : null}
      {e.status === "archived" && e.archived_reason ? <div className="note-fail">{e.archived_reason}</div> : null}
      <div style={{ fontSize: 15 }}>{e.summary}</div>
      {e.body.trim() !== e.summary.trim() ? <div style={{ color: "var(--ink-2)" }}>{e.body}</div> : null}
      {e.relevance ? (
        <div className="relevance">
          <div className="small muted">For Creative Academy</div>
          <div style={{ fontSize: 15 }}>{e.relevance}</div>
        </div>
      ) : null}
      {e.limitations.length ? (
        <div>
          <div className="small muted" style={{ marginBottom: 6 }}>Limitations noted in source</div>
          <div className="row">{e.limitations.map((l, i) => <span key={i} className="lchip" title={l.kind}>{l.text}</span>)}</div>
        </div>
      ) : null}
      <div className="kv2">
        <div>
          <div className="small muted">Source</div>
          <a href={e.source_url} target="_blank" rel="noopener noreferrer" style={{ wordBreak: "break-all" }}>{e.source_display}</a>
        </div>
        <div>
          <div className="small muted">Last verified</div>
          <div>{fmtDate(e.verified_at)}{e.verified_by ? ` · ${e.verified_by}` : ""}</div>
        </div>
      </div>
      {d.latestChange?.old && d.latestChange.new ? (
        <div>
          <div className="small muted" style={{ marginBottom: 6 }}>Latest change · {d.latestChange.run_code}</div>
          <div className="diff"><Diff old={d.latestChange.old} new={d.latestChange.new} /></div>
        </div>
      ) : null}
      <div>
        <div className="small muted" style={{ marginBottom: 2 }}>Version history</div>
        {d.versions.map((v) => (
          <div key={v.version} className="vrow">
            <strong>v{v.version}</strong>
            <span className="muted">{fmtDate(v.date)}</span>
            <span>{v.note}</span>
            <Badge label={v.status === "current" ? "Current" : "Archived"} />
          </div>
        ))}
      </div>
    </div>
  );
}
