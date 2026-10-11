// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", async importOriginal => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(async () => true),
}));

import { groupingBoundary } from "../../src/components/layout/groupingBoundary";
import { applyEditCommand, beginGroupingEdit } from "../../src/components/layout/groupingEdit";
import { buildLocalGroupingScan, buildPresetGroupingPlan } from "../../src/components/layout/groupingLocalPlan";
import type { GroupingPresetStrategy } from "../../src/components/layout/tabGrouping";
import { __resetPersistenceCoordinatorForTests, markPersistentSchemaSupported } from "../../src/lib/workspacePersistenceCoordinator";
import { __resetGroupingRuntimeForTests, recordPersistentSchemaState } from "../../src/stores/groupingRuntimeStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import type { Pane, PaneTab, Workspace } from "../../src/types";

const NOW = 1_800_000_000_000;
const strategies: GroupingPresetStrategy[] = ["active_watch", "main_sessions"];
type EditCase = "empty column" | "surviving resident row" | "another adopted group";

function pane(id: string, tabIds = [id], human = false): Pane {
  const tabs: PaneTab[] = tabIds.map(tabId => ({
    id: tabId, sessionId: `session-${tabId}`, agentId: "shell-starter", type: "terminal",
    label: tabId, labelSource: "user", cwd: `/work/${tabId}`,
    origin: { kind: human ? "human" : "agent" },
  }));
  return { id: `p-${id}`, tabs, agentId: tabs[0].agentId, sessionId: tabs[0].sessionId,
    activeTabId: tabs[0].id, label: id, cwd: tabs[0].cwd };
}

function initialLayout(strategy: GroupingPresetStrategy, rows: number): Workspace[] {
  const sourcePanes = [pane("focus", ["focus", "spare"]), ...["w", "m2", "m3"].map(id => pane(id, [id], true))];
  const residentColumns = Array.from({ length: 4 }, (_, column) => [
    pane(`r${column}`), ...(rows === 2 ? [pane(`r${column}b`)] : []),
  ]);
  return [
    { id: "source", name: "作業机", gridTemplateId: "4x1", status: "running", createdAt: NOW - 1,
      panes: sourcePanes, splitColumns: sourcePanes.map(pane => [pane.id]),
      columnWidths: [20, 25, 30, 25], rowHeightsPerCol: sourcePanes.map(() => [100]) },
    { id: "destination", name: strategy === "active_watch" ? "稼働中" : "メイン", gridTemplateId: rows === 2 ? "4x2" : "4x1",
      status: "running", createdAt: NOW, color: "blue", pet: "clawd",
      panes: residentColumns.flat(), splitColumns: residentColumns.map(column => column.map(pane => pane.id)),
      columnWidths: [20, 25, 30, 25], rowHeightsPerCol: residentColumns.map(() => rows === 2 ? [45, 55] : [100]) },
  ];
}

function liveSnapshot() {
  const workspace = useWorkspaceListStore.getState();
  const ui = useUiStore.getState();
  return structuredClone({ workspaces: workspace.workspaces, activeWorkspaceId: workspace.activeWorkspaceId,
    lastActivePaneByWorkspace: workspace.lastActivePaneByWorkspace,
    activePaneId: ui.activePaneId, lastActivePaneId: ui.lastActivePaneId });
}

function identityPairs(workspaces: Workspace[]) {
  return workspaces.flatMap(workspace => workspace.panes.flatMap(pane => pane.tabs.map(tab => [tab.id, tab.sessionId])))
    .sort((left, right) => left[0].localeCompare(right[0]));
}

function allTabs(workspaces: Workspace[]) {
  return workspaces.flatMap(workspace => workspace.panes.flatMap(pane => pane.tabs))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function changeLiveLayout(change: (workspaces: Workspace[]) => void, bumpRevision = true) {
  const store = useWorkspaceListStore.getState();
  const workspaces = structuredClone(store.workspaces);
  change(workspaces);
  useWorkspaceListStore.setState({ workspaces, layoutRevision: store.layoutRevision + Number(bumpRevision) });
}

async function fixture(strategy: GroupingPresetStrategy, rows = 1) {
  const original = initialLayout(strategy, rows);
  useWorkspaceListStore.setState({ workspaces: structuredClone(original),
    layoutRevision: useWorkspaceListStore.getState().layoutRevision + 1,
    activeWorkspaceId: "source", lastActivePaneByWorkspace: { source: "session-focus", destination: "session-r0" } });
  useUiStore.setState({ activePaneId: "session-focus", lastActivePaneId: "session-focus", focusRevision: 0 });
  const scan = await buildLocalGroupingScan({
    workspaces: useWorkspaceListStore.getState().workspaces, now: NOW, attentionByTabId: {},
    metadata: Object.fromEntries(["w", "m2", "m3"].map(id => [`session-${id}`, { agentStatus: "working" as const }])),
    lastOutputBySession: { "session-w": NOW, "session-m2": NOW - 1, "session-m3": NOW - 2 },
    attentionBySession: {}, questionsBySession: {}, seenAttentionByTab: {},
  });
  const plan = buildPresetGroupingPlan(scan, strategy);
  expect(plan.groups[0].tabIds).toEqual(["w", "m2", "m3"]);
  expect(plan.groups[0].destination).toEqual({ kind: "existing_workspace", workspaceId: "destination" });
  expect(plan.groups[0].layout?.columns.map(column => column.existingColumnPaneId)).toEqual(["p-r0", "p-r1", "p-r2"]);
  const context = { baseline: scan.baseline, activeWorkspaceId: "source", activeSessionId: "session-focus",
    allocationSeed: `anchor-edit-${strategy}`, createdAt: NOW };
  return { plan, context, original, before: liveSnapshot() };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  __resetGroupingRuntimeForTests();
  __resetPersistenceCoordinatorForTests();
  markPersistentSchemaSupported(1);
  recordPersistentSchemaState({ loadedSchemaVersion: 1, migrationComplete: true });
});

afterEach(() => {
  __resetPersistenceCoordinatorForTests();
  __resetGroupingRuntimeForTests();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe.each(strategies)("%s anchor-resident editing", strategy => {
  it.each<EditCase>(["empty column", "surviving resident row", "another adopted group"])(
    "previews, applies and undoes a real preset with %s",
    async editCase => {
      const rows = editCase === "surviving resident row" ? 2 : 1;
      const { plan, context, original, before } = await fixture(strategy, rows);
      const layoutRevision = useWorkspaceListStore.getState().layoutRevision;
      const focusRevision = useUiStore.getState().focusRevision;
      let edit = beginGroupingEdit(plan);
      const selectedGroupId = plan.groups[0].groupId;
      if (editCase === "another adopted group") {
        edit = applyEditCommand(edit, { kind: "create_group", title: "別の作業", tabIds: ["spare"] },
          { idFactory: () => "other-adopted", existingWorkspaceNames: original.map(workspace => workspace.name) });
      }
      edit = applyEditCommand(edit, { kind: "reassign_tabs", tabIds: ["r0"], target: {
        kind: "pane", groupId: editCase === "another adopted group" ? "other-adopted" : selectedGroupId,
        columnIndex: 0, paneIndex: 0,
      } });
      const selected = edit.plan.groups.find(group => group.groupId === selectedGroupId)!;
      expect(selected.layout?.columns[0].existingColumnPaneId).toBe("p-r0");
      expect(selected.layout?.columns[0].panes[0].tabIds).toEqual(editCase === "another adopted group" ? ["w"] : ["w", "r0"]);
      if (editCase === "another adopted group") {
        expect(edit.plan.groups.find(group => group.groupId === "other-adopted")).toMatchObject({
          adopted: true, disposition: "reorganize", tabIds: ["spare", "r0"],
        });
      }
      expect(liveSnapshot()).toEqual(before);
      expect(plan.groups[0].tabIds).toEqual(["w", "m2", "m3"]);

      const preview = groupingBoundary.preview(edit.plan, context);
      expect(preview.ok, preview.ok ? undefined : preview.errors.join(" / ")).toBe(true);
      if (!preview.ok) throw new Error("Edited preset preview failed");
      const prepared = groupingBoundary.prepare(edit.plan, context);
      expect(prepared.ok, prepared.ok ? undefined : prepared.errors.join(" / ")).toBe(true);
      if (!prepared.ok) throw new Error("Edited preset preparation failed");
      expect(prepared.ticket.transaction.workspaces).toEqual(preview.transaction.workspaces);
      expect(liveSnapshot()).toEqual(before);
      expect(useWorkspaceListStore.getState().layoutRevision).toBe(layoutRevision);
      expect(useUiStore.getState().focusRevision).toBe(focusRevision);

      const result = groupingBoundary.commit(edit.plan, prepared.ticket);
      expect(result.commit).toMatchObject({ ok: true });
      const applied = useWorkspaceListStore.getState().workspaces;
      expect(identityPairs(applied)).toEqual(identityPairs(original));
      expect(allTabs(applied)).toEqual(allTabs(original));
      const destination = applied.find(workspace => workspace.id === "destination")!;
      const newPaneFor = (tabId: string) => destination.panes.find(pane => pane.tabs.some(tab => tab.id === tabId))!;
      const w = newPaneFor("w");
      const m2 = newPaneFor("m2");
      const m3 = newPaneFor("m3");
      expect(destination.splitColumns).toEqual(rows === 2 ? [
        ["p-r0b", w.id], ["p-r1", "p-r1b", m2.id], ["p-r2", "p-r2b", m3.id], ["p-r3", "p-r3b"],
      ] : [[w.id], ["p-r1", m2.id], ["p-r2", m3.id], ["p-r3"]]);
      expect(destination.panes.some(pane => pane.id === "p-r0")).toBe(false);
      expect([w.activeTabId, m2.activeTabId, m3.activeTabId]).toEqual(["w", "m2", "m3"]);
      expect(w.tabs.map(tab => tab.id)).toEqual(editCase === "another adopted group" ? ["w"] : ["w", "r0"]);
      for (const resident of original[1].panes.filter(pane => pane.id !== "p-r0")) {
        expect(destination.panes.find(pane => pane.id === resident.id)).toEqual(resident);
      }
      expect(destination.splitColumns?.every(column => column.length <= 4)).toBe(true);
      const source = applied.find(workspace => workspace.id === "source")!;
      expect(source.splitColumns).toEqual([["p-focus"]]);
      expect(source.panes[0].tabs.map(tab => tab.id)).toEqual(editCase === "another adopted group" ? ["focus"] : ["focus", "spare"]);
      if (editCase === "another adopted group") {
        const other = applied.find(workspace => workspace.name === "別の作業")!;
        expect(other.panes[0].tabs.map(tab => [tab.id, tab.sessionId])).toEqual([
          ["spare", "session-spare"], ["r0", "session-r0"],
        ]);
        expect(other.splitColumns).toEqual([[other.panes[0].id]]);
      }

      expect(groupingBoundary.undo()).toMatchObject({ ok: true });
      expect(liveSnapshot()).toEqual(before);
    },
  );

  it("rejects an anchor removed externally before preparation without appending elsewhere", async () => {
    const { plan, context } = await fixture(strategy);
    changeLiveLayout(workspaces => {
      const destination = workspaces[1];
      destination.panes = destination.panes.filter(pane => pane.id !== "p-r0");
      destination.splitColumns = destination.splitColumns!.slice(1);
    });
    const changed = liveSnapshot();
    for (const compile of [groupingBoundary.preview, groupingBoundary.prepare]) {
      const result = compile(plan, context);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Missing anchor accepted");
      expect(result.errors).toContain("既存列の表示場所が見つかりません: p-r0");
    }
    expect(liveSnapshot()).toEqual(changed);
  });

  it("rejects an anchor moved to another workspace before preparation", async () => {
    const { plan, context } = await fixture(strategy);
    changeLiveLayout(workspaces => {
      const destination = workspaces[1];
      const anchor = destination.panes.find(pane => pane.id === "p-r0")!;
      destination.panes = destination.panes.filter(pane => pane.id !== anchor.id);
      destination.splitColumns = destination.splitColumns!.slice(1);
      workspaces[0].panes.push(anchor);
      workspaces[0].splitColumns![0].push(anchor.id);
    });
    const changed = liveSnapshot();
    for (const compile of [groupingBoundary.preview, groupingBoundary.prepare]) {
      const result = compile(plan, context);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Moved live anchor accepted");
      expect(result.errors).toContain("既存列の表示場所が見つかりません: p-r0");
    }
    expect(liveSnapshot()).toEqual(changed);
  });

  it("rejects an anchor column filled before preparation", async () => {
    const { plan, context } = await fixture(strategy);
    changeLiveLayout(workspaces => {
      const added = ["external-0", "external-1", "external-2"].map(id => pane(id));
      workspaces[1].panes.push(...added);
      workspaces[1].splitColumns![0].push(...added.map(pane => pane.id));
    });
    const changed = liveSnapshot();
    for (const compile of [groupingBoundary.preview, groupingBoundary.prepare]) {
      const result = compile(plan, context);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Overfull anchor column accepted");
      expect(result.errors).toContain("ワークスペース destination で上下に表示するタブ数が4を超えます");
    }
    expect(liveSnapshot()).toEqual(changed);
  });

  it("rejects a live layout change after preparation as preview_stale even without a revision bump", async () => {
    const { plan, context } = await fixture(strategy);
    const prepared = groupingBoundary.prepare(plan, context);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error("Unedited preset preparation failed");
    const revision = useWorkspaceListStore.getState().layoutRevision;
    changeLiveLayout(workspaces => { workspaces[1].splitColumns!.reverse(); }, false);
    const changed = liveSnapshot();
    expect(useWorkspaceListStore.getState().layoutRevision).toBe(revision);
    expect(groupingBoundary.commit(plan, prepared.ticket).commit).toMatchObject({ ok: false, kind: "preview_stale" });
    expect(liveSnapshot()).toEqual(changed);
  });

  it("rejects an anchor-field-only change after preparation as plan_changed", async () => {
    const { plan, context, before } = await fixture(strategy);
    const prepared = groupingBoundary.prepare(plan, context);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error("Unedited preset preparation failed");
    const changed = structuredClone(plan);
    changed.groups[0].layout!.columns[0].existingColumnPaneId = "p-r3";
    expect(groupingBoundary.preview(changed, context).ok).toBe(true);
    expect(groupingBoundary.commit(changed, prepared.ticket).commit).toMatchObject({ ok: false, kind: "plan_changed" });
    expect(liveSnapshot()).toEqual(before);
  });
});
