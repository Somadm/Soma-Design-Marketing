import { afterEach, describe, expect, it } from "vitest";
import { todayHelsinki } from "../src/domain/plan.js";
import { api, makeApp, type TestApp } from "./helpers.js";

let t: TestApp;
afterEach(async () => {
  await t?.app.close();
  await t?.db.end();
});

describe("Connected accounts", () => {
  it("everything starts not connected; saved keys are encrypted and only hinted", async () => {
    t = await makeApp();
    const a = api(t);
    const first = (await a.get("/api/accounts")).json().services;
    expect(first.every((s: { state: string }) => s.state === "not_connected")).toBe(true);
    expect((await a.put("/api/accounts/captions", {})).statusCode).toBe(400);
    expect((await a.put("/api/accounts/captions", { api_key: "cap_live_abcdefgh1234" })).statusCode).toBe(200);
    const after = (await a.get("/api/accounts")).json().services.find((s: { id: string }) => s.id === "captions");
    expect(after.state).toBe("credentials_saved");
    expect(after.saved.api_key).toBe("…1234");
    expect(JSON.stringify((await a.get("/api/accounts")).json())).not.toContain("cap_live_abcdefgh1234");
    const raw = (await t.db.query("SELECT ciphertext FROM sagal.secrets WHERE name = 'captions.api_key'")).rows[0].ciphertext.toString("utf8");
    expect(raw).not.toContain("cap_live");
    expect(await t.vault.get("captions.api_key")).toBe("cap_live_abcdefgh1234");
    // A saved key isn't "connected" until it's checked: Video studio still offers the manual handoff.
    expect((await a.del("/api/accounts/captions")).statusCode).toBe(200);
    expect(await t.vault.get("captions.api_key")).toBeNull();
  });

  it("checks a HeyGen key as soon as it's saved", async () => {
    let status = 200;
    const seen: string[] = [];
    const fetchImpl = (async (url: string, init: { headers: Record<string, string> }) => {
      seen.push(`${url} ${init.headers["X-Api-Key"]}`);
      return new Response(JSON.stringify(status === 200 ? { error: null, data: { remaining_quota: 1200 } } : { error: { code: 401 } }), { status });
    }) as unknown as typeof fetch;
    t = await makeApp({ fetchImpl });
    const a = api(t);
    const r = (await a.put("/api/accounts/heygen", { api_key: "hg_good_key_1234" })).json();
    expect(r.test).toMatchObject({ ok: true });
    expect(seen[0]).toBe("https://api.heygen.com/v2/user/remaining_quota hg_good_key_1234");
    const hg = () => a.get("/api/accounts").then((x) => x.json().services.find((s: { id: string }) => s.id === "heygen"));
    expect((await hg()).state).toBe("connected");
    status = 401;
    const bad = (await a.put("/api/accounts/heygen", { api_key: "hg_wrong" })).json();
    expect(bad.test.ok).toBe(false);
    expect(bad.test.message).toMatch(/didn't accept this key/);
    expect((await hg()).state).toBe("needs_reconnect");
  });

  it("runs OAuth with a one-time state and stores tokens encrypted", async () => {
    const calls: { url: string; body: string }[] = [];
    const fetchImpl = (async (url: string, init: { body: URLSearchParams }) => {
      calls.push({ url, body: String(init.body) });
      return new Response(JSON.stringify({ access_token: "li_access_token", expires_in: 3600 }), { status: 200 });
    }) as unknown as typeof fetch;
    t = await makeApp({ fetchImpl });
    const a = api(t);
    const noCreds = await a.get("/api/oauth/linkedin/start");
    expect(noCreds.headers.location).toMatch(/ok=0/);
    await a.put("/api/accounts/linkedin", { client_id: "li_client", client_secret: "li_secret_value" });
    const start = await a.get("/api/oauth/linkedin/start");
    const loc = new URL(String(start.headers.location));
    expect(loc.origin + loc.pathname).toBe("https://www.linkedin.com/oauth/v2/authorization");
    expect(loc.searchParams.get("scope")).toContain("w_member_social");
    expect(loc.searchParams.get("redirect_uri")).toBe("http://localhost:8080/api/oauth/linkedin/callback");
    const state = loc.searchParams.get("state")!;

    const forged = await t.app.inject({ url: `/api/oauth/linkedin/callback?code=abc&state=forged` });
    expect(forged.headers.location).toMatch(/ok=0/);
    const cb = await t.app.inject({ url: `/api/oauth/linkedin/callback?code=abc&state=${state}` });
    expect(cb.headers.location).toMatch(/ok=1/);
    expect(calls[0].body).toContain("client_secret=li_secret_value");
    expect(await t.vault.get("linkedin.access_token")).toBe("li_access_token");
    expect((await a.get("/api/accounts")).json().services.find((s: { id: string }) => s.id === "linkedin").state).toBe("connected");
    const replay = await t.app.inject({ url: `/api/oauth/linkedin/callback?code=abc&state=${state}` });
    expect(replay.headers.location).toMatch(/ok=0/);
  });
});

describe("planning, inbox, results and memory", () => {
  it("moving an idea into the plan creates one post per platform at the Helsinki time", async () => {
    t = await makeApp();
    const a = api(t);
    const idea = (await a.post("/api/ideas", { title: "Subway-sign calm", format: "Single image", platforms: ["Instagram", "LinkedIn"] })).json().idea;
    const today = todayHelsinki();
    expect((await a.post(`/api/ideas/${idea.id}/plan`, { date: today, time: "16:00" })).statusCode).toBe(200);
    const pub = (await a.get(`/api/publishing?week=${today}`)).json();
    expect(pub.posts.map((p: { platform: string; time: string; display: string }) => [p.platform, p.time, p.display])).toEqual([
      ["Instagram", "16:00", "later"],
      ["LinkedIn", "16:00", "later"],
    ]);
    expect((await a.post(`/api/ideas/${idea.id}/board`)).statusCode).toBe(200);
    expect((await a.get(`/api/publishing?week=${today}`)).json().posts).toHaveLength(0);
  });

  it("sample content fills every screen and is removable", async () => {
    t = await makeApp();
    const a = api(t);
    await a.post("/api/sample/load");
    const o = (await a.get("/api/overview")).json();
    expect(o).toMatchObject({ sample: true, inboxCount: 4 });
    expect((await a.get("/api/conversations")).json().projects.length).toBe(2);
    expect((await a.get("/api/inspiration")).json().items).toHaveLength(6);
    const results = (await a.get("/api/results")).json();
    expect(results.metrics.sample).toBe(true);
    const ask = results.tasks.find((x: { status: string }) => x.status === "Needs Sabah");
    await a.post(`/api/tasks/${ask.id}/decide`, { decision: "send" });
    expect((await a.get("/api/results")).json().tasks.find((x: { id: number }) => x.id === ask.id).status).toBe("Sent to Bilan");
    const inbox = (await a.get("/api/inbox")).json().open;
    const decision = inbox.find((i: { kind: string }) => i.kind === "Decision");
    await a.post(`/api/inbox/${decision.id}/act`, { which: "secondary" });
    expect((await a.get("/api/inbox")).json().handled[0]).toMatchObject({ resolution: "Use Figma" });
    const go = (await a.post(`/api/inbox/${inbox[0].id}/act`, { which: "primary" })).json();
    expect(go).toEqual({ navigate: "video" });
    await a.post("/api/sample/remove");
    expect((await a.get("/api/overview")).json()).toMatchObject({ sample: false, inboxCount: 0 });
    expect((await a.get("/api/results")).json().metrics).toBeNull();
  });

  it("facts are Sabah's and every change is in the history", async () => {
    t = await makeApp();
    const a = api(t);
    await a.put("/api/memory/facts", { name: "Soma", what: "A small design studio", nonsense: "ignored" });
    const m = (await a.get("/api/memory")).json();
    expect(m.entries.map((e: { key: string; owner: string }) => `${e.key}:${e.owner}`)).toEqual(["name:sabah", "what:sabah"]);
    expect(m.history).toHaveLength(2);
  });
});
