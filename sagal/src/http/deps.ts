import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { Brain } from "../agent/brain.js";
import type { AuthService } from "../auth/service.js";
import type { Config } from "../config.js";
import type { Db } from "../db/pool.js";
import type { Previewer } from "../domain/inspiration.js";
import type { Notifier } from "../domain/notify.js";
import type { Mailer } from "../email.js";
import type { Vault } from "../secrets/vault.js";
import type { Storages } from "../storage/storage.js";

export interface Deps {
  db: Db;
  cfg: Config;
  vault: Vault;
  auth: AuthService;
  storages: Storages;
  mailer: Mailer;
  notifier: Notifier;
  brain?: (apiKey: string) => Brain;
  fetchImpl?: typeof fetch;
  /** Tests replace the link reader so they never touch the internet. */
  linkPreview?: Previewer;
}

export const COOKIE = "sagal_session";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new HttpError(400, `${issue.path.join(".") || "input"}: ${issue.message}`);
  }
  return r.data;
}

export const idParam = (req: FastifyRequest): number => {
  const id = Number((req.params as { id?: string }).id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "Invalid id");
  return id;
};

export function notFound(reply: FastifyReply, what = "Not found") {
  return reply.code(404).send({ error: what });
}
