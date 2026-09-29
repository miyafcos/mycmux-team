import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("grouping line unit-test timing boundary", () => {
  it("keeps wall-clock timing contracts in the isolated performance suite", () => {
    const source = readFileSync(
      resolve(process.cwd(), "tests", "unit", "groupingLinesPerf.test.ts"),
      "utf8",
    );

    expect(source).toContain(
      "Timing contracts are owned by `npm run perf:grouping` in isolated execution.",
    );
    expect(source).not.toMatch(/\b(?:performance\.now|process\.threadCpuUsage|Date\.now)\s*\(/u);
    expect(source).not.toContain("percentileMs");
    expect(source).not.toContain("console.log");
    expect(source).not.toMatch(/toBeLessThanOrEqual\((?:5|50|100)\)/u);
  });
});
