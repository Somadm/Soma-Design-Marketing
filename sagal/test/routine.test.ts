import { afterEach, describe, expect, it } from "vitest";
import { maybeRunRoutine, postingGaps } from "../src/agent/routine.js";
import { getSettings, setSetting } from "../src/domain/settings.js";
import { createStorages } from "../src/storage/storage.js";
import { addDays, helsinkiDate, helsinkiToUtc } from "../src/time.js";
import { api, FakeBrain, makeApp, type TestApp } from "./helpers.js";

let t: TestApp | undefined;
afterEach(async () => {
  await t?.app.close();
  await t?.db.end();
  t = undefined;
});

const today = () => helsinkiDate(new Date());
const deps = (t: TestApp) => ({ db: t.db, cfg: t.cfg, vault: t.vault, storages: createStorages(t.cfg), brain: () => t.brain });

describe("Sagal's morning routine", () => {
  it("finds empty posting days in the next week, skipping planned and proposed ones", async () => {
    t = await makeApp();
    await setSetting(t.db, "routine", { enabled: true, days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], lastRun: null });
    const routine = (await getSettings(t.db)).routine;
    const all = await postingGaps(t.db, routine);
    expect(all).toEqual(Array.from({ length: 7 }, (_, i) => addDays(today(), i + 1)));
    // One day planned, one day waiting for Sabah's yes.
    const idea = (await api(t).post("/api/ideas", { title: "Planned", platforms: ["Instagram"] })).json().idea;
    await api(t).post(`/api/ideas/${idea.id}/plan`, { date: all[0] });
    await t.db.query("INSERT INTO sagal.inbox_items (kind, title, body, primary_label, dedupe_key) VALUES ('Approval needed','x','x','Plan it',$1)", [`plan-proposal:${all[1]}`]);
    expect(await postingGaps(t.db, routine)).toEqual(all.slice(2));
  });

  it("prepares posts for empty days and asks Sabah; her one tap plans it", async () => {
    let gapDate = "";
    const brain = new FakeBrain((input) => {
      const ctx = JSON.stringify(input.history);
      gapDate = /\((\d{4}-\d{2}-\d{2})\)/.exec(ctx)![1];
      return {
        text: "Prepared one post for you.",
        tools: [
          { name: "create_idea", input: { title: "Three drafts, one survived", story: "s", audience: "a", purpose: "p", format: "Carousel", platforms: ["Instagram"] } },
          { name: "create_carousel", input: { title: "Three drafts, one survived", idea_id: 1, slides: [{ headline: "We threw away two drafts." }], captions: { Instagram: "Two drafts didn't make it." } } },
          { name: "propose_post", input: { idea_id: 1, date: gapDate, why: "You haven't posted process work in a while." } },
        ],
      };
    });
    t = await makeApp({ cfg: { ANTHROPIC_API_KEY: "sk-ant-test" }, brain });
    await setSetting(t.db, "routine", { enabled: true, days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], lastRun: null });

    // Not before 07:30 Helsinki.
    expect((await maybeRunRoutine(deps(t), { now: helsinkiToUtc(today(), "06:00") })).ran).toBe(false);
    const r = await maybeRunRoutine(deps(t), { now: helsinkiToUtc(today(), "08:00") });
    expect(r.ran).toBe(true);
    expect(brain.calls[0].model).toBe("claude-opus-5-5");
    // Once a day.
    expect((await maybeRunRoutine(deps(t), { now: helsinkiToUtc(today(), "09:00") })).ran).toBe(false);

    const a = api(t);
    const item = (await a.get("/api/inbox")).json().open.find((i: { kind: string }) => i.kind === "Approval needed");
    expect(item.primary_label).toBe("Plan it");
    expect(item.primary_action).toBe(`plan_idea:1:${gapDate}:12:00`);
    // Nothing is planned until Sabah taps.
    expect((await t.db.query("SELECT status FROM sagal.ideas WHERE id = 1")).rows[0].status).toBe("board");
    expect((await a.post(`/api/inbox/${item.id}/act`, { which: "primary" })).statusCode).toBe(200);
    expect((await t.db.query("SELECT status, to_char(plan_date,'YYYY-MM-DD') AS d FROM sagal.ideas WHERE id = 1")).rows[0]).toEqual({ status: "agreed", d: gapDate });
    const post = (await t.db.query("SELECT platform, carousel_id, caption FROM sagal.posts WHERE idea_id = 1")).rows[0];
    expect(post).toMatchObject({ platform: "Instagram", caption: "Two drafts didn't make it." });
    expect(post.carousel_id).toBeTruthy();
    // The thread shows what happened.
    const conv = (await t.db.query("SELECT c.id FROM sagal.conversations c WHERE c.title = 'Morning check'")).rows[0].id;
    const texts = (await a.get(`/api/conversations/${conv}`)).json().messages.map((m: { text: string }) => m.text);
    expect(texts.some((x: string) => x.startsWith("Morning routine."))).toBe(true);
    expect(texts).toContain("Prepared one post for you.");
  });

  it("stays quiet when it's paused, Claude isn't connected, or the week is covered", async () => {
    t = await makeApp();
    expect((await maybeRunRoutine(deps(t), { now: helsinkiToUtc(today(), "08:00") })).ran).toBe(false); // no Claude key
    expect(t.brain.calls).toHaveLength(0);
    expect((await api(t).patch("/api/settings/routine", { enabled: false, days: ["Fri", "Mon"] })).statusCode).toBe(200);
    expect((await api(t).get("/api/routine")).json().routine).toMatchObject({ enabled: false, days: ["Mon", "Fri"] });
    await setSetting(t.db, "routine", { enabled: true, days: [], lastRun: null });
    expect(await postingGaps(t.db, (await getSettings(t.db)).routine)).toEqual([]);
  });

  it("propose_post only accepts real ideas on future days", async () => {
    const brain = new FakeBrain(() => ({ text: "ok", tools: [{ name: "propose_post", input: { idea_id: 1, date: today(), why: "x" } }] }));
    t = await makeApp({ cfg: { ANTHROPIC_API_KEY: "sk-ant-test" }, brain });
    await api(t).post("/api/ideas", { title: "An idea", platforms: ["Instagram"] });
    const conv = (await api(t).post("/api/conversations", {})).json().id;
    const r = await api(t).post(`/api/conversations/${conv}/messages`, { text: "Propose it for today" });
    expect(r.body).toContain("Pick a date from tomorrow on.");
  });
});
