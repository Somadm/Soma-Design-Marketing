import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { Brain, TurnCallbacks, TurnInput, TurnResult } from "../src/agent/brain.js";
import { runTool, type ToolContext } from "../src/agent/tools.js";
import { AuthService } from "../src/auth/service.js";
import { testConfig, type Config } from "../src/config.js";
import { migrate } from "../src/db/migrate.js";
import { createPool, type Db } from "../src/db/pool.js";
import type { Previewer } from "../src/domain/inspiration.js";
import { Notifier } from "../src/domain/notify.js";
import { LinkError } from "../src/inspiration/linkPreview.js";
import { MemoryMailer } from "../src/email.js";
import { buildServer } from "../src/http/server.js";
import { Vault } from "../src/secrets/vault.js";
import { createStorages } from "../src/storage/storage.js";

process.env.NODE_ENV = "test";
export const TEST_DB = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/sagal_test";
export const OWNER = "sabah@example.com";
export const PASSWORD = "correct horse battery";

export async function freshDb(): Promise<Db> {
  const db = createPool(TEST_DB);
  await db.query("DROP SCHEMA IF EXISTS sagal CASCADE; DROP SCHEMA IF EXISTS shared CASCADE;");
  await migrate(db);
  return db;
}

/** Tests never reach the internet: by default a link can't be read. */
const noInternet: Previewer = async () => {
  throw new LinkError("No internet in tests.");
};

/** A scripted stand-in for Claude: each reply can stream text and call Sagal's real tools. */
export class FakeBrain implements Brain {
  calls: TurnInput[] = [];
  constructor(public script: (input: TurnInput) => { text: string; tools?: { name: string; input: unknown }[]; error?: Error; escalate?: string }) {}
  async reply(input: TurnInput, ctx: ToolContext, cb: TurnCallbacks): Promise<TurnResult> {
    this.calls.push(input);
    const step = this.script(input);
    if (step.error) throw step.error;
    if (step.escalate && input.allowEscalate) return { text: "", effects: [], model: input.model, escalate: step.escalate };
    const effects = [];
    for (const t of step.tools ?? []) {
      const out = await runTool(t.name, t.input, ctx);
      if (out.isError) throw new Error(out.result);
      if (out.effect) {
        effects.push(out.effect);
        cb.onEffect(out.effect);
      }
    }
    for (const w of step.text.split(/(?<= )/)) cb.onText(w);
    return { text: step.text, effects, model: input.model };
  }
}

export interface TestApp {
  app: FastifyInstance;
  db: Db;
  cfg: Config;
  vault: Vault;
  mailer: MemoryMailer;
  brain: FakeBrain;
  cookie: string;
}

export async function makeApp(opts: { cfg?: Record<string, string>; brain?: FakeBrain; fetchImpl?: typeof fetch; linkPreview?: Previewer; signIn?: boolean } = {}): Promise<TestApp> {
  const db = await freshDb();
  const cfg = testConfig({
    DATABASE_URL: TEST_DB,
    OWNER_EMAIL: OWNER,
    LOCAL_MEDIA_DIR: mkdtempSync(path.join(tmpdir(), "sagal-media-")),
    APP_URL: "http://localhost:8080",
    ...opts.cfg,
  });
  const vault = new Vault(db, cfg.SECRETS_MASTER_KEY);
  const mailer = new MemoryMailer();
  const auth = new AuthService(db, cfg, mailer);
  const notifier = new Notifier(db, cfg, mailer, () => auth.ownerEmail());
  const brain = opts.brain ?? new FakeBrain(() => ({ text: "Got it." }));
  const app = await buildServer({ db, cfg, vault, auth, storages: createStorages(cfg), mailer, notifier, brain: () => brain, fetchImpl: opts.fetchImpl, linkPreview: opts.linkPreview ?? noInternet });
  const t: TestApp = { app, db, cfg, vault, mailer, brain, cookie: "" };
  if (opts.signIn !== false) t.cookie = await signUp(t);
  return t;
}

export function lastCode(mailer: MemoryMailer): string {
  const m = mailer.sent[mailer.sent.length - 1];
  return /(\d{6})/.exec(m.subject)![1];
}

export async function signUp(t: TestApp): Promise<string> {
  const r = await t.app.inject({ method: "POST", url: "/api/auth/register", headers: { "x-sagal": "1" }, payload: { email: OWNER, password: PASSWORD } });
  const { challengeId } = r.json();
  const v = await t.app.inject({ method: "POST", url: "/api/auth/verify", headers: { "x-sagal": "1" }, payload: { challengeId, code: lastCode(t.mailer) } });
  const set = v.headers["set-cookie"];
  return String(Array.isArray(set) ? set[0] : set).split(";")[0];
}

/** Authenticated request helper. */
export function api(t: TestApp) {
  const call = async (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
    const r = await t.app.inject({ method, url, headers: { cookie: t.cookie, "x-sagal": "1" }, payload: payload as object });
    return r;
  };
  return {
    get: (u: string) => call("GET", u),
    post: (u: string, p?: unknown) => call("POST", u, p ?? {}),
    put: (u: string, p?: unknown) => call("PUT", u, p ?? {}),
    patch: (u: string, p?: unknown) => call("PATCH", u, p ?? {}),
    del: (u: string) => call("DELETE", u),
  };
}

/** Parses an SSE body into events. */
export function sse(body: string): { type: string; [k: string]: unknown }[] {
  return body
    .split("\n\n")
    .filter((c) => c.startsWith("data: "))
    .map((c) => JSON.parse(c.slice(6)));
}

export function multipart(field: string, filename: string, contentType: string, content: Buffer | string) {
  const boundary = "----sagaltest" + Math.random().toString(16).slice(2);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
    Buffer.isBuffer(content) ? content : Buffer.from(content),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

export async function upload(t: TestApp, url: string, filename: string, contentType: string, content: Buffer | string = "data") {
  const m = multipart("file", filename, contentType, content);
  return t.app.inject({ method: "POST", url, headers: { cookie: t.cookie, "x-sagal": "1", ...m.headers }, payload: m.body });
}
