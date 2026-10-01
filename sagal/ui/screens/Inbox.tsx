import React from "react";
import { api } from "../api";
import { Kicker, LoadError, Loading, MarkS, Tag, useAction, useApp, useLoad, useRouter, when } from "../lib";

interface Item { id: number; kind: string; due_label: string; title: string; body: string; primary_label: string; secondary_label: string | null; urgent: boolean; resolution: string | null; resolved_at: string | null; sample: boolean }

const WORDS = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

export function InboxScreen() {
  const { go } = useRouter();
  const { discuss, refreshOverview } = useApp();
  const { data, error, loading, reload } = useLoad<{ open: Item[]; handled: Item[] }>("/api/inbox");
  const { run } = useAction();
  const n = data?.open.length ?? 0;
  const title = n === 0 ? "Nothing needs you right now." : n === 1 ? "One thing needs you." : `${WORDS[n] ?? n} things need you.`;

  const act = (it: Item, which: "primary" | "secondary") =>
    run(async () => {
      const r = await api.post<{ navigate?: string }>(`/api/inbox/${it.id}/act`, { which });
      if (r.navigate) go(`/${r.navigate}`);
      else {
        await reload();
        refreshOverview();
      }
    });

  return (
    <div className="scroll">
      <div className="page w980">
        <div className="stack g8">
          <Kicker>Needs Sabah</Kicker>
          <h1 className="title-xl">{loading ? "Needs Sabah" : title}</h1>
          <p className="lede">Sagal only brings you missing audio, real decisions, production problems and anything outside the plan. Everything else she handles.</p>
        </div>
        {error && <LoadError error={error} retry={reload} />}
        {loading && <Loading />}
        {data && n === 0 && <div className="card dashed serif" style={{ padding: 32, fontSize: 28, lineHeight: 1.2, borderRadius: 22 }}>All clear. I'll shout, politely, if anything comes up.</div>}
        {data?.open.map((it) => (
          <div key={it.id} className="stack g14" style={{ border: `1px solid ${it.urgent ? "#EBD9AE" : "var(--line)"}`, background: it.urgent ? "#FFF8EA" : "#fff", borderRadius: 24, padding: "clamp(18px,2.4vw,28px)" }}>
            <div className="row between g10 wrap">
              <span className="kicker" style={{ color: "var(--ink)" }}>{it.kind}</span>
              <span className="row g8">
                {it.sample && <Tag>Sample</Tag>}
                {it.due_label && <span className="chip plain">{it.due_label}</span>}
              </span>
            </div>
            <div className="serif" style={{ fontSize: "clamp(28px,3vw,36px)", lineHeight: 1.05, letterSpacing: "-.01em" }}>{it.title}</div>
            <div className="row g12" style={{ alignItems: "flex-start" }}>
              <MarkS size={26} />
              <div style={{ fontSize: 16, lineHeight: 1.6, maxWidth: 680, textWrap: "pretty" } as React.CSSProperties}>{it.body}</div>
            </div>
            <div className="row g8 wrap" style={{ paddingLeft: 38 }}>
              <button className="btn ink" onClick={() => act(it, "primary")}>{it.primary_label}</button>
              {it.secondary_label && <button className="btn ghost" onClick={() => act(it, "secondary")}>{it.secondary_label}</button>}
              <button className="btn link" onClick={() => discuss({ type: "inbox", id: it.id, label: `Needs Sabah · ${it.title}` })}>Talk it through</button>
            </div>
          </div>
        ))}
        {data && data.handled.length > 0 && (
          <div className="stack g8" style={{ paddingTop: 8 }}>
            <Kicker>Handled</Kicker>
            {data.handled.map((h) => (
              <div key={h.id} className="row between g12 wrap" style={{ padding: "12px 0", borderBottom: "1px solid var(--line)", fontSize: 14.5 }}>
                <span>{h.title}</span>
                <span className="muted">You chose “{h.resolution}” · {h.resolved_at ? when(h.resolved_at) : ""}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
