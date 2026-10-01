import React from "react";
import { MarkB, useRouter } from "../lib";

export function BilanScreen() {
  const { go } = useRouter();
  return (
    <div className="scroll" style={{ background: "var(--stone)" }}>
      <div className="stack g20" style={{ maxWidth: 900, margin: "0 auto", padding: "clamp(32px,6vw,80px) clamp(18px,4vw,48px)", alignItems: "flex-start" }}>
        <MarkB size={56} />
        <div className="kicker">Bilan · Paid advertising strategist</div>
        <h1 className="title-xl">Bilan's workspace is separate.</h1>
        <p className="lede" style={{ fontSize: 17, maxWidth: 600 }}>
          Sagal and Bilan share one memory (business facts, brand assets, approved language) and one task list. Anything they pass between them (briefs, prepared assets, organic posts proposed for paid testing) lives in Results &amp; Bilan, where each task shows who owns it.
        </p>
        <button className="btn ink" onClick={() => go("/results")}>Open shared tasks</button>
      </div>
    </div>
  );
}
