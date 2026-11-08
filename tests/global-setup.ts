import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import pg from "pg";

const PG_PORT = 5544;
const CLAUDE_PORT = 4011;
const DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${PG_PORT}/postgres`;

function start(args: string[], env: Record<string, string>): Promise<ChildProcess> {
  const child = spawn(process.execPath, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve, reject) => {
    child.stdout!.once("data", () => resolve(child));
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`${args.at(-1)} exited early with code ${code}`)));
  });
}

/** Starts a throwaway in-memory Postgres and the fake Claude server. Costs nothing. */
export default async function setup() {
  // --liftoff-only: see the db:local script in package.json.
  const database = await start(["--liftoff-only", "scripts/local-postgres.mjs", "--memory"], {
    PORT: String(PG_PORT),
  });
  const fake = await start(["scripts/fake-claude.mjs"], { FAKE_CLAUDE_PORT: String(CLAUDE_PORT) });

  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  await client.query(await readFile("db/schema.sql", "utf8"));
  await client.end();

  process.env.DATABASE_URL = DATABASE_URL;
  process.env.PG_POOL_MAX = "1";
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${CLAUDE_PORT}`;
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.GEMINI_BASE_URL = `http://127.0.0.1:${CLAUDE_PORT}`;
  process.env.GEMINI_API_KEY = "test-key";
  process.env.GEMINI_RETRY_BASE_MS = "5";
  process.env.NOTIFY_CHANNELS = "log";

  return () => {
    fake.removeAllListeners("exit");
    database.removeAllListeners("exit");
    fake.kill();
    database.kill();
  };
}
