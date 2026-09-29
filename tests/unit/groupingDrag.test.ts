import { describe, expect, it } from "vitest";

import {
  GROUPING_DRAG_THRESHOLD_PX,
  GROUPING_AUTOSCROLL_EDGE_PX,
  GROUPING_AUTOSCROLL_STEP_PX,
  groupingAutoScrollStep,
  groupingDragReduce,
  groupingDragTabsArePresent,
  groupingDropIdForTarget,
  groupingDropIsNoop,
  resolveGroupingDropTarget,
  type GroupingDragCancelReason,
  type GroupingDragEvent,
  type GroupingDragOrigin,
  type GroupingDragState,
} from "../../src/components/layout/groupingDrag";
import { paneRefKey } from "../../src/components/layout/groupingEdit";
import type { GroupingPlan } from "../../src/components/layout/tabGrouping";

const origin: GroupingDragOrigin = {
  pointerId: 7,
  x: 10,
  y: 20,
  sourceTabId: "a",
  tabIds: ["a", "b"],
};
const idle: GroupingDragState = { phase: "idle" };
const armed: GroupingDragState = { phase: "armed", origin };
const dragging: GroupingDragState = {
  phase: "dragging",
  origin,
  x: 17,
  y: 20,
  dropId: "dest:0:0",
};
const dropping: GroupingDragState = {
  phase: "dropping",
  origin,
  dropId: "dest:0:0",
};
const none = { kind: "none" } as const;

const idleIgnored: GroupingDragEvent[] = [
  { kind: "move", pointerId: 7, x: 30, y: 40, dropId: null },
  { kind: "release", pointerId: 7, dropId: "dest:0:0" },
  { kind: "settle" },
  { kind: "cancel", reason: "escape" },
];

describe("groupingDragReduce", () => {
  it("arms an idle state on press", () => {
    expect(groupingDragReduce(idle, { kind: "press", origin })).toEqual({
      state: armed,
      effect: none,
    });
  });

  it.each(idleIgnored)("ignores $kind while idle", (event) => {
    expect(groupingDragReduce(idle, event)).toEqual({ state: idle, effect: none });
  });

  it("ignores the wrong pointer and movement below the threshold while armed", () => {
    expect(groupingDragReduce(armed, {
      kind: "move", pointerId: 8, x: 100, y: 100, dropId: null,
    })).toEqual({ state: armed, effect: none });
    expect(groupingDragReduce(armed, {
      kind: "move", pointerId: 7, x: 16, y: 20, dropId: null,
    })).toEqual({ state: armed, effect: none });
  });

  it("starts exactly at the seven pixel threshold", () => {
    expect(GROUPING_DRAG_THRESHOLD_PX).toBe(7);
    expect(GROUPING_DRAG_THRESHOLD_PX).toBeGreaterThanOrEqual(6);
    expect(GROUPING_DRAG_THRESHOLD_PX).toBeLessThanOrEqual(8);
    expect(groupingDragReduce(armed, {
      kind: "move", pointerId: 7, x: 17, y: 20, dropId: "dest:0:0",
    })).toEqual({
      state: dragging,
      effect: { kind: "begin", origin },
    });
    expect(groupingDragReduce(armed, {
      kind: "move", pointerId: 7, x: 19, y: 20, dropId: null,
    }, 10)).toEqual({ state: armed, effect: none });
    expect(groupingDragReduce(armed, {
      kind: "move", pointerId: 7, x: 20, y: 20, dropId: null,
    }, 10).effect.kind).toBe("begin");
  });

  it("turns an armed release into a click only for the matching pointer", () => {
    expect(groupingDragReduce(armed, {
      kind: "release", pointerId: 8, dropId: null,
    })).toEqual({ state: armed, effect: none });
    expect(groupingDragReduce(armed, {
      kind: "release", pointerId: 7, dropId: null,
    })).toEqual({
      state: idle,
      effect: { kind: "click", sourceTabId: "a" },
    });
  });

  it("cancels an armed drag with the original reason", () => {
    expect(groupingDragReduce(armed, { kind: "cancel", reason: "escape" })).toEqual({
      state: idle,
      effect: { kind: "cancelled", reason: "escape" },
    });
  });

  it("updates only matching-pointer drag coordinates", () => {
    expect(groupingDragReduce(dragging, {
      kind: "move", pointerId: 8, x: 30, y: 40, dropId: null,
    })).toEqual({ state: dragging, effect: none });
    expect(groupingDragReduce(dragging, {
      kind: "move", pointerId: 7, x: 30, y: 40, dropId: null,
    })).toEqual({
      state: { phase: "dragging", origin, x: 30, y: 40, dropId: null },
      effect: none,
    });
  });

  it("ignores a wrong-pointer release and cancels a targetless release", () => {
    expect(groupingDragReduce(dragging, {
      kind: "release", pointerId: 8, dropId: null,
    })).toEqual({ state: dragging, effect: none });
    expect(groupingDragReduce(dragging, {
      kind: "release", pointerId: 7, dropId: null,
    })).toEqual({
      state: idle,
      effect: { kind: "cancelled", reason: "target-gone" },
    });
  });

  it("emits one drop and seals duplicate events until settle", () => {
    const first = groupingDragReduce(dragging, {
      kind: "release", pointerId: 7, dropId: "other:0:0",
    });
    expect(first).toEqual({
      state: { phase: "dropping", origin, dropId: "other:0:0" },
      effect: { kind: "drop", tabIds: ["a", "b"], dropId: "other:0:0" },
    });
    const duplicateRelease = groupingDragReduce(first.state, {
      kind: "release", pointerId: 7, dropId: "other:0:0",
    });
    expect(duplicateRelease).toEqual({ state: first.state, effect: none });
    expect(groupingDragReduce(first.state, {
      kind: "move", pointerId: 7, x: 99, y: 99, dropId: "other:0:0",
    })).toEqual({ state: first.state, effect: none });
    expect(groupingDragReduce(first.state, { kind: "press", origin })).toEqual({
      state: first.state,
      effect: none,
    });
    const settled = groupingDragReduce(first.state, { kind: "settle" });
    expect(settled).toEqual({ state: idle, effect: none });
    expect(groupingDragReduce(settled.state, {
      kind: "release", pointerId: 7, dropId: "other:0:0",
    })).toEqual({ state: idle, effect: none });
  });

  it.each<GroupingDragCancelReason>([
    "pointercancel",
    "escape",
    "unmount",
    "lost-capture",
    "blur",
    "target-gone",
    "revision-changed",
    "mode-changed",
    "resize",
    "noop",
    "layout-changed",
    "focus-moved",
    "secondary-button",
    "stale-selection",
  ])("preserves cancel reason %s from dragging", (reason) => {
    expect(groupingDragReduce(dragging, { kind: "cancel", reason })).toEqual({
      state: idle,
      effect: { kind: "cancelled", reason },
    });
  });

  it("keeps dropping immutable except for settle and cancel", () => {
    expect(groupingDragReduce(dropping, {
      kind: "release", pointerId: 7, dropId: "dest:0:0",
    })).toEqual({ state: dropping, effect: none });
    expect(groupingDragReduce(dropping, {
      kind: "move", pointerId: 7, x: 1, y: 2, dropId: null,
    })).toEqual({ state: dropping, effect: none });
    expect(groupingDragReduce(dropping, { kind: "press", origin })).toEqual({
      state: dropping,
      effect: none,
    });
    expect(groupingDragReduce(dropping, { kind: "settle" })).toEqual({ state: idle, effect: none });
    expect(groupingDragReduce(dropping, { kind: "cancel", reason: "unmount" })).toEqual({
      state: idle,
      effect: { kind: "cancelled", reason: "unmount" },
    });
  });
});

describe("resolveGroupingDropTarget", () => {
  const pane = { groupId: "g:one\nline", columnIndex: 1, paneIndex: 2 } as const;
  const paneKey = paneRefKey(pane);
  const prefixedPane = { groupId: "group:a", columnIndex: 0, paneIndex: 0 } as const;
  const prefixedPaneKey = paneRefKey(prefixedPane);
  const emptiedGroup = { kind: "group", groupId: "emptied" } as const;
  const newlineGroup = { kind: "group", groupId: "g\n:a" } as const;
  const emptiedGroupKey = groupingDropIdForTarget(emptiedGroup);
  const newlineGroupKey = groupingDropIdForTarget(newlineGroup);
  const valid = new Set([paneKey, prefixedPaneKey, emptiedGroupKey, newlineGroupKey, "keep-current", "broken"]);

  it("resolves keep-current, pane, newline pane, and emptied group targets", () => {
    expect(resolveGroupingDropTarget("keep-current", valid)).toEqual({ kind: "unassigned" });
    expect(resolveGroupingDropTarget(paneKey, valid)).toEqual({ kind: "pane", ...pane });
    expect(paneRefKey(resolveGroupingDropTarget(paneKey, valid) as typeof pane & { kind: "pane" })).toBe(paneKey);
    expect(resolveGroupingDropTarget(prefixedPaneKey, valid)).toEqual({ kind: "pane", ...prefixedPane });
    expect(resolveGroupingDropTarget(emptiedGroupKey, valid)).toEqual(emptiedGroup);
    expect(resolveGroupingDropTarget(newlineGroupKey, valid)).toEqual(newlineGroup);
  });

  it("rejects null, stale, empty-group, and malformed ids", () => {
    expect(resolveGroupingDropTarget(null, valid)).toBeNull();
    expect(resolveGroupingDropTarget(paneKey, new Set())).toBeNull();
    expect(resolveGroupingDropTarget(emptiedGroupKey, new Set())).toBeNull();
    expect(resolveGroupingDropTarget("group:", new Set(["group:"]))).toBeNull();
    expect(resolveGroupingDropTarget("broken", valid)).toBeNull();
  });

  it("uses canonical reversible group ids that cannot collide with pane keys", () => {
    const paneTarget = { kind: "pane", groupId: "group:a", columnIndex: 0, paneIndex: 0 } as const;
    const groupTarget = { kind: "group", groupId: "a:0:0" } as const;
    const paneDropId = groupingDropIdForTarget(paneTarget);
    const groupDropId = groupingDropIdForTarget(groupTarget);
    expect(paneDropId).toBe("group:a:0:0");
    expect(groupDropId).toBe("group:a%3A0%3A0");
    expect(new Set([paneDropId, groupDropId])).toHaveLength(2);

    const validDropIds = new Set([paneDropId, groupDropId]);
    const targetsByDropId = new Map([
      [paneDropId, paneTarget],
      [groupDropId, groupTarget],
    ]);
    expect(resolveGroupingDropTarget(paneDropId, validDropIds, targetsByDropId)).toEqual(paneTarget);
    expect(resolveGroupingDropTarget(groupDropId, validDropIds, targetsByDropId)).toEqual(groupTarget);
    expect(resolveGroupingDropTarget(
      paneDropId,
      validDropIds,
      new Map([[paneDropId, groupTarget]]),
    )).toBeNull();
  });

  it.each(["a:0:0", "x%y", "line\nid"])("round-trips opaque group id %j", (groupId) => {
    const target = { kind: "group", groupId } as const;
    const dropId = groupingDropIdForTarget(target);
    expect(resolveGroupingDropTarget(dropId, new Set([dropId]))).toEqual(target);
  });

  it("never throws and round-trips an isolated surrogate fallback", () => {
    const target = { kind: "group", groupId: "x\ud800y" } as const;
    expect(() => groupingDropIdForTarget(target)).not.toThrow();
    const dropId = groupingDropIdForTarget(target);
    expect(resolveGroupingDropTarget(dropId, new Set([dropId]))).toEqual(target);
  });
});

function plan(): GroupingPlan {
  return {
    planId: "plan",
    title: "plan",
    rationale: "test",
    strategy: "project",
    groups: [
      {
        groupId: "g-layout",
        title: "layout",
        disposition: "reorganize",
        destination: { kind: "new_workspace", proposedName: "layout" },
        layout: {
          columns: [
            { panes: [
              { title: "first", role: "mother", tabIds: ["a", "b"] },
              { title: "second", role: "worker", tabIds: ["c"] },
            ] },
            { panes: [{ title: "third", role: "worker", tabIds: ["d"] }] },
          ],
        },
        tabIds: ["a", "b", "c", "d"],
        adopted: true,
      },
      {
        groupId: "g-flat",
        title: "flat",
        disposition: "keep",
        destination: { kind: "current_locations" },
        layout: null,
        tabIds: ["e"],
        adopted: false,
      },
      {
        groupId: "g-empty",
        title: "empty",
        disposition: "keep",
        destination: { kind: "current_locations" },
        layout: null,
        tabIds: [],
        adopted: false,
      },
    ],
    unassignedTabIds: ["u", "v"],
    warnings: [],
  };
}

describe("groupingDropIsNoop", () => {
  const pane = { kind: "pane", groupId: "g-layout", columnIndex: 0, paneIndex: 0 } as const;

  it("recognizes pane, unassigned, and group no-ops", () => {
    const current = plan();
    expect(groupingDropIsNoop(current, ["a", "b"], pane)).toBe(true);
    expect(groupingDropIsNoop(current, ["a", "c"], pane)).toBe(false);
    expect(groupingDropIsNoop(current, ["unknown"], pane)).toBe(false);
    expect(groupingDropIsNoop(current, ["u", "v"], { kind: "unassigned" })).toBe(true);
    expect(groupingDropIsNoop(current, ["u", "a"], { kind: "unassigned" })).toBe(false);
    expect(groupingDropIsNoop(current, ["e"], { kind: "group", groupId: "g-flat" })).toBe(true);
    expect(groupingDropIsNoop(current, ["u"], { kind: "group", groupId: "g-empty" })).toBe(false);
    expect(groupingDropIsNoop(current, ["a", "b"], { kind: "group", groupId: "g-layout" })).toBe(true);
    expect(groupingDropIsNoop(current, ["c"], { kind: "group", groupId: "g-layout" })).toBe(false);
  });

  it("treats null plans and empty moving sets as no-ops", () => {
    expect(groupingDropIsNoop(null, ["a"], pane)).toBe(true);
    expect(groupingDropIsNoop(plan(), [], pane)).toBe(true);
  });

  it("does not report missing destinations as no-ops", () => {
    expect(groupingDropIsNoop(plan(), ["a"], {
      kind: "pane", groupId: "missing", columnIndex: 0, paneIndex: 0,
    })).toBe(false);
    expect(groupingDropIsNoop(plan(), ["a"], { kind: "group", groupId: "missing" })).toBe(false);
  });
});

describe("groupingDragTabsArePresent", () => {
  it("requires every moving tab to remain in a pane or unassigned inventory", () => {
    const current = plan();
    expect(groupingDragTabsArePresent(current, ["a", "d", "u"])).toBe(true);
    expect(groupingDragTabsArePresent(current, ["e"])).toBe(true);
    expect(groupingDragTabsArePresent(current, ["a", "missing"])).toBe(false);
    current.groups[0].layout?.columns[0]?.panes[0]?.tabIds.splice(0, 1);
    expect(current.groups[0].tabIds).toContain("a");
    expect(groupingDragTabsArePresent(current, ["a"])).toBe(false);
    expect(groupingDragTabsArePresent(current, [])).toBe(false);
    expect(groupingDragTabsArePresent(null, ["a"])).toBe(false);
  });
});

describe("groupingAutoScrollStep", () => {
  const bounds = { top: 100, bottom: 300 };

  it("returns clamped vertical deltas and gives the upper band priority", () => {
    expect(GROUPING_AUTOSCROLL_EDGE_PX).toBe(24);
    expect(GROUPING_AUTOSCROLL_STEP_PX).toBe(8);
    expect(groupingAutoScrollStep(110, bounds, { scrollTop: 40, scrollHeight: 500, clientHeight: 200 })).toBe(-8);
    expect(groupingAutoScrollStep(290, bounds, { scrollTop: 40, scrollHeight: 500, clientHeight: 200 })).toBe(8);
    expect(groupingAutoScrollStep(200, bounds, { scrollTop: 40, scrollHeight: 500, clientHeight: 200 })).toBe(0);
    expect(groupingAutoScrollStep(100, bounds, { scrollTop: 0, scrollHeight: 500, clientHeight: 200 })).toBe(0);
    expect(groupingAutoScrollStep(300, bounds, { scrollTop: 300, scrollHeight: 500, clientHeight: 200 })).toBe(0);
    expect(groupingAutoScrollStep(300, bounds, { scrollTop: 0, scrollHeight: 100, clientHeight: 100 })).toBe(0);
    expect(groupingAutoScrollStep(115, { top: 100, bottom: 130 }, {
      scrollTop: 40,
      scrollHeight: 500,
      clientHeight: 30,
    })).toBe(-8);
    expect(groupingAutoScrollStep(100, bounds, { scrollTop: 3, scrollHeight: 500, clientHeight: 200 })).toBe(-3);
    expect(groupingAutoScrollStep(300, bounds, { scrollTop: 297, scrollHeight: 500, clientHeight: 200 })).toBe(3);
  });
});
