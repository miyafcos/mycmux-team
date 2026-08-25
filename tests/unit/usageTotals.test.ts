import { describe, expect, it } from "vitest";

import { metricFromTotals, periodDeltaForMetric, periodDeltaFromTotals } from "../../src/components/ailog/UsageTotals";
import type { Totals } from "../../src/lib/ailog";

const compare = { tokensPct: 12.3, sessionsPct: -4.5, costPct: 8.9, reworkPct: 0 };

describe("periodDeltaForMetric", () => {
  it("uses the matching previous-period value and suppresses unsupported metrics", () => {
    expect(periodDeltaForMetric("ioTokens", compare, "7d")).toBeNull();
    expect(periodDeltaForMetric("totalTokens", compare, "7d")).toBeNull();
    expect(periodDeltaForMetric("sessions", compare, "7d")).toBe(-4.5);
    expect(periodDeltaForMetric("costUsd", compare, "7d")).toBe(8.9);
    expect(periodDeltaForMetric("turns", compare, "7d")).toBeNull();
    expect(periodDeltaForMetric("ioTokens", compare, "all")).toBeNull();
  });
});

const totals = (overrides: Partial<Totals>): Totals => ({
  sessions: 0, turns: 0, userMessages: 0, input: 0, output: 0,
  cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0,
  wallMs: 0, activeMs: 0, projects: 0, models: 0,
  ...overrides,
});

describe("periodDeltaFromTotals", () => {
  it("compares the same selected metric in both periods", () => {
    const current = totals({ sessions: 12, turns: 30, input: 90, output: 30, cacheRead: 80, costUsd: 6 });
    const previous = totals({ sessions: 10, turns: 20, input: 60, output: 20, cacheRead: 20, costUsd: 4 });
    expect(metricFromTotals(current, "ioTokens")).toBe(120);
    expect(metricFromTotals(current, "totalTokens")).toBe(200);
    expect(periodDeltaFromTotals("ioTokens", current, previous, "7d")).toBe(50);
    expect(periodDeltaFromTotals("totalTokens", current, previous, "7d")).toBe(100);
    expect(periodDeltaFromTotals("sessions", current, previous, "7d")).toBe(20);
    expect(periodDeltaFromTotals("turns", current, previous, "7d")).toBe(50);
    expect(periodDeltaFromTotals("costUsd", current, previous, "7d")).toBe(50);
  });

  it("does not invent a percentage for all-time or a zero baseline", () => {
    const current = totals({ input: 10 });
    expect(periodDeltaFromTotals("ioTokens", current, totals({}), "7d")).toBeNull();
    expect(periodDeltaFromTotals("ioTokens", current, totals({ input: 5 }), "all")).toBeNull();
  });
});
