import { describe, expect, it } from "vitest";
import {
  groupingLineEndAnchor,
  groupingMeasuredMoveLines,
  groupingMoveDiffs,
  groupingMoveLineColor,
  groupingMoveLinePath,
  groupingMoveLines,
  groupingRelativeRect,
  groupingSideBySideOrientation,
} from "../../src/components/layout/groupingMoveLines";
import { WORKSPACE_COLORS } from "../../src/lib/workspaceColors";
import type { Pane, PaneTab, Workspace } from "../../src/types/workspace";

function tab(id: string, label = id): PaneTab {
  return { id, sessionId: `session-${id}`, agentId: "codex", label };
}

function pane(id: string, tabs: PaneTab[]): Pane {
  return {
    id,
    agentId: "codex",
    sessionId: tabs[0]?.sessionId ?? "",
    tabs,
    activeTabId: tabs[0]?.id ?? "",
  };
}

function workspace(id: string, panes: Pane[], splitColumns?: string[][]): Workspace {
  return {
    id,
    name: id,
    gridTemplateId: "2x1",
    panes,
    status: "running",
    createdAt: 1,
    ...(splitColumns ? { splitColumns } : {}),
  };
}

describe("groupingMoveLines", () => {
  it("returns only cross-workspace moves in after rendering order", () => {
    const before = [
      workspace("ws-a", [pane("a-1", [tab("move-1", "  One  "), tab("same-ws")]), pane("a-2", [tab("move-2")])]),
      workspace("ws-b", [pane("b-1", [tab("stay-b")])]),
      workspace("ws-c", [pane("c-1", [tab("move-3")])]),
    ];
    const after = [
      workspace("ws-a", [pane("a-2", [tab("same-ws")]), pane("a-1", [])], [["a-2"], ["a-1"]]),
      workspace("ws-b", [pane("b-2", [tab("move-2"), tab("new-tab")]), pane("b-1", [tab("move-3"), tab("stay-b")])], [["b-1"], ["b-2"]]),
      workspace("ws-c", [pane("c-1", [tab("move-1", "  One  ")])]),
    ];

    expect(groupingMoveLines(before, after)).toEqual([
      {
        tabId: "move-3",
        label: "move-3",
        fromWorkspaceId: "ws-c",
        toWorkspaceId: "ws-b",
        fromRect: null,
        toRect: null,
      },
      {
        tabId: "move-2",
        label: "move-2",
        fromWorkspaceId: "ws-a",
        toWorkspaceId: "ws-b",
        fromRect: null,
        toRect: null,
      },
      {
        tabId: "move-1",
        label: "One",
        fromWorkspaceId: "ws-a",
        toWorkspaceId: "ws-c",
        fromRect: null,
        toRect: null,
      },
    ]);
  });

  it("returns no line for a move between panes in one workspace", () => {
    const before = [workspace("ws-a", [pane("a-1", [tab("same-ws")]), pane("a-2", [])])];
    const after = [workspace("ws-a", [pane("a-1", []), pane("a-2", [tab("same-ws")])])];
    expect(groupingMoveLines(before, after)).toEqual([]);
  });

  it("classifies cross-workspace and within-workspace moves without reporting reorder-only or new tabs", () => {
    const before = [
      workspace("ws-a", [
        pane("a-1", [tab("cross-a"), tab("within-a"), tab("stay-a")]),
        pane("a-2", []),
      ], [["a-1"], ["a-2"]]),
      workspace("ws-b", [
        pane("b-1", [tab("cross-b"), tab("within-b")]),
        pane("b-2", []),
      ], [["b-1"], ["b-2"]]),
      workspace("ws-c", [pane("c-1", [tab("cross-c")])]),
    ];
    const after = [
      workspace("ws-a", [
        pane("a-1", [tab("stay-a"), tab("cross-c")]),
        pane("a-2", [tab("within-a")]),
      ], [["a-1"], ["a-2"]]),
      workspace("ws-b", [
        pane("b-1", [tab("cross-a")]),
        pane("b-2", [tab("within-b")]),
      ], [["b-1"], ["b-2"]]),
      workspace("ws-c", [pane("c-1", [tab("cross-b"), tab("new-tab")])]),
    ];

    const diffs = groupingMoveDiffs(before, after);
    expect(diffs).toEqual([
      {
        tabId: "cross-c",
        label: "cross-c",
        kind: "cross-workspace",
        fromWorkspaceId: "ws-c",
        toWorkspaceId: "ws-a",
        fromPaneId: "c-1",
        toPaneId: "a-1",
        fromColumnIndex: 0,
        toColumnIndex: 0,
      },
      {
        tabId: "within-a",
        label: "within-a",
        kind: "within-workspace",
        fromWorkspaceId: "ws-a",
        toWorkspaceId: "ws-a",
        fromPaneId: "a-1",
        toPaneId: "a-2",
        fromColumnIndex: 0,
        toColumnIndex: 1,
      },
      {
        tabId: "cross-a",
        label: "cross-a",
        kind: "cross-workspace",
        fromWorkspaceId: "ws-a",
        toWorkspaceId: "ws-b",
        fromPaneId: "a-1",
        toPaneId: "b-1",
        fromColumnIndex: 0,
        toColumnIndex: 0,
      },
      {
        tabId: "within-b",
        label: "within-b",
        kind: "within-workspace",
        fromWorkspaceId: "ws-b",
        toWorkspaceId: "ws-b",
        fromPaneId: "b-1",
        toPaneId: "b-2",
        fromColumnIndex: 0,
        toColumnIndex: 1,
      },
      {
        tabId: "cross-b",
        label: "cross-b",
        kind: "cross-workspace",
        fromWorkspaceId: "ws-b",
        toWorkspaceId: "ws-c",
        fromPaneId: "b-1",
        toPaneId: "c-1",
        fromColumnIndex: 0,
        toColumnIndex: 0,
      },
    ]);
    const lines = groupingMoveLines(before, after);
    expect(diffs).toHaveLength(5);
    expect(lines).toHaveLength(3);
    expect(diffs.filter((diff) => diff.kind === "within-workspace")).toHaveLength(2);
    expect(lines).toEqual(diffs.filter((diff) => diff.kind === "cross-workspace").map((diff) => ({
      tabId: diff.tabId,
      label: diff.label,
      fromWorkspaceId: diff.fromWorkspaceId,
      toWorkspaceId: diff.toWorkspaceId,
      fromRect: null,
      toRect: null,
    })));
    expect(lines.map((line) => line.tabId)).toEqual(["cross-c", "cross-a", "cross-b"]);
  });
});

describe("groupingMeasuredMoveLines", () => {
  const moveLine = (tabId: string, toWorkspaceId = "ws-after") => ({
    tabId,
    label: tabId,
    fromWorkspaceId: "ws-before",
    toWorkspaceId,
    fromRect: null,
    toRect: null,
  });

  it.each(["horizontal", "vertical"] as const)(
    "matches the existing four anchor forms in %s orientation",
    (orientation) => {
      const lines = ["missing-workspace", "workspace-edge", "clear", "blocked"].map((id) => moveLine(id, id));
      const fromRects = new Map(lines.map((line, index) => [
        line.tabId,
        { left: 10, top: 20 + index * 40, width: 60, height: 20 },
      ]));
      const toRects = new Map<string, { left: number; top: number; width: number; height: number }>([
        ["missing-workspace", { left: 120, top: 40, width: 80, height: 20 }],
        ["workspace-edge", orientation === "horizontal"
          ? { left: 20, top: 80, width: 80, height: 20 }
          : { left: 120, top: 20, width: 40, height: 20 }],
        ["clear", orientation === "horizontal"
          ? { left: 120, top: 120, width: 80, height: 20 }
          : { left: 120, top: 120, width: 40, height: 20 }],
        ["blocked", orientation === "horizontal"
          ? { left: 120, top: 160, width: 80, height: 20 }
          : { left: 180, top: 120, width: 40, height: 20 }],
        ["sibling", orientation === "horizontal"
          ? { left: 60, top: 165, width: 20, height: 10 }
          : { left: 190, top: 50, width: 20, height: 20 }],
      ]);
      const workspaceRects = new Map([
        ["workspace-edge", { left: 20, top: 20, width: 300, height: 220 }],
        ["clear", { left: 20, top: 20, width: 300, height: 220 }],
        ["blocked", { left: 20, top: 20, width: 300, height: 220 }],
      ]);

      const measured = groupingMeasuredMoveLines({ lines, fromRects, toRects, workspaceRects, orientation });
      expect(measured).toHaveLength(4);
      for (const line of measured) {
        const toRect = toRects.get(line.tabId)!;
        const workspaceRect = workspaceRects.get(line.toWorkspaceId) ?? null;
        const siblings = [...toRects.values()].filter((rect) => rect !== toRect);
        const expected = groupingLineEndAnchor(toRect, workspaceRect, siblings, orientation);
        expect(line.fromRect).toEqual(fromRects.get(line.tabId));
        expect(line.destinationRect).toEqual(toRect);
        if (line.routePoints) {
          expect(line.toRect).toEqual(toRect);
          expect(line.leadIn).toBeNull();
          const routeEnd = line.routePoints.at(-1)!;
          if (orientation === "horizontal") {
            expect(routeEnd.y).toBe(toRect.top + toRect.height / 2);
            expect([toRect.left, toRect.left + toRect.width]).toContain(routeEnd.x);
          } else {
            expect(routeEnd.x).toBe(toRect.left + toRect.width / 2);
            expect([toRect.top, toRect.top + toRect.height]).toContain(routeEnd.y);
          }
        } else {
          expect(line.toRect).toEqual(expected.anchor);
          expect(line.leadIn).toEqual(expected.leadIn);
        }
      }
    },
  );

  it("iterates endpoint rectangles once instead of once per line", () => {
    const lines = Array.from({ length: 50 }, (_, index) => moveLine(`tab-${index}`));
    const fromRects = new Map(lines.map((line, index) => [line.tabId, { left: 0, top: index * 24, width: 80, height: 20 }]));
    const rawToRects = new Map(lines.map((line, index) => [line.tabId, { left: 300, top: index * 24, width: 80, height: 20 }]));
    let gets = 0;
    let iterations = 0;
    const toRects = new Proxy(rawToRects, {
      get(target, property) {
        if (property === "get") {
          return (key: string) => {
            gets += 1;
            return target.get(key);
          };
        }
        if (property === "values" || property === "entries" || property === Symbol.iterator) {
          iterations += 1;
          const value = Reflect.get(target, property, target) as (...args: unknown[]) => unknown;
          return value.bind(target);
        }
        return Reflect.get(target, property, target);
      },
    });

    expect(groupingMeasuredMoveLines({
      lines,
      fromRects,
      toRects,
      workspaceRects: new Map([["ws-after", { left: 240, top: 0, width: 200, height: 1400 }]]),
      orientation: "horizontal",
    })).toHaveLength(50);
    expect({ gets, iterations }).toEqual({ gets: 50, iterations: 1 });
  });

  it.each(["untouched chip", "non-destination pane"] as const)("uses an %s as a collision obstacle", (obstacleKind) => {
    const line = moveLine("moved");
    const target = { left: 120, top: 40, width: 80, height: 20 };
    const untouched = { left: 60, top: 45, width: 20, height: 10 };
    const measured = groupingMeasuredMoveLines({
      lines: [line],
      fromRects: new Map([[line.tabId, { left: 0, top: 40, width: 20, height: 20 }]]),
      toRects: new Map([[line.tabId, target]]),
      afterChipRects: new Map([[line.tabId, target], ...(obstacleKind === "untouched chip" ? [["untouched", untouched] as const] : [])]),
      paneRects: new Map<string, { left: number; top: number; width: number; height: number }>([
        ["destination-pane", { left: 100, top: 30, width: 140, height: 100 }],
        ...(obstacleKind === "non-destination pane" ? [["other-pane", { left: 40, top: 30, width: 60, height: 100 }] as const] : []),
      ]),
      destinationPaneIds: new Map([[line.tabId, "destination-pane"]]),
      workspaceRects: new Map([[line.toWorkspaceId, { left: 20, top: 20, width: 300, height: 200 }]]),
      orientation: "horizontal",
    })[0];

    expect(measured.destinationRect).toEqual(target);
    expect(measured.leadIn).toBeNull();
    expect(measured.routePoints).not.toBeNull();
    expect(measured.routePoints?.at(-1)?.y).toBe(target.top + target.height / 2);
    expect([target.left, target.left + target.width]).toContain(measured.routePoints?.at(-1)?.x);
  });

  it("uses the opposite destination edge when the primary approach is blocked", () => {
    const line = moveLine("target");
    const target = { left: 120, top: 40, width: 80, height: 20 };
    const blocker = { left: 80, top: 40, width: 39, height: 20 };
    const measured = groupingMeasuredMoveLines({
      lines: [line],
      fromRects: new Map([[line.tabId, { left: 0, top: 40, width: 40, height: 20 }]]),
      toRects: new Map([[line.tabId, target]]),
      afterChipRects: new Map([[line.tabId, target], ["blocker", blocker]]),
      workspaceRects: new Map([[line.toWorkspaceId, { left: 20, top: 20, width: 300, height: 200 }]]),
      orientation: "horizontal",
    })[0];
    expect(measured.routePoints?.at(-1)).toEqual({ x: target.left + target.width, y: target.top + target.height / 2 });
    expect(measured.routePoints?.slice(1).every((point, index) => {
      const from = measured.routePoints![index];
      const painted = {
        left: Math.min(from.x, point.x) - 2,
        top: Math.min(from.y, point.y) - 2,
        width: Math.abs(point.x - from.x) + 4,
        height: Math.abs(point.y - from.y) + 4,
      };
      return painted.left >= blocker.left + blocker.width
        || blocker.left >= painted.left + painted.width
        || painted.top >= blocker.top + blocker.height
        || blocker.top >= painted.top + painted.height;
    })).toBe(true);
  });

  it("exits the source pane through the source-chip opening before detouring", () => {
    const line = moveLine("moved");
    const source = { left: 0, top: 40, width: 20, height: 20 };
    const target = { left: 120, top: 40, width: 80, height: 20 };
    const measured = groupingMeasuredMoveLines({
      lines: [line],
      fromRects: new Map([[line.tabId, source]]),
      toRects: new Map([[line.tabId, target]]),
      afterChipRects: new Map([[line.tabId, target], ["blocker", { left: 80, top: 40, width: 39, height: 20 }]]),
      paneRects: new Map([
        ["source-pane", { left: -10, top: 30, width: 80, height: 100 }],
        ["destination-pane", { left: 100, top: 30, width: 140, height: 100 }],
      ]),
      sourcePaneIds: new Map([[line.tabId, "source-pane"]]),
      destinationPaneIds: new Map([[line.tabId, "destination-pane"]]),
      workspaceRects: new Map([[line.toWorkspaceId, { left: 80, top: 20, width: 300, height: 200 }]]),
      orientation: "horizontal",
    })[0];

    expect(measured.routePoints?.slice(0, 2)).toEqual([
      { x: source.left + source.width, y: source.top + source.height / 2 },
      { x: 73, y: source.top + source.height / 2 },
    ]);
  });

  it("keeps the five-pixel painted detour boundary inside obstacle filtering", () => {
    const line = moveLine("target");
    const target = { left: 120, top: 40, width: 80, height: 20 };
    expect(() => groupingMeasuredMoveLines({
      lines: [line],
      fromRects: new Map([[line.tabId, { left: 0, top: 40, width: 40, height: 20 }]]),
      toRects: new Map([[line.tabId, target]]),
      afterChipRects: new Map([
        [line.tabId, target],
        ["primary-blocker", { left: 80, top: 40, width: 39, height: 20 }],
        ["paint-boundary-blocker", { left: 204, top: 40, width: 1, height: 20 }],
      ]),
      workspaceRects: new Map([[line.toWorkspaceId, { left: 20, top: 20, width: 300, height: 200 }]]),
      orientation: "horizontal",
    })).toThrow("No collision-free grouping move route is available");
  });

  it("routes an upper destination around an already reserved lower lead-in", () => {
    const upper = moveLine("upper", "shared");
    const lower = moveLine("lower", "shared");
    const upperTarget = { left: 300, top: 80, width: 80, height: 20 };
    const lowerTarget = { left: 300, top: 160, width: 80, height: 20 };
    const measured = groupingMeasuredMoveLines({
      lines: [upper, lower],
      fromRects: new Map([
        [upper.tabId, { left: 0, top: 40, width: 20, height: 20 }],
        [lower.tabId, { left: 0, top: 160, width: 20, height: 20 }],
      ]),
      toRects: new Map([[upper.tabId, upperTarget], [lower.tabId, lowerTarget]]),
      afterChipRects: new Map([
        [upper.tabId, upperTarget],
        [lower.tabId, lowerTarget],
        ["upper-blocker", { left: 120, top: 55, width: 30, height: 35 }],
      ]),
      paneRects: new Map([["destination-pane", { left: 290, top: 50, width: 200, height: 180 }]]),
      destinationPaneIds: new Map([[upper.tabId, "destination-pane"], [lower.tabId, "destination-pane"]]),
      workspaceRects: new Map([["shared", { left: 200, top: 20, width: 400, height: 260 }]]),
      orientation: "horizontal",
    });
    const upperMeasured = measured.find((line) => line.tabId === upper.tabId)!;
    const lowerMeasured = measured.find((line) => line.tabId === lower.tabId)!;
    expect(lowerMeasured.leadIn).not.toBeNull();
    expect(upperMeasured.routePoints).not.toBeNull();
    const lead = lowerMeasured.leadIn!;
    const paintedLead = { left: lead.left, top: lead.top - 2, width: lead.width, height: 4 };
    expect(upperMeasured.routePoints?.slice(1).every((point, index) => {
      const from = upperMeasured.routePoints![index];
      const painted = {
        left: Math.min(from.x, point.x) - 2,
        top: Math.min(from.y, point.y) - 2,
        width: Math.abs(point.x - from.x) + 4,
        height: Math.abs(point.y - from.y) + 4,
      };
      return painted.left >= paintedLead.left + paintedLead.width
        || paintedLead.left >= painted.left + painted.width
        || painted.top >= paintedLead.top + paintedLead.height
        || paintedLead.top >= painted.top + painted.height;
    })).toBe(true);
  });

  it("uses opposite destination edges for two detours into the same workspace", () => {
    const upper = moveLine("upper", "shared");
    const lower = moveLine("lower", "shared");
    const upperTarget = { left: 300, top: 40, width: 80, height: 20 };
    const lowerTarget = { left: 300, top: 100, width: 80, height: 20 };
    const sourcePane = { left: -10, top: 20, width: 90, height: 140 };
    const destinationPane = { left: 280, top: 20, width: 140, height: 140 };
    const measured = groupingMeasuredMoveLines({
      lines: [upper, lower],
      fromRects: new Map([
        [upper.tabId, { left: 0, top: 40, width: 20, height: 20 }],
        [lower.tabId, { left: 0, top: 100, width: 20, height: 20 }],
      ]),
      toRects: new Map([[upper.tabId, upperTarget], [lower.tabId, lowerTarget]]),
      afterChipRects: new Map([
        [upper.tabId, upperTarget],
        [lower.tabId, lowerTarget],
        ["upper-blocker", { left: 140, top: 40, width: 50, height: 20 }],
        ["lower-blocker", { left: 140, top: 100, width: 50, height: 20 }],
      ]),
      paneRects: new Map([["source-pane", sourcePane], ["destination-pane", destinationPane]]),
      sourcePaneIds: new Map([[upper.tabId, "source-pane"], [lower.tabId, "source-pane"]]),
      destinationPaneIds: new Map([[upper.tabId, "destination-pane"], [lower.tabId, "destination-pane"]]),
      workspaceRects: new Map([["shared", { left: 220, top: 10, width: 240, height: 180 }]]),
      orientation: "horizontal",
    });
    const destinationXs = measured.map((line) => line.routePoints?.at(-1)?.x);
    const sourceLaneXs = measured.map((line) => line.routePoints?.[1].x);
    expect(measured.every((line) => line.routePoints !== null)).toBe(true);
    expect(new Set(destinationXs)).toEqual(new Set([upperTarget.left + upperTarget.width, lowerTarget.left]));
    expect(new Set(sourceLaneXs)).toHaveLength(2);
    expect(Math.abs(sourceLaneXs[0]! - sourceLaneXs[1]!)).toBeGreaterThan(sourcePane.width);
  });

  it("uses the latest endpoint size when a live age grows from 9m to 10m", () => {
    const line = moveLine("age-tab");
    const fromRects = new Map([[line.tabId, { left: 40, top: 20, width: 60, height: 20 }]]);
    const workspaceRects = new Map([[line.toWorkspaceId, { left: 20, top: 100, width: 300, height: 200 }]]);
    const measure = (width: number) => groupingMeasuredMoveLines({
      lines: [line],
      fromRects,
      toRects: new Map([[line.tabId, { left: 120, top: 160, width, height: 20 }]]),
      workspaceRects,
      orientation: "vertical",
    })[0];

    expect(measure(68).toRect).not.toEqual(measure(60).toRect);
    expect(measure(68).leadIn).not.toEqual(measure(60).leadIn);
  });
});

describe("grouping move geometry", () => {
  it("converts a viewport rect to container-relative coordinates", () => {
    expect(groupingRelativeRect(
      { left: 130, top: 70, width: 40, height: 20 },
      { left: 100, top: 50, width: 500, height: 400 },
    )).toEqual({ left: 30, top: 20, width: 40, height: 20 });
  });

  it("builds the specified horizontal cubic path", () => {
    expect(groupingMoveLinePath(
      { left: 0, top: 0, width: 100, height: 20 },
      { left: 300, top: 100, width: 100, height: 20 },
      "horizontal",
    )).toBe("M 100 10 C 200 10 200 110 300 110");
  });

  it("uses bottom and top centres for a vertical path", () => {
    expect(groupingMoveLinePath(
      { left: 0, top: 0, width: 100, height: 20 },
      { left: 300, top: 100, width: 100, height: 20 },
      "vertical",
    )).toBe("M 50 20 C 50 60 350 60 350 100");
  });

  it("keeps the horizontal control distance at least 24", () => {
    expect(groupingMoveLinePath(
      { left: 0, top: 0, width: 100, height: 20 },
      { left: 110, top: 20, width: 100, height: 20 },
      "horizontal",
    )).toBe("M 100 10 C 124 10 86 30 110 30");
  });

  it("rounds every path coordinate to two decimal places", () => {
    expect(groupingMoveLinePath(
      { left: 0.123, top: 0.456, width: 100.111, height: 20.222 },
      { left: 300.789, top: 100.654, width: 100.111, height: 20.222 },
      "horizontal",
    )).toBe("M 100.23 10.57 C 200.51 10.57 200.51 110.77 300.79 110.77");
  });
});

describe("groupingSideBySideOrientation", () => {
  it.each([
    [0, "horizontal"],
    [959, "vertical"],
    [960, "horizontal"],
    [1400, "horizontal"],
  ] as const)("maps width %s to %s", (width, expected) => {
    expect(groupingSideBySideOrientation(width)).toBe(expected);
  });
});

describe("groupingMoveLineColor", () => {
  it("uses a destination palette colour when present", () => {
    const destinations = [{ ...workspace("ws-a", []), color: WORKSPACE_COLORS[2].value }];
    expect(groupingMoveLineColor(destinations, 0))
      .toBe(WORKSPACE_COLORS[2].value);
  });

  it("reserves every explicit colour before assigning deterministic fallbacks", () => {
    const destinations = [
      workspace("missing-first", []),
      { ...workspace("unknown", []), color: "#123456" },
      workspace("missing-at-index-2", []),
      { ...workspace("explicit-green-last", []), color: WORKSPACE_COLORS[2].value },
    ];
    const colors = destinations.map((_, index) => groupingMoveLineColor(destinations, index));

    expect(colors).toEqual([
      WORKSPACE_COLORS[5].value,
      WORKSPACE_COLORS[0].value,
      WORKSPACE_COLORS[3].value,
      WORKSPACE_COLORS[2].value,
    ]);
    expect(new Set(colors)).toHaveLength(destinations.length);
    expect(destinations.map((_, index) => groupingMoveLineColor(destinations, index))).toEqual(colors);
  });

  it("reuses the separated-hue palette deterministically only after it is exhausted", () => {
    const destinations = Array.from(
      { length: WORKSPACE_COLORS.length + 1 },
      (_, index) => workspace(`ws-${index}`, []),
    );
    const colors = destinations.map((_, index) => groupingMoveLineColor(destinations, index));

    expect(new Set(colors.slice(0, WORKSPACE_COLORS.length))).toHaveLength(WORKSPACE_COLORS.length);
    expect(colors.at(-1)).toBe(colors[0]);
  });
});
