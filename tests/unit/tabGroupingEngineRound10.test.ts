import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Pane, PaneTab, Workspace } from "../../src/types";
import {
  createGroupingEngine,
  normalizeGroupingStateSnapshot,
  persistentLayoutProjection,
  structuralUndoSignature,
  validateGroupingStateSnapshot,
  type GroupingCompileContext,
  type GroupingEngineDependencies,
  type GroupingSelectionState,
  type GroupingStateSnapshot,
} from "./helpers/groupingTestEntrypoint";
import {
  defaultLayoutForTabs,
  type AnalysisBaselineEntry,
  type GroupingPlan,
} from "../../src/components/layout/tabGrouping";

const NOW = 1_800_000_000_000;
const APPLIED_AT = NOW + 123;

function tab(id: string): PaneTab {
  return {
    id,
    sessionId: `session-${id}`,
    agentId: "shell-starter",
    type: "terminal",
    label: `label-${id}`,
    labelSource: "user",
    cwd: `C:/work/${id}`,
    lastProcess: "pwsh",
    agentKind: "codex",
    agentSessionId: `agent-${id}`,
    launchEnv: { TEST_TAB: id },
    origin: { kind: "human" },
  };
}

function pane(id: string, tabs: PaneTab[]): Pane {
  const active = tabs[0];
  return {
    id,
    agentId: active?.agentId ?? "",
    sessionId: active?.sessionId ?? "",
    activeTabId: active?.id ?? "",
    tabs,
    label: `pane-${id}`,
    cwd: active?.cwd,
    lastProcess: active?.lastProcess,
    agentKind: active?.agentKind,
    agentSessionId: active?.agentSessionId,
    launchEnv: active?.launchEnv,
  };
}

function workspace(id: string, name: string, paneId: string, tabIds: string[]): Workspace {
  const panes = [pane(paneId, tabIds.map(tab))];
  return {
    id,
    name,
    gridTemplateId: "1x1",
    status: "running",
    createdAt: NOW,
    color: `color-${id}`,
    pet: "clawd",
    panes,
    splitColumns: [[paneId]],
    columnWidths: [100],
    rowHeightsPerCol: [[100]],
  };
}

function initialLayout(): Workspace[] {
  return [
    workspace("ws-a", "母艦", "pane-a", ["t1", "t2"]),
    workspace("ws-b", "作業机", "pane-b", ["t3"]),
  ];
}

function baselineOf(workspaces: readonly Workspace[]): AnalysisBaselineEntry[] {
  return workspaces.flatMap((item) => item.panes.flatMap((itemPane) => (
    itemPane.tabs.map((itemTab) => ({
      tabId: itemTab.id,
      workspaceId: item.id,
      paneId: itemPane.id,
      sessionId: itemTab.sessionId,
    }))
  )));
}

function planFor(): GroupingPlan {
  return {
    planId: "plan-round10",
    title: "案件で分ける",
    rationale: "案件単位",
    strategy: "project",
    groups: [
      {
        groupId: "group-a",
        title: "案件甲",
        disposition: "reorganize",
        destination: { kind: "new_workspace", proposedName: "案件甲" },
        layout: defaultLayoutForTabs(["t1"], "母艦"),
        tabIds: ["t1"],
        adopted: true,
      },
      {
        groupId: "group-keep",
        title: "現状維持",
        disposition: "keep",
        destination: { kind: "current_locations" },
        layout: null,
        tabIds: ["t2", "t3"],
        adopted: true,
      },
    ],
    unassignedTabIds: [],
    warnings: [],
  };
}

function contextFor(workspaces: readonly Workspace[], seed: string): GroupingCompileContext {
  return {
    baseline: baselineOf(workspaces),
    activeWorkspaceId: "ws-a",
    activeSessionId: "session-t1",
    allocationSeed: seed,
    createdAt: NOW,
    newWorkspaceDefaults: { status: "running", pet: "clawd" },
  };
}

function harness(initial: Workspace[]) {
  let workspaces = structuredClone(initial) as Workspace[];
  let selection: GroupingSelectionState = {
    activeWorkspaceId: "ws-a",
    activeSessionId: "session-t1",
    lastActivePaneByWorkspace: {
      "ws-a": "session-t1",
      "ws-b": "session-t3",
    },
  };
  const state = { replaceCalls: 0, restoreCalls: 0, selectionCalls: 0 };
  type UndoRecord = Parameters<GroupingEngineDependencies["undo"]["set"]>[0];
  let undoRecord: UndoRecord | null = null;
  const deps: GroupingEngineDependencies = {
    boundaryToken: {},
    getWorkspaces: () => workspaces,
    getSelection: () => structuredClone(selection),
    replaceWorkspaces: (next) => {
      state.replaceCalls += 1;
      workspaces = structuredClone(next) as Workspace[];
    },
    applySelection: (next) => {
      state.selectionCalls += 1;
      selection = structuredClone(next);
    },
    restoreGroupingState: (snapshot: GroupingStateSnapshot) => {
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
    workspaces: () => workspaces,
    selection: () => selection,
    undo: () => structuredClone(undoRecord),
    setUndo: (record: typeof undoRecord) => { undoRecord = structuredClone(record); },
    mutateSelection: (mutate: (draft: GroupingSelectionState) => void) => {
      const draft = structuredClone(selection);
      mutate(draft);
      selection = draft;
    },
  };
}

function prepare(seed: string) {
  const engine = createGroupingEngine();
  const current = initialLayout();
  const plan = planFor();
  const prepared = engine.prepareGroupingCommit(plan, current, contextFor(current, seed));
  if (!prepared.ok) throw new Error(prepared.errors.join(" / "));
  expect(prepared.ok).toBe(true);
  return { engine, current, plan, ticket: prepared.ticket };
}

function expectDeepFrozen(value: unknown, seen = new WeakSet<object>()): void {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return;
  if (seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Reflect.ownKeys(value)) {
    expectDeepFrozen((value as Record<PropertyKey, unknown>)[key], seen);
  }
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("Gate 2 round 10 engine hardening", () => {
  it("normalizes dangling store selection before commit and records a valid undo snapshot", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { engine, current, plan, ticket } = prepare("dangling-before-selection");
    const store = harness(current);
    store.mutateSelection((selection) => {
      selection.lastActivePaneByWorkspace["ws-b"] = "missing-session";
    });

    const result = engine.commitPreparedGrouping(plan, ticket, store.deps);

    expect(result.ok).toBe(true);
    expect(store.selection().lastActivePaneByWorkspace).not.toHaveProperty("ws-b");
    expect(validateGroupingStateSnapshot({
      schemaVersion: 1,
      workspaces: store.workspaces(),
      selection: store.selection(),
    })).toEqual([]);
    expect(store.undo()?.snapshot.selection.lastActivePaneByWorkspace).not.toHaveProperty("ws-b");
    expect(warn).toHaveBeenCalledWith(
      "[mycmux] tab grouping normalized dangling selection",
      expect.objectContaining({ scope: "commit before" }),
    );
  });

  it("normalizes a legacy dangling undo snapshot without restore failure or poison", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { engine, current, plan, ticket } = prepare("dangling-undo-selection");
    const store = harness(current);
    expect(engine.commitPreparedGrouping(plan, ticket, store.deps).ok).toBe(true);
    const undo = store.undo();
    expect(undo).not.toBeNull();
    if (!undo) return;
    undo.snapshot.selection.lastActivePaneByWorkspace["ws-b"] = "missing-session";
    store.setUndo(undo);

    expect(engine.restoreGroupingUndo(store.deps)).toEqual({ ok: true });
    expect(validateGroupingStateSnapshot({
      schemaVersion: 1,
      workspaces: store.workspaces(),
      selection: store.selection(),
    })).toEqual([]);
    expect(store.undo()).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "[mycmux] tab grouping normalized dangling selection",
      expect.objectContaining({ scope: "undo snapshot" }),
    );

    const retry = engine.prepareGroupingCommit(
      plan,
      store.workspaces(),
      contextFor(store.workspaces(), "after-dangling-undo-selection"),
    );
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(engine.commitPreparedGrouping(plan, retry.ticket, store.deps).ok).toBe(true);
  });

  it("rejects invalid selection produced by the apply boundary without hiding it through normalization", () => {
    const { engine, current, plan, ticket } = prepare("invalid-output-selection");
    const store = harness(current);
    const originalApplySelection = store.deps.applySelection;
    store.deps.applySelection = (selection) => {
      originalApplySelection({
        ...structuredClone(selection),
        lastActivePaneByWorkspace: {
          ...selection.lastActivePaneByWorkspace,
          "ws-b": "missing-session",
        },
      });
    };

    const result = engine.commitPreparedGrouping(plan, ticket, store.deps);

    expect(result).toMatchObject({
      ok: false,
      kind: "commit_mismatch",
      errors: ["focusまたはselectionがexpectedResultと一致しません"],
    });
    expect(persistentLayoutProjection(store.workspaces())).toEqual(persistentLayoutProjection(current));
    expect(store.state).toEqual({ replaceCalls: 1, restoreCalls: 1, selectionCalls: 1 });
    expect(store.undo()).toBeNull();
  });

  it("falls back a dangling active session to the first tab in the active workspace", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const snapshot: GroupingStateSnapshot = {
      schemaVersion: 1,
      workspaces: initialLayout(),
      selection: {
        activeWorkspaceId: "ws-b",
        activeSessionId: "missing-session",
        lastActivePaneByWorkspace: { "ws-b": "missing-session" },
      },
    };

    const normalized = normalizeGroupingStateSnapshot(snapshot, "active-session-test");

    expect(normalized.selection).toEqual({
      activeWorkspaceId: "ws-b",
      activeSessionId: "session-t3",
      lastActivePaneByWorkspace: {},
    });
    expect(validateGroupingStateSnapshot(normalized)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "[mycmux] tab grouping normalized dangling selection",
      expect.objectContaining({ scope: "active-session-test" }),
    );
  });

  it("returns a recursively frozen commit ticket", () => {
    const { ticket } = prepare("deep-freeze-ticket");

    expectDeepFrozen(ticket);
    expect(() => {
      (ticket as { schemaEpoch: number }).schemaEpoch += 1;
    }).toThrow(TypeError);
    expect(() => {
      ticket.transaction.expected.movedTabIds.push("forged-tab");
    }).toThrow(TypeError);
  });

  it("stores the applied report summary and canonical applied layout signature in undo", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(APPLIED_AT);
    const { engine, current, plan, ticket } = prepare("undo-report");
    const store = harness(current);

    const result = engine.commitPreparedGrouping(plan, ticket, store.deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const undo = store.undo() as unknown as {
      createdAt: number;
      expectedStructuralSignature: string;
      appliedLayoutSignature?: string;
      report?: {
        movedTabCount: number;
        affectedWorkspaceIds: string[];
        appliedAt: number;
      };
    } | null;
    expect(undo).not.toBeNull();
    expect(undo).toMatchObject({
      createdAt: APPLIED_AT,
      expectedStructuralSignature: structuralUndoSignature(store.workspaces()),
      appliedLayoutSignature: ticket.outputSignature,
      report: {
        movedTabCount: result.report.moved.length,
        affectedWorkspaceIds: ["tg-3e5eb83ae813702fb4a8a30c", "ws-a"],
        appliedAt: APPLIED_AT,
      },
    });
    now.mockRestore();
  });
});
