import { describe, expect, it } from "vitest";

import { periodDeltaForMetric } from "../../src/components/ailog/UsageTotals";

const compare = { tokensPct: 12.3, sessionsPct: -4.5, costPct: 8.9, reworkPct: 0 };

describe("periodDeltaForMetric", () => {
  it("uses the matching previous-period value and suppresses unsupported metrics", () => {
    expect(periodDeltaForMetric("ioTokens", compare, "7d")).toBe(12.3);
    expect(periodDeltaForMetric("totalTokens", compare, "7d")).toBe(12.3);
    expect(periodDeltaForMetric("sessions", compare, "7d")).toBe(-4.5);
    expect(periodDeltaForMetric("costUsd", compare, "7d")).toBe(8.9);
    expect(periodDeltaForMetric("turns", compare, "7d")).toBeNull();
    expect(periodDeltaForMetric("ioTokens", compare, "all")).toBeNull();
  });
});
