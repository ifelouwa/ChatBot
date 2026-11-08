// A zero-install Postgres for local development, stored in .data/pg.
// It accepts one connection at a time, so set PG_POOL_MAX=1 when using it.
// Production should use a real hosted Postgres.
// Run with --liftoff-only: V8's optimising WebAssembly compiler can run out of
// memory on this database engine and crash the process.
import { mkdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const port = Number(process.env.PORT ?? 5433);
const inMemory = process.argv.includes("--memory");
let dataDir;
if (!inMemory) {
  await mkdir(".data", { recursive: true });
  dataDir = ".data/pg";
}

const db = await PGlite.create(dataDir);
const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1" });
await server.start();
console.log(`Local Postgres on postgres://postgres:postgres@127.0.0.1:${port}/postgres`);

const stop = async () => {
  await server.stop();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
