import Anthropic from "@anthropic-ai/sdk";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { finishOAuth, PROVIDERS, redirectUri, startOAuth } from "../../integrations/oauth.js";
import { disconnect, integrationStates, saveCredentials, serviceDef, SERVICES, setState, type ServiceId } from "../../integrations/registry.js";
import { HttpError, parse, type Deps } from "../deps.js";

export async function accountRoutes(app: FastifyInstance, deps: Deps) {
  const { db, vault, cfg } = deps;
  const svc = (s: string) => {
    const d = serviceDef(s);
    if (!d) throw new HttpError(404, "Unknown service.");
    return d;
  };

  /** Connected accounts: what each service needs, its state, and hints (never values). */
  app.get("/api/accounts", async () => {
    const states = await integrationStates(db);
    const hints = await vault.hints();
    return {
      services: SERVICES.map((s) => ({
        ...s,
        state: states[s.id]?.state ?? "not_connected",
        account: states[s.id]?.account_label ?? null,
        connectedAt: states[s.id]?.connected_at ?? null,
        lastError: states[s.id]?.last_error ?? null,
        saved: Object.fromEntries(s.fields.map((f) => [f.key, hints[`${s.id}.${f.key}`] ? (f.secret ? hints[`${s.id}.${f.key}`].hint : "saved") : null])),
        envFallback: s.id === "anthropic" ? Boolean(cfg.ANTHROPIC_API_KEY) : s.id === "email" ? Boolean(cfg.RESEND_API_KEY) : false,
        redirectUri: s.oauth ? redirectUri(cfg, s.id) : null,
      })),
    };
  });

  app.put("/api/accounts/:service", async (req) => {
    const s = svc((req.params as { service: string }).service);
    const values = parse(z.record(z.string().max(40), z.string().max(4000)), req.body);
    try {
      await saveCredentials(db, vault, s, values);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    return { ok: true };
  });

  app.delete("/api/accounts/:service", async (req) => {
    const s = svc((req.params as { service: string }).service);
    await disconnect(db, vault, s.id);
    return { ok: true };
  });

  /** Optional check Sabah can run after pasting a key. Only runs when she presses it. */
  app.post("/api/accounts/:service/test", async (req) => {
    const s = svc((req.params as { service: string }).service);
    const f = deps.fetchImpl ?? fetch;
    try {
      if (s.id === "anthropic") {
        const key = (await vault.get("anthropic.api_key")) ?? cfg.ANTHROPIC_API_KEY;
        if (!key) throw new Error("No key saved yet.");
        await new Anthropic({ apiKey: key, maxRetries: 0 }).models.retrieve(cfg.SAGAL_MODEL);
        await setState(db, "anthropic", "connected", { account: cfg.SAGAL_MODEL });
        return { ok: true, message: `Claude answered. Sagal will think with ${cfg.SAGAL_MODEL}.` };
      }
      if (s.id === "email") {
        const to = await deps.auth.ownerEmail();
        if (!to) throw new Error("No owner email.");
        const how = await deps.mailer.send({ to, subject: "Sagal · test email", text: "If you can read this, Sagal can email you." });
        if (how === "logged") throw new Error("No Resend key saved yet.");
        await setState(db, "email", "connected", { account: to });
        return { ok: true, message: `Sent a test email to ${to}.` };
      }
      void f;
      return { ok: false, message: "There's no test for this one yet. It's checked when it's first used." };
    } catch (err) {
      await setState(db, s.id, "needs_reconnect", { error: (err as Error).message });
      return { ok: false, message: (err as Error).message };
    }
  });

  app.get("/api/oauth/:service/start", async (req, reply) => {
    const s = svc((req.params as { service: string }).service);
    if (!PROVIDERS[s.id]) throw new HttpError(400, "This service uses an API key.");
    try {
      return reply.redirect(await startOAuth(db, cfg, vault, s.id));
    } catch (err) {
      return reply.redirect(`/memory/accounts?service=${s.id}&ok=0&message=${encodeURIComponent((err as Error).message)}`);
    }
  });

  app.get("/api/oauth/:service/callback", async (req, reply) => {
    const id = (req.params as { service: string }).service as ServiceId;
    const r = await finishOAuth(db, cfg, vault, id, req.query as Record<string, string>, deps.fetchImpl);
    return reply.redirect(`/memory/accounts?service=${id}&ok=${r.ok ? 1 : 0}&message=${encodeURIComponent(r.message)}`);
  });
}
