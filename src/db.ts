import pg from "pg";
import type { Config } from "./config.js";

const { Pool } = pg;
export type Db = pg.Pool;
export type DbClient = pg.PoolClient;

export function createDb(config: Pick<Config, "DATABASE_URL">): Db {
  return new Pool({ connectionString: config.DATABASE_URL, max: 10 });
}

export async function transaction<T>(db: Db, work: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
