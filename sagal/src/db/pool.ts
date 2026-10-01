import pg from "pg";

// BIGSERIAL ids and NUMERIC money stay well inside JS number precision here.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));
// DATE columns stay as "YYYY-MM-DD" strings (Helsinki calendar dates), never shifted by a time zone.
pg.types.setTypeParser(1082, (v) => v);

export type Db = pg.Pool;
export type DbClient = pg.PoolClient | pg.Pool;

export function createPool(connectionString: string): Db {
  const ssl =
    /sslmode=require/.test(connectionString) || /supabase\.(co|com)/.test(connectionString) || process.env.PGSSL === "true"
      ? { rejectUnauthorized: false }
      : undefined;
  return new pg.Pool({ connectionString, ssl, max: 10 });
}

export async function withTransaction<T>(db: Db, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
