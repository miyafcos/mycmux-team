// These are jsdom/pure-data measurements; Gate 5-R must remeasure p95 on the real WebView2 runtime.
// Run standalone: values collected while another test or build is running are invalid.
import { beforeEach, describe, expect, it } from "vitest";

import { groupingBoundary } from "../../src/components/layout/groupingBoundary";
import { applyEditCommand, beginGroupingEdit } from "../../src/components/layout/groupingEdit";
import { groupingLineageNodes } from "../../src/components/layout/groupingLineage";
import {
  groupingLeadInPath,
  groupingMeasuredMoveLines,
  groupingMoveDiffs,
  groupingMoveLinePath,
  groupingMoveLineRoutePath,
  type GroupingLineRect,
  type GroupingMoveDiff,
  type GroupingMoveLine,
} from "../../src/components/layout/groupingMoveLines";
import { defaultLayoutForTabs, type GroupingPlan } from "../../src/components/layout/tabGrouping";
import {
  __resetPersistenceCoordinatorForTests,
  markPersistentSchemaSupported,
} from "../../src/lib/workspacePersistenceCoordinator";
import {
  __resetGroupingRuntimeForTests,
  recordPersistentSchemaState,
} from "../../src/stores/groupingRuntimeStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import type { Pane, PaneTab, Workspace } from "../../src/types/workspace";

const FIXED_NOW = 1_800_000_000_000;

interface PerfStat {
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly samples: number;
}

interface Distribution {
  readonly id: "D1" | "D2" | "D3";
  readonly label: string;
  readonly workspaces: Workspace[];
}

interface RectMaps {
  readonly lines: GroupingMoveLine[];
  readonly fromRects: Map<string, GroupingLineRect>;
  readonly toRects: Map<string, GroupingLineRect>;
  readonly afterChipRects: Map<string, GroupingLineRect>;
  readonly paneRects: Map<string, GroupingLineRect>;
  readonly sourcePaneIds: Map<string, string>;
  readonly destinationPaneIds: Map<string, string>;
  readonly workspaceRects: Map<string, GroupingLineRect>;
}

/** Warm up four times, then take 41 samples; return the 21st sorted value as median and nearest-rank p95. */
function measure(run: () => void, samples = 41): PerfStat {
  run();
  run();
  run();
  run();
  const measured: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    run();
    measured.push(performance.now() - started);
  }
  measured.sort((left, right) => left - right);
  const median = measured[Math.floor(measured.length / 2)];
  const p95 = measured[Math.min(measured.length - 1, Math.ceil(0.95 * measured.length) - 1)];
  return { medianMs: median, p95Ms: p95, samples };
}

function logStat(
  itemId: "(a)" | "(b)" | "(c)",
  distribution: Distribution,
  stat: PerfStat,
  thresholdMs: number,
): void {
  console.log(
    `perf/G5-P ${itemId} ${distribution.id} median=${stat.medianMs.toFixed(3)}ms p95=${stat.p95Ms.toFixed(3)}ms n=${stat.samples}`,
  );
  if (stat.p95Ms > thresholdMs) console.log("WARN p95 over target");
}

function tab(id: string, ordinal: number, firstTabId: string, secondTabId: string): PaneTab {
  const origin: PaneTab["origin"] = ordinal === 0
    ? { kind: "human" }
    : ordinal === 1
      ? { kind: "agent", parentTabId: firstTabId }
      : ordinal === 2
        ? { kind: "agent", parentTabId: secondTabId }
        : { kind: "human" };
  return {
    id,
    sessionId: `session-${id}`,
    agentId: "shell-starter",
    agentKind: "codex",
    type: "terminal",
    label: `tab-${id}`,
    labelSource: "user",
    cwd: `C:\\work\\${id}`,
    origin,
  };
}

function pane(id: string, tabs: PaneTab[]): Pane {
  return {
    id,
    agentId: "shell-starter",
    sessionId: tabs[0]?.sessionId ?? `session-${id}`,
    activeTabId: tabs[0]?.id ?? "",
    tabs,
    label: `pane-${id}`,
    cwd: tabs[0]?.cwd ?? "C:\\work",
  };
}

function workspace(id: string, tabs: PaneTab[], createdAt: number): Workspace {
  const paneId = `${id}-pane`;
  return {
    id,
    name: id,
    gridTemplateId: "1x1",
    panes: [pane(paneId, tabs)],
    splitColumns: [[paneId]],
    columnWidths: [100],
    rowHeightsPerCol: [[100]],
    status: "running",
    createdAt,
  };
}

function makeDistribution(id: Distribution["id"], workspaceCount: number, tabsPerWorkspace: number): Distribution {
  const tabIds = Array.from({ length: 100 }, (_, index) => `${id}-tab-${index}`);
  const allTabs = tabIds.map((tabId, index) => tab(tabId, index, tabIds[0], tabIds[1]));
  const workspaces = Array.from({ length: workspaceCount }, (_, workspaceIndex) => workspace(
    `${id}-ws-${workspaceIndex}`,
    allTabs.slice(workspaceIndex * tabsPerWorkspace, (workspaceIndex + 1) * tabsPerWorkspace),
    FIXED_NOW + workspaceIndex,
  ));
  return {
    id,
    label: `${workspaceCount}WSx${tabsPerWorkspace}tabs`,
    workspaces,
  };
}

function distributions(): Distribution[] {
  return [
    makeDistribution("D1", 10, 10),
    makeDistribution("D2", 1, 100),
    makeDistribution("D3", 100, 1),
  ];
}

function allTabIds(workspaces: readonly Workspace[]): string[] {
  return workspaces.flatMap((item) => item.panes.flatMap((itemPane) => itemPane.tabs.map((itemTab) => itemTab.id)));
}

function planFor(distribution: Distribution): GroupingPlan {
  const ids = allTabIds(distribution.workspaces);
  const first = ids.slice(0, 50);
  const second = ids.slice(50);
  return {
    planId: `plan-${distribution.id}`,
    title: `性能案${distribution.id}`,
    rationale: "100タブの描画データを決定的に測る",
    strategy: "project",
    groups: [
      {
        groupId: `${distribution.id}-group-a`,
        title: "案件甲",
        disposition: "reorganize",
        destination: { kind: "new_workspace", proposedName: `移動先甲${distribution.id}` },
        layout: defaultLayoutForTabs(first, "母艦甲"),
        tabIds: first,
        adopted: true,
      },
      {
        groupId: `${distribution.id}-group-b`,
        title: "案件乙",
        disposition: "reorganize",
        destination: { kind: "new_workspace", proposedName: `移動先乙${distribution.id}` },
        layout: defaultLayoutForTabs(second, "母艦乙"),
        tabIds: second,
        adopted: true,
      },
    ],
    unassignedTabIds: [],
    warnings: [],
  };
}

type PreviewContext = Parameters<typeof groupingBoundary.preview>[1];

function contextFor(distribution: Distribution): PreviewContext {
  const firstTab = distribution.workspaces[0]?.panes[0]?.tabs[0];
  return {
    baseline: distribution.workspaces.flatMap((item) => item.panes.flatMap((itemPane) => (
      itemPane.tabs.map((itemTab) => ({
        tabId: itemTab.id,
        workspaceId: item.id,
        paneId: itemPane.id,
        sessionId: itemTab.sessionId,
      }))
    ))),
    activeWorkspaceId: distribution.workspaces[0]?.id ?? null,
    activeSessionId: firstTab?.sessionId ?? null,
    allocationSeed: `g5p-${distribution.id}`,
    createdAt: FIXED_NOW,
    newWorkspaceDefaults: { status: "running", pet: "clawd" },
  };
}

function seedStores(workspaces: Workspace[]): void {
  __resetGroupingRuntimeForTests();
  __resetPersistenceCoordinatorForTests();
  markPersistentSchemaSupported(1);
  recordPersistentSchemaState({ loadedSchemaVersion: 1, migrationComplete: true });
  useWorkspaceListStore.setState({
    workspaces: structuredClone(workspaces),
    layoutRevision: 0,
    activeWorkspaceId: workspaces[0]?.id ?? null,
    lastActivePaneByWorkspace: Object.fromEntries(workspaces.flatMap((item) => {
      const sessionId = item.panes[0]?.tabs[0]?.sessionId;
      return sessionId ? [[item.id, sessionId]] : [];
    })),
  });
  const activeSessionId = workspaces[0]?.panes[0]?.tabs[0]?.sessionId ?? null;
  useUiStore.setState({ activePaneId: activeSessionId, lastActivePaneId: activeSessionId, focusRevision: 0 });
}

function requirePreview(plan: GroupingPlan, context: PreviewContext): Workspace[] {
  const preview = groupingBoundary.preview(plan, context);
  if (!preview.ok) throw new Error(preview.errors.join(" / "));
  return preview.transaction.workspaces;
}

function lineFromDiff(diff: GroupingMoveDiff): GroupingMoveLine {
  return {
    tabId: diff.tabId,
    label: diff.label,
    fromWorkspaceId: diff.fromWorkspaceId,
    toWorkspaceId: diff.toWorkspaceId,
    fromRect: null,
    toRect: null,
  };
}

function rectMaps(before: readonly Workspace[], after: readonly Workspace[], diffs: readonly GroupingMoveDiff[]): RectMaps {
  const lines = diffs.map(lineFromDiff);
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
      paneRects.set(paneKey, {
        left: 0,
        top: paneTop - 12,
        width: 124,
        height: Math.max(48, itemPane.tabs.length * 24 + 24),
      });
      return itemPane.tabs.map((itemTab, tabIndex) => [
        itemTab.id,
        { rect: { left: 20, top: paneTop + tabIndex * 24, width: 100, height: 20 }, paneId: paneKey },
      ] as const);
    });
    beforeWorkspaceTop += item.panes.reduce(
      (height, itemPane) => height + Math.max(48, itemPane.tabs.length * 24 + 24) + 24,
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
    paneRects.set(paneKey, {
      left: paneLeft - 24,
      top: paneTop - 12,
      width: 220,
      height: Math.max(48, itemPane.tabs.length * 24 + 24),
    });
    const workspaceHeight = item.panes.reduce(
      (height, itemPaneValue) => height + Math.max(48, itemPaneValue.tabs.length * 24 + 24) + 24,
      0,
    );
    workspaceRects.set(item.id, {
      left: paneLeft - 50,
      top: 0,
      width: 240,
      height: Math.max(280, workspaceHeight),
    });
    return itemPane.tabs.map((itemTab, tabIndex) => {
      const rect = { left: paneLeft, top: paneTop + tabIndex * 24, width: 100, height: 20 };
      afterChipRects.set(itemTab.id, rect);
      return [itemTab.id, { rect, paneId: paneKey }] as const;
    });
  })));
  for (const line of lines) {
    const source = beforeLocations.get(line.tabId);
    const destination = afterLocations.get(line.tabId);
    if (source) {
      fromRects.set(line.tabId, source.rect);
      sourcePaneIds.set(line.tabId, source.paneId);
    }
    if (destination) {
      toRects.set(line.tabId, destination.rect);
      destinationPaneIds.set(line.tabId, destination.paneId);
    }
  }
  return {
    lines,
    fromRects,
    toRects,
    afterChipRects,
    paneRects,
    sourcePaneIds,
    destinationPaneIds,
    workspaceRects,
  };
}

function drawData(distribution: Distribution, plan: GroupingPlan, context: PreviewContext) {
  const after = requirePreview(plan, context);
  const diffs = groupingMoveDiffs(distribution.workspaces, after);
  const lineage = groupingLineageNodes(distribution.workspaces);
  const maps = rectMaps(distribution.workspaces, after, diffs);
  const measured = groupingMeasuredMoveLines({ ...maps, orientation: "horizontal" });
  const paths = measured.flatMap((line) => [
    line.routePoints
      ? groupingMoveLineRoutePath(line.routePoints)
      : groupingMoveLinePath(line.fromRect!, line.toRect!, "horizontal"),
    ...(line.leadIn ? [groupingLeadInPath(line.leadIn, "horizontal")] : []),
  ]);
  return { after, diffs, lineage, maps, measured, paths };
}

function editedDiffs(distribution: Distribution, plan: GroupingPlan, context: PreviewContext): GroupingMoveDiff[] {
  const tabId = plan.groups[0].tabIds[0];
  const edited = applyEditCommand(beginGroupingEdit(plan), {
    kind: "reassign_tabs",
    tabIds: [tabId],
    target: { kind: "pane", groupId: plan.groups[1].groupId, columnIndex: 0, paneIndex: 0 },
  });
  const after = requirePreview(edited.plan, context);
  return groupingMoveDiffs(distribution.workspaces, after);
}

beforeEach(() => {
  __resetGroupingRuntimeForTests();
  __resetPersistenceCoordinatorForTests();
});

describe("G5-P 100-tab pure-data performance", () => {
  it.each(distributions())("(a) confirm draw data $id $label", (distribution) => {
    seedStores(distribution.workspaces);
    const plan = planFor(distribution);
    const context = contextFor(distribution);
    const output = drawData(distribution, plan, context);
    expect(allTabIds(distribution.workspaces)).toHaveLength(100);
    expect(output.diffs).toHaveLength(100);
    expect(output.lineage.size).toBe(100);
    expect(output.measured).toHaveLength(100);
    expect(output.paths.length).toBeGreaterThanOrEqual(100);
    expect(output.paths.every((path) => path.startsWith("M "))).toBe(true);
    const stat = measure(() => { drawData(distribution, plan, context); });
    logStat("(a)", distribution, stat, 100);
    expect(stat.medianMs).toBeLessThanOrEqual(100);
  });

  it.each(distributions())("(b) one edit $id $label", (distribution) => {
    seedStores(distribution.workspaces);
    const plan = planFor(distribution);
    const context = contextFor(distribution);
    const initial = requirePreview(plan, context);
    const edited = editedDiffs(distribution, plan, context);
    expect(groupingMoveDiffs(distribution.workspaces, initial)).toHaveLength(100);
    expect(edited).toHaveLength(100);
    const stat = measure(() => {
      const diffs = editedDiffs(distribution, plan, context);
      if (diffs.length !== 100) throw new Error(`edited diff count=${diffs.length}`);
    });
    logStat("(b)", distribution, stat, 50);
    expect(stat.medianMs).toBeLessThanOrEqual(50);
  });

  it.each(distributions())("(c) measured move lines $id $label", (distribution) => {
    seedStores(distribution.workspaces);
    const plan = planFor(distribution);
    const context = contextFor(distribution);
    const after = requirePreview(plan, context);
    const diffs = groupingMoveDiffs(distribution.workspaces, after);
    const maps = rectMaps(distribution.workspaces, after, diffs);
    expect(groupingMeasuredMoveLines({ ...maps, orientation: "horizontal" })).toHaveLength(100);
    const stat = measure(() => {
      const measured = groupingMeasuredMoveLines({ ...maps, orientation: "horizontal" });
      if (measured.length !== 100) throw new Error(`measured line count=${measured.length}`);
    });
    logStat("(c)", distribution, stat, 5);
    expect(stat.medianMs).toBeLessThanOrEqual(5);
  });
});
