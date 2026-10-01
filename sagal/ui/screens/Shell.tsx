import React, { useEffect, useState } from "react";
import { api } from "../api";
import { MarkS, Tag, useApp, useClock, useRouter } from "../lib";
import { BilanScreen } from "./Bilan";
import { CarouselScreen } from "./Carousel";
import { InboxScreen } from "./Inbox";
import { InspirationScreen } from "./Inspiration";
import { MemoryScreen } from "./Memory";
import { PlanScreen } from "./Plan";
import { PublishingScreen } from "./Publishing";
import { ResultsScreen } from "./Results";
import { TalkScreen, type ThreadNav } from "./Talk";
import { VideoScreen } from "./Video";
import { VoiceTestScreen } from "./VoiceTest";

export const NAV = [
  ["talk", "Talk to Sagal"],
  ["inbox", "Needs Sabah"],
  ["plan", "Plan together"],
  ["carousel", "Carousel studio"],
  ["video", "Video studio"],
  ["publish", "Publishing"],
  ["inspo", "Inspiration"],
  ["results", "Results & Bilan"],
  ["memory", "Memory & settings"],
  ["voicetest", "Test Sagal's voice"],
] as const;
const LABEL: Record<string, string> = Object.fromEntries([...NAV, ["bilan", "Bilan"]]);

export function Shell() {
  const { path, go } = useRouter();
  const { overview, vw, toast, refreshOverview } = useApp();
  const [navOpen, setNavOpen] = useState(false);
  const [threads, setThreads] = useState<ThreadNav | null>(null);
  const clock = useClock();
  const screen = path.split(/[/?]/)[1] || "talk";
  const isMobile = vw < 880;
  const isBilan = screen === "bilan";
  useEffect(() => setNavOpen(false), [path]);
  useEffect(() => {
    if (path === "/" || path === "/signin") go("/talk");
  }, [path, go]);

  const signOut = async () => {
    await api.post("/api/auth/logout").catch(() => {});
    location.href = "/";
  };

  const content = (() => {
    switch (screen) {
      case "inbox": return <InboxScreen />;
      case "plan": return <PlanScreen />;
      case "carousel": return <CarouselScreen />;
      case "video": return <VideoScreen />;
      case "publish": return <PublishingScreen />;
      case "inspo": return <InspirationScreen />;
      case "results": return <ResultsScreen />;
      case "memory": return <MemoryScreen />;
      case "voicetest": return <VoiceTestScreen />;
      case "bilan": return <BilanScreen />;
      default: return <TalkScreen onThreads={setThreads} />;
    }
  })();

  const nav = (
    <nav className={`nav${isMobile ? " mobile" : ""}`} aria-label="Sagal">
      <div className="stack g14" style={{ padding: "18px 16px 14px" }}>
        <div className="row between">
          <div className="wordmark">Soma</div>
          {isMobile && (
            <button onClick={() => setNavOpen(false)} aria-label="Close menu" className="circle-btn" style={{ width: 36, height: 36 }}>
              ×
            </button>
          )}
        </div>
        <div className="seg" role="group" aria-label="Workspace">
          <button className={!isBilan ? "on" : ""} onClick={() => go("/talk")}>
            <MarkS size={16} url={overview?.portraitUrl} />
            Sagal
          </button>
          <button className={isBilan ? "on" : ""} onClick={() => go("/bilan")}>
            <span className="mark-b" style={{ width: 16, height: 16, fontSize: 10 }}>B</span>Bilan
          </button>
        </div>
        <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.4 }}>{isBilan ? "Paid advertising strategist" : "Creative producer & organic social"}</div>
      </div>
      <div className="stack g4" style={{ padding: "2px 8px 12px" }}>
        {NAV.map(([id, label]) => (
          <React.Fragment key={id}>
            <a
              href={`/${id}`}
              className={`nav-item${screen === id ? " on" : ""}`}
              aria-current={screen === id ? "page" : undefined}
              onClick={(e) => {
                e.preventDefault();
                go(`/${id}`);
              }}
            >
              <span>{label}</span>
              {id === "inbox" && overview && overview.inboxCount > 0 && <span className="badge">{overview.inboxCount}</span>}
            </a>
            {id === "talk" && screen === "talk" && threads && (
              <div className="stack g10" style={{ padding: "4px 0 10px 10px" }}>
                <button onClick={threads.newThread} className="pill sm" style={{ alignSelf: "flex-start", borderStyle: "dashed", borderColor: "var(--dash)", background: "transparent" }}>
                  + New conversation
                </button>
                {threads.projects.map((p) => (
                  <div key={p.id} className="stack g4">
                    <div className="kicker sm" style={{ padding: "0 8px 2px" }}>{p.name}</div>
                    {p.threads.map((t) => (
                      <button key={t.id} className={`thread${t.id === threads.current ? " on" : ""}`} onClick={() => threads.open(t.id)}>
                        <span className="t">{t.title}</span>
                        <span className="muted" style={{ fontSize: 11.5, flexShrink: 0 }}>{t.when}</span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </React.Fragment>
        ))}
      </div>
      <div className="stack g10" style={{ marginTop: "auto", padding: "14px 16px 18px", borderTop: "1px solid var(--line)" }}>
        {overview?.sample && (
          <div className="stack g6">
            <Tag>Sample content loaded</Tag>
            <button
              className="btn link xs"
              style={{ alignSelf: "flex-start", fontSize: 12 }}
              onClick={async () => {
                await api.post("/api/sample/remove");
                refreshOverview();
                toast("Sample content removed.");
                go(path);
                location.reload();
              }}
            >
              Remove sample content
            </button>
          </div>
        )}
        <div className="xs muted" style={{ lineHeight: 1.4 }}>Sabah · Europe/Helsinki · {clock}</div>
        <button className="btn link xs" style={{ alignSelf: "flex-start", fontSize: 12 }} onClick={signOut}>
          Sign out
        </button>
      </div>
    </nav>
  );

  return (
    <div className="app">
      {isMobile && navOpen && <div className="backdrop" onClick={() => setNavOpen(false)} />}
      {(!isMobile || navOpen) && nav}
      <main className="main">
        {isMobile && (
          <div className="topbar">
            <button className="pill" onClick={() => setNavOpen(true)} style={{ minHeight: 44 }} aria-label="Open menu">
              Menu
              {overview && overview.inboxCount > 0 && <span className="badge" style={{ marginLeft: 8 }}>{overview.inboxCount}</span>}
            </button>
            <div style={{ fontWeight: 600, fontSize: 15, textAlign: "center", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{LABEL[screen] ?? "Sagal"}</div>
            <MarkS size={36} url={overview?.portraitUrl} />
          </div>
        )}
        {content}
      </main>
    </div>
  );
}
