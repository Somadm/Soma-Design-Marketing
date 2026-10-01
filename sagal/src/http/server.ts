import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fastifyCookie from "@fastify/cookie";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { AuthError, SESSION_DAYS } from "../auth/service.js";
import { storageFilename } from "../storage/storage.js";
import { COOKIE, HttpError, type Deps } from "./deps.js";
import { accountRoutes } from "./routes/accounts.js";
import { authRoutes } from "./routes/auth.js";
import { contentRoutes } from "./routes/content.js";
import { memoryRoutes } from "./routes/memory.js";
import { planRoutes } from "./routes/plan.js";
import { talkRoutes } from "./routes/talk.js";

const here = path.dirname(fileURLToPath(import.meta.url));


/** Screens served by the single-page app. */
const APP_PATHS = ["/", "/talk", "/talk/*", "/inbox", "/plan", "/carousel", "/carousel/*", "/video", "/video/*", "/publish", "/inspo", "/results", "/memory", "/memory/*", "/voicetest", "/bilan", "/signin"];

export async function buildServer(deps: Deps): Promise<FastifyInstance> {
  const { cfg } = deps;
  const app = Fastify({
    logger: process.env.NODE_ENV === "test" ? false : { level: "info", redact: ["req.headers.cookie"] },
    bodyLimit: 1024 * 1024,
    trustProxy: true,
  });
  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, { limits: { fileSize: cfg.MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 10 } });

  const publicDir = [path.resolve(here, "../../public"), path.resolve(here, "../../../public")].find((p) => existsSync(p));
  if (publicDir) {
    await app.register(fastifyStatic, { root: publicDir, prefix: "/", index: false, wildcard: false });
    for (const p of APP_PATHS) app.get(p, (_req, reply) => reply.header("cache-control", "no-store").sendFile("index.html"));
  }

  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "same-origin");
    reply.header("x-frame-options", "DENY");
    return payload;
  });

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, _req, reply) => {
    if (err instanceof HttpError || err instanceof AuthError) return reply.code(err.status).send({ error: err.message });
    if (err.code === "FST_REQ_FILE_TOO_LARGE") return reply.code(413).send({ error: `That file is over the ${cfg.MAX_UPLOAD_MB} MB limit.` });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    app.log.error(err);
    return reply.code(500).send({ error: "Something went wrong on the server. It's been logged." });
  });

  app.get("/healthz", async () => {
    await deps.db.query("SELECT 1");
    return { ok: true };
  });

  // Every /api route needs a signed-in session, except sign-in itself and OAuth callbacks
  // (which check their own one-time state). Writes must also carry the x-sagal header,
  // which a cross-site form can't set: a simple CSRF guard on top of SameSite cookies.
  app.addHook("onRequest", async (req, reply) => {
    const url = req.url.split("?")[0];
    if (!url.startsWith("/api/")) return;
    if (req.method !== "GET" && req.method !== "HEAD" && req.headers["x-sagal"] !== "1") {
      return reply.code(403).send({ error: "Missing x-sagal header" });
    }
    if (url.startsWith("/api/auth/") || /^\/api\/oauth\/[a-z]+\/callback$/.test(url)) return;
    if (!(await deps.auth.checkSession(req.cookies[COOKIE]))) return reply.code(401).send({ error: "Please sign in." });
  });

  // Local-disk media (development): signed, expiring links only.
  if (deps.storages.local) {
    const local = deps.storages.local;
    app.get("/media/*", async (req, reply) => {
      const key = (req.params as { "*": string })["*"];
      const q = req.query as { exp?: string; name?: string; sig?: string };
      if (!local.verify(key, Number(q.exp), q.name ?? "", q.sig ?? "")) return reply.code(403).send({ error: "This link has expired." });
      const name = storageFilename(q.name ?? "file");
      reply.header("content-disposition", `inline; filename="${name}"`).header("cache-control", "private, max-age=300");
      const ext = path.extname(name).toLowerCase();
      const types: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".pdf": "application/pdf", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".webm": "audio/webm", ".ogg": "audio/ogg", ".mp4": "video/mp4", ".mov": "video/quicktime", ".txt": "text/plain; charset=utf-8", ".srt": "text/plain; charset=utf-8" };
      reply.type(types[ext] ?? "application/octet-stream");
      try {
        return reply.send(await local.read(key));
      } catch {
        return reply.code(404).send({ error: "Not found" });
      }
    });
  }

  await authRoutes(app, deps, {
    setSession: (reply, token) =>
      reply.setCookie(COOKIE, token, {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: cfg.APP_URL.startsWith("https://"),
        maxAge: SESSION_DAYS * 86400,
      }),
    clearSession: (reply) => reply.clearCookie(COOKIE, { path: "/" }),
  });
  await talkRoutes(app, deps);
  await planRoutes(app, deps);
  await contentRoutes(app, deps);
  await memoryRoutes(app, deps);
  await accountRoutes(app, deps);
  return app;
}
