import { hostname } from "node:os";
import { loadConfig } from "./config.js";
import { migrate } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { buildServer } from "./http/server.js";
import { seedSources } from "./knowledge/store.js";
import { ClaudeResearchModel } from "./research/claude.js";
import { startScheduler, type SchedulerHandle } from "./refresh/schedule.js";

async function main() {
  const cfg = loadConfig();
  const db = createPool(cfg.DATABASE_URL);
  const applied = await migrate(db);
  if (applied.length) console.log(`Applied migrations: ${applied.join(", ")}`);
  await seedSources(db);

  const model = cfg.ANTHROPIC_API_KEY ? new ClaudeResearchModel(cfg) : null;
  if (!model) console.warn("ANTHROPIC_API_KEY is not set: research and refreshes are disabled until it is configured.");

  const workerId = `${hostname()}:${process.pid}`;
  let scheduler: SchedulerHandle | null = null;
  if (cfg.PROCESS_ROLE !== "web") {
    scheduler = startScheduler({ db, cfg, model, workerId });
    console.log(`Scheduler started (${workerId}), tick every ${cfg.SCHEDULER_TICK_SECONDS}s`);
  }

  let app: Awaited<ReturnType<typeof buildServer>> | null = null;
  if (cfg.PROCESS_ROLE !== "worker") {
    app = await buildServer({ db, cfg, model, wakeScheduler: scheduler?.wake });
    await app.listen({ port: cfg.PORT, host: cfg.HOST });
  }

  const shutdown = async (signal: string) => {
    console.log(`${signal} received, shutting down`);
    await app?.close();
    // Let an in-flight tick finish its current step; a refresh interrupted here is
    // recovered by stale-run detection on the next start.
    await Promise.race([scheduler?.stop(), new Promise((r) => setTimeout(r, 20_000))]);
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
