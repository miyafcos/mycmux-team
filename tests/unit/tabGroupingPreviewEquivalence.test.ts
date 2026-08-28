import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GroupingPlan } from "../../src/components/layout/tabGrouping";
import type { Pane, PaneTab, Workspace } from "../../src/types";
import type { GroupingCompileContext } from "./helpers/groupingTestEntrypoint";

const NOW = 1_800_000_000_000;

function tab(id: string): PaneTab {
  return {
    id,
    sessionId: `session-${id}`,
    agentId: "shell-starter",
    type: "terminal",
    label: `ラベル${id}`,
    labelSource: "user",
    cwd: `C:/work/${id}`,
    origin: { kind: "human" },
  };
}

function pane(id: string, tabIds: string[]): Pane {
  const tabs = tabIds.map(tab);
  return {
    id,
    agentId: tabs[0]?.agentId ?? "shell-starter",
    sessionId: tabs[0]?.sessionId ?? `session-${id}`,
    activeTabId: tabs[0]?.id ?? "",
    tabs,
    label: `ペイン${id}`,
    cwd: tabs[0]?.cwd ?? "C:/work",
  };
}

function gridTemplateId(columnCount: number): Workspace["gridTemplateId"] {
  if (columnCount === 1) return "1x1";
  if (columnCount === 2) return "2x1";
  if (columnCount === 3) return "3x1";
  return "4x1";
}

function workspace(id: string, name: string, columns: string[][]): Workspace {
  const panes = columns.map((tabIds, index) => pane(`${id}-pane-${index + 1}`, tabIds));
  return {
    id,
    name,
    gridTemplateId: gridTemplateId(columns.length),
    status: "running",
    createdAt: NOW,
    color: `color-${id}`,
    pet: "clawd",
    panes,
    splitColumns: panes.map((item) => [item.id]),
    columnWidths: panes.map(() => 100),
    rowHeightsPerCol: panes.map(() => [100]),
  };
}

function initialLayout(): Workspace[] {
  return [
    workspace("ws-a", "母艦", [["t1", "t2"]]),
    workspace("ws-b", "作業机", [["t3"]]),
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

async function loadModules() {
  const entrypoint = await import("./helpers/groupingTestEntrypoint");
  const internals = await entrypoint.loadGroupingInternalsForTests();
  const boundary = await import("../../src/components/layout/groupingBoundary");
  const layoutRevisionAudit = await import("../../src/lib/layoutRevisionAuditBootstrap");
  return { ...internals, boundary, hashCanonical: entrypoint.hashCanonical, layoutRevisionAudit };
}

type LoadedModules = Awaited<ReturnType<typeof loadModules>>;

function seedStores(modules: LoadedModules, workspaces: Workspace[]): void {
  modules.runtime.__resetGroupingRuntimeForTests();
  modules.persistence.__resetPersistenceCoordinatorForTests();
  modules.persistence.markPersistentSchemaSupported(1);
  modules.runtime.recordPersistentSchemaState({ loadedSchemaVersion: 1, migrationComplete: true });
  modules.workspaceStore.useWorkspaceListStore.setState({
    workspaces: structuredClone(workspaces),
    layoutRevision: 0,
    activeWorkspaceId: workspaces[0]?.id ?? null,
    lastActivePaneByWorkspace: Object.fromEntries(workspaces.flatMap((item) => {
      const sessionId = item.panes[0]?.tabs[0]?.sessionId;
      return sessionId ? [[item.id, sessionId]] : [];
    })),
  });
  modules.uiStore.useUiStore.setState({
    activePaneId: workspaces[0]?.panes[0]?.tabs[0]?.sessionId ?? null,
    lastActivePaneId: workspaces[0]?.panes[0]?.tabs[0]?.sessionId ?? null,
    focusRevision: 0,
  });
}

function planFor(
  modules: LoadedModules,
  workspaces: readonly Workspace[],
  movedTabIds: string[],
  destination: GroupingPlan["groups"][number]["destination"] = {
    kind: "new_workspace",
    proposedName: "案件甲",
  },
  layout = modules.grouping.defaultLayoutForTabs(movedTabIds, "母艦"),
): GroupingPlan {
  const moved = new Set(movedTabIds);
  const kept = workspaces.flatMap((item) => item.panes.flatMap((itemPane) => itemPane.tabs.map((itemTab) => itemTab.id)))
    .filter((id) => !moved.has(id));
  return {
    planId: "plan-preview-equivalence",
    title: "案件で分ける",
    rationale: "案件単位",
    strategy: "project",
    groups: [
      {
        groupId: "group-a",
        title: "案件甲",
        disposition: "reorganize",
        destination,
        layout,
        tabIds: movedTabIds,
        adopted: true,
      },
      {
        groupId: "group-keep",
        title: "現状維持",
        disposition: "keep",
        destination: { kind: "current_locations" },
        layout: null,
        tabIds: kept,
        adopted: true,
      },
    ],
    unassignedTabIds: [],
    warnings: [],
  };
}

function medianMs(run: () => void, samples = 21): number {
  run();
  run();
  const measured: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    run();
    measured.push(performance.now() - started);
  }
  measured.sort((left, right) => left - right);
  return measured[Math.floor(measured.length / 2)];
}

function installAvailableUndo(modules: LoadedModules, recordId: string): void {
  const liveWorkspaces = modules.workspaceStore.useWorkspaceListStore.getState().workspaces;
  modules.runtime.groupingUndoRepository.set({
    recordId,
    schemaVersion: 1,
    snapshot: modules.adapter.getGroupingStoreAdapter().getGroupingState(),
    report: {
      movedTabCount: 0,
      affectedWorkspaceIds: liveWorkspaces.map((item) => item.id),
      emptyWorkspaceIds: [],
      appliedAt: NOW,
    },
    appliedLayoutSignature: modules.hashCanonical(modules.engine.persistentLayoutProjection(liveWorkspaces)),
    expectedStructuralSignature: modules.engine.structuralUndoSignature(liveWorkspaces),
    committedLayoutRevision: modules.workspaceStore.useWorkspaceListStore.getState().layoutRevision,
    createdAt: NOW,
    status: "available",
    expireReason: null,
  });
}

let modules: LoadedModules;

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  modules = await loadModules();
  modules.layoutRevisionAudit.__resetLayoutRevisionAuditBootstrapForTests();
  seedStores(modules, initialLayout());
}, 120_000);

describe("Gate 3 grouping preview equivalence", () => {
  it("uses the same canonical transaction as prepare for identical live state and context", () => {
    const current = initialLayout();
    const plan = planFor(modules, current, ["t1"]);
    const context = contextFor(current, "preview-ok");

    const preview = modules.boundary.groupingBoundary.preview(plan, context);
    const prepared = modules.boundary.groupingBoundary.prepare(plan, context);

    expect(preview.ok).toBe(true);
    expect(prepared.ok).toBe(true);
    if (!preview.ok || !prepared.ok) return;
    expect(modules.hashCanonical(preview.transaction)).toBe(
      modules.hashCanonical(prepared.ticket.transaction),
    );
  });

  it("returns the canonical typed failure for five destination columns", () => {
    const current = [
      workspace("ws-a", "母艦", [["t1", "t2"]]),
      workspace("ws-b", "三列机", [["t3"], ["t4"], ["t5"]]),
    ];
    seedStores(modules, current);
    const plan = planFor(
      modules,
      current,
      ["t1", "t2"],
      { kind: "existing_workspace", workspaceId: "ws-b" },
      {
        columns: [
          { panes: [{ title: "甲", role: "mother", tabIds: ["t1"] }] },
          { panes: [{ title: "乙", role: "worker", tabIds: ["t2"] }] },
        ],
      },
    );
    const context = contextFor(current, "preview-five-columns");
    const expected = {
      ok: false as const,
      errors: ["ワークスペース ws-b の列数が4を超えます"],
      stale: [],
    };

    expect(modules.boundary.groupingBoundary.preview(plan, context)).toEqual(expected);
    expect(modules.boundary.groupingBoundary.prepare(plan, context)).toEqual(expected);
  });

  it.each([
    ["poisoned", "boundary_poisoned"],
    ["operation", "operation_in_progress"],
    ["transition", "operation_in_progress"],
  ] as const)("matches prepare for the %s guard", (state, expectedKind) => {
    const current = initialLayout();
    const plan = planFor(modules, current, ["t1"]);
    const context = contextFor(current, `preview-guard-${state}`);
    if (state === "poisoned") {
      modules.runtime.useGroupingRuntimeStore.setState({ poisoned: true });
    } else if (state === "operation") {
      modules.runtime.useGroupingRuntimeStore.setState({
        operation: { kind: "commit", token: Symbol("preview-guard") },
      });
    } else {
      const token = Symbol("preview-transition");
      modules.runtime.useGroupingRuntimeStore.setState({
        transitionDepth: 1,
        transitionSource: "grouping-commit",
        transitionFrames: [token],
      });
    }

    const preview = modules.boundary.groupingBoundary.preview(plan, context);
    const prepared = modules.boundary.groupingBoundary.prepare(plan, context);
    expect(preview).toMatchObject({ ok: false, kind: expectedKind, stale: [], errors: [expect.any(String)] });
    expect(prepared).toMatchObject({ ok: false, kind: expectedKind, stale: [], errors: [expect.any(String)] });
    if (!preview.ok && !prepared.ok) expect(preview.kind).toBe(prepared.kind);
  });

  it("does not consume tickets or mutate the layout revision and Undo record", () => {
    const current = initialLayout();
    const plan = planFor(modules, current, ["t1"]);
    const context = contextFor(current, "preview-side-effect");
    const prepared = modules.boundary.groupingBoundary.prepare(plan, context);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const snapshot = modules.adapter.getGroupingStoreAdapter().getGroupingState();
    modules.runtime.groupingUndoRepository.set({
      recordId: "preview-side-effect-undo",
      schemaVersion: 1,
      snapshot,
      report: { movedTabCount: 0, affectedWorkspaceIds: [], emptyWorkspaceIds: [], appliedAt: NOW },
      appliedLayoutSignature: modules.hashCanonical(modules.engine.persistentLayoutProjection(current)),
      expectedStructuralSignature: modules.engine.structuralUndoSignature(current),
      committedLayoutRevision: 0,
      createdAt: NOW,
      status: "available",
      expireReason: null,
    });
    const revisionBefore = modules.workspaceStore.useWorkspaceListStore.getState().layoutRevision;
    const undoBefore = structuredClone(modules.runtime.useGroupingRuntimeStore.getState().undo);

    for (let index = 0; index < 300; index += 1) {
      const preview = modules.boundary.groupingBoundary.preview(plan, context);
      if (!preview.ok) throw new Error(`preview ${index} failed: ${preview.errors.join(" / ")}`);
    }

    expect(modules.workspaceStore.useWorkspaceListStore.getState().layoutRevision).toBe(revisionBefore);
    expect(modules.runtime.useGroupingRuntimeStore.getState().undo).toEqual(undoBefore);
    expect(modules.boundary.groupingBoundary.commit(plan, prepared.ticket).commit.ok).toBe(true);
  });

  it("keeps the 100-tab preview median below 50ms", () => {
    const ids = Array.from({ length: 100 }, (_, index) => `t${index + 1}`);
    const current = [workspace("ws-a", "百タブ", [ids])];
    seedStores(modules, current);
    const plan = planFor(modules, current, ids.slice(0, 50));
    const context = contextFor(current, "preview-performance");
    const first = modules.boundary.groupingBoundary.preview(plan, context);
    expect(first.ok).toBe(true);

    const samples = 21;
    const median = medianMs(() => {
      const preview = modules.boundary.groupingBoundary.preview(plan, context);
      if (!preview.ok) throw new Error(preview.errors.join(" / "));
    }, samples);
    console.log(`tabGrouping preview 100 tabs median: ${median.toFixed(3)}ms (${samples} samples)`);
    expect(median).toBeLessThan(50);
  });

  it("keeps Undo available for scrollback changes and expires it for structural changes", () => {
    const current = initialLayout();
    current[0].panes[0].tabs[0].terminalSnapshot = ["restored output before grouping"];
    current[0].panes[0].tabs[0].turnMarks = [{ label: "before", at: 1, lines_from_bottom: 1 }];
    seedStores(modules, current);
    installAvailableUndo(modules, "undo-invalidation-structure");

    const scrollbackChanged = structuredClone(
      modules.workspaceStore.useWorkspaceListStore.getState().workspaces,
    );
    const runtimeChangedTab = scrollbackChanged[0].panes[0].tabs[0];
    runtimeChangedTab.terminalSnapshot = ["restored output after grouping"];
    runtimeChangedTab.turnMarks = [{ label: "after", at: 2, lines_from_bottom: 2 }];
    runtimeChangedTab.label = "runtime label after grouping";
    runtimeChangedTab.cwd = "C:/runtime/after";
    runtimeChangedTab.lastProcess = "runtime-process";
    runtimeChangedTab.agentKind = "codex";
    runtimeChangedTab.launchEnv = { RUNTIME_ONLY: "1" };
    scrollbackChanged[0].panes[0].gitBranch = "runtime-branch";
    modules.workspaceStore.useWorkspaceListStore.setState({
      workspaces: scrollbackChanged,
      layoutRevision: 1,
    });
    expect(modules.runtime.useGroupingRuntimeStore.getState().undo?.status).toBe("available");

    const structurallyChanged = structuredClone(scrollbackChanged);
    structurallyChanged[0].name = `${structurallyChanged[0].name}-changed`;
    modules.workspaceStore.useWorkspaceListStore.setState({
      workspaces: structurallyChanged,
      layoutRevision: 2,
    });
    expect(modules.runtime.useGroupingRuntimeStore.getState().undo?.status).toBe("expired");
  });

  it("expires Undo when a declared tab is launched (lifecycle is structural)", () => {
    const current = initialLayout();
    current[0].panes[0].tabs[0].lifecycle = "declared";
    seedStores(modules, current);
    installAvailableUndo(modules, "undo-invalidation-lifecycle");
    expect(modules.runtime.useGroupingRuntimeStore.getState().undo?.status).toBe("available");

    const launched = structuredClone(
      modules.workspaceStore.useWorkspaceListStore.getState().workspaces,
    );
    delete launched[0].panes[0].tabs[0].lifecycle;
    modules.workspaceStore.useWorkspaceListStore.setState({
      workspaces: launched,
      layoutRevision: 1,
    });
    expect(modules.runtime.useGroupingRuntimeStore.getState().undo?.status).toBe("expired");
  });

  it("keeps the 100-tab Undo invalidation watcher median below 20ms with restored scrollback", () => {
    const ids = Array.from({ length: 100 }, (_, index) => `watcher-t${index + 1}`);
    const current = [workspace("ws-watcher", "復元済み百タブ", [ids])];
    current[0].panes[0].tabs.forEach((itemTab, tabIndex) => {
      itemTab.terminalSnapshot = Array.from(
        { length: 160 },
        (_, lineIndex) => `tab-${tabIndex}-line-${lineIndex}-${"x".repeat(80)}`,
      );
    });
    seedStores(modules, current);
    installAvailableUndo(modules, "undo-invalidation-performance");

    const median = medianMs(() => {
      modules.workspaceStore.useWorkspaceListStore.setState((state) => ({
        layoutRevision: state.layoutRevision + 1,
      }));
    });

    expect(modules.runtime.useGroupingRuntimeStore.getState().undo?.status).toBe("available");
    if (process.env.MYCMUX_GROUPING_BENCH_LOG === "1") {
      console.log(`tabGrouping Undo watcher 100 tabs median: ${median.toFixed(3)}ms`);
    }
    expect(median).toBeLessThan(20);
  }, 120_000);
});
