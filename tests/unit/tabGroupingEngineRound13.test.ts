import { beforeEach, describe, expect, it, vi } from "vitest";

import { defaultLayoutForTabs } from "../../src/components/layout/tabGrouping";
import type { Pane, PaneTab, Workspace } from "../../src/types";
import {
  createGroupingEngine,
  normalizeGroupingStateSnapshot,
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

function pane(id: string, tabs: PaneTab[], activeTabId = tabs[0]?.id ?? ""): Pane {
  const active = tabs.find((item) => item.id === activeTabId) ?? tabs[0];
  return {
    id,
    agentId: active?.agentId ?? "",
    sessionId: active?.sessionId ?? "",
    activeTabId: active?.id ?? "",
    tabs,
    label: `pane-${id}`,
    cwd: active?.cwd,
  };
}

function workspace(id: string, name: string, panes: Pane[]): Workspace {
  return {
    id,
    name,
    gridTemplateId: panes.length === 2 ? "1x2" : "1x1",
    status: "running",
    createdAt: NOW,
    color: `color-${id}`,
    pet: "clawd",
    panes,
    splitColumns: [panes.map((item) => item.id)],
    columnWidths: [100],
    rowHeightsPerCol: [panes.map(() => 100)],
  };
}

function initialLayout(): Workspace[] {
  return [
    workspace("ws-a", "母艦", [pane("pane-a", [tab("t1"), tab("t2")])]),
    workspace("ws-b", "作業机", [pane("pane-b", [tab("t3")])]),
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
  selection: Pick<GroupingSelectionState, "activeWorkspaceId" | "activeSessionId"> = {
    activeWorkspaceId: "ws-a",
    activeSessionId: "session-t1",
  },
): GroupingCompileContext {
  return {
    baseline: baselineOf(workspaces),
    activeWorkspaceId: selection.activeWorkspaceId,
    activeSessionId: selection.activeSessionId,
    allocationSeed: seed,
    createdAt: NOW,
    newWorkspaceDefaults: { status: "running", pet: "clawd" },
  };
}

function planFor(workspaces: readonly Workspace[], movedTabIds: string[], id: string): GroupingPlan {
  const allTabIds = workspaces.flatMap((item) => item.panes.flatMap((itemPane) => (
    itemPane.tabs.map((itemTab) => itemTab.id)
  )));
  const destinationName = {
    first: "案件甲",
    "empty-active": "案件乙",
    second: "案件丙",
    warning: "案件丁",
  }[id] ?? "案件戊";
  return {
    planId: `plan-round13-${id}`,
    title: "案件で分ける",
    rationale: "案件単位",
    strategy: "project",
    groups: [
      {
        groupId: `group-move-${id}`,
        title: destinationName,
        disposition: "reorganize",
        destination: { kind: "new_workspace", proposedName: destinationName },
        layout: defaultLayoutForTabs(movedTabIds, destinationName),
        tabIds: [...movedTabIds],
        adopted: true,
      },
      {
        groupId: `group-keep-${id}`,
        title: "現状維持",
        disposition: "keep",
        destination: { kind: "current_locations" },
        layout: null,
        tabIds: allTabIds.filter((tabId) => !movedTabIds.includes(tabId)),
        adopted: true,
      },
    ],
    unassignedTabIds: [],
    warnings: [],
  };
}

function harness(initial: Workspace[], initialSelection: GroupingSelectionState) {
  let workspaces = structuredClone(initial);
  let selection = structuredClone(initialSelection);
  let undoRecord: Parameters<GroupingEngineDependencies["undo"]["set"]>[0] | null = null;
  const deps: GroupingEngineDependencies = {
    boundaryToken: {},
    getWorkspaces: () => workspaces,
    getSelection: () => selection,
    replaceWorkspaces: (next) => { workspaces = structuredClone(next); },
    applySelection: (next) => { selection = structuredClone(next); },
    restoreGroupingState: (snapshot) => {
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
    workspaces: () => structuredClone(workspaces),
    selection: () => structuredClone(selection),
    undo: () => structuredClone(undoRecord),
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

function applyFirstMove() {
  const engine = createGroupingEngine();
  const current = initialLayout();
  const plan = planFor(current, ["t1", "t2"], "first");
  const store = harness(current, {
    activeWorkspaceId: "ws-a",
    activeSessionId: "session-t1",
    lastActivePaneByWorkspace: {
      "ws-a": "session-t1",
      "ws-b": "session-t3",
    },
  });
  const ticket = prepare(engine, current, plan, contextFor(current, "round13-first"));
  const result = engine.commitPreparedGrouping(plan, ticket, store.deps);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.kind);
  expect(result.report.emptyWorkspaceIds).toEqual(["ws-a"]);
  return store;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("Gate 3 L1b engine contracts", () => {
  it("clears stale session identity from the pane of an emptied workspace", () => {
    const store = applyFirstMove();
    const emptied = store.workspaces().find((item) => item.id === "ws-a");

    expect(emptied?.panes).toHaveLength(1);
    expect(emptied?.panes[0]?.id).toBe("pane-a");
    expect(emptied?.panes[0]?.tabs).toEqual([]);
    expect(emptied?.panes[0]?.sessionId).toBe("");
    expect(emptied?.panes[0]?.activeTabId).toBe("");
    expect(emptied?.panes[0]?.agentId).toBe("");
  });

  it("merges two tabs into an existing workspace with fixed engine output", () => {
    const current = initialLayout();
    const plan = planFor(current, ["t1", "t2"], "existing-merge");
    plan.groups[0].destination = { kind: "existing_workspace", workspaceId: "ws-b" };
    const store = harness(current, {
      activeWorkspaceId: "ws-a",
      activeSessionId: "session-t1",
      lastActivePaneByWorkspace: { "ws-a": "session-t1", "ws-b": "session-t3" },
    });
    const engine = createGroupingEngine();
    const ticket = prepare(engine, current, plan, contextFor(current, "round13-existing-merge"));

    expect(ticket.transaction.expected.tabs).toEqual({
      t1: {
        workspaceId: "ws-b",
        paneId: "tg-b25e3393f2d69909c17a4ae6",
        sessionId: "session-t1",
      },
      t2: {
        workspaceId: "ws-b",
        paneId: "tg-b25e3393f2d69909c17a4ae6",
        sessionId: "session-t2",
      },
      t3: { workspaceId: "ws-b", paneId: "pane-b", sessionId: "session-t3" },
    });
    expect(ticket.transaction.expected.splitColumns).toEqual({
      "ws-a": [["pane-a"]],
      "ws-b": [["pane-b"], ["tg-b25e3393f2d69909c17a4ae6"]],
    });

    const result = engine.commitPreparedGrouping(plan, ticket, store.deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const destination = store.workspaces().find((item) => item.id === "ws-b");
    expect(destination && {
      panes: destination.panes.map((itemPane) => ({
        id: itemPane.id,
        activeTabId: itemPane.activeTabId,
        tabIds: itemPane.tabs.map((itemTab) => itemTab.id),
      })),
      splitColumns: destination.splitColumns,
    }).toEqual({
      panes: [
        { id: "pane-b", activeTabId: "t3", tabIds: ["t3"] },
        {
          id: "tg-b25e3393f2d69909c17a4ae6",
          activeTabId: "t1",
          tabIds: ["t1", "t2"],
        },
      ],
      splitColumns: [["pane-b"], ["tg-b25e3393f2d69909c17a4ae6"]],
    });
    const source = store.workspaces().find((item) => item.id === "ws-a");
    expect(source?.panes.map((itemPane) => ({
      id: itemPane.id,
      tabIds: itemPane.tabs.map((itemTab) => itemTab.id),
    }))).toEqual([{ id: "pane-a", tabIds: [] }]);
    expect(result.report.moved).toEqual([
      {
        tabId: "t1",
        from: { workspaceId: "ws-a", paneId: "pane-a", sessionId: "session-t1" },
        to: {
          workspaceId: "ws-b",
          paneId: "tg-b25e3393f2d69909c17a4ae6",
          sessionId: "session-t1",
        },
        label: "label-t1",
      },
      {
        tabId: "t2",
        from: { workspaceId: "ws-a", paneId: "pane-a", sessionId: "session-t2" },
        to: {
          workspaceId: "ws-b",
          paneId: "tg-b25e3393f2d69909c17a4ae6",
          sessionId: "session-t2",
        },
        label: "label-t2",
      },
    ]);
    expect(store.undo()?.report.movedTabCount).toBe(2);
    expect(store.undo()?.report.movedTabCount).toBe(result.report.moved.length);
  });
});

describe("Gate 2 round 13 engine fixes", () => {
  it("commits with null active session when the active workspace is empty", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const firstStore = applyFirstMove();
    const current = firstStore.workspaces();
    const selection: GroupingSelectionState = {
      activeWorkspaceId: "ws-a",
      activeSessionId: "session-t3",
      lastActivePaneByWorkspace: { "ws-b": "session-t3" },
    };
    const store = harness(current, selection);
    const engine = createGroupingEngine();
    const plan = planFor(current, ["t3"], "empty-active");
    const ticket = prepare(engine, current, plan, contextFor(current, "empty-active", selection));

    const result = engine.commitPreparedGrouping(plan, ticket, store.deps);

    expect(result.ok).toBe(true);
    expect(ticket.context.activeSessionId).toBeNull();
    expect(store.selection()).toMatchObject({ activeWorkspaceId: "ws-a", activeSessionId: null });
    expect(validateGroupingStateSnapshot({
      schemaVersion: 1,
      workspaces: store.workspaces(),
      selection: store.selection(),
    })).toEqual([]);
  });

  it("prefers the recorded active session over the first pane session", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const snapshot: GroupingStateSnapshot = {
      schemaVersion: 1,
      workspaces: [
        workspace("ws-a", "母艦", [pane("pane-a1", [tab("t1")]), pane("pane-a2", [tab("t2")])]),
        workspace("ws-b", "作業机", [pane("pane-b", [tab("t3")])]),
      ],
      selection: {
        activeWorkspaceId: "ws-a",
        activeSessionId: "session-t3",
        lastActivePaneByWorkspace: {
          "ws-a": "session-t2",
          "ws-b": "session-t3",
        },
      },
    };

    const normalized = normalizeGroupingStateSnapshot(snapshot, "round13-recorded-fallback");

    expect(normalized.selection.activeSessionId).toBe("session-t2");
    expect(validateGroupingStateSnapshot(normalized)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "[mycmux] tab grouping normalized dangling selection",
      expect.objectContaining({
        changes: expect.arrayContaining([
          expect.objectContaining({ replacement: "session-t2" }),
        ]),
      }),
    );
  });

  it("does not report a workspace that was already empty on the second apply", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const firstStore = applyFirstMove();
    const current = firstStore.workspaces();
    const selection = firstStore.selection();
    const store = harness(current, selection);
    const engine = createGroupingEngine();
    const plan = planFor(current, ["t1"], "second");
    const ticket = prepare(engine, current, plan, contextFor(current, "round13-second", selection));

    const result = engine.commitPreparedGrouping(plan, ticket, store.deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transaction.expected.emptyWorkspaceIds).toEqual([]);
    expect(result.report.emptyWorkspaceIds).toEqual([]);
    expect(store.undo()?.report.emptyWorkspaceIds).toEqual([]);
  });

  it("warns only for the prepare normalization that changes an empty session", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const firstStore = applyFirstMove();
    warn.mockClear();
    const current = firstStore.workspaces();
    const engine = createGroupingEngine();
    const plan = planFor(current, ["t1"], "warning");

    const prepared = engine.prepareGroupingCommit(
      plan,
      current,
      contextFor(current, "round13-warning", { activeWorkspaceId: "ws-a", activeSessionId: "" }),
    );

    expect(prepared.ok).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "[mycmux] tab grouping normalized dangling selection",
      expect.objectContaining({ scope: "prepare input" }),
    );
  });

  it("does not apply a deferred group", () => {
    const current = initialLayout();
    const plan = planFor(current, ["t1"], "deferred");
    plan.groups[0].adopted = false;
    const engine = createGroupingEngine();

    const prepared = engine.prepareGroupingCommit(
      plan,
      current,
      contextFor(current, "round13-deferred"),
    );

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.ticket.transaction.expected.movedTabIds).toEqual([]);
    expect(prepared.ticket.transaction.workspaces).toEqual(current);
  });

  it("rejects reorganize with current_locations without mutating any tab", () => {
    const current = initialLayout();
    const before = structuredClone(current);
    const plan = planFor(current, ["t1"], "invalid-current-locations");
    plan.groups[0].destination = { kind: "current_locations" };
    const engine = createGroupingEngine();

    const prepared = engine.prepareGroupingCommit(
      plan,
      current,
      contextFor(current, "round13-invalid-current-locations"),
    );

    expect(prepared.ok).toBe(false);
    expect(current).toEqual(before);
    expect(current.flatMap((item) => item.panes.flatMap((itemPane) => itemPane.tabs.map((itemTab) => itemTab.id))).sort())
      .toEqual(["t1", "t2", "t3"]);
  });

  it("preserves every original tab field after a successful move", () => {
    const current = initialLayout();
    const original = structuredClone(current[0].panes[0].tabs[0]);
    original.label = "元ラベル";
    original.cwd = "C:/keep";
    current[0].panes[0].tabs[0] = structuredClone(original);
    const plan = planFor(current, ["t1"], "tab-field-parity");
    const store = harness(current, {
      activeWorkspaceId: "ws-a",
      activeSessionId: "session-t1",
      lastActivePaneByWorkspace: { "ws-a": "session-t1", "ws-b": "session-t3" },
    });
    const engine = createGroupingEngine();
    const ticket = prepare(engine, current, plan, contextFor(current, "round13-tab-field-parity"));

    const result = engine.commitPreparedGrouping(plan, ticket, store.deps);

    expect(result.ok).toBe(true);
    const moved = store.workspaces()
      .flatMap((item) => item.panes.flatMap((itemPane) => itemPane.tabs))
      .find((itemTab) => itemTab.id === "t1");
    expect(moved).toEqual(original);
  });
});
