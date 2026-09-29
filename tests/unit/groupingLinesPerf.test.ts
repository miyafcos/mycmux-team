// Timing contracts are owned by `npm run perf:grouping` in isolated execution.
// This jsdom suite covers only pure diff, geometry, collision, and draw-data behavior.
import { describe, expect, it } from "vitest";

import {
  groupingLeadInPath,
  groupingMeasuredMoveLines,
  groupingMoveDiffs,
  groupingMoveLinePath,
  groupingMoveLineRoutePath,
  groupingMoveLines,
  type GroupingLineRect,
} from "../../src/components/layout/groupingMoveLines";
import type { Pane, PaneTab, Workspace } from "../../src/types/workspace";

function tab(id: string): PaneTab {
  return { id, sessionId: `session-${id}`, agentId: "codex", label: id };
}

function pane(id: string, tabs: PaneTab[]): Pane {
  return { id, agentId: "codex", sessionId: tabs[0]?.sessionId ?? "", tabs, activeTabId: tabs[0]?.id ?? "" };
}

function workspace(id: string, tabs: PaneTab[]): Workspace {
  const paneId = `${id}-pane`;
  return {
    id,
    name: id,
    gridTemplateId: "1x1",
    panes: [pane(paneId, tabs)],
    splitColumns: [[paneId]],
    status: "running",
    createdAt: 1,
  };
}

function rotate(workspaces: Workspace[]): Workspace[] {
  const result = structuredClone(workspaces);
  const tabGroups = workspaces.map((item) => item.panes[0].tabs);
  result.forEach((item, index) => {
    item.panes[0].tabs = structuredClone(tabGroups[(index - 1 + tabGroups.length) % tabGroups.length]);
    item.panes[0].activeTabId = item.panes[0].tabs[0]?.id ?? "";
    item.panes[0].sessionId = item.panes[0].tabs[0]?.sessionId ?? "";
  });
  return result;
}

function distributions(): Array<{ name: string; before: Workspace[]; after: Workspace[] }> {
  const tenByTen = Array.from({ length: 10 }, (_, workspaceIndex) => workspace(
    `ws-${workspaceIndex}`,
    Array.from({ length: 10 }, (_, tabIndex) => tab(`ten-${workspaceIndex}-${tabIndex}`)),
  ));
  const hundredSources = Array.from({ length: 100 }, (_, index) => workspace(`source-${index}`, [tab(`target-${index}`)]));
  const hundredSingles = Array.from({ length: 100 }, (_, index) => workspace(`single-${index}`, [tab(`single-tab-${index}`)]));
  return [
    { name: "10WSx10tabs", before: tenByTen, after: rotate(tenByTen) },
    {
      name: "1WS-receives-100tabs",
      before: hundredSources,
      after: [workspace("target", hundredSources.flatMap((item) => structuredClone(item.panes[0].tabs)))],
    },
    { name: "100WSx1tab", before: hundredSingles, after: rotate(hundredSingles) },
  ];
}

function rectMaps(before: readonly Workspace[], after: readonly Workspace[]) {
  const lines = groupingMoveLines(before, after);
  const fromRects = new Map<string, GroupingLineRect>();
  const toRects = new Map<string, GroupingLineRect>();
  const afterChipRects = new Map<string, GroupingLineRect>();
  const paneRects = new Map<string, GroupingLineRect>();
  const sourcePaneIds = new Map<string, string>();
  const destinationPaneIds = new Map<string, string>();
  const workspaceRects = new Map<string, GroupingLineRect>();
  let beforeWorkspaceTop = 0;
  const beforeLocations = new Map(before.flatMap((item) => {
    const workspaceTop = beforeWorkspaceTop;
    const locations = item.panes.flatMap((itemPane, paneIndex) => {
      const paneTop = workspaceTop + item.panes.slice(0, paneIndex).reduce(
        (top, priorPane) => top + Math.max(48, priorPane.tabs.length * 24 + 24) + 24,
        0,
      );
      const paneKey = `before:${itemPane.id}`;
      paneRects.set(paneKey, { left: 0, top: paneTop - 12, width: 124, height: Math.max(48, itemPane.tabs.length * 24 + 24) });
      return itemPane.tabs.map((itemTab, tabIndex) => [
        itemTab.id,
        { rect: { left: 20, top: paneTop + tabIndex * 24, width: 100, height: 20 }, paneId: paneKey },
      ] as const);
    });
    beforeWorkspaceTop += item.panes.reduce(
      (height, paneItem) => height + Math.max(48, paneItem.tabs.length * 24 + 24) + 24,
      0,
    );
    return locations;
  }));
  const afterLocations = new Map(after.flatMap((item, workspaceIndex) => item.panes.flatMap((itemPane, paneIndex) => {
    const paneLeft = 500 + workspaceIndex * 240;
    const paneTop = item.panes.slice(0, paneIndex).reduce(
      (top, priorPane) => top + Math.max(48, priorPane.tabs.length * 24 + 24) + 24,
      0,
    );
    const paneKey = `after:${itemPane.id}`;
    paneRects.set(paneKey, { left: paneLeft - 24, top: paneTop - 12, width: 220, height: Math.max(48, itemPane.tabs.length * 24 + 24) });
    const workspaceHeight = item.panes.reduce(
      (height, paneItem) => height + Math.max(48, paneItem.tabs.length * 24 + 24) + 24,
      0,
    );
    workspaceRects.set(item.id, { left: paneLeft - 50, top: 0, width: 240, height: Math.max(280, workspaceHeight) });
    return itemPane.tabs.map((itemTab, tabIndex) => {
      const rect = { left: paneLeft, top: paneTop + tabIndex * 24, width: 100, height: 20 };
      afterChipRects.set(itemTab.id, rect);
      return [itemTab.id, { rect, paneId: paneKey }] as const;
    });
  })));
  lines.forEach((line) => {
    const source = beforeLocations.get(line.tabId);
    if (source) {
      fromRects.set(line.tabId, source.rect);
      sourcePaneIds.set(line.tabId, source.paneId);
    }
    const location = afterLocations.get(line.tabId);
    if (!location) return;
    toRects.set(line.tabId, location.rect);
    destinationPaneIds.set(line.tabId, location.paneId);
  });
  return { lines, fromRects, toRects, afterChipRects, paneRects, sourcePaneIds, destinationPaneIds, workspaceRects };
}

function generateDrawData(before: readonly Workspace[], after: readonly Workspace[]) {
  const diffs = groupingMoveDiffs(before, after);
  const maps = rectMaps(before, after);
  const measured = groupingMeasuredMoveLines({ ...maps, orientation: "horizontal" });
  const mainPaths = measured.map((line) => (
    line.routePoints
      ? groupingMoveLineRoutePath(line.routePoints)
      : groupingMoveLinePath(line.fromRect!, line.toRect!, "horizontal")
  ));
  const paths = measured.flatMap((line, index) => [
    mainPaths[index],
    ...(line.leadIn ? [groupingLeadInPath(line.leadIn, "horizontal")] : []),
  ]);
  return { diffs, measured, mainPaths, paths, detourCount: measured.filter((line) => line.routePoints !== null).length };
}

function withOneEditedMove(after: readonly Workspace[]): Workspace[] {
  const edited = structuredClone(after) as Workspace[];
  const source = edited.find((item) => item.panes.some((itemPane) => itemPane.tabs.length > 0));
  const sourcePane = source?.panes.find((itemPane) => itemPane.tabs.length > 0);
  const moved = sourcePane?.tabs.shift();
  if (!source || !sourcePane || !moved) return edited;
  if (edited.length === 1) {
    const editPane = pane(`${source.id}-edit-pane`, [moved]);
    source.panes.push(editPane);
    source.splitColumns = [[sourcePane.id], [editPane.id]];
  } else {
    const destinationPane = edited.at(-1)!.panes[0];
    destinationPane.tabs.push(moved);
  }
  sourcePane.activeTabId = sourcePane.tabs[0]?.id ?? "";
  return edited;
}

describe("grouping line behavior contracts", () => {
  it.each(distributions())("keeps $name geometry and collision output complete", ({ name, before, after }) => {
    const maps = rectMaps(before, after);
    const editedAfter = withOneEditedMove(after);
    const initialOutput = generateDrawData(before, after);
    const editedOutput = generateDrawData(before, editedAfter);
    const expectedEditedCount = name === "1WS-receives-100tabs" ? 100 : 99;
    expect(initialOutput.diffs).toHaveLength(100);
    expect(initialOutput.measured).toHaveLength(100);
    expect(initialOutput.paths.length).toBeGreaterThanOrEqual(100);
    expect(initialOutput.paths.length).toBeLessThanOrEqual(200);
    expect(editedOutput.diffs).toHaveLength(expectedEditedCount);
    expect(editedOutput.measured).toHaveLength(expectedEditedCount);
    expect(editedOutput.paths.length).toBeGreaterThanOrEqual(expectedEditedCount);
    expect(editedOutput.paths.length).toBeLessThanOrEqual(expectedEditedCount * 2);
    expect(initialOutput.detourCount).toBeGreaterThan(0);
    expect(editedOutput.detourCount).toBeGreaterThan(0);
    expect(initialOutput.measured.every((line, index) => (
      line.routePoints === null || initialOutput.mainPaths[index].includes(" L ")
    ))).toBe(true);
    expect(editedOutput.measured.every((line, index) => (
      line.routePoints === null || editedOutput.mainPaths[index].includes(" L ")
    ))).toBe(true);
    expect([...initialOutput.paths, ...editedOutput.paths].every((path) => path.startsWith("M "))).toBe(true);
    expect(groupingMeasuredMoveLines({ ...maps, orientation: "horizontal" })).toHaveLength(100);
  });
});
