import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/perf/**/*.perf.test.{ts,tsx}"],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 300_000,
  },
});
