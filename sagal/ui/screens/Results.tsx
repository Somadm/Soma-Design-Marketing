import React, { useState } from "react";
import { api } from "../api";
import { Kicker, LoadError, Loading, MarkB, MarkS, MarkSa, Pills, Tag, useAction, useLoad } from "../lib";

interface Task { id: number; type: string; title: string; status: string; owner: string; evidence: string; next_step: string; sample: boolean }
interface Results { lessons: { id: number; kicker: string; title: string; evidence: string; sample: boolean }[]; tasks: Task[]; metrics: null | { sample: boolean; reached: number; saves: number; shares: number; profileVisits: number }; confirmedPosts: number }

const TSTATUS: Record<string, string> = { "In progress": "info", "Ready for Bilan": "ok", "Needs Sabah": "warn", Blocked: "err", Declined: "idle", "Sent to Bilan": "ok", "Kept organic": "idle" };
const FILTERS = ["All", "Brief from Bilan", "Asset prepared", "Proposed for paid"] as const;

export function ResultsScreen() {
  const { data, error, loading, reload } = useLoad<Results>("/api/results");
  const { run } = useAction();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("All");
  if (!data) return <div className="scroll"><div className="page w1320">{error ? <LoadError error={error} retry={reload} /> : loading && <Loading />}</div></div>;
  const m = data.metrics;
  const tasks = data.tasks.filter((t) => filter === "All" || t.type === filter);
  const mark = (o: string) => (o.startsWith("Bilan") ? <MarkB /> : o.startsWith("Sabah") ? <MarkSa /> : <MarkS size={26} />);

  return (
    <div className="scroll">
      <div className="page w1320" style={{ gap: 28 }}>
        <div className="head">
          <div className="stack g8">
            <Kicker>Results &amp; Bilan · organic, last 28 days</Kicker>
            <h1 className="title-xl">What we learned</h1>
          </div>
          {m?.sample ? <Tag>Sample data · no platform connected</Tag> : <Tag>No platform connected yet</Tag>}
        </div>
        {m ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 10 }}>
            {[["Accounts reached", m.reached], ["Saves", m.saves], ["Shares", m.shares], ["Profile visits", m.profileVisits]].map(([k, v]) => (
              <div key={k as string} style={{ borderTop: "2px solid var(--ink)", paddingTop: 12 }}>
                <div className="small muted">{k}</div>
                <div className="serif" style={{ fontSize: 48, lineHeight: 1 }}>{(v as number).toLocaleString("en-GB")}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="card dashed stack g8" style={{ borderRadius: 22 }}>
            <div className="title-s">No results yet.</div>
            <div className="lede" style={{ fontSize: 15 }}>
              Numbers appear once a post is confirmed published and the platform shares its insights. Posts you publish by hand aren't counted automatically. {data.confirmedPosts ? `${data.confirmedPosts} confirmed post(s) so far.` : ""}
            </div>
          </div>
        )}
        {data.lessons.length > 0 && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,300px),1fr))", gap: 14 }}>
            {data.lessons.map((l) => (
              <div key={l.id} className="card stone stack g10" style={{ borderRadius: 22 }}>
                <Kicker sm>{l.kicker}</Kicker>
                <span className="serif" style={{ fontSize: 26, lineHeight: 1.1 }}>{l.title}</span>
                <span className="muted" style={{ fontSize: 13.5 }}>{l.evidence}</span>
              </div>
            ))}
          </div>
        )}
        <div className="stack g14">
          <div className="row between g12 wrap" style={{ alignItems: "flex-end" }}>
            <div>
              <div className="serif" style={{ fontSize: 36, lineHeight: 1 }}>Shared with Bilan</div>
              <div className="muted" style={{ fontSize: 14, marginTop: 6 }}>Briefs from Bilan, assets Sagal prepared, and organic posts proposed for paid testing.</div>
            </div>
            <Pills options={FILTERS} value={filter} onChange={setFilter} />
          </div>
          {!tasks.length ? (
            <div className="card dashed small muted" style={{ borderRadius: 18 }}>Nothing shared yet. When Sagal proposes a post for paid testing, it waits here for you first.</div>
          ) : (
            <div className="list" style={{ borderRadius: 22 }}>
              {tasks.map((t) => (
                <div key={t.id} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: "10px 20px", padding: "16px 20px", borderBottom: "1px solid var(--line-soft)", alignItems: "center" }}>
                  <div className="stack g4" style={{ gridColumn: "span 2", minWidth: 0 }}>
                    <span className="row g8"><Kicker sm>{t.type}</Kicker>{t.sample && <Tag>Sample</Tag>}</span>
                    <span style={{ fontSize: 15.5, fontWeight: 600, lineHeight: 1.35 }}>{t.title}</span>
                    <span className="small muted">Evidence: {t.evidence}</span>
                  </div>
                  <div className="row g8">
                    {mark(t.owner)}
                    <div className="stack"><span style={{ fontSize: 13.5, fontWeight: 600 }}>{t.owner}</span><span className="xs muted">{t.next_step}</span></div>
                  </div>
                  <div className="row g8 wrap">
                    <span className={`chip ${TSTATUS[t.status] ?? "idle"}`}>{t.status}</span>
                    {t.status === "Needs Sabah" && (
                      <>
                        <button className="btn ink xs" onClick={() => run(async () => { await api.post(`/api/tasks/${t.id}/decide`, { decision: "send" }); await reload(); }, "Sent to Bilan.")}>Send to Bilan</button>
                        <button className="btn ghost xs" onClick={() => run(async () => { await api.post(`/api/tasks/${t.id}/decide`, { decision: "keep" }); await reload(); })}>Keep organic</button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
