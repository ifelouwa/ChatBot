// Applies db/schema.sql to DATABASE_URL.
import { readFile } from "node:fs/promises";
import pg from "pg";

// Same rule as src/lib/db.ts: the first plain Postgres address wins.
const connectionString = ["DATABASE_URL", "POSTGRES_URL", "DIRECT_DATABASE_URL", "POSTGRES_URL_NON_POOLING"]
  .map((name) => process.env[name])
  .find((value) => value && /^postgres(ql)?:\/\//.test(value));
if (!connectionString) {
  console.error("No Postgres connection string found. Set DATABASE_URL, or copy .env.example to .env.local first.");
  process.exit(1);
}

const sql = await readFile(new URL("../db/schema.sql", import.meta.url), "utf8");
const client = new pg.Client({ connectionString });
await client.connect();
try {
  await client.query(sql);
  console.log("Database schema is up to date.");
} finally {
  await client.end();
}
