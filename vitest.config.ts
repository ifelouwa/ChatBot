import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@business": path.resolve(import.meta.dirname, "business/index.ts"),
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    globalSetup: ["./tests/global-setup.ts"],
    // All integration tests share one database connection.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
