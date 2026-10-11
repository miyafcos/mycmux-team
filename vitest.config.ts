import { defineConfig } from "vitest/config";
import { narrowBasePlugin } from "./tests/helpers/narrowBasePlugin";

const TYPE_COVERAGE_TEST = "tests/unit/persistentLayoutProjectionTypeCoverage.test.ts";

export default defineConfig({
  test: {
    environment: "node",
    projects: [
      {
        plugins: [narrowBasePlugin()],
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.{ts,tsx}"],
          exclude: [TYPE_COVERAGE_TEST],
          maxWorkers: 4,
          sequence: { groupOrder: 0 },
        },
      },
      {
        test: {
          name: "type-coverage",
          include: [TYPE_COVERAGE_TEST],
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
