import pg from "pg";

export type Queryable = Pick<pg.Pool, "query">;

// Survives hot reloads in development, which would otherwise leak connections.
const globals = globalThis as unknown as { enquiryPool?: pg.Pool };

/**
 * Hosting integrations name the connection string differently, and some put a
 * non-Postgres URL (such as a prisma+postgres:// proxy) in DATABASE_URL. This
 * takes the first one that's a plain Postgres address.
 */
export function connectionString(): string {
  // The pooled address comes first: it suits serverless functions, which open many short-lived connections.
  const candidates = ["DATABASE_URL_POOLED", "DATABASE_URL", "POSTGRES_URL", "DIRECT_DATABASE_URL", "POSTGRES_URL_NON_POOLING"];
  for (const name of candidates) {
    const value = process.env[name];
    if (value && /^postgres(ql)?:\/\//.test(value)) return value;
  }
  throw new Error(`No Postgres connection string found. Set DATABASE_URL to a postgres:// address.`);
}

export function db(): pg.Pool {
  if (!globals.enquiryPool) {
    globals.enquiryPool = new pg.Pool({
      connectionString: connectionString(),
      max: Number(process.env.PG_POOL_MAX) || 5,
    });
  }
  return globals.enquiryPool;
}

export async function transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
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
