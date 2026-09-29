import { beforeEach, describe, expect, it, vi } from "vitest";

import { defaultLayoutForTabs } from "../../src/components/layout/tabGrouping";
import type { Pane, PaneTab, Workspace } from "../../src/types";
import {
  createGroupingEngine,
  normalizeGroupingStateSnapshot,
  persistentLayoutProjection,
  validateGroupingStateSnapshot,
  type GroupingCompileContext,
  type GroupingEngineDependencies,
  type GroupingPlan,
  type GroupingSelectionState,
  type GroupingStateSnapshot,
} from "./helpers/groupingTestEntrypoint";

const NOW = 1_800_000_000_000;

function tab(id: string): PaneTab {
  return {
    id,
    sessionId: `session-${id}`,
    agentId: "shell-starter",
    type: "terminal",
    label: `label-${id}`,
    labelSource: "user",
    cwd: `C:/work/${id}`,
    origin: { kind: "human" },
  };
}

function pane(id: string, tabs: PaneTab[], activeTabId = tabs[0].id): Pane {
  const active = tabs.find((item) => item.id === activeTabId) ?? tabs[0];
  return {
    id,
    agentId: active.agentId,
    sessionId: active.sessionId,
    activeTabId: active.id,
    tabs,
    label: `pane-${id}`,
    cwd: active.cwd,
  };
}

function workspace(id: string, name: string, itemPane: Pane): Workspace {
  return {
    id,
    name,
    gridTemplateId: "1x1",
    status: "running",
    createdAt: NOW,
    color: `color-${id}`,
    pet: "clawd",
    panes: [itemPane],
    splitColumns: [[itemPane.id]],
    columnWidths: [100],
    rowHeightsPerCol: [[100]],
  };
}

function initialLayout(): Workspace[] {
  return [
    workspace("ws-a", "母艦", pane("pane-a", [tab("t1"), tab("t2")])),
    workspace("ws-b", "作業机", pane("pane-b", [tab("t3")])),
  ];
}

function baselineOf(workspaces: readonly Workspace[]) {
  return workspaces.flatMap((item) => item.panes.flatMap((itemPane) => (
    itemPane.tabs.map((itemTab) => ({
      tabId: itemTab.id,
      workspaceId: item.id,
      paneId: itemPane.id,
      sessionId: itemTab.sessionId,
    }))
  )));
}

function contextFor(
  workspaces: readonly Workspace[],
  seed: string,
  activeWorkspaceId = "ws-a",
  activeSessionId = "session-t1",
): GroupingCompileContext {
  return {
    baseline: baselineOf(workspaces),
    activeWorkspaceId,
    activeSessionId,
    allocationSeed: seed,
    createdAt: NOW,
    newWorkspaceDefaults: { status: "running", pet: "clawd" },
  };
}

function planFor(movedTabIds: string[]): GroupingPlan {
  const allTabIds = ["t1", "t2", "t3"];
  return {
    planId: `plan-round12-${movedTabIds.join("-")}`,
    title: "案件で分ける",
    rationale: "案件単位",
    strategy: "project",
    groups: [
      {
        groupId: "group-move",
        title: "案件甲",
        disposition: "reorganize",
        destination: { kind: "new_workspace", proposedName: "案件甲" },
        layout: defaultLayoutForTabs(movedTabIds, "案件甲"),
        tabIds: [...movedTabIds],
        adopted: true,
      },
      {
        groupId: "group-keep",
        title: "現状維持",
        disposition: "keep",
        destination: { kind: "current_locations" },
        layout: null,
        tabIds: allTabIds.filter((id) => !movedTabIds.includes(id)),
        adopted: true,
      },
    ],
    unassignedTabIds: [],
    warnings: [],
  };
}

function harness(
  initial: Workspace[],
  initialSelection: GroupingSelectionState = {
    activeWorkspaceId: "ws-a",
    activeSessionId: "session-t1",
    lastActivePaneByWorkspace: {
      "ws-a": "session-t1",
      "ws-b": "session-t3",
    },
  },
) {
  let workspaces = structuredClone(initial);
  let selection = structuredClone(initialSelection);
  let undoRecord: Parameters<GroupingEngineDependencies["undo"]["set"]>[0] | null = null;
  const state = { replaceCalls: 0, restoreCalls: 0, selectionCalls: 0 };
  const deps: GroupingEngineDependencies = {
    boundaryToken: {},
    getWorkspaces: () => workspaces,
    getSelection: () => selection,
    replaceWorkspaces: (next) => {
      state.replaceCalls += 1;
      workspaces = structuredClone(next);
    },
    applySelection: (next) => {
      state.selectionCalls += 1;
      selection = structuredClone(next);
    },
    restoreGroupingState: (snapshot) => {
      state.restoreCalls += 1;
      workspaces = structuredClone(snapshot.workspaces);
      selection = structuredClone(snapshot.selection);
    },
    getLayoutRevision: () => 1,
    undo: {
      get: () => undoRecord,
      set: (record) => { undoRecord = structuredClone(record); },
      expire: (reason) => {
        if (!undoRecord) return;
        undoRecord = { ...undoRecord, status: "expired", expireReason: reason };
      },
      clear: () => { undoRecord = null; },
    },
  };
  return {
    deps,
    state,
    workspaces: () => structuredClone(workspaces),
    selection: () => structuredClone(selection),
    undo: () => structuredClone(undoRecord),
    setUndo: (record: typeof undoRecord) => { undoRecord = structuredClone(record); },
  };
}

function prepare(
  engine: ReturnType<typeof createGroupingEngine>,
  current: Workspace[],
  plan: GroupingPlan,
  context: GroupingCompileContext,
) {
  const prepared = engine.prepareGroupingCommit(plan, current, context);
  if (!prepared.ok) throw new Error(prepared.errors.join(" / "));
  return prepared.ticket;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("Gate 2 round 12 engine fixes", () => {
  it("normalizes a cross-workspace active session before compile and commits an unrelated move", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const engine = createGroupingEngine();
    const current = initialLayout();
    const plan = planFor(["t1"]);
    const ticket = prepare(
      engine,
      current,
      plan,
      contextFor(current, "cross-workspace-commit", "ws-a", "session-t3"),
    );
    const store = harness(current, {
      activeWorkspaceId: "ws-a",
      activeSessionId: "session-t3",
      lastActivePaneByWorkspace: {
        "ws-a": "session-t1",
        "ws-b": "session-t3",
      },
    });

    const result = engine.commitPreparedGrouping(plan, ticket, store.deps);

    expect(result.ok).toBe(true);
    expect(ticket.context).toMatchObject({
      activeWorkspaceId: "ws-a",
      activeSessionId: "session-t1",
    });
    expect(store.undo()?.snapshot.selection).toMatchObject({
      activeWorkspaceId: "ws-a",
      activeSessionId: "session-t1",
    });
    expect(validateGroupingStateSnapshot({
      schemaVersion: 1,
      workspaces: store.workspaces(),
      selection: store.selection(),
    })).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "[mycmux] tab grouping normalized dangling selection",
      expect.objectContaining({
        changes: expect.arrayContaining([
          expect.objectContaining({
            kind: "activeSessionId",
            workspaceId: "ws-a",
            sessionId: "session-t3",
            replacement: "session-t1",
          }),
        ]),
      }),
    );
  });

  it("keeps a cross-workspace active session strict when restoring undo", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const engine = createGroupingEngine();
    const current = initialLayout();
    const plan = planFor(["t1"]);
    const ticket = prepare(engine, current, plan, contextFor(current, "strict-cross-undo"));
    const store = harness(current);
    expect(engine.commitPreparedGrouping(plan, ticket, store.deps).ok).toBe(true);
    const undo = store.undo();
    expect(undo).not.toBeNull();
    if (!undo) return;
    undo.snapshot.selection.activeWorkspaceId = "ws-a";
    undo.snapshot.selection.activeSessionId = "session-t3";
    store.setUndo(undo);

    expect(engine.restoreGroupingUndo(store.deps)).toMatchObject({
      ok: false,
      kind: "restore_failed",
      reason: expect.stringContaining("selection.activeSessionId"),
    });
    expect(store.undo()).toBeNull();
    expect(engine.restoreGroupingUndo(store.deps)).toEqual({
      ok: false,
      kind: "boundary_poisoned",
      reason: "rollback_failed 後は元に戻せません",
    });
  });

  it("repairs a globally missing active session in a legacy undo snapshot", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const engine = createGroupingEngine();
    const current = initialLayout();
    const plan = planFor(["t1"]);
    const ticket = prepare(engine, current, plan, contextFor(current, "missing-session-undo"));
    const store = harness(current);
    expect(engine.commitPreparedGrouping(plan, ticket, store.deps).ok).toBe(true);
    const undo = store.undo();
    expect(undo).not.toBeNull();
    if (!undo) return;
    undo.snapshot.selection.activeWorkspaceId = "ws-a";
    undo.snapshot.selection.activeSessionId = "missing-session";
    store.setUndo(undo);

    expect(engine.restoreGroupingUndo(store.deps)).toEqual({ ok: true });
    expect(validateGroupingStateSnapshot({
      schemaVersion: 1,
      workspaces: store.workspaces(),
      selection: store.selection(),
    })).toEqual([]);
    expect(store.undo()).toBeNull();
    expect(engine.restoreGroupingUndo(store.deps)).toEqual({
      ok: false,
      kind: "missing",
      reason: "戻せる再配置がありません",
    });
    expect(warn).toHaveBeenCalledWith(
      "[mycmux] tab grouping normalized dangling selection",
      expect.objectContaining({ scope: "undo snapshot" }),
    );
  });

  it("uses the first pane active session as the dangling-session fallback", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const workspaces = initialLayout();
    workspaces[0] = workspace(
      "ws-a",
      "母艦",
      pane("pane-a", [tab("t1"), tab("t2")], "t2"),
    );
    const snapshot: GroupingStateSnapshot = {
      schemaVersion: 1,
      workspaces,
      selection: {
        activeWorkspaceId: "ws-a",
        activeSessionId: "missing-session",
        lastActivePaneByWorkspace: {},
      },
    };

    const normalized = normalizeGroupingStateSnapshot(snapshot, "round12-store-fallback");

    expect(normalized.selection.activeSessionId).toBe("session-t2");
    expect(validateGroupingStateSnapshot(normalized)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "[mycmux] tab grouping normalized dangling selection",
      expect.objectContaining({ scope: "round12-store-fallback" }),
    );
  });

  it("rejects normalized-before structural damage before replacement", () => {
    const engine = createGroupingEngine();
    const current = initialLayout();
    const plan = planFor(["t1"]);
    const ticket = prepare(engine, current, plan, contextFor(current, "invalid-normalized-before"));
    const store = harness(current);
    const originalGetWorkspaces = store.deps.getWorkspaces;
    let reads = 0;
    store.deps.getWorkspaces = () => {
      const next = structuredClone(originalGetWorkspaces());
      reads += 1;
      if (reads === 2) next[0].splitColumns = [["pane-a", "missing-pane"]];
      return next;
    };

    const result = engine.commitPreparedGrouping(plan, ticket, store.deps);

    expect(result).toEqual({
      ok: false,
      kind: "invalid_input",
      errors: ["identity pane: missing-pane at workspaces[0].splitColumns"],
    });
    expect(store.state).toEqual({ replaceCalls: 0, restoreCalls: 0, selectionCalls: 0 });
    expect(store.undo()).toBeNull();
  });

  it("copies empty workspace ids from the applied report into the undo record", () => {
    const engine = createGroupingEngine();
    const current = initialLayout();
    const plan = planFor(["t1", "t2"]);
    const ticket = prepare(engine, current, plan, contextFor(current, "empty-workspace-report"));
    const store = harness(current);

    const result = engine.commitPreparedGrouping(plan, ticket, store.deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.emptyWorkspaceIds).toEqual(["ws-a"]);
    expect(store.undo()?.report.emptyWorkspaceIds).toEqual(["ws-a"]);
    expect(persistentLayoutProjection(store.workspaces())).toEqual(
      persistentLayoutProjection(result.transaction.workspaces),
    );
  });
});
