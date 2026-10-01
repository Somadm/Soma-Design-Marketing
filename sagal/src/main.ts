import { maybeRunRoutine } from "./agent/routine.js";
import { AuthService } from "./auth/service.js";
import { loadConfig } from "./config.js";
import { migrate } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { Notifier } from "./domain/notify.js";
import { ResendMailer } from "./email.js";
import { buildServer } from "./http/server.js";
import { startWorker } from "./publishing/worker.js";
import { Vault } from "./secrets/vault.js";
import { createStorages } from "./storage/storage.js";

async function main() {
  const cfg = loadConfig();
  const db = createPool(cfg.DATABASE_URL);
  const applied = await migrate(db);
  if (applied.length) console.log(`Applied migrations: ${applied.join(", ")}`);
  const vault = new Vault(db, cfg.SECRETS_MASTER_KEY);
  const mailer = new ResendMailer(cfg, vault);
  const auth = new AuthService(db, cfg, mailer);
  const notifier = new Notifier(db, cfg, mailer, () => auth.ownerEmail());
  const storages = createStorages(cfg);
  const app = await buildServer({ db, cfg, vault, auth, storages, mailer, notifier });
  // Sagal's morning routine: keeps the posting days filled (drafts + one-tap proposals).
  const worker = startWorker(db, notifier, cfg.WORKER_POLL_SECONDS, () => maybeRunRoutine({ db, cfg, vault, storages, notifier }));
  await app.listen({ port: cfg.PORT, host: cfg.HOST });
  console.log(`Sagal is running at ${cfg.APP_URL} (storage: ${cfg.STORAGE_DRIVER}, models: ${cfg.SAGAL_MODEL_EVERYDAY} / ${cfg.SAGAL_MODEL_DEEP})`);

  const shutdown = async (signal: string) => {
    console.log(`${signal} received, shutting down`);
    await app.close();
    await Promise.race([worker.stop(), new Promise((r) => setTimeout(r, 15_000))]);
    await db.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
