import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Pane, PaneTab, Workspace } from "../../src/types";
import {
  createGroupingEngine,
  createDeterministicGroupingAllocator,
  persistentLayoutProjection,
  validateLayoutIdentity,
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
import type { GroupingUndoRecord } from "../../src/stores/groupingRuntimeStore";

const NOW = 1_800_000_000_000;

function tab(id: string, overrides: Partial<PaneTab> = {}): PaneTab {
  return {
    id,
    sessionId: `session-${id}`,
    agentId: "shell-starter",
    type: "terminal",
    label: `ラベル${id}`,
    labelSource: "user",
    cwd: `C:/work/${id}`,
    lastProcess: "pwsh",
    agentKind: "codex",
    agentSessionId: `agent-${id}`,
    launchEnv: { TEST_TAB: id },
    origin: { kind: "human" },
    ...overrides,
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
    label: `ペイン${id}`,
    cwd: active?.cwd,
    lastProcess: active?.lastProcess,
    agentKind: active?.agentKind,
    agentSessionId: active?.agentSessionId,
    launchEnv: active?.launchEnv,
  };
}

function workspace(id: string, name: string, paneId: string, tabIds: string[]): Workspace {
  const panes = [pane(paneId, tabIds.map((tabId) => tab(tabId)))];
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

function applyCapacityViolation(
  workspaces: Workspace[],
  kind: "five-columns" | "five-panes",
  workspaceIndex = 1,
): Workspace[] {
  const target = workspaces[workspaceIndex];
  const panes = Array.from({ length: 5 }, (_, index) => (
    pane(`${target.id}-capacity-pane-${index}`, [tab(`${target.id}-capacity-tab-${index}`)])
  ));
  target.panes = panes;
  target.splitColumns = kind === "five-columns"
    ? panes.map((item) => [item.id])
    : [panes.map((item) => item.id)];
  target.gridTemplateId = "4x4";
  target.columnWidths = Array.from({ length: target.splitColumns.length }, () => 100);
  target.rowHeightsPerCol = target.splitColumns.map((column) => (
    Array.from({ length: column.length }, () => 100)
  ));
  return workspaces;
}

function applyGridTemplateDrift(input: readonly Workspace[], workspaceIndex = 1): Workspace[] {
  const workspaces = structuredClone(input) as Workspace[];
  const target = workspaces[workspaceIndex];
  const addedPane = pane(`${target.id}-drift-pane`, [tab("t4")]);
  target.panes = [...target.panes, addedPane];
  target.splitColumns = [[target.panes[0].id], [addedPane.id]];
  target.gridTemplateId = "1x1";
  target.columnWidths = [100, 100];
  target.rowHeightsPerCol = [[100], [100]];
  return workspaces;
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

function planFor(
  allTabIds: readonly string[],
  movedTabIds: readonly string[] = ["t1"],
  options: { planId?: string; groupId?: string; name?: string; destinationWorkspaceId?: string } = {},
): GroupingPlan {
  const moved = new Set(movedTabIds);
  const kept = allTabIds.filter((id) => !moved.has(id));
  const name = options.name ?? "案件甲";
  return {
    planId: options.planId ?? "plan-a",
    title: "案件で分ける",
    rationale: "案件単位",
    strategy: "project",
    groups: [
      {
        groupId: options.groupId ?? "group-a",
        title: name,
        disposition: "reorganize",
        destination: options.destinationWorkspaceId
          ? { kind: "existing_workspace", workspaceId: options.destinationWorkspaceId }
          : { kind: "new_workspace", proposedName: name },
        layout: defaultLayoutForTabs([...movedTabIds], "母艦"),
        tabIds: [...movedTabIds],
        adopted: true,
      },
      ...(kept.length > 0 ? [{
        groupId: "group-keep",
        title: "現状維持",
        disposition: "keep" as const,
        destination: { kind: "current_locations" as const },
        layout: null,
        tabIds: kept,
        adopted: true,
      }] : []),
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

type HarnessOptions = {
  corruptCommit?: (next: Workspace[]) => Workspace[];
  corruptRestore?: (snapshot: GroupingStateSnapshot) => GroupingStateSnapshot;
  throwOnRestore?: boolean;
  selectionNoop?: boolean;
};

function harness(initial: Workspace[], options: HarnessOptions = {}) {
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
  const boundaryToken = {};
  let undoRecord: GroupingUndoRecord | null = null;
  const deps: GroupingEngineDependencies = {
    boundaryToken,
    getWorkspaces: () => workspaces,
    getSelection: () => structuredClone(selection),
    replaceWorkspaces: (next) => {
      state.replaceCalls += 1;
      const candidate = structuredClone(next) as Workspace[];
      workspaces = options.corruptCommit ? options.corruptCommit(candidate) : candidate;
    },
    applySelection: (next) => {
      state.selectionCalls += 1;
      if (!options.selectionNoop) selection = structuredClone(next);
    },
    restoreGroupingState: (snapshot) => {
      state.restoreCalls += 1;
      if (options.throwOnRestore) throw new Error("restore exploded");
      const restored = options.corruptRestore
        ? options.corruptRestore(structuredClone(snapshot))
        : structuredClone(snapshot);
      workspaces = restored.workspaces;
      selection = restored.selection;
    },
    getLayoutRevision: () => 0,
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
    mutateWorkspaces: (mutate: (draft: Workspace[]) => void) => {
      const draft = structuredClone(workspaces) as Workspace[];
      mutate(draft);
      workspaces = draft;
    },
    setWorkspaces: (next: Workspace[]) => { workspaces = structuredClone(next); },
    undo: () => structuredClone(undoRecord),
    setUndo: (record: GroupingUndoRecord | null) => { undoRecord = structuredClone(record); },
    mutateSelection: (mutate: (draft: GroupingSelectionState) => void) => {
      const draft = structuredClone(selection);
      mutate(draft);
      selection = draft;
    },
  };
}

function prepare(seed = "seed-a", moved: readonly string[] = ["t1"]) {
  const engine = createGroupingEngine();
  const current = initialLayout();
  const plan = planFor(["t1", "t2", "t3"], moved);
  const prepared = engine.prepareGroupingCommit(plan, current, contextFor(current, seed));
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) throw new Error(prepared.errors.join(" / "));
  return { engine, current, plan, ticket: prepared.ticket };
}

beforeEach(() => {
  // Each test owns an engine instance so ticket/poison state cannot leak.
});

describe("persistent numeric validation", () => {
  it.each([NaN, Infinity, -Infinity])("returns a validation error instead of throwing for %s", (value) => {
    const engine = createGroupingEngine();
    const current = initialLayout();
    current[0].createdAt = value;
    const plan = planFor(["t1", "t2", "t3"]);
    const context = contextFor(current, "non-finite");
    let compiled: ReturnType<typeof engine.compileGroupingPlan> | undefined;
    let prepared: ReturnType<typeof engine.prepareGroupingCommit> | undefined;
    expect(() => { compiled = engine.compileGroupingPlan(plan, current, context); }).not.toThrow();
    expect(() => { prepared = engine.prepareGroupingCommit(plan, current, context); }).not.toThrow();
    expect(compiled).toMatchObject({ ok: false, stale: [], errors: [expect.stringMatching(/non-finite persistent number/i)] });
    expect(prepared).toMatchObject({ ok: false, stale: [], errors: [expect.stringMatching(/non-finite persistent number/i)] });
  });

  it("fails closed before replacement when the live commit input becomes non-finite", () => {
    const { engine, current, plan, ticket } = prepare("non-finite-commit");
    const store = harness(current);
    store.mutateWorkspaces((draft) => { draft[0].createdAt = Number.NaN; });
    const committed = engine.commitPreparedGrouping(plan, ticket, store.deps);
    expect(committed).toMatchObject({
      ok: false,
      kind: "invalid_input",
      errors: [expect.stringMatching(/non-finite persistent number/i)],
    });
    expect(store.state.replaceCalls).toBe(0);
  });
});

describe("Gate 1 CommitTicket OCC", () => {
  it("rejects target close after preview without replacing", () => {
    const { engine, current, plan, ticket } = prepare();
    const store = harness(current);
    store.mutateWorkspaces((draft) => {
      draft[0].panes[0].tabs = draft[0].panes[0].tabs.filter((item) => item.id !== "t1");
      const active = draft[0].panes[0].tabs[0];
      draft[0].panes[0].activeTabId = active.id;
      draft[0].panes[0].sessionId = active.sessionId;
    });
    const result = engine.commitPreparedGrouping(plan, ticket, store.deps);
    expect(result).toMatchObject({ ok: false, kind: "preview_stale" });
    if (!result.ok) expect(result.stale?.map((issue) => issue.code)).toEqual(["tab_closed"]);
    expect(store.state.replaceCalls).toBe(0);
  });

  it("rejects a non-target tab addition after preview without replacing", () => {
    const { engine, current, plan, ticket } = prepare();
    const store = harness(current);
    store.mutateWorkspaces((draft) => draft[0].panes[0].tabs.push(tab("t-new")));
    const result = engine.commitPreparedGrouping(plan, ticket, store.deps);
    expect(result).toMatchObject({ ok: false, kind: "preview_stale" });
    expect(store.state.replaceCalls).toBe(0);
  });

  it.each(["move", "session"] as const)("rejects target %s after preview", (kind) => {
    const { engine, current, plan, ticket } = prepare();
    const store = harness(current);
    store.mutateWorkspaces((draft) => {
      const target = draft[0].panes[0].tabs.find((item) => item.id === "t1")!;
      if (kind === "session") target.sessionId = "session-replaced";
      else {
        draft[0].panes[0].tabs = draft[0].panes[0].tabs.filter((item) => item.id !== "t1");
        const active = draft[0].panes[0].tabs[0];
        draft[0].panes[0].activeTabId = active.id;
        draft[0].panes[0].sessionId = active.sessionId;
        draft[1].panes[0].tabs.push(target);
      }
      if (kind === "session") draft[0].panes[0].sessionId = target.sessionId;
    });
    const result = engine.commitPreparedGrouping(plan, ticket, store.deps);
    expect(result).toMatchObject({
      ok: false,
      kind: "preview_stale",
    });
    if (!result.ok) {
      expect(result.stale?.map((issue) => issue.code)).toContain(
        kind === "move" ? "tab_moved" : "session_mismatch",
      );
    }
    expect(store.state.replaceCalls).toBe(0);
  });

  it("rejects destination disappearance after preview", () => {
    const engine = createGroupingEngine();
    const current = initialLayout();
    const plan = planFor(["t1", "t2", "t3"], ["t1"], { destinationWorkspaceId: "ws-b" });
    const prepared = engine.prepareGroupingCommit(plan, current, contextFor(current, "seed-destination"));
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const store = harness(current);
    store.mutateWorkspaces((draft) => draft.splice(1, 1));
    const result = engine.commitPreparedGrouping(plan, prepared.ticket, store.deps);
    expect(result).toMatchObject({ ok: false, kind: "preview_stale" });
    if (!result.ok) expect(result.stale?.map((issue) => issue.code)).toContain("workspace_missing");
    expect(store.state.replaceCalls).toBe(0);
  });

  it("rejects plan and ticket tampering before replace", () => {
    const first = prepare("seed-plan");
    const changedPlan = structuredClone(first.plan);
    changedPlan.title = "別の案";
    const firstStore = harness(first.current);
    expect(first.engine.commitPreparedGrouping(changedPlan, first.ticket, firstStore.deps)).toMatchObject({
      ok: false,
      kind: "plan_changed",
    });
    expect(firstStore.state.replaceCalls).toBe(0);

    const second = prepare("seed-ticket");
    const tamperedTransactionTicket = {
      ...second.ticket,
      transaction: {
        ...second.ticket.transaction,
        workspaces: second.ticket.transaction.workspaces.map((workspace, index) => (
          index === 0 ? { ...workspace, name: "改変" } : workspace
        )),
      },
    };
    const secondStore = harness(second.current);
    expect(second.engine.commitPreparedGrouping(second.plan, tamperedTransactionTicket, secondStore.deps)).toMatchObject({
      ok: false,
      kind: "invalid_input",
    });
    expect(secondStore.state.replaceCalls).toBe(0);
  });
});

describe("Gate 1 deterministic allocation and identity", () => {
  it("recompiles one ticket exactly and allocates different ids for another seed", () => {
    const current = initialLayout();
    const untouched = structuredClone(current);
    const plan = planFor(["t1", "t2", "t3"]);
    const engine = createGroupingEngine();
    const first = engine.compileGroupingPlan(plan, current, contextFor(current, "seed-one"));
    const repeat = engine.compileGroupingPlan(plan, current, contextFor(current, "seed-one"));
    const second = engine.compileGroupingPlan(plan, current, contextFor(current, "seed-two"));
    expect(first).toEqual(repeat);
    expect(current).toEqual(untouched);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.transaction.expected.newWorkspaceIds[0]).not.toBe(second.transaction.expected.newWorkspaceIds[0]);
    const firstPane = first.transaction.workspaces.at(-1)?.panes[0].id;
    const secondPane = second.transaction.workspaces.at(-1)?.panes[0].id;
    expect(firstPane).not.toBe(secondPane);
  });

  it("accepts a drifted input grid template and normalizes every output workspace", () => {
    const current = applyGridTemplateDrift(initialLayout());
    const engine = createGroupingEngine();
    const plan = planFor(["t1", "t2", "t3", "t4"]);

    expect(validateLayoutIdentity(current)).toEqual([]);
    expect(validateLayoutIdentity(current, "output")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "layout",
        id: "ws-b",
        locations: ["workspaces[1].gridTemplateId"],
      }),
    ]));

    const compiled = engine.compileGroupingPlan(plan, current, contextFor(current, "seed-grid-drift"));

    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.transaction.workspaces.find((item) => item.id === "ws-b")?.gridTemplateId).toBe("2x1");
    expect(validateLayoutIdentity(compiled.transaction.workspaces, "output")).toEqual([]);
  });

  it("normalizes a drifted third workspace outside the grouping destinations", () => {
    const current = initialLayout();
    const driftWorkspace = workspace("ws-c", "待避", "pane-c", ["t4"]);
    driftWorkspace.gridTemplateId = "2x1";
    const untouchedBefore = structuredClone(driftWorkspace);
    current.push(driftWorkspace);
    const engine = createGroupingEngine();
    const plan = planFor(
      ["t1", "t2", "t3", "t4"],
      ["t1"],
      { destinationWorkspaceId: "ws-b" },
    );

    const compiled = engine.compileGroupingPlan(
      plan,
      current,
      contextFor(current, "seed-third-grid-drift"),
    );

    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.transaction.workspaces.find((item) => item.id === "ws-c")).toEqual({
      ...untouchedBefore,
      gridTemplateId: "1x1",
    });
  });

  it("accepts and validates an engine-generated one-column three-pane layout", () => {
    const current = initialLayout();
    const plan = planFor(["t1", "t2", "t3"], ["t1", "t2", "t3"]);
    plan.groups[0].layout = {
      columns: [{
        panes: ["t1", "t2", "t3"].map((tabId, index) => ({
          title: `机${index + 1}`,
          role: "worker" as const,
          tabIds: [tabId],
        })),
      }],
    };
    const engine = createGroupingEngine();

    const compiled = engine.compileGroupingPlan(plan, current, contextFor(current, "seed-one-by-three"));

    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const created = compiled.transaction.workspaces.find((item) => (
      item.id === compiled.transaction.expected.newWorkspaceIds[0]
    ));
    expect(created).toMatchObject({ gridTemplateId: "4x4" });
    expect(created?.splitColumns).toHaveLength(1);
    expect(created?.splitColumns?.[0]).toHaveLength(3);
    expect(validateLayoutIdentity(compiled.transaction.workspaces, "output")).toEqual([]);
  });

  it("keeps all identities unique across two consecutive applications", () => {
    const engine = createGroupingEngine();
    const store = harness(initialLayout());
    const firstPlan = planFor(["t1", "t2", "t3"], ["t1"], { name: "案件甲" });
    const firstContext = contextFor(store.workspaces(), "seed-first");
    const first = engine.prepareGroupingCommit(firstPlan, store.workspaces(), firstContext);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(engine.commitPreparedGrouping(firstPlan, first.ticket, store.deps).ok).toBe(true);

    const secondPlan = planFor(["t1", "t2", "t3"], ["t2"], {
      planId: "plan-b",
      groupId: "group-b",
      name: "案件乙",
    });
    const secondContext = {
      ...contextFor(store.workspaces(), "seed-second"),
      activeWorkspaceId: store.selection().activeWorkspaceId,
      activeSessionId: store.selection().activeSessionId,
    };
    const second = engine.prepareGroupingCommit(secondPlan, store.workspaces(), secondContext);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(engine.commitPreparedGrouping(secondPlan, second.ticket, store.deps).ok).toBe(true);
    expect(validateLayoutIdentity(store.workspaces())).toEqual([]);
    const entityIds = store.workspaces().flatMap((workspace) => [
      workspace.id,
      ...workspace.panes.map((itemPane) => itemPane.id),
    ]);
    expect(new Set(entityIds).size).toBe(entityIds.length);
  });

  it.each(["status", "pet", "color"] as const)(
    "resolves per-group defaults when groupId is %s",
    (groupId) => {
      const current = initialLayout();
      const plan = planFor(["t1", "t2", "t3"], ["t1"], { groupId });
      const context = contextFor(current, `seed-defaults-${groupId}`);
      context.newWorkspaceDefaults = {
        [groupId]: {
          status: "stopped",
          pet: "hina",
          color: "#4C8DF6",
        },
      };

      let compiled: ReturnType<ReturnType<typeof createGroupingEngine>["compileGroupingPlan"]> | undefined;
      expect(() => {
        compiled = createGroupingEngine().compileGroupingPlan(plan, current, context);
      }).not.toThrow();
      expect(compiled?.ok).toBe(true);
      if (!compiled?.ok) return;
      const workspaceId = compiled.transaction.expected.newWorkspaceIds[0];
      expect(compiled.transaction.workspaces.find((item) => item.id === workspaceId)).toMatchObject({
        status: "stopped",
        pet: "hina",
        color: "#4C8DF6",
      });
    },
  );

  it.each(["workspace", "pane", "tab", "session"] as const)("fails closed on duplicate %s identity", (kind) => {
    const current = initialLayout();
    if (kind === "workspace") current[1].id = current[0].id;
    if (kind === "pane") {
      current[1].panes[0].id = current[0].panes[0].id;
      current[1].splitColumns = [[current[0].panes[0].id]];
    }
    if (kind === "tab") {
      current[1].panes[0].tabs[0].id = current[0].panes[0].tabs[0].id;
      current[1].panes[0].activeTabId = current[0].panes[0].tabs[0].id;
    }
    if (kind === "session") {
      current[1].panes[0].tabs[0].sessionId = current[0].panes[0].tabs[0].sessionId;
      current[1].panes[0].sessionId = current[0].panes[0].tabs[0].sessionId;
    }
    const issues = validateLayoutIdentity(current);
    const expectedId = kind === "workspace" ? "ws-a"
      : kind === "pane" ? "pane-a"
        : kind === "tab" ? "t1"
          : "session-t1";
    expect(issues).toContainEqual(expect.objectContaining({ kind, id: expectedId }));
    const engine = createGroupingEngine();
    const prepared = engine.prepareGroupingCommit(
      planFor(["t1", "t2", "t3"]),
      current,
      contextFor(current, `seed-duplicate-${kind}`),
    );
    expect(prepared.ok).toBe(false);
  });

  it("rejects cross-kind allocation collisions and empty identities", () => {
    const seed = "seed-collision";
    const allocator = createDeterministicGroupingAllocator(seed, "plan-a");
    const current = initialLayout();
    const generatedWorkspaceId = allocator.workspaceId("group-a");
    current[0].panes[0].id = generatedWorkspaceId;
    current[0].splitColumns = [[generatedWorkspaceId]];
    const engine = createGroupingEngine();
    const result = engine.prepareGroupingCommit(
      planFor(["t1", "t2", "t3"]),
      current,
      contextFor(current, seed),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("allocationSeed collision");

    const empty = initialLayout();
    empty[0].id = "";
    empty[0].panes[0].tabs[0].sessionId = "";
    empty[0].panes[0].sessionId = "";
    expect(validateLayoutIdentity(empty)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "workspace", id: "" }),
      expect.objectContaining({ kind: "session", id: "" }),
    ]));
  });

  it("rejects layouts above the four-column and four-pane limits", () => {
    const current = initialLayout();
    current[0].panes[0].tabs.push(tab("t4"), tab("t5"));
    const allIds = ["t1", "t2", "t3", "t4", "t5"];
    const engine = createGroupingEngine();
    const columnsPlan = planFor(allIds, allIds);
    columnsPlan.groups[0].layout = {
      columns: Array.from({ length: 5 }, (_, index) => ({
        panes: [{ title: `列${index + 1}`, role: "worker", tabIds: [allIds[index]] }],
      })),
    };
    const columns = engine.compileGroupingPlan(columnsPlan, current, contextFor(current, "seed-columns"));
    expect(columns.ok).toBe(false);
    if (!columns.ok) expect(columns.errors.join(" ")).toContain("列数が4を超えます");

    const panesPlan = planFor(allIds, allIds);
    panesPlan.groups[0].layout = {
      columns: [{
        panes: Array.from({ length: 5 }, (_, index) => ({
          title: `机${index + 1}`,
          role: "worker" as const,
          tabIds: [allIds[index]],
        })),
      }],
    };
    const panes = engine.compileGroupingPlan(panesPlan, current, contextFor(current, "seed-panes"));
    expect(panes.ok).toBe(false);
    if (!panes.ok) expect(panes.errors.join(" ")).toContain("ペイン数が4を超えます");
  });

  it.each(["five-columns", "five-panes"] as const)(
    "rejects an untouched workspace that already has %s",
    (kind) => {
      const current = applyCapacityViolation(initialLayout(), kind);
      const allTabIds = current.flatMap((itemWorkspace) => (
        itemWorkspace.panes.flatMap((itemPane) => itemPane.tabs.map((itemTab) => itemTab.id))
      ));
      const engine = createGroupingEngine();
      const result = engine.compileGroupingPlan(
        planFor(allTabIds, ["t1"]),
        current,
        contextFor(current, `seed-existing-${kind}`),
      );

      expect(validateLayoutIdentity(current)).toEqual(expect.arrayContaining([
        expect.objectContaining({ locations: [expect.stringContaining("splitColumns")] }),
      ]));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.join(" ")).toContain("splitColumns");
    },
  );

  it("rejects split-column, active-tab, and empty-pane identity corruption", () => {
    const split = initialLayout();
    split[0].splitColumns = [["missing-pane"]];
    expect(validateLayoutIdentity(split).length).toBeGreaterThan(0);

    const active = initialLayout();
    active[0].panes[0].activeTabId = "missing-tab";
    expect(validateLayoutIdentity(active).length).toBeGreaterThan(0);

    const empty = initialLayout();
    empty[0].panes[0].tabs = [];
    expect(validateLayoutIdentity(empty).length).toBeGreaterThan(0);
  });

  it("uses the 4x4 fallback for a valid one-column three-pane output", () => {
    const current = initialLayout();
    const panes = [
      pane("pane-one", [tab("one")]),
      pane("pane-two", [tab("two")]),
      pane("pane-three", [tab("three")]),
    ];
    current[0] = {
      ...current[0],
      gridTemplateId: "4x4",
      panes,
      splitColumns: [panes.map((item) => item.id)],
      columnWidths: [100],
      rowHeightsPerCol: [[100, 100, 100]],
    };

    expect(validateLayoutIdentity(current)).toEqual([]);
    expect(validateLayoutIdentity(current, "output")).toEqual([]);
  });

  it.each([
    ["status", {}],
    ["status", "idle"],
    ["pet", {}],
    ["color", {}],
  ] as const)("rejects an invalid workspace %s value", (field, value) => {
    const current = initialLayout();
    (current[0] as unknown as Record<string, unknown>)[field] = value;

    expect(validateLayoutIdentity(current)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "layout",
        id: "ws-a",
        locations: [`workspaces[0].${field}`],
      }),
    ]));

    let compiled: ReturnType<ReturnType<typeof createGroupingEngine>["compileGroupingPlan"]> | undefined;
    expect(() => {
      compiled = createGroupingEngine().compileGroupingPlan(
        planFor(["t1", "t2", "t3"]),
        current,
        contextFor(current, `seed-invalid-${field}`),
      );
    }).not.toThrow();
    expect(compiled?.ok).toBe(false);
    if (compiled && !compiled.ok) {
      expect(compiled.errors.join(" ")).toContain(`workspaces[0].${field}`);
    }
  });
});

describe("Gate 1 verified commit and rollback", () => {
  it("rolls back a partially corrupted replace and verifies the full snapshot", () => {
    const { engine, current, plan, ticket } = prepare("seed-corrupt");
    const originalProjection = persistentLayoutProjection(current);
    const store = harness(current, {
      corruptCommit: (next) => {
        next[0].name = "壊れた名前";
        return next;
      },
    });
    const result = engine.commitPreparedGrouping(plan, ticket, store.deps);
    expect(result).toMatchObject({ ok: false, kind: "commit_mismatch" });
    expect(store.state.replaceCalls).toBe(1);
    expect(store.state.restoreCalls).toBe(1);
    expect(persistentLayoutProjection(store.workspaces())).toEqual(originalProjection);
    expect(store.selection()).toEqual({
      activeWorkspaceId: "ws-a",
      activeSessionId: "session-t1",
      lastActivePaneByWorkspace: {
        "ws-a": "session-t1",
        "ws-b": "session-t3",
      },
    });
  });

  it.each(["five-columns", "five-panes"] as const)(
    "rejects committed output with %s through the common validator",
    (kind) => {
      const { engine, current, plan, ticket } = prepare(`seed-output-${kind}`);
      const store = harness(current, {
        corruptCommit: (next) => applyCapacityViolation(next, kind),
      });

      const result = engine.commitPreparedGrouping(plan, ticket, store.deps);

      expect(result).toMatchObject({ ok: false, kind: "commit_mismatch" });
      if (!result.ok) expect(result.errors.join(" ")).toContain("splitColumns");
      expect(store.state.restoreCalls).toBe(1);
      expect(persistentLayoutProjection(store.workspaces())).toEqual(persistentLayoutProjection(current));
    },
  );

  it.each(["corrupt", "throw"] as const)("reports rollback_failed when restore is %s and blocks later commits", (mode) => {
    const { engine, current, plan, ticket } = prepare(`seed-rollback-${mode}`);
    const store = harness(current, {
      corruptCommit: (next) => {
        next[0].name = "commit-corrupt";
        return next;
      },
      corruptRestore: mode === "corrupt" ? (snapshot) => {
        snapshot.workspaces[0].name = "restore-corrupt";
        return snapshot;
      } : undefined,
      throwOnRestore: mode === "throw",
    });
    expect(engine.commitPreparedGrouping(plan, ticket, store.deps)).toMatchObject({
      ok: false,
      kind: "rollback_failed",
    });
    const replaceCalls = store.state.replaceCalls;
    const another = engine.prepareGroupingCommit(plan, current, contextFor(current, `seed-after-${mode}`));
    expect(another.ok).toBe(true);
    if (!another.ok) return;
    expect(engine.commitPreparedGrouping(plan, another.ticket, store.deps)).toMatchObject({
      ok: false,
      kind: "boundary_poisoned",
    });
    expect(store.state.replaceCalls).toBe(replaceCalls);
  });

  it("rolls back when focus application is a no-op", () => {
    const { engine, current, plan, ticket } = prepare("seed-focus");
    const store = harness(current, { selectionNoop: true });
    expect(engine.commitPreparedGrouping(plan, ticket, store.deps)).toMatchObject({
      ok: false,
      kind: "commit_mismatch",
    });
    expect(store.state.restoreCalls).toBe(1);
  });

  it.each(["split", "metrics", "metadata"] as const)("detects %s-only commit corruption", (kind) => {
    let setup = prepare(`seed-${kind}`);
    if (kind === "split") {
      const engine = createGroupingEngine();
      const current = initialLayout();
      const plan = planFor(["t1", "t2", "t3"], ["t1", "t2"]);
      plan.groups[0].layout = {
        columns: [{ panes: [
          { title: "第一", role: "worker", tabIds: ["t1"] },
          { title: "第二", role: "worker", tabIds: ["t2"] },
        ] }],
      };
      const prepared = engine.prepareGroupingCommit(plan, current, contextFor(current, "seed-split"));
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      setup = { engine, current, plan, ticket: prepared.ticket };
    }
    const { engine, current, plan, ticket } = setup;
    const store = harness(current, {
      corruptCommit: (next) => {
        if (kind === "split") next.at(-1)!.splitColumns![0].reverse();
        if (kind === "metrics") next.at(-1)!.columnWidths = [37];
        if (kind === "metadata") next.at(-1)!.panes[0].tabs[0].label = "破損";
        return next;
      },
    });
    expect(engine.commitPreparedGrouping(plan, ticket, store.deps)).toMatchObject({
      ok: false,
      kind: "commit_mismatch",
    });
    expect(store.state.restoreCalls).toBe(1);
  });

  it("consumes tickets after success and after failure", () => {
    const success = prepare("seed-once-success");
    const successStore = harness(success.current);
    expect(success.engine.commitPreparedGrouping(success.plan, success.ticket, successStore.deps).ok).toBe(true);
    expect(successStore.state.replaceCalls).toBe(1);
    const afterSuccessCalls = successStore.state.replaceCalls;
    expect(success.engine.commitPreparedGrouping(success.plan, success.ticket, successStore.deps)).toMatchObject({
      ok: false,
      kind: "invalid_input",
    });
    expect(successStore.state.replaceCalls).toBe(afterSuccessCalls);

    const failure = prepare("seed-once-failure");
    const failureStore = harness(failure.current);
    failureStore.mutateWorkspaces((draft) => draft[0].name = "確認後の変更");
    expect(failure.engine.commitPreparedGrouping(failure.plan, failure.ticket, failureStore.deps)).toMatchObject({
      ok: false,
      kind: "preview_stale",
    });
    failureStore.setWorkspaces(failure.current);
    expect(failure.engine.commitPreparedGrouping(failure.plan, failure.ticket, failureStore.deps)).toMatchObject({
      ok: false,
      kind: "invalid_input",
    });
    expect(failureStore.state.replaceCalls).toBe(0);
  });

  it("rejects cross-engine replay, previewId tampering, and malformed tickets", () => {
    const replay = prepare("seed-cross-engine");
    const replayStore = harness(replay.current);
    expect(replay.engine.commitPreparedGrouping(replay.plan, replay.ticket, replayStore.deps).ok).toBe(true);
    const otherEngine = createGroupingEngine();
    expect(otherEngine.commitPreparedGrouping(replay.plan, replay.ticket, replayStore.deps)).toMatchObject({
      ok: false,
      kind: "invalid_input",
    });

    const tampered = prepare("seed-preview-tamper");
    const tamperedStore = harness(tampered.current);
    const tamperedPreviewTicket = {
      ...tampered.ticket,
      previewId: "preview-forged" as typeof tampered.ticket.previewId,
    };
    expect(tampered.engine.commitPreparedGrouping(tampered.plan, tamperedPreviewTicket, tamperedStore.deps)).toMatchObject({
      ok: false,
      kind: "invalid_input",
    });
    expect(tamperedStore.state.replaceCalls).toBe(0);

    const malformed = prepare("seed-malformed");
    const malformedStore = harness(malformed.current);
    const malformedTicket = {
      ...malformed.ticket,
      transaction: undefined,
    } as unknown as typeof malformed.ticket;
    let malformedResult: ReturnType<typeof malformed.engine.commitPreparedGrouping> | undefined;
    expect(() => {
      malformedResult = malformed.engine.commitPreparedGrouping(malformed.plan, malformedTicket, malformedStore.deps);
    }).not.toThrow();
    expect(malformedResult).toMatchObject({
      ok: false,
      kind: "invalid_input",
    });
    expect(malformedStore.state.replaceCalls).toBe(0);
  });

  it("shares the rollback_failed latch across engine instances for the same dependency boundary", () => {
    const first = prepare("seed-shared-poison-a");
    const secondEngine = createGroupingEngine();
    const secondPrepared = secondEngine.prepareGroupingCommit(
      first.plan,
      first.current,
      contextFor(first.current, "seed-shared-poison-b"),
    );
    expect(secondPrepared.ok).toBe(true);
    if (!secondPrepared.ok) return;
    const store = harness(first.current, {
      corruptCommit: (next) => {
        next[0].name = "commit-corrupt";
        return next;
      },
      throwOnRestore: true,
    });
    expect(first.engine.commitPreparedGrouping(first.plan, first.ticket, store.deps)).toMatchObject({
      ok: false,
      kind: "rollback_failed",
    });
    const replaceCalls = store.state.replaceCalls;
    const equivalentAdapter = { ...store.deps };
    expect(secondEngine.commitPreparedGrouping(first.plan, secondPrepared.ticket, equivalentAdapter)).toMatchObject({
      ok: false,
      kind: "boundary_poisoned",
    });
    expect(store.state.replaceCalls).toBe(replaceCalls);
  });
});

describe("Gate 1 undo boundary", () => {
  it("warns but does not poison when the saved undo snapshot has a drifted grid template", () => {
    const engine = createGroupingEngine();
    const current = applyGridTemplateDrift(initialLayout());
    const plan = planFor(["t1", "t2", "t3", "t4"]);
    const prepared = engine.prepareGroupingCommit(plan, current, contextFor(current, "seed-undo-grid-drift"));
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const store = harness(current);
    expect(engine.commitPreparedGrouping(plan, prepared.ticket, store.deps).ok).toBe(true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      expect(engine.restoreGroupingUndo(store.deps)).toEqual({ ok: true });
      expect(warn).toHaveBeenCalledWith(
        "[mycmux] tab grouping undo gridTemplateId drift",
        expect.arrayContaining([expect.stringContaining("gridTemplateId")]),
      );

      const afterUndo = store.workspaces();
      const nextPlan = planFor(["t1", "t2", "t3", "t4"], ["t1"], { planId: "after-grid-drift-undo" });
      const next = engine.prepareGroupingCommit(
        nextPlan,
        afterUndo,
        contextFor(afterUndo, "seed-after-grid-drift-undo"),
      );
      expect(next.ok).toBe(true);
      if (!next.ok) return;
      expect(engine.commitPreparedGrouping(nextPlan, next.ticket, store.deps)).not.toMatchObject({
        kind: "boundary_poisoned",
      });
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    {
      name: "duplicate workspace identity",
      corrupt: (record: GroupingUndoRecord) => {
        record.snapshot.workspaces[1].id = record.snapshot.workspaces[0].id;
      },
      marker: "workspaces",
    },
    {
      name: "active selection in a different workspace",
      corrupt: (record: GroupingUndoRecord) => {
        record.snapshot.selection.activeWorkspaceId = "ws-b";
        record.snapshot.selection.activeSessionId = "session-t1";
      },
      marker: "selection",
    },
    {
      name: "five columns",
      corrupt: (record: GroupingUndoRecord) => {
        applyCapacityViolation(record.snapshot.workspaces, "five-columns");
      },
      marker: "splitColumns",
    },
    {
      name: "five panes in one column",
      corrupt: (record: GroupingUndoRecord) => {
        applyCapacityViolation(record.snapshot.workspaces, "five-panes");
      },
      marker: "splitColumns",
    },
  ])("rejects an invalid undo snapshot immediately: $name", ({ corrupt, marker }) => {
    const { engine, current, plan, ticket } = prepare(`seed-invalid-undo-${marker}`);
    const store = harness(current);
    expect(engine.commitPreparedGrouping(plan, ticket, store.deps).ok).toBe(true);
    const record = store.undo();
    expect(record).not.toBeNull();
    if (!record) return;
    corrupt(record);
    store.setUndo(record);

    const result = engine.restoreGroupingUndo(store.deps);

    expect(result).toMatchObject({ ok: false, kind: "restore_failed" });
    if (!result.ok) expect(result.reason).toContain(marker);
    expect(store.state.restoreCalls).toBe(0);
  });

  it.each(["resize", "rename", "pane-label"] as const)("expires undo after %s", (kind) => {
    const { engine, current, plan, ticket } = prepare(`seed-undo-${kind}`);
    const store = harness(current);
    expect(engine.commitPreparedGrouping(plan, ticket, store.deps).ok).toBe(true);
    store.mutateWorkspaces((draft) => {
      if (kind === "resize") draft[0].columnWidths = [73];
      if (kind === "rename") draft[0].name = "手動改名";
      if (kind === "pane-label") draft[0].panes[0].label = "構造変更";
    });
    const result = engine.restoreGroupingUndo(store.deps);
    expect(result).toMatchObject({ ok: false, kind: "expired" });
    expect(store.state.restoreCalls).toBe(0);
  });

  it("does not expire on tab click and preserves live selection through undo", () => {
    const engine = createGroupingEngine();
    const current = initialLayout();
    current[1].panes[0].tabs.push(tab("t4"));
    const plan = planFor(["t1", "t2", "t3", "t4"], ["t1", "t2"]);
    const prepared = engine.prepareGroupingCommit(plan, current, contextFor(current, "seed-undo-selection"));
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const ticket = prepared.ticket;
    const store = harness(current);
    expect(engine.commitPreparedGrouping(plan, ticket, store.deps).ok).toBe(true);
    const movedWorkspaceId = store.workspaces().find((workspace) => (
      workspace.panes.some((itemPane) => itemPane.tabs.some((itemTab) => itemTab.id === "t2"))
    ))!.id;
    store.mutateWorkspaces((draft) => {
      const targetPane = draft.flatMap((item) => item.panes).find((item) => (
        item.tabs.some((itemTab) => itemTab.id === "t2")
      ))!;
      const active = targetPane.tabs.find((item) => item.id === "t2")!;
      targetPane.activeTabId = active.id;
      targetPane.sessionId = active.sessionId;
      targetPane.agentId = active.agentId;
      targetPane.cwd = active.cwd;
      targetPane.lastProcess = active.lastProcess;
      targetPane.agentKind = active.agentKind;
      targetPane.agentSessionId = active.agentSessionId;
      targetPane.launchEnv = active.launchEnv;

      const backgroundPane = draft[1].panes[0];
      const background = backgroundPane.tabs.find((item) => item.id === "t4")!;
      backgroundPane.activeTabId = background.id;
      backgroundPane.sessionId = background.sessionId;
      backgroundPane.agentId = background.agentId;
      backgroundPane.cwd = background.cwd;
      backgroundPane.lastProcess = background.lastProcess;
      backgroundPane.agentKind = background.agentKind;
      backgroundPane.agentSessionId = background.agentSessionId;
      backgroundPane.launchEnv = background.launchEnv;
    });
    store.mutateSelection((selection) => {
      selection.activeWorkspaceId = movedWorkspaceId;
      selection.activeSessionId = "session-t2";
      selection.lastActivePaneByWorkspace = {
        [movedWorkspaceId]: "session-t2",
        "ws-b": "session-t4",
      };
    });
    expect(engine.restoreGroupingUndo(store.deps)).toEqual({ ok: true });
    expect(store.selection()).toEqual({
      activeWorkspaceId: "ws-a",
      activeSessionId: "session-t2",
      lastActivePaneByWorkspace: {
        "ws-a": "session-t2",
        "ws-b": "session-t4",
      },
    });
    expect(store.workspaces()[0].panes[0].activeTabId).toBe("t2");
    expect(store.workspaces()[0].panes[0].sessionId).toBe("session-t2");
    expect(store.workspaces()[1].panes[0].activeTabId).toBe("t4");
    expect(store.workspaces()[1].panes[0].sessionId).toBe("session-t4");
  });

  it("falls back to the snapshot selection when the live selection no longer exists", () => {
    const { engine, current, plan, ticket } = prepare("seed-undo-selection-fallback");
    const store = harness(current);
    expect(engine.commitPreparedGrouping(plan, ticket, store.deps).ok).toBe(true);
    store.mutateSelection((selection) => {
      selection.activeWorkspaceId = "missing-workspace";
      selection.activeSessionId = "missing-session";
    });

    expect(engine.restoreGroupingUndo(store.deps)).toEqual({ ok: true });
    expect(store.selection()).toMatchObject({
      activeWorkspaceId: "ws-a",
      activeSessionId: "session-t1",
    });
  });

  it("poisons the engine boundary when undo restoration cannot be verified", () => {
    const { engine, current, plan, ticket } = prepare("seed-undo-restore-failure");
    const store = harness(current, {
      corruptRestore: (snapshot) => {
        snapshot.workspaces[0].name = "undo-restore-corrupt";
        return snapshot;
      },
    });
    expect(engine.commitPreparedGrouping(plan, ticket, store.deps).ok).toBe(true);

    expect(engine.restoreGroupingUndo(store.deps)).toMatchObject({
      ok: false,
      kind: "restore_failed",
    });
    const restoreCalls = store.state.restoreCalls;
    expect(engine.restoreGroupingUndo(store.deps)).toMatchObject({
      ok: false,
      kind: "boundary_poisoned",
    });
    expect(store.state.restoreCalls).toBe(restoreCalls);

    const live = structuredClone(store.workspaces());
    const nextPlan = planFor(["t1", "t2", "t3"], ["t1"], { planId: "after-undo-poison" });
    const prepared = engine.prepareGroupingCommit(nextPlan, live, contextFor(live, "seed-after-undo-poison"));
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const replaceCalls = store.state.replaceCalls;
    expect(engine.commitPreparedGrouping(nextPlan, prepared.ticket, store.deps)).toMatchObject({
      ok: false,
      kind: "boundary_poisoned",
    });
    expect(store.state.replaceCalls).toBe(replaceCalls);
  });
});
