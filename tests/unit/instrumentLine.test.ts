import { describe, expect, it } from "vitest";

import {
  contextBar,
  formatCostUsd,
  formatInstrumentLine,
  formatSid,
  instrumentLineFromTelemetry,
  instrumentSlotsFromTelemetry,
} from "../../src/components/dashboard/instrumentLine";

describe("formatInstrumentLine", () => {
  it("joins slots in model → CTX → cost → sid order", () => {
    expect(formatInstrumentLine({
      model: { name: "opus-5", effort: "high" },
      context: { pct: 34, tokens: 68_000 },
      costUsd: 1.23,
      sid: "a1b2c3d4ef",
    })).toBe("opus-5 (high) │ CTX ▓▓░░ 34% │ ≈$1.23 │ sid a1b2c3d4");
  });

  it("drops missing slots instead of leaving placeholders", () => {
    expect(formatInstrumentLine({ sid: "abc12345zzzz" })).toBe("sid abc12345");
    expect(formatInstrumentLine({
      model: { name: "opus-5" },
      costUsd: 0,
    })).toBe("opus-5 │ ≈$0.00");
    expect(formatInstrumentLine({})).toBe("");
  });

  it("omits effort parentheses when effort is missing", () => {
    expect(formatInstrumentLine({ model: { name: "opus-5" } })).toBe("opus-5");
  });

  it("marks CTX at 50% with ! and 80% with !!", () => {
    expect(formatInstrumentLine({ context: { pct: 49 } })).toBe("CTX ▓▓░░ 49%");
    expect(formatInstrumentLine({ context: { pct: 50 } })).toBe("CTX ▓▓░░ 50%!");
    expect(formatInstrumentLine({ context: { pct: 79 } })).toBe("CTX ▓▓▓▓ 79%!");
    expect(formatInstrumentLine({ context: { pct: 80 } })).toBe("CTX ▓▓▓▓ 80%!!");
    expect(formatInstrumentLine({ context: { pct: 100 } })).toBe("CTX ▓▓▓▓ 100%!!");
  });

  it("shows tokens only when pct is unknown", () => {
    expect(formatInstrumentLine({ context: { tokens: 12_345 } })).toBe("CTX 12345");
  });

  it("truncates sid to 8 characters and skips empty ids", () => {
    expect(formatSid("abcdefghijkl")).toBe("abcdefgh");
    expect(formatSid("short")).toBe("short");
    expect(formatSid("  ")).toBeNull();
    expect(formatSid(undefined)).toBeNull();
  });

  it("prefixes cost with ≈$", () => {
    expect(formatCostUsd(1.234)).toBe("≈$1.23");
    expect(formatCostUsd(0.0042)).toBe("≈$0.0042");
    expect(formatCostUsd(0)).toBe("≈$0.00");
  });

  it("fills the CTX bar in 25% steps", () => {
    expect(contextBar(0)).toBe("░░░░");
    expect(contextBar(1)).toBe("▓░░░");
    expect(contextBar(25)).toBe("▓░░░");
    expect(contextBar(26)).toBe("▓▓░░");
    expect(contextBar(50)).toBe("▓▓░░");
    expect(contextBar(51)).toBe("▓▓▓░");
    expect(contextBar(75)).toBe("▓▓▓░");
    expect(contextBar(76)).toBe("▓▓▓▓");
    expect(contextBar(100)).toBe("▓▓▓▓");
  });

  it("builds a line from AgentTelemetry plus sid", () => {
    expect(instrumentLineFromTelemetry({
      model: { name: "opus-5", effort: "high" },
      context: { pct: 34 },
      cost: { usd: 1.23, source: "computed" },
    }, "a1b2c3d4")).toBe("opus-5 (high) │ CTX ▓▓░░ 34% │ ≈$1.23 │ sid a1b2c3d4");
  });

  it("omits the CTX bar in compact card slots", () => {
    expect(instrumentSlotsFromTelemetry({
      model: { name: "opus-5", effort: "high" },
      context: { pct: 34 },
      cost: { usd: 1.23, source: "computed" },
    }, "a1b2c3d4eeee", { compactContext: true }).map((slot) => slot)).toEqual([
      { kind: "model", text: "opus-5 (high)" },
      { kind: "context", text: "CTX 34%" },
      { kind: "cost", text: "≈$1.23" },
      { kind: "sid", text: "sid a1b2c3d4" },
    ]);
  });
});
