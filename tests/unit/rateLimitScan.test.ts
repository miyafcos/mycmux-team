import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scanRateLimit } from "../../src/lib/rateLimitScan";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

describe("scanRateLimit", () => {
  it("recognizes sampled Claude limit-reached text", () => {
    expect(scanRateLimit(fixture("rateLimitClaudeReached.txt"))).toMatchObject({
      kind: "limit-reached",
      evidence: "usage limit reached",
    });
  });

  it("keeps sampled warning and Codex model-choice prompt distinct from a stop", () => {
    expect(scanRateLimit(fixture("rateLimitClaudeNearLimit.txt"))).toMatchObject({ kind: "near-limit" });
    expect(scanRateLimit(fixture("rateLimitCodexNearLimit.txt"))).toMatchObject({
      kind: "near-limit",
      evidence: "Approaching rate limits",
    });
  });

  it("strips ANSI escapes and rejects unrelated limits and normal quota rows", () => {
    expect(scanRateLimit("\u001b[31mUsage limit reached\u001b[0m")).toMatchObject({ kind: "limit-reached" });
    expect(scanRateLimit("read limit is 200 lines\n5h 72% | 7d 41%")).toEqual({ kind: "none" });
  });
});
