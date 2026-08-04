import { describe, expect, it } from "vitest";
import {
  pageJumpIndex,
  resolveCrsmEscapeAction,
  sortSessionsByLastActivity,
} from "../../src/components/CommandPalette/CrsmPalette";

describe("CrsmPalette helpers", () => {
  it("keeps active-query results in last_activity-desc order", () => {
    const activeQueryResults = [
      { id: "older-relevant", last_activity: "2026-08-03T10:00:00Z" },
      { id: "newer-less-relevant", last_activity: "2026-08-04T10:00:00Z" },
      { id: "middle", last_activity: "2026-08-03T18:00:00Z" },
    ];

    expect(sortSessionsByLastActivity(activeQueryResults).map((session) => session.id)).toEqual([
      "newer-less-relevant",
      "middle",
      "older-relevant",
    ]);
  });

  it("uses Escape to clear a query before closing", () => {
    expect(resolveCrsmEscapeAction("resume work")).toBe("clear-query");
    expect(resolveCrsmEscapeAction("")).toBe("close");
  });

  it("moves by a floored viewport page and clamps Home and End", () => {
    expect(pageJumpIndex(3, "PageDown", 20, 420, 48)).toBe(11);
    expect(pageJumpIndex(3, "PageUp", 20, 420, 48)).toBe(0);
    expect(pageJumpIndex(8, "Home", 20, 420, 48)).toBe(0);
    expect(pageJumpIndex(8, "End", 20, 420, 48)).toBe(19);
    expect(pageJumpIndex(18, "PageDown", 20, 420, 48)).toBe(19);
  });
});
