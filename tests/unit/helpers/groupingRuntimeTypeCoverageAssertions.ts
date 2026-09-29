import { expect } from "vitest";

export function expectGroupingRuntimeTypeCoverage(
  status: number | null,
  diagnostics: string,
): void {
  expect(status).not.toBe(0);
  expect(diagnostics.match(/error TS2345/g)).toHaveLength(3);
  expect(diagnostics).not.toContain("TS2307");
}
