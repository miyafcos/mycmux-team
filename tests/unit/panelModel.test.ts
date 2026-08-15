import { describe, expect, it } from "vitest";
import { dailyDigestNavigation, decisionFindingKinds, findingKindsForSegment, loadersForSegment, recordBreakdownNavigation, recurringFindingKinds, shouldRefreshBreakdown } from "../../src/components/ailog/panelModel";

describe("ailog panel model", () => {
  it("keeps finding kinds in exactly one insight segment", () => {
    expect(findingKindsForSegment("recurring")).toEqual(recurringFindingKinds);
    expect(findingKindsForSegment("decisions")).toEqual(decisionFindingKinds);
    expect([...recurringFindingKinds, ...decisionFindingKinds].sort()).toEqual(["cause", "constraint", "decision", "gotcha", "verified"]);
  });

  it("maps each segment to its cache resource group", () => {
    expect(loadersForSegment("record", "when")).toEqual(["usage"]);
    expect(loadersForSegment("record", "what")).toEqual(["breakdown"]);
    expect(loadersForSegment("record", "how")).toEqual(["experiment"]);
    expect(loadersForSegment("insight", "daily")).toEqual(["digest"]);
    expect(loadersForSegment("insight", "recurring")).toEqual(["findings", "rankings"]);
    expect(loadersForSegment("insight", "decisions")).toEqual(["findings"]);
  });

  it("routes a dated record to that daily digest without changing its date", () => {
    expect(dailyDigestNavigation("2026-08-13")).toEqual({ surface: "insight", segment: "daily", date: "2026-08-13" });
  });

  it("routes a dated recurring gotcha to the same-day record breakdown", () => {
    expect(recordBreakdownNavigation("2026-08-13")).toEqual({ surface: "record", segment: "what", from: "2026-08-13", to: "2026-08-13" });
  });

  it("refreshes breakdown controls only while the record what segment is visible", () => {
    expect(shouldRefreshBreakdown("record", "what")).toBe(true);
    expect(shouldRefreshBreakdown("record", "when")).toBe(false);
    expect(shouldRefreshBreakdown("record", "how")).toBe(false);
    expect(shouldRefreshBreakdown("insight", "what")).toBe(false);
  });
});
