import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Suites share one Postgres test database.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
