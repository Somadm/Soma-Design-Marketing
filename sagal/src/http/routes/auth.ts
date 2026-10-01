import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { COOKIE, parse, type Deps } from "../deps.js";

export async function authRoutes(
  app: FastifyInstance,
  { auth, cfg }: Deps,
  s: { setSession(reply: FastifyReply, token: string): void; clearSession(reply: FastifyReply): void },
) {
  const Creds = z.object({ email: z.string().max(200), password: z.string().max(200) });

  app.get("/api/auth/status", async (req) => ({
    ownerExists: await auth.ownerExists(),
    signedIn: await auth.checkSession(req.cookies[COOKIE]),
    email: (await auth.checkSession(req.cookies[COOKIE])) ? await auth.ownerEmail() : null,
    ownerEmailHint: cfg.OWNER_EMAIL ? cfg.OWNER_EMAIL.replace(/^(.).*(@.*)$/, "$1…$2") : null,
  }));

  const sent = (r: { challengeId: string; delivery: "sent" | "logged" }) => ({
    challengeId: r.challengeId,
    delivery: r.delivery,
    note: r.delivery === "logged" ? "Email isn't set up yet, so the code was written to the server log. Find it in your hosting dashboard's Logs." : null,
  });

  app.post("/api/auth/register", async (req) => {
    const b = parse(Creds, req.body);
    return sent(await auth.register(b.email, b.password));
  });

  app.post("/api/auth/login", async (req) => {
    const b = parse(Creds, req.body);
    return sent(await auth.login(b.email, b.password));
  });

  app.post("/api/auth/forgot", async (req) => {
    const b = parse(z.object({ email: z.string().max(200) }), req.body);
    return sent(await auth.requestReset(b.email));
  });

  app.post("/api/auth/verify", async (req, reply) => {
    const b = parse(z.object({ challengeId: z.string().max(100), code: z.string().max(20), newPassword: z.string().max(200).optional() }), req.body);
    const token = await auth.verify(b.challengeId, b.code, b.newPassword, req.headers["user-agent"]);
    s.setSession(reply, token);
    return { ok: true };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    await auth.logout(req.cookies[COOKIE]);
    s.clearSession(reply);
    return { ok: true };
  });
}
