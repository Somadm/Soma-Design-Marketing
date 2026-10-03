import Anthropic from "@anthropic-ai/sdk";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { accountLabel, graph, metaAccount } from "../../integrations/meta.js";
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
    // Keys that can be checked are checked straight away, so "connected" means it works.
    if (s.id === "heygen") return { ok: true, test: await testService(s.id) };
    return { ok: true };
  });

  app.delete("/api/accounts/:service", async (req) => {
    const s = svc((req.params as { service: string }).service);
    await disconnect(db, vault, s.id);
    return { ok: true };
  });

  /** Checks a saved key against the service itself. Only runs when Sabah saves or presses Test. */
  async function testService(id: ServiceId): Promise<{ ok: boolean; message: string }> {
    const f = deps.fetchImpl ?? fetch;
    try {
      if (id === "anthropic") {
        const key = (await vault.get("anthropic.api_key")) ?? cfg.ANTHROPIC_API_KEY;
        if (!key) throw new Error("No key saved yet.");
        const client = new Anthropic({ apiKey: key, maxRetries: 0 });
        await client.models.retrieve(cfg.SAGAL_MODEL_EVERYDAY);
        await client.models.retrieve(cfg.SAGAL_MODEL_DEEP);
        await setState(db, "anthropic", "connected", { account: "Sonnet 5.5 + Opus 5.5" });
        return { ok: true, message: "Claude answered. Sagal can use both Sonnet 5.5 and Opus 5.5." };
      }
      if (id === "email") {
        const to = await deps.auth.ownerEmail();
        if (!to) throw new Error("No owner email.");
        const how = await deps.mailer.send({ to, subject: "Sagal · test email", text: "If you can read this, Sagal can email you." });
        if (how === "logged") throw new Error("No Resend key saved yet.");
        await setState(db, "email", "connected", { account: to });
        return { ok: true, message: `Sent a test email to ${to}.` };
      }
      if (id === "heygen") {
        const key = await vault.get("heygen.api_key");
        if (!key) throw new Error("No HeyGen key saved yet.");
        const r = await f("https://api.heygen.com/v2/user/remaining_quota", { headers: { "X-Api-Key": key, accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
        const body = (await r.json().catch(() => null)) as { error?: unknown; data?: { remaining_quota?: number } } | null;
        if (r.status === 401 || r.status === 403) throw new Error("HeyGen didn't accept this key. Copy it again from HeyGen → Settings → API (the API key, not your password) and paste it here.");
        if (!r.ok || !body || body.error) throw new Error(`HeyGen answered with an error (${r.status}). Try again in a minute.`);
        const credit = typeof body.data?.remaining_quota === "number" ? ` · API credit left: ${body.data.remaining_quota}` : "";
        await setState(db, "heygen", "connected", { account: `API key works${credit}` });
        return { ok: true, message: `HeyGen accepted the key${credit}.` };
      }
      if (id === "meta") {
        const acct = await metaAccount(vault);
        if (!acct) throw new Error("Press Connect first (or again): Sagal doesn't have your Page's access yet.");
        const page = await graph<{ name: string; instagram_business_account?: { id: string; username?: string } }>(f, "GET", acct.pageId, {
          fields: "name,instagram_business_account{id,username}",
          access_token: acct.pageToken,
        });
        const ig = page.instagram_business_account;
        await setState(db, "meta", "connected", { account: accountLabel({ pageName: page.name, igUsername: ig?.username ?? null }) });
        return {
          ok: true,
          message: ig ? `Facebook Page “${page.name}” and Instagram @${ig.username} are ready. Sagal can post to both.` : `Facebook Page “${page.name}” is ready. No Instagram account is linked to it, so Instagram posts are handed to you.`,
        };
      }
      return { ok: false, message: "There's no test for this one yet. It's checked when it's first used." };
    } catch (err) {
      const message = (err as Error).name === "TimeoutError" ? "The service took too long to answer. Try again in a minute." : (err as Error).message;
      await setState(db, id, "needs_reconnect", { error: message });
      return { ok: false, message };
    }
  }

  app.post("/api/accounts/:service/test", async (req) => testService(svc((req.params as { service: string }).service).id));

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
