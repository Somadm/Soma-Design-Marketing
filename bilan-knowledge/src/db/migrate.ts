import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, type Db } from "./pool.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Locate migrations/ whether running from src/ (tsx) or dist/src/ (compiled). */
async function migrationsDir(): Promise<string> {
  for (const candidate of [path.resolve(here, "../../migrations"), path.resolve(here, "../../../migrations")]) {
    try {
      await readdir(candidate);
      return candidate;
    } catch {}
  }
  throw new Error("migrations directory not found");
}

export async function migrate(db: Db): Promise<string[]> {
  const dir = await migrationsDir();
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  const client = await db.connect();
  try {
    // Serialize concurrent migrators (e.g. web + worker starting together).
    await client.query("SELECT pg_advisory_lock(727401)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
    );
    for (const file of files) {
      const { rowCount } = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
      if (rowCount) continue;
      const sql = await readFile(path.join(dir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(727401)").catch(() => {});
    client.release();
  }
  return applied;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const db = createPool(url);
  migrate(db)
    .then((applied) => console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database up to date"))
    .finally(() => db.end());
}
