import { describe, expect, it } from "vitest";

import { sampleGroupingApplyPath } from "../../src/components/layout/groupingApplyAnimation";
import {
  createGroupingLandingSettleTracker,
  groupingBridgePath,
  groupingExitTangent,
  groupingLandingAssignments,
} from "../../src/components/layout/groupingLandingFlight";

describe("groupingExitTangent", () => {
  it("returns the unit direction of the last distinct sample pair", () => {
    const tangent = groupingExitTangent([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 20 },
    ]);
    expect(tangent).not.toBeNull();
    expect(tangent!.x).toBeCloseTo(0);
    expect(tangent!.y).toBeCloseTo(1);
  });

  it("skips duplicated trailing samples", () => {
    const tangent = groupingExitTangent([
      { x: 0, y: 0 },
      { x: 8, y: 6 },
      { x: 8, y: 6 },
    ]);
    expect(tangent!.x).toBeCloseTo(0.8);
    expect(tangent!.y).toBeCloseTo(0.6);
  });

  it("returns null for a path with no direction", () => {
    expect(groupingExitTangent([{ x: 4, y: 4 }, { x: 4, y: 4 }])).toBeNull();
    expect(groupingExitTangent([])).toBeNull();
  });
});

describe("groupingBridgePath", () => {
  it("starts along the exit tangent and ends at the landing point", () => {
    const exit = { x: 100, y: 50 };
    const tangent = { x: 0, y: 1 };
    const landing = { x: 400, y: 300 };
    const samples = sampleGroupingApplyPath([groupingBridgePath(exit, tangent, landing)], 32);
    expect(samples[0]).toEqual(exit);
    const last = samples[samples.length - 1];
    expect(last.x).toBeCloseTo(landing.x);
    expect(last.y).toBeCloseTo(landing.y);
    const dx = samples[1].x - samples[0].x;
    const dy = samples[1].y - samples[0].y;
    const length = Math.hypot(dx, dy);
    const dot = (dx / length) * tangent.x + (dy / length) * tangent.y;
    expect(dot).toBeGreaterThan(0.98);
  });

  it("degrades to a straight line without a tangent", () => {
    expect(groupingBridgePath({ x: 0, y: 0 }, null, { x: 10, y: 0 })).toBe("M 0 0 L 10 0");
  });

  it("degrades to a zero-length line when exit equals landing", () => {
    expect(groupingBridgePath({ x: 5, y: 5 }, { x: 1, y: 0 }, { x: 5, y: 5 })).toBe("M 5 5 L 5 5");
  });
});

describe("createGroupingLandingSettleTracker", () => {
  const rect = (left: number, top = 0) => ({ left, top, width: 100, height: 40 });

  it("settles after two consecutive frames within the threshold", () => {
    const tracker = createGroupingLandingSettleTracker(0);
    expect(tracker.observe(rect(10), 16).state).toBe("pending");
    const second = tracker.observe(rect(10.5), 32);
    expect(second.state).toBe("settled");
    if (second.state === "settled") expect(second.rect.left).toBe(10.5);
  });

  it("resets the stable count when the rect jumps", () => {
    const tracker = createGroupingLandingSettleTracker(0);
    expect(tracker.observe(rect(10), 16).state).toBe("pending");
    expect(tracker.observe(rect(30), 32).state).toBe("pending");
    expect(tracker.observe(rect(30.2), 48).state).toBe("settled");
  });

  it("expires at the wait limit and reports the freshest rect", () => {
    const tracker = createGroupingLandingSettleTracker(0);
    expect(tracker.observe(rect(10), 16).state).toBe("pending");
    expect(tracker.observe(rect(50), 60).state).toBe("pending");
    const expired = tracker.observe(null, 100);
    expect(expired.state).toBe("expired");
    if (expired.state === "expired") expect(expired.rect?.left).toBe(50);
  });

  it("expires with null when no rect was ever seen", () => {
    const tracker = createGroupingLandingSettleTracker(0);
    const expired = tracker.observe(null, 120);
    expect(expired.state).toBe("expired");
    if (expired.state === "expired") expect(expired.rect).toBeNull();
  });

  it("missing rects break the stability streak", () => {
    const tracker = createGroupingLandingSettleTracker(0);
    expect(tracker.observe(rect(10), 10).state).toBe("pending");
    expect(tracker.observe(null, 20).state).toBe("pending");
    expect(tracker.observe(rect(10), 30).state).toBe("pending");
    expect(tracker.observe(rect(10), 40).state).toBe("settled");
  });

  it("throws when observed after finishing", () => {
    const tracker = createGroupingLandingSettleTracker(0);
    tracker.observe(null, 200);
    expect(() => tracker.observe(rect(0), 210)).toThrow();
  });
});

describe("groupingLandingAssignments", () => {
  it("splits visible-workspace tabs from bundled ones", () => {
    const moved = [
      { tabId: "a", workspaceId: "ws-1", paneId: "p-1" },
      { tabId: "b", workspaceId: "ws-2", paneId: "p-2" },
      { tabId: "c", workspaceId: "ws-2", paneId: "p-3" },
      { tabId: "d", workspaceId: "ws-3", paneId: "p-4" },
    ];
    const assignments = groupingLandingAssignments(moved, "ws-1");
    expect(assignments.paneLandings.map((tab) => tab.tabId)).toEqual(["a"]);
    expect([...assignments.bundles.keys()]).toEqual(["ws-2", "ws-3"]);
    expect(assignments.bundles.get("ws-2")!.map((tab) => tab.tabId)).toEqual(["b", "c"]);
  });

  it("bundles everything when no workspace is visible", () => {
    const assignments = groupingLandingAssignments(
      [{ tabId: "a", workspaceId: "ws-1", paneId: "p-1" }],
      null,
    );
    expect(assignments.paneLandings).toHaveLength(0);
    expect(assignments.bundles.get("ws-1")).toHaveLength(1);
  });
});
