import { describe, expect, it } from "vitest";
import { dailyDigestNavigation, decisionFindingKinds, findingKindsForSegment, loadersForSegment, recordNavigation, recurringFindingKinds } from "../../src/components/ailog/panelModel";

describe("ailog panel model", () => {
  it("groups every learning finding kind in the learning segment", () => {
    expect(findingKindsForSegment("learning")).toEqual([...recurringFindingKinds, ...decisionFindingKinds]);
    expect([...recurringFindingKinds, ...decisionFindingKinds].sort()).toEqual(["cause", "constraint", "decision", "gotcha", "verified"]);
  });

  it("maps each segment to its cache resource group", () => {
    expect(loadersForSegment("record")).toEqual(["usage", "breakdown"]);
    expect(loadersForSegment("how")).toEqual(["experiment"]);
    expect(loadersForSegment("daily")).toEqual(["digest"]);
    expect(loadersForSegment("learning")).toEqual(["findings", "rankings", "ruleCheck"]);
  });

  it("routes a dated record to that daily digest without changing its date", () => {
    expect(dailyDigestNavigation("2026-08-13")).toEqual({ segment: "daily", date: "2026-08-13" });
  });

  it("routes a date to the unified record segment", () => {
    expect(recordNavigation("2026-08-13")).toEqual({ segment: "record", from: "2026-08-13", to: "2026-08-13" });
  });
});
