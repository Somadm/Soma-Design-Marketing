import { hostname } from "node:os";
import { loadConfig } from "./config.js";
import { migrate } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { buildServer } from "./http/server.js";
import { seedSources } from "./kb/store.js";
import { ClaudeResearchModel } from "./research/claude.js";
import { VoyageEmbedder } from "./research/embeddings.js";
import { startWorker, type WorkerHandle } from "./refresh/worker.js";

async function main() {
  const cfg = loadConfig();
  const db = createPool(cfg.DATABASE_URL);
  const applied = await migrate(db);
  if (applied.length) console.log(`Applied migrations: ${applied.join(", ")}`);
  await seedSources(db);

  const model = cfg.ANTHROPIC_API_KEY ? new ClaudeResearchModel(cfg) : null;
  if (!model) console.warn("ANTHROPIC_API_KEY is not set: research is disabled until it is configured.");
  const embedder = cfg.VOYAGE_API_KEY ? new VoyageEmbedder(cfg) : null;
  const deployed = cfg.DEPLOYMENT_ENV === "production";

  let worker: WorkerHandle | null = null;
  if (cfg.PROCESS_ROLE !== "web") {
    worker = startWorker({ db, cfg, model, embedder, workerId: `${hostname()}:${process.pid}`, deployed });
    console.log(`Worker started (${deployed ? "production" : cfg.DEPLOYMENT_ENV}); kb_tick every ${cfg.TICK_MINUTES} min`);
  }
  const app = cfg.PROCESS_ROLE !== "worker" ? await buildServer({ db, cfg, model, embedder, wakeWorker: worker?.wake }) : null;
  if (app) await app.listen({ port: cfg.PORT, host: cfg.HOST });

  const shutdown = async (signal: string) => {
    console.log(`${signal} received, shutting down`);
    await app?.close();
    // An interrupted refresh is recovered by kb_tick's stuck-run rule and retried.
    await Promise.race([worker?.stop(), new Promise((r) => setTimeout(r, 20_000))]);
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
