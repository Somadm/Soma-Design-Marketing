import { afterEach, describe, expect, it } from "vitest";
import { lastCode, makeApp, OWNER, PASSWORD, type TestApp } from "./helpers.js";

let t: TestApp;
afterEach(async () => {
  await t?.app.close();
  await t?.db.end();
});

const post = (t: TestApp, url: string, payload: object, cookie = "") =>
  t.app.inject({ method: "POST", url, headers: { "x-sagal": "1", ...(cookie ? { cookie } : {}) }, payload });

describe("sign-in: email + password + emailed code", () => {
  it("only OWNER_EMAIL can create the account, once, after proving the address", async () => {
    t = await makeApp({ signIn: false });
    const stranger = await post(t, "/api/auth/register", { email: "someone@else.com", password: PASSWORD });
    expect(stranger.statusCode).toBe(403);
    const weak = await post(t, "/api/auth/register", { email: OWNER, password: "short" });
    expect(weak.statusCode).toBe(400);

    const r = await post(t, "/api/auth/register", { email: OWNER, password: PASSWORD });
    expect(r.statusCode).toBe(200);
    expect(t.mailer.sent[0].to).toBe(OWNER);
    // Not an owner until the code is confirmed.
    expect((await t.app.inject({ url: "/api/auth/status" })).json().ownerExists).toBe(false);
    const v = await post(t, "/api/auth/verify", { challengeId: r.json().challengeId, code: lastCode(t.mailer) });
    expect(v.statusCode).toBe(200);
    expect(String(v.headers["set-cookie"])).toMatch(/sagal_session=.*HttpOnly.*SameSite=Lax/i);
    const again = await post(t, "/api/auth/register", { email: OWNER, password: PASSWORD });
    expect(again.statusCode).toBe(409);
  });

  it("needs the password AND the emailed code to sign in", async () => {
    t = await makeApp();
    const wrong = await post(t, "/api/auth/login", { email: OWNER, password: "not the password" });
    expect(wrong.statusCode).toBe(401);
    const r = await post(t, "/api/auth/login", { email: " Sabah@Example.com ", password: PASSWORD });
    expect(r.statusCode).toBe(200);
    const bad = await post(t, "/api/auth/verify", { challengeId: r.json().challengeId, code: "000000" === lastCode(t.mailer) ? "111111" : "000000" });
    expect(bad.statusCode).toBe(401);
    const ok = await post(t, "/api/auth/verify", { challengeId: r.json().challengeId, code: lastCode(t.mailer) });
    expect(ok.statusCode).toBe(200);
    const reuse = await post(t, "/api/auth/verify", { challengeId: r.json().challengeId, code: lastCode(t.mailer) });
    expect(reuse.statusCode).toBe(400);
  });

  it("locks out after repeated wrong codes and wrong passwords", async () => {
    t = await makeApp();
    const r = await post(t, "/api/auth/login", { email: OWNER, password: PASSWORD });
    const code = lastCode(t.mailer);
    const wrong = code === "123456" ? "654321" : "123456";
    for (let i = 0; i < 5; i++) await post(t, "/api/auth/verify", { challengeId: r.json().challengeId, code: wrong });
    expect((await post(t, "/api/auth/verify", { challengeId: r.json().challengeId, code })).statusCode).toBe(429);
    for (let i = 0; i < 5; i++) await post(t, "/api/auth/login", { email: OWNER, password: "wrong password!" });
    expect((await post(t, "/api/auth/login", { email: OWNER, password: PASSWORD })).statusCode).toBe(429);
  });

  it("resets a forgotten password with an emailed code and signs out other sessions", async () => {
    t = await makeApp();
    const oldCookie = t.cookie;
    const r = await post(t, "/api/auth/forgot", { email: OWNER });
    const v = await post(t, "/api/auth/verify", { challengeId: r.json().challengeId, code: lastCode(t.mailer), newPassword: "a brand new passphrase" });
    expect(v.statusCode).toBe(200);
    expect((await t.app.inject({ url: "/api/overview", headers: { cookie: oldCookie } })).statusCode).toBe(401);
    expect((await post(t, "/api/auth/login", { email: OWNER, password: "a brand new passphrase" })).statusCode).toBe(200);
    // Unknown address gets the same answer and no email.
    const before = t.mailer.sent.length;
    expect((await post(t, "/api/auth/forgot", { email: "x@y.com" })).statusCode).toBe(200);
    expect(t.mailer.sent.length).toBe(before);
  });

  it("protects every API route and rejects writes without the CSRF header", async () => {
    t = await makeApp();
    expect((await t.app.inject({ url: "/api/conversations" })).statusCode).toBe(401);
    expect((await t.app.inject({ url: "/api/conversations", headers: { cookie: t.cookie } })).statusCode).toBe(200);
    const noHeader = await t.app.inject({ method: "POST", url: "/api/conversations", headers: { cookie: t.cookie }, payload: {} });
    expect(noHeader.statusCode).toBe(403);
    const logout = await post(t, "/api/auth/logout", {}, t.cookie);
    expect(logout.statusCode).toBe(200);
    expect((await t.app.inject({ url: "/api/conversations", headers: { cookie: t.cookie } })).statusCode).toBe(401);
  });
});

describe("code throttling", () => {
  it("won't send a second code within seconds", async () => {
    t = await makeApp();
    expect((await post(t, "/api/auth/login", { email: OWNER, password: PASSWORD })).statusCode).toBe(200);
    expect((await post(t, "/api/auth/login", { email: OWNER, password: PASSWORD })).statusCode).toBe(429);
  });
});
