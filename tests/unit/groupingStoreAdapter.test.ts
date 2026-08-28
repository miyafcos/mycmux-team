import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Pane, PaneTab, Workspace } from "../../src/types";
import type {
  GroupingCompileContext,
  GroupingPlan,
  GroupingStateSnapshot,
  Sha256,
} from "./helpers/groupingTestEntrypoint";

const NOW = 1_800_000_000_000;
const EXPIRED_REASON = "その後レイアウトが変更されたため元に戻せません";

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

function pane(id: string, tabs: PaneTab[]): Pane {
  const active = tabs[0];
  return {
    id,
    agentId: active.agentId,
    sessionId: active.sessionId,
    activeTabId: active.id,
    tabs,
    label: `ペイン${id}`,
    cwd: active.cwd,
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

type LoadedModules = Awaited<ReturnType<typeof loadModules>>;

async function loadModules() {
  const entrypoint = await import("./helpers/groupingTestEntrypoint");
  return entrypoint.loadGroupingInternalsForTests();
}

function planFor(modules: LoadedModules): GroupingPlan {
  return {
    planId: "plan-gate2b",
    title: "案件で分ける",
    rationale: "案件単位",
    strategy: "project",
    groups: [
      {
        groupId: "group-a",
        title: "案件甲",
        disposition: "reorganize",
        destination: { kind: "new_workspace", proposedName: "案件甲" },
        layout: modules.grouping.defaultLayoutForTabs(["t1"], "母艦"),
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

function seedStores(modules: LoadedModules): Workspace[] {
  const workspaces = initialLayout();
  modules.runtime.__resetGroupingRuntimeForTests();
  modules.persistence.__resetPersistenceCoordinatorForTests();
  modules.persistence.markPersistentSchemaSupported(1);
  modules.runtime.recordPersistentSchemaState({
    loadedSchemaVersion: 1,
    migrationComplete: true,
  });
  modules.workspaceStore.useWorkspaceListStore.setState({
    workspaces: structuredClone(workspaces),
    layoutRevision: 0,
    activeWorkspaceId: "ws-a",
    lastActivePaneByWorkspace: {
      "ws-a": "session-t1",
      "ws-b": "session-t3",
    },
  });
  modules.uiStore.useUiStore.setState({
    activePaneId: "session-t1",
    lastActivePaneId: "session-t1",
    focusRevision: 0,
  });
  return workspaces;
}

function prepare(modules: LoadedModules, current: Workspace[], seed: string, plan = planFor(modules)) {
  const selection = modules.adapter.getGroupingStoreAdapter().getSelection();
  const prepared = modules.adapter.prepareGroupingAtStoreBoundary(plan, {
    ...contextFor(current, seed),
    activeWorkspaceId: selection.activeWorkspaceId,
    activeSessionId: selection.activeSessionId,
  });
  if (!prepared.ok) throw new Error(`prepare failed: ${prepared.errors.join(" / ")} ${JSON.stringify(prepared.stale)}`);
  expect(prepared.ok).toBe(true);
  return { plan, ticket: prepared.ticket };
}

function interceptRestoreCalls(modules: LoadedModules) {
  const store = modules.workspaceStore.useWorkspaceListStore;
  const original = store.getState()._restoreGroupingLayout;
  const calls: Parameters<typeof original>[] = [];
  store.setState({
    _restoreGroupingLayout: (...args) => {
      calls.push(structuredClone(args));
      return original(...args);
    },
  });
  return { calls, original };
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

let modules: LoadedModules;

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  modules = await loadModules();
  seedStores(modules);
}, 120_000);

describe("Gate 2B fail-closed store boundary", () => {
  it("poisons the runtime when uiStore restoration fails and rejects later apply, undo, and preview", () => {
    const current = initialLayout();
    const { plan, ticket } = prepare(modules, current, "rollback-ui-failure");
    const later = prepare(modules, current, "after-poison");
    const reentryAdapter = modules.adapter.getGroupingStoreAdapter();
    let synchronousPreviewBlocked = false;
    let synchronousApplyResult: ReturnType<typeof modules.adapter.commitGroupingAtStoreBoundary> | null = null;
    const unsubscribeRuntime = modules.runtime.useGroupingRuntimeStore.subscribe((state, previous) => {
      if (!previous.operation || state.operation !== null) return;
      try {
        reentryAdapter.getWorkspaces();
      } catch {
        synchronousPreviewBlocked = true;
      }
      synchronousApplyResult = modules.adapter.commitGroupingAtStoreBoundary(plan, later.ticket);
    });
    modules.runtime.groupingUndoRepository.set({
      recordId: "test-poison-undo",
      schemaVersion: 1,
      snapshot: modules.adapter.getGroupingStoreAdapter().getGroupingState(),
      expectedStructuralSignature: modules.engine.structuralUndoSignature(current),
      committedLayoutRevision: 0,
      createdAt: NOW,
      status: "available",
      expireReason: null,
    });
    expect(modules.runtime.useGroupingRuntimeStore.getState().undo).not.toBeNull();
    const workspaceStore = modules.workspaceStore.useWorkspaceListStore;
    const originalRestore = workspaceStore.getState()._restoreGroupingLayout;
    let replaceCalls = 0;
    workspaceStore.setState({
      _restoreGroupingLayout: (workspaces, selection, source) => {
        replaceCalls += 1;
        const next = structuredClone(workspaces);
        if (replaceCalls === 1) next[0].name = "commit-corrupt";
        originalRestore(next, selection, source);
      },
    });
    const uiSet = vi.spyOn(modules.uiStore.useUiStore, "setState")
      .mockImplementation(() => { throw new Error("ui restore exploded"); });

    const result = modules.adapter.commitGroupingAtStoreBoundary(plan, ticket);
    unsubscribeRuntime();

    expect(result.commit).toMatchObject({ ok: false, kind: "rollback_failed" });
    expect(synchronousPreviewBlocked).toBe(true);
    expect(synchronousApplyResult?.commit).toMatchObject({ ok: false, kind: "boundary_poisoned" });
    expect(modules.runtime.useGroupingRuntimeStore.getState()).toMatchObject({
      poisoned: true,
      operation: null,
      undo: null,
      diagnostic: { code: "rollback_failed", operation: "commit", layoutRevision: expect.any(Number) },
    });
    const poisonedAdapter = modules.adapter.getGroupingStoreAdapter();
    expect(() => poisonedAdapter.getWorkspaces()).toThrow(/poison/i);
    let poisonedPreview: ReturnType<typeof modules.adapter.prepareGroupingAtStoreBoundary> | undefined;
    expect(() => {
      poisonedPreview = modules.adapter.prepareGroupingAtStoreBoundary(
        plan,
        contextFor(current, "poisoned-preview"),
      );
    }).not.toThrow();
    expect(poisonedPreview).toMatchObject({
      ok: false,
      kind: "boundary_poisoned",
      stale: [],
      errors: [expect.stringMatching(/poison/i)],
    });
    uiSet.mockRestore();

    expect(modules.adapter.commitGroupingAtStoreBoundary(plan, later.ticket).commit).toMatchObject({
      ok: false,
      kind: "boundary_poisoned",
    });
    expect(modules.adapter.undoGroupingAtStoreBoundary()).toMatchObject({
      ok: false,
      kind: "boundary_poisoned",
    });
  });

  it("rejects a reentrant workspace mutation from an intermediate-state subscriber", () => {
    const current = initialLayout();
    const before = modules.engine.persistentLayoutProjection(current);
    const { plan, ticket } = prepare(modules, current, "reentrant-mutation");
    let reentryError: unknown;
    const focusRevision = modules.uiStore.useUiStore.getState().focusRevision;
    const unsubscribe = modules.workspaceStore.useWorkspaceListStore.subscribe((state, previous) => {
      if (state.layoutRevision === previous.layoutRevision) return;
      unsubscribe();
      try {
        state.setActiveWorkspace("ws-b");
      } catch (error) {
        reentryError = error;
        throw error;
      }
    });

    const result = modules.adapter.commitGroupingAtStoreBoundary(plan, ticket);

    expect(result.commit).toMatchObject({ ok: false, kind: "commit_mismatch" });
    expect(reentryError).toBeInstanceOf(Error);
    expect(String(reentryError)).toContain("grouping transition");
    expect(modules.engine.persistentLayoutProjection(
      modules.workspaceStore.useWorkspaceListStore.getState().workspaces,
    )).toEqual(before);
    expect(modules.uiStore.useUiStore.getState().focusRevision).toBe(focusRevision);
  });

  it("expires undo at execution time after a raw revision-bypassing layout change", () => {
    const current = initialLayout();
    const { plan, ticket } = prepare(modules, current, "raw-layout-change");
    const intercepted = interceptRestoreCalls(modules);
    expect(modules.adapter.commitGroupingAtStoreBoundary(plan, ticket).commit.ok).toBe(true);
    const callsBeforeUndo = intercepted.calls.length;
    const revision = modules.workspaceStore.useWorkspaceListStore.getState().layoutRevision;
    const changed = structuredClone(modules.workspaceStore.useWorkspaceListStore.getState().workspaces);
    changed[0].name = "revisionを迂回した改名";
    modules.workspaceStore.useWorkspaceListStore.setState({ workspaces: changed });
    expect(modules.workspaceStore.useWorkspaceListStore.getState().layoutRevision).toBe(revision);

    expect(modules.adapter.undoGroupingAtStoreBoundary()).toEqual({
      ok: false,
      kind: "expired",
      reason: EXPIRED_REASON,
    });
    expect(intercepted.calls).toHaveLength(callsBeforeUndo);
    expect(modules.runtime.useGroupingRuntimeStore.getState().undo).toMatchObject({ status: "expired" });
  });

  it("keeps undo available when runtime metadata changes on a tabless pane", () => {
    const current = initialLayout();
    const barePane = current[0].panes[0];
    barePane.tabs = [];
    barePane.activeTabId = "";
    barePane.sessionId = "session-bare";
    barePane.agentId = "shell-starter";
    modules.workspaceStore.useWorkspaceListStore.setState({
      workspaces: structuredClone(current),
      layoutRevision: 10,
      activeWorkspaceId: "ws-b",
      lastActivePaneByWorkspace: { "ws-b": "session-t3" },
    });
    modules.uiStore.useUiStore.setState({
      activePaneId: "session-t3",
      lastActivePaneId: "session-t3",
    });
    modules.runtime.groupingUndoRepository.set({
      recordId: "test-metadata-undo",
      schemaVersion: 1,
      snapshot: modules.adapter.getGroupingStoreAdapter().getGroupingState(),
      expectedStructuralSignature: modules.engine.structuralUndoSignature(current),
      committedLayoutRevision: 10,
      createdAt: NOW,
      status: "available",
      expireReason: null,
    });
    const intercepted = interceptRestoreCalls(modules);

    const metadataResult = modules.workspaceStore.useWorkspaceListStore.getState()
      .setPaneAgentSessionFromMetadata("session-bare", {
        agentKind: "codex",
        agentSessionId: "agent-bare",
      });

    expect(metadataResult).toMatchObject({ accepted: true, applied: true });
    expect(modules.workspaceStore.useWorkspaceListStore.getState().layoutRevision).toBe(11);
    expect(modules.runtime.useGroupingRuntimeStore.getState().undo).toMatchObject({
      status: "available",
      expireReason: null,
    });
    expect(intercepted.calls).toHaveLength(0);
  });

  it("keeps layout writes usable when undo invalidation sees a non-finite layout", () => {
    const current = initialLayout();
    modules.runtime.groupingUndoRepository.set({
      recordId: "test-non-finite-invalidation",
      schemaVersion: 1,
      snapshot: modules.adapter.getGroupingStoreAdapter().getGroupingState(),
      expectedStructuralSignature: modules.engine.structuralUndoSignature(current),
      committedLayoutRevision: 0,
      createdAt: NOW,
      status: "available",
      expireReason: null,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const poisoned = structuredClone(current);
    poisoned[0].createdAt = Number.POSITIVE_INFINITY;

    expect(() => modules.workspaceStore.useWorkspaceListStore.setState((state) => ({
      workspaces: poisoned,
      layoutRevision: state.layoutRevision + 1,
    }))).not.toThrow();
    expect(() => modules.workspaceStore.useWorkspaceListStore.getState()
      .renameWorkspace("ws-a", "still-writable")).not.toThrow();
    expect(modules.workspaceStore.useWorkspaceListStore.getState().workspaces[0].name).toBe("still-writable");
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/non-finite persistent number/i));
  });

  it("does not consume a ticket when the shared mutex is busy", () => {
    const current = initialLayout();
    const { plan, ticket } = prepare(modules, current, "double-apply");
    const intercepted = interceptRestoreCalls(modules);
    const lock = modules.runtime.tryBeginGroupingOperation("commit");
    expect(lock).not.toBeNull();
    if (!lock) return;

    expect(modules.adapter.commitGroupingAtStoreBoundary(plan, ticket).commit).toMatchObject({
      ok: false,
      kind: "operation_in_progress",
    });
    expect(intercepted.calls).toHaveLength(0);
    modules.runtime.endGroupingOperation(lock);

    expect(modules.adapter.commitGroupingAtStoreBoundary(plan, ticket).commit.ok).toBe(true);
  });

  it("returns a structured preview failure while the shared mutex is busy", () => {
    const current = initialLayout();
    const { plan } = prepare(modules, current, "preview-during-apply");
    const lock = modules.runtime.tryBeginGroupingOperation("commit");
    expect(lock).not.toBeNull();
    if (!lock) return;

    try {
      let preview: ReturnType<typeof modules.adapter.prepareGroupingAtStoreBoundary> | undefined;
      expect(() => {
        preview = modules.adapter.prepareGroupingAtStoreBoundary(
          plan,
          contextFor(current, "preview-during-apply"),
        );
      }).not.toThrow();
      expect(preview).toMatchObject({
        ok: false,
        kind: "operation_in_progress",
        stale: [],
        errors: [expect.stringMatching(/operation/i)],
      });
    } finally {
      modules.runtime.endGroupingOperation(lock);
    }
  });

  it("returns a structured preview failure when preview re-enters an active transition", () => {
    const current = initialLayout();
    const { plan, ticket } = prepare(modules, current, "preview-reentrant-transition");
    let preview: ReturnType<typeof modules.adapter.prepareGroupingAtStoreBoundary> | undefined;
    let reentered = false;
    const unsubscribe = modules.runtime.useGroupingRuntimeStore.subscribe((state, previous) => {
      if (reentered
        || previous.transitionDepth !== 0
        || state.transitionDepth !== 1
        || state.operation?.kind !== "commit") return;
      reentered = true;
      preview = modules.adapter.prepareGroupingAtStoreBoundary(
        plan,
        contextFor(current, "preview-reentrant-transition"),
      );
    });

    let committed: ReturnType<typeof modules.adapter.commitGroupingAtStoreBoundary> | undefined;
    try {
      committed = modules.adapter.commitGroupingAtStoreBoundary(plan, ticket);
    } finally {
      unsubscribe();
    }

    expect(committed?.commit.ok).toBe(true);
    expect(reentered).toBe(true);
    expect(preview).toMatchObject({
      ok: false,
      kind: "operation_in_progress",
      stale: [],
      errors: [expect.stringMatching(/operation/i)],
    });
  });

  it("marks an unknown prepare exception with an explicit failure kind", () => {
    const current = initialLayout();
    const { plan } = prepare(modules, current, "unexpected-prepare-error");
    const context = contextFor(current, "unexpected-prepare-error");
    context.newWorkspaceDefaults = {
      "group-a": { color: {} as string },
    };

    expect(modules.adapter.prepareGroupingAtStoreBoundary(plan, context)).toMatchObject({
      ok: false,
      kind: "unexpected_error",
      stale: [],
      errors: [expect.stringMatching(/toLowerCase|color/i)],
    });
  });

  it("consumes the exact ticket when schema preflight rejects it", () => {
    const current = initialLayout();
    const { plan, ticket } = prepare(modules, current, "schema-preflight-consumes");
    const before = modules.adapter.getGroupingStoreAdapter().getGroupingState();
    const revisionBefore = modules.workspaceStore.useWorkspaceListStore.getState().layoutRevision;
    const mutableTicket = structuredClone(ticket) as unknown as { schemaVersion: number } & typeof ticket;
    mutableTicket.schemaVersion = 999;

    expect(modules.adapter.commitGroupingAtStoreBoundary(plan, mutableTicket).commit).toMatchObject({
      ok: false,
      kind: "schema_incompatible",
    });
    mutableTicket.schemaVersion = 1;
    expect(modules.adapter.commitGroupingAtStoreBoundary(plan, mutableTicket).commit).toMatchObject({
      ok: false,
      kind: "invalid_input",
    });
    expect(modules.adapter.getGroupingStoreAdapter().getGroupingState()).toEqual(before);
    expect(modules.workspaceStore.useWorkspaceListStore.getState().layoutRevision).toBe(revisionBefore);
    expect(modules.runtime.groupingUndoRepository.get()).toBeNull();
  });

  it("consumes the exact ticket when no-op preflight rejects it", () => {
    const current = initialLayout();
    const { plan, ticket } = prepare(modules, current, "noop-preflight-consumes");
    const before = modules.adapter.getGroupingStoreAdapter().getGroupingState();
    const revisionBefore = modules.workspaceStore.useWorkspaceListStore.getState().layoutRevision;
    const mutableTicket = structuredClone(ticket);
    const movedTabIds = mutableTicket.transaction.expected.movedTabIds;
    const originalMovedTabIds = [...movedTabIds];
    movedTabIds.length = 0;

    expect(modules.adapter.commitGroupingAtStoreBoundary(plan, mutableTicket).commit).toMatchObject({
      ok: false,
      kind: "invalid_input",
    });
    movedTabIds.push(...originalMovedTabIds);
    expect(modules.adapter.commitGroupingAtStoreBoundary(plan, mutableTicket).commit).toMatchObject({
      ok: false,
      kind: "invalid_input",
    });
    expect(modules.adapter.getGroupingStoreAdapter().getGroupingState()).toEqual(before);
    expect(modules.workspaceStore.useWorkspaceListStore.getState().layoutRevision).toBe(revisionBefore);
    expect(modules.runtime.groupingUndoRepository.get()).toBeNull();
  });

  it("rejects undo while apply owns the shared mutex without restoring", () => {
    const current = initialLayout();
    const { plan, ticket } = prepare(modules, current, "undo-during-apply");
    const intercepted = interceptRestoreCalls(modules);
    expect(modules.adapter.commitGroupingAtStoreBoundary(plan, ticket).commit.ok).toBe(true);
    const callsBeforeUndo = intercepted.calls.length;
    const lock = modules.runtime.tryBeginGroupingOperation("commit");
    expect(lock).not.toBeNull();
    if (!lock) return;

    expect(modules.adapter.undoGroupingAtStoreBoundary()).toMatchObject({
      ok: false,
      kind: "operation_in_progress",
    });
    expect(intercepted.calls).toHaveLength(callsBeforeUndo);
    modules.runtime.endGroupingOperation(lock);
    expect(modules.adapter.undoGroupingAtStoreBoundary()).toEqual({ ok: true });
  });

  it("restores both stores in one logical transition while deferring side effects", () => {
    const adapter = modules.adapter.getGroupingStoreAdapter();
    const snapshot: GroupingStateSnapshot = {
      schemaVersion: 1,
      workspaces: initialLayout().map((item, index) => index === 0 ? { ...item, name: "復元後" } : item),
      selection: {
        activeWorkspaceId: "ws-b",
        activeSessionId: "session-t3",
        lastActivePaneByWorkspace: { "ws-b": "session-t3" },
      },
    };
    let listNotifications = 0;
    let uiNotifications = 0;
    let sideEffects = 0;
    let sideEffectDeferred = false;
    const scheduleSideEffect = () => {
      try {
        modules.runtime.assertSideEffectAllowed("test-side-effect");
        sideEffects += 1;
      } catch {
        sideEffectDeferred = true;
      }
    };
    const unsubscribeList = modules.workspaceStore.useWorkspaceListStore.subscribe(() => {
      listNotifications += 1;
      scheduleSideEffect();
    });
    const unsubscribeUi = modules.uiStore.useUiStore.subscribe(() => {
      uiNotifications += 1;
      scheduleSideEffect();
    });
    const unsubscribeTransition = modules.runtime.useGroupingRuntimeStore.subscribe((state, previous) => {
      if (state.transitionDepth !== 0 || previous.transitionDepth <= 0 || !sideEffectDeferred) return;
      modules.runtime.assertSideEffectAllowed("test-side-effect");
      sideEffects += 1;
      sideEffectDeferred = false;
    });
    const epochBefore = modules.runtime.useGroupingRuntimeStore.getState().transitionEpoch;
    const revisionBefore = modules.workspaceStore.useWorkspaceListStore.getState().layoutRevision;
    const focusRevisionBefore = modules.uiStore.useUiStore.getState().focusRevision;

    adapter.restoreGroupingState(snapshot);
    unsubscribeList();
    unsubscribeUi();
    unsubscribeTransition();

    expect(listNotifications).toBeGreaterThan(0);
    expect(uiNotifications).toBeGreaterThan(0);
    expect(sideEffects).toBe(1);
    expect(sideEffectDeferred).toBe(false);
    expect(adapter.getGroupingState()).toEqual(snapshot);
    expect(modules.workspaceStore.useWorkspaceListStore.getState().layoutRevision).toBe(revisionBefore + 1);
    expect(modules.uiStore.useUiStore.getState().focusRevision).toBe(focusRevisionBefore);
    expect(modules.runtime.useGroupingRuntimeStore.getState()).toMatchObject({
      transitionDepth: 0,
      transitionEpoch: epochBefore + 1,
      transitionSource: null,
    });
  });

  it("restores a null active session while retaining last active and focusRevision", () => {
    const adapter = modules.adapter.getGroupingStoreAdapter();
    const snapshot = adapter.getGroupingState();
    snapshot.selection.activeSessionId = null;
    const focusRevision = modules.uiStore.useUiStore.getState().focusRevision;

    adapter.restoreGroupingState(snapshot);

    expect(adapter.getGroupingState()).toEqual(snapshot);
    expect(modules.uiStore.useUiStore.getState()).toMatchObject({
      activePaneId: null,
      lastActivePaneId: "session-t1",
      focusRevision,
    });
  });

  it("rolls back to active null without promoting the remembered pane", () => {
    const current = initialLayout();
    modules.uiStore.useUiStore.setState({
      activePaneId: null,
      lastActivePaneId: "session-t1",
    });
    const focusRevision = modules.uiStore.useUiStore.getState().focusRevision;
    const focusIntents: Array<{ activeSessionId: string | null }> = [];
    const unsubscribeFocus = modules.runtime.subscribeGroupingFocusIntents((intent) => {
      focusIntents.push(intent);
    });
    const { plan, ticket } = prepare(modules, current, "rollback-null-active");
    const workspaceStore = modules.workspaceStore.useWorkspaceListStore;
    const originalRestore = workspaceStore.getState()._restoreGroupingLayout;
    let commitCalls = 0;
    workspaceStore.setState({
      _restoreGroupingLayout: (workspaces, selection, source, capability) => {
        const next = structuredClone(workspaces);
        if (source === "grouping-commit" && commitCalls++ === 0) {
          next[0].name = "force-rollback";
        }
        originalRestore(next, selection, source, capability);
      },
    });

    expect(modules.adapter.commitGroupingAtStoreBoundary(plan, ticket).commit).toMatchObject({
      ok: false,
      kind: "commit_mismatch",
    });
    expect(modules.uiStore.useUiStore.getState()).toMatchObject({
      activePaneId: null,
      lastActivePaneId: "session-t1",
      focusRevision,
    });
    expect(modules.adapter.getGroupingStoreAdapter().getSelection().activeSessionId).toBeNull();
    expect(focusIntents).toEqual([expect.objectContaining({ activeSessionId: null })]);
    expect(modules.engine.persistentLayoutProjection(
      modules.workspaceStore.useWorkspaceListStore.getState().workspaces,
    )).toEqual(modules.engine.persistentLayoutProjection(current));
    unsubscribeFocus();
  });

  it("releases transition depth and operation ownership when restore throws", () => {
    const current = initialLayout();
    const { plan, ticket } = prepare(modules, current, "restore-throws-release");
    const workspaceStore = modules.workspaceStore.useWorkspaceListStore;
    const originalRestore = workspaceStore.getState()._restoreGroupingLayout;
    let restoreCalls = 0;
    workspaceStore.setState({
      _restoreGroupingLayout: (workspaces, selection, source) => {
        restoreCalls += 1;
        const next = structuredClone(workspaces);
        if (restoreCalls === 1) next[0].name = "force-rollback";
        originalRestore(next, selection, source);
      },
    });
    const uiSet = vi.spyOn(modules.uiStore.useUiStore, "setState")
      .mockImplementation(() => { throw new Error("restore exploded"); });

    const result = modules.adapter.commitGroupingAtStoreBoundary(plan, ticket);
    uiSet.mockRestore();

    expect(result.commit).toMatchObject({ ok: false, kind: "rollback_failed" });
    expect(modules.runtime.useGroupingRuntimeStore.getState()).toMatchObject({
      transitionDepth: 0,
      transitionSource: null,
      operation: null,
      poisoned: true,
    });
  });

  it("still publishes poison when rollback restoration fails projection validation", () => {
    const current = initialLayout();
    const { plan, ticket } = prepare(modules, current, "diagnostic-signature-failure");
    const workspaceStore = modules.workspaceStore.useWorkspaceListStore;
    const originalRestore = workspaceStore.getState()._restoreGroupingLayout;
    let restoreCalls = 0;
    workspaceStore.setState({
      _restoreGroupingLayout: (workspaces, selection, source) => {
        restoreCalls += 1;
        const next = structuredClone(workspaces);
        if (restoreCalls === 1) {
          next[0].name = "force-rollback";
        } else {
          next[0].createdAt = Number.NaN;
        }
        originalRestore(next, selection, source);
      },
    });

    expect(modules.adapter.commitGroupingAtStoreBoundary(plan, ticket).commit).toMatchObject({
      ok: false,
      kind: "rollback_failed",
    });
    expect(modules.runtime.useGroupingRuntimeStore.getState()).toMatchObject({
      poisoned: true,
      operation: null,
      diagnostic: {
        code: "rollback_failed",
        operation: "commit",
        actualSignature: expect.any(String),
      },
    });
  });

  it("releases the mutex when undo prework throws before a transition starts", () => {
    const getUndo = vi.spyOn(modules.runtime.groupingUndoRepository, "get")
      .mockImplementation(() => { throw new Error("undo repository exploded"); });

    expect(modules.adapter.undoGroupingAtStoreBoundary()).toEqual({
      ok: false,
      kind: "unexpected_error",
      reason: "undo repository exploded",
    });
    getUndo.mockRestore();

    expect(modules.runtime.useGroupingRuntimeStore.getState()).toMatchObject({
      operation: null,
      transitionDepth: 0,
      transitionSource: null,
      poisoned: false,
    });
  });

  it("distinguishes a post-undo cleanup failure after the layout was reverted", () => {
    const current = initialLayout();
    const { plan, ticket } = prepare(modules, current, "post-undo-cleanup-failure");
    expect(modules.adapter.commitGroupingAtStoreBoundary(plan, ticket).commit.ok).toBe(true);
    const expected = modules.engine.persistentLayoutProjection(current);
    const unsubscribe = modules.runtime.useGroupingRuntimeStore.subscribe((state, previous) => {
      if (previous.operation?.kind === "undo" && state.operation === null) {
        throw new Error("undo cleanup exploded");
      }
    });

    const result = modules.adapter.undoGroupingAtStoreBoundary();
    unsubscribe();

    expect(result).toEqual({
      ok: false,
      kind: "post_undo_failed",
      layoutReverted: true,
      persistenceRequested: false,
      reason: "undo cleanup exploded",
    });
    expect(modules.engine.persistentLayoutProjection(
      modules.workspaceStore.useWorkspaceListStore.getState().workspaces,
    )).toEqual(expected);
    expect(modules.runtime.useGroupingRuntimeStore.getState()).toMatchObject({
      operation: null,
      undo: null,
      poisoned: false,
    });
  });

  it("returns an invalid_layout failure when undo validation sees a non-finite layout", () => {
    const current = initialLayout();
    modules.runtime.groupingUndoRepository.set({
      recordId: "test-non-finite-undo",
      schemaVersion: 1,
      snapshot: modules.adapter.getGroupingStoreAdapter().getGroupingState(),
      expectedStructuralSignature: modules.engine.structuralUndoSignature(current),
      committedLayoutRevision: 0,
      createdAt: NOW,
      status: "available",
      expireReason: null,
    });
    const poisoned = structuredClone(current);
    poisoned[0].createdAt = Number.NEGATIVE_INFINITY;
    modules.workspaceStore.useWorkspaceListStore.setState({ workspaces: poisoned });

    expect(modules.adapter.undoGroupingAtStoreBoundary()).toMatchObject({
      ok: false,
      kind: "invalid_layout",
      reason: expect.stringMatching(/non-finite persistent number/i),
    });
    expect(modules.runtime.useGroupingRuntimeStore.getState()).toMatchObject({
      operation: null,
      transitionDepth: 0,
      poisoned: false,
    });
  });

  it("commits one layout replacement, one selection update, one revision, and one undo record", () => {
    const current = initialLayout();
    const { plan, ticket } = prepare(modules, current, "normal-commit");
    const intercepted = interceptRestoreCalls(modules);
    const uiSet = vi.spyOn(modules.uiStore.useUiStore, "setState");
    const revisionBefore = modules.workspaceStore.useWorkspaceListStore.getState().layoutRevision;

    const result = modules.adapter.commitGroupingAtStoreBoundary(plan, ticket);

    expect(result.commit.ok).toBe(true);
    expect(intercepted.calls).toHaveLength(2);
    expect(modules.engine.persistentLayoutProjection(intercepted.calls[0][0])).toEqual(
      modules.engine.persistentLayoutProjection(ticket.transaction.workspaces),
    );
    expect(intercepted.calls[0][1].activeWorkspaceId).toBe("ws-a");
    expect(modules.engine.persistentLayoutProjection(intercepted.calls[1][0])).toEqual(
      modules.engine.persistentLayoutProjection(ticket.transaction.workspaces),
    );
    if (result.commit.ok) {
      expect(intercepted.calls[1][1].activeWorkspaceId).toBe(result.commit.transaction.expected.focusWorkspaceId);
    }
    expect(uiSet).toHaveBeenCalledTimes(1);
    expect(modules.workspaceStore.useWorkspaceListStore.getState().layoutRevision).toBe(revisionBefore + 1);
    expect(modules.runtime.useGroupingRuntimeStore.getState().undo).toMatchObject({
      schemaVersion: 1,
      status: "available",
      committedLayoutRevision: revisionBefore + 1,
    });
  });

  it("stores a deeply frozen undo record and returns a defensive clone", () => {
    const input = {
      recordId: "undo-defensive-copy",
      schemaVersion: 1,
      snapshot: modules.adapter.getGroupingStoreAdapter().getGroupingState(),
      expectedStructuralSignature: modules.engine.structuralUndoSignature(initialLayout()),
      committedLayoutRevision: 0,
      createdAt: NOW,
      status: "available",
      expireReason: null,
    } as unknown as Parameters<typeof modules.runtime.groupingUndoRepository.set>[0] & { recordId: string };
    modules.runtime.groupingUndoRepository.set(input);

    const internal = modules.runtime.useGroupingRuntimeStore.getState().undo;
    expectDeepFrozen(internal);
    input.snapshot.workspaces[0].name = "mutated-input";
    const publicCopy = modules.runtime.groupingUndoRepository.get();
    expect(publicCopy?.snapshot.workspaces[0].name).toBe("母艦");
    if (!publicCopy) return;
    publicCopy.snapshot.workspaces[0].panes[0].tabs[0].sessionId = "duplicate-session";
    expect(modules.runtime.groupingUndoRepository.get()?.snapshot.workspaces[0].panes[0].tabs[0].sessionId)
      .toBe("session-t1");
  });

  it("preserves the exact Apply A undo after Apply B fails in post-commit processing", () => {
    const initial = initialLayout();
    const first = prepare(modules, initial, "preserve-undo-a");
    expect(modules.adapter.commitGroupingAtStoreBoundary(first.plan, first.ticket).commit.ok).toBe(true);
    const layoutAfterA = structuredClone(modules.workspaceStore.useWorkspaceListStore.getState().workspaces);
    const undoA = modules.runtime.groupingUndoRepository.get();
    expect(undoA).not.toBeNull();
    if (!undoA) return;

    const secondPlan = planFor(modules);
    secondPlan.planId = "plan-preserve-undo-b";
    secondPlan.groups[0] = {
      ...secondPlan.groups[0],
      title: "案件乙",
      destination: { kind: "new_workspace", proposedName: "案件乙" },
    };
    const second = prepare(modules, layoutAfterA, "preserve-undo-b", secondPlan);
    let injected = false;
    const unsubscribe = modules.runtime.useGroupingRuntimeStore.subscribe((state, previous) => {
      if (!injected && previous.transitionDepth === 1 && state.transitionDepth === 0) {
        injected = true;
        modules.runtime.recordPersistentSchemaState({ loadedSchemaVersion: 999, migrationComplete: false });
      }
    });
    const result = modules.adapter.commitGroupingAtStoreBoundary(second.plan, second.ticket);
    unsubscribe();
    modules.runtime.recordPersistentSchemaState({ loadedSchemaVersion: 1, migrationComplete: true });

    expect(result.commit).toMatchObject({ ok: false, kind: "schema_incompatible" });
    expect(modules.engine.persistentLayoutProjection(
      modules.workspaceStore.useWorkspaceListStore.getState().workspaces,
    )).toEqual(modules.engine.persistentLayoutProjection(layoutAfterA));
    const preserved = modules.runtime.groupingUndoRepository.get();
    expect(preserved).toEqual(undoA);
    expect(preserved).toHaveProperty("recordId");
    expect((preserved as typeof preserved & { recordId: string }).recordId)
      .toBe((undoA as typeof undoA & { recordId: string }).recordId);
    expect(modules.engine.hasGroupingUndo(modules.adapter.getGroupingStoreAdapter())).toBe(true);
    expect(modules.adapter.undoGroupingAtStoreBoundary()).toEqual({ ok: true });
    expect(modules.engine.persistentLayoutProjection(
      modules.workspaceStore.useWorkspaceListStore.getState().workspaces,
    )).toEqual(modules.engine.persistentLayoutProjection(initial));
  });

  it("restores Apply A undo when publishing Apply B undo throws, then expires it on a real change", () => {
    const initial = initialLayout();
    const first = prepare(modules, initial, "undo-subscriber-a");
    expect(modules.adapter.commitGroupingAtStoreBoundary(first.plan, first.ticket).commit.ok).toBe(true);
    const layoutAfterA = structuredClone(modules.workspaceStore.useWorkspaceListStore.getState().workspaces);
    const layoutAfterASignature = modules.engine.structuralUndoSignature(layoutAfterA);
    const undoA = modules.runtime.groupingUndoRepository.get();
    expect(undoA).not.toBeNull();
    if (!undoA) return;

    const secondPlan = planFor(modules);
    secondPlan.planId = "plan-undo-subscriber-b";
    secondPlan.groups[0] = {
      ...secondPlan.groups[0],
      title: "案件乙",
      destination: { kind: "new_workspace", proposedName: "案件乙" },
    };
    const second = prepare(modules, layoutAfterA, "undo-subscriber-b", secondPlan);
    let threw = false;
    const unsubscribe = modules.runtime.useGroupingRuntimeStore.subscribe((state, previous) => {
      if (threw || state.undo === previous.undo || state.undo?.status !== "available") return;
      if (modules.engine.structuralUndoSignature(state.undo.snapshot.workspaces) === layoutAfterASignature) {
        threw = true;
        throw new Error("undo subscriber rejected Apply B");
      }
    });
    const result = modules.adapter.commitGroupingAtStoreBoundary(second.plan, second.ticket);
    unsubscribe();

    expect(threw).toBe(true);
    expect(result.commit.ok).toBe(false);
    expect(modules.engine.persistentLayoutProjection(
      modules.workspaceStore.useWorkspaceListStore.getState().workspaces,
    )).toEqual(modules.engine.persistentLayoutProjection(layoutAfterA));
    expect(modules.runtime.groupingUndoRepository.get()).toEqual(undoA);

    modules.workspaceStore.useWorkspaceListStore.getState().renameWorkspace("ws-a", "external-change");
    const expired = modules.runtime.groupingUndoRepository.get();
    expect(expired).toMatchObject({
      recordId: (undoA as typeof undoA & { recordId: string }).recordId,
      status: "expired",
      expireReason: EXPIRED_REASON,
    });
  });

  it("poisons the runtime boundary when undo restoration cannot be verified", () => {
    const current = initialLayout();
    const { plan, ticket } = prepare(modules, current, "undo-runtime-poison");
    const later = prepare(modules, current, "undo-runtime-poison-later");
    expect(modules.adapter.commitGroupingAtStoreBoundary(plan, ticket).commit.ok).toBe(true);
    const secondAdapter = modules.adapter.getGroupingStoreAdapter();
    const workspaceStore = modules.workspaceStore.useWorkspaceListStore;
    const originalRestore = workspaceStore.getState()._restoreGroupingLayout;
    workspaceStore.setState({
      _restoreGroupingLayout: (workspaces, selection, source) => {
        const next = structuredClone(workspaces);
        next[0].name = "undo-restore-corrupt";
        originalRestore(next, selection, source);
      },
    });

    expect(modules.adapter.undoGroupingAtStoreBoundary()).toMatchObject({
      ok: false,
      kind: "restore_failed",
    });
    expect(modules.runtime.useGroupingRuntimeStore.getState()).toMatchObject({
      poisoned: true,
      operation: null,
      undo: null,
      diagnostic: { code: "rollback_failed", operation: "undo", layoutRevision: expect.any(Number) },
    });
    expect(() => secondAdapter.getWorkspaces()).toThrow(/poison/i);
    expect(modules.adapter.commitGroupingAtStoreBoundary(plan, later.ticket).commit).toMatchObject({
      ok: false,
      kind: "boundary_poisoned",
    });
    expect(modules.adapter.commitGroupingAtStoreBoundary(plan, later.ticket).commit).toMatchObject({
      ok: false,
      kind: "boundary_poisoned",
    });
    expect(modules.adapter.undoGroupingAtStoreBoundary()).toMatchObject({
      ok: false,
      kind: "boundary_poisoned",
    });
  });

  it("keeps one boundary token across adapters and cannot bypass poison with another adapter", () => {
    const first = modules.adapter.getGroupingStoreAdapter();
    const second = modules.adapter.getGroupingStoreAdapter();
    expect(first).not.toBe(second);
    expect(first.boundaryToken).toBe(second.boundaryToken);
    modules.runtime.poisonGroupingBoundary({
      code: "rollback_failed",
      occurredAt: NOW,
      layoutRevision: modules.workspaceStore.useWorkspaceListStore.getState().layoutRevision,
      operation: "rollback",
      errors: ["forced poison"],
    });

    expect(() => first.getWorkspaces()).toThrow(/poison/i);
    expect(() => second.getSelection()).toThrow(/poison/i);
    expect(modules.runtime.tryBeginGroupingOperation("commit")).toBeNull();
    expect(modules.runtime.tryBeginGroupingOperation("undo")).toBeNull();
  });
});

describe("Gate 2C persistence and schema boundary", () => {
  it("rejects a no-op commit so every successful commit can produce a revisioned undo", () => {
    const current = initialLayout();
    const plan = planFor(modules);
    plan.groups = [{
      ...plan.groups[0],
      disposition: "keep",
      destination: { kind: "current_locations" },
      layout: null,
      tabIds: ["t1", "t2", "t3"],
    }];
    const prepared = prepare(modules, current, "no-op-commit", plan);
    const revisionBefore = modules.workspaceStore.useWorkspaceListStore.getState().layoutRevision;

    expect(modules.adapter.commitGroupingAtStoreBoundary(plan, prepared.ticket)).toMatchObject({
      commit: { ok: false, kind: "invalid_input" },
      durability: "idle",
    });
    expect(modules.workspaceStore.useWorkspaceListStore.getState().layoutRevision).toBe(revisionBefore);
    expect(modules.runtime.useGroupingRuntimeStore.getState().undo).toBeNull();
  });

  it("rejects preview, commit, and undo for an unknown schema without store mutation or persistence", () => {
    const current = initialLayout();
    const { plan, ticket } = prepare(modules, current, "unknown-schema");
    const workspaceBefore = modules.engine.persistentLayoutProjection(
      modules.workspaceStore.useWorkspaceListStore.getState().workspaces,
    );
    const revisionBefore = modules.workspaceStore.useWorkspaceListStore.getState().layoutRevision;
    const selectionBefore = modules.adapter.getGroupingStoreAdapter().getSelection();
    modules.runtime.recordPersistentSchemaState({
      loadedSchemaVersion: 999,
      migrationComplete: false,
    });
    const restore = vi.spyOn(
      modules.workspaceStore.useWorkspaceListStore.getState(),
      "_restoreGroupingLayout",
    );
    const uiSet = vi.spyOn(modules.uiStore.useUiStore, "setState");
    const persist = vi.fn(async (request) => ({
      status: "saved" as const,
      requestId: request.requestId,
      savedRevision: request.revision,
      savedSignature: request.signature,
      savedDigest: request.snapshotDigest,
      leaderGeneration: request.leaderGeneration,
    }));
    const unregister = modules.persistence.registerPersistenceLeader({ windowId: "main", persist });

    expect(modules.adapter.prepareGroupingAtStoreBoundary(plan, contextFor(current, "schema-preview"))).toMatchObject({
      ok: false,
      kind: "schema_incompatible",
    });
    expect(modules.adapter.commitGroupingAtStoreBoundary(plan, ticket)).toMatchObject({
      commit: { ok: false, kind: "schema_incompatible" },
    });
    expect(modules.adapter.undoGroupingAtStoreBoundary()).toMatchObject({
      ok: false,
      kind: "schema_incompatible",
    });

    modules.runtime.recordPersistentSchemaState({
      loadedSchemaVersion: 1,
      migrationComplete: true,
    });
    const invalidTicket = {
      ...ticket,
      schemaVersion: 999,
    } as unknown as typeof ticket;
    expect(modules.adapter.commitGroupingAtStoreBoundary(plan, invalidTicket)).toMatchObject({
      commit: { ok: false, kind: "invalid_input" },
    });
    const missingTicket = { ...ticket } as Partial<typeof ticket>;
    delete missingTicket.schemaVersion;
    expect(modules.adapter.commitGroupingAtStoreBoundary(plan, missingTicket as typeof ticket)).toMatchObject({
      commit: { ok: false, kind: "invalid_input" },
    });
    const snapshot = modules.adapter.getGroupingStoreAdapter().getGroupingState();
    modules.runtime.groupingUndoRepository.set({
      schemaVersion: 999,
      snapshot: {
        ...modules.adapter.getGroupingStoreAdapter().getGroupingState(),
        schemaVersion: 999,
      },
      expectedStructuralSignature: modules.engine.structuralUndoSignature(current),
      committedLayoutRevision: 0,
      createdAt: NOW,
      status: "available",
      expireReason: null,
    } as unknown as Parameters<typeof modules.runtime.groupingUndoRepository.set>[0]);
    expect(modules.adapter.undoGroupingAtStoreBoundary()).toMatchObject({
      ok: false,
      kind: "schema_incompatible",
    });
    modules.runtime.groupingUndoRepository.set({
      schemaVersion: 1,
      snapshot: { ...snapshot, schemaVersion: undefined },
      expectedStructuralSignature: modules.engine.structuralUndoSignature(current),
      committedLayoutRevision: 0,
      createdAt: NOW,
      status: "available",
      expireReason: null,
    } as unknown as Parameters<typeof modules.runtime.groupingUndoRepository.set>[0]);
    expect(modules.adapter.undoGroupingAtStoreBoundary()).toMatchObject({
      ok: false,
      kind: "schema_incompatible",
    });
    modules.runtime.groupingUndoRepository.set({
      schemaVersion: undefined,
      snapshot,
      expectedStructuralSignature: modules.engine.structuralUndoSignature(current),
      committedLayoutRevision: 0,
      createdAt: NOW,
      status: "available",
      expireReason: null,
    } as unknown as Parameters<typeof modules.runtime.groupingUndoRepository.set>[0]);
    expect(modules.adapter.undoGroupingAtStoreBoundary()).toMatchObject({
      ok: false,
      kind: "schema_incompatible",
    });
    expect(restore).not.toHaveBeenCalled();
    expect(uiSet).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(modules.engine.persistentLayoutProjection(modules.workspaceStore.useWorkspaceListStore.getState().workspaces))
      .toEqual(workspaceBefore);
    expect(modules.workspaceStore.useWorkspaceListStore.getState().layoutRevision).toBe(revisionBefore);
    expect(modules.adapter.getGroupingStoreAdapter().getSelection()).toEqual(selectionBefore);
    expect(modules.runtime.useGroupingRuntimeStore.getState()).toMatchObject({
      operation: null,
      durability: { status: "idle" },
    });
    unregister();
  });

  it("includes a monotonic schema epoch in OCC and rejects an ABA change before persistence", () => {
    const current = initialLayout();
    const { plan, ticket } = prepare(modules, current, "schema-epoch-aba");
    const epoch = modules.runtime.useGroupingRuntimeStore.getState().persistentSchema.schemaEpoch;
    expect(ticket.schemaEpoch).toBe(epoch);
    modules.runtime.recordPersistentSchemaState({ loadedSchemaVersion: 999, migrationComplete: false });
    modules.runtime.recordPersistentSchemaState({ loadedSchemaVersion: 1, migrationComplete: true });
    expect(modules.runtime.useGroupingRuntimeStore.getState().persistentSchema.schemaEpoch).toBe(epoch + 2);

    const persist = vi.fn();
    modules.persistence.registerPersistenceLeader({ windowId: "main", persist });
    expect(modules.adapter.commitGroupingAtStoreBoundary(plan, ticket)).toMatchObject({
      commit: { ok: false, kind: "schema_incompatible" },
    });
    expect(persist).not.toHaveBeenCalled();
  });

  it.each(["acquire", "enter"] as const)(
    "rejects a schema ABA injected by the %s notification before engine mutation",
    (phase) => {
      const current = initialLayout();
      const { plan, ticket } = prepare(modules, current, `schema-${phase}`);
      const before = modules.engine.persistentLayoutProjection(current);
      const persist = vi.fn();
      modules.persistence.registerPersistenceLeader({ windowId: "main", persist });
      let injected = false;
      const unsubscribe = modules.runtime.useGroupingRuntimeStore.subscribe((state, previous) => {
        const hit = phase === "acquire"
          ? previous.operation === null && state.operation?.kind === "commit"
          : previous.transitionDepth === 0 && state.transitionDepth === 1;
        if (!injected && hit) {
          injected = true;
          modules.runtime.recordPersistentSchemaState({ loadedSchemaVersion: 999, migrationComplete: false });
          modules.runtime.recordPersistentSchemaState({ loadedSchemaVersion: 1, migrationComplete: true });
        }
      });
      const result = modules.adapter.commitGroupingAtStoreBoundary(plan, ticket);
      unsubscribe();
      expect(result).toMatchObject({ commit: { ok: false, kind: "schema_incompatible" } });
      expect(modules.engine.persistentLayoutProjection(
        modules.workspaceStore.useWorkspaceListStore.getState().workspaces,
      )).toEqual(before);
      expect(modules.runtime.useGroupingRuntimeStore.getState().operation).toBeNull();
      expect(persist).not.toHaveBeenCalled();
    },
  );

  it("rolls back a schema change injected by the transition exit notification and does not persist", () => {
    const current = initialLayout();
    const { plan, ticket } = prepare(modules, current, "schema-exit");
    const before = modules.engine.persistentLayoutProjection(current);
    const selectionBefore = modules.adapter.getGroupingStoreAdapter().getSelection();
    const persist = vi.fn();
    modules.persistence.registerPersistenceLeader({ windowId: "main", persist });
    let injected = false;
    const unsubscribe = modules.runtime.useGroupingRuntimeStore.subscribe((state, previous) => {
      if (!injected && previous.transitionDepth === 1 && state.transitionDepth === 0) {
        injected = true;
        modules.runtime.recordPersistentSchemaState({ loadedSchemaVersion: 999, migrationComplete: false });
      }
    });
    const result = modules.adapter.commitGroupingAtStoreBoundary(plan, ticket);
    unsubscribe();

    expect(result).toMatchObject({ commit: { ok: false, kind: "schema_incompatible" } });
    expect(modules.engine.persistentLayoutProjection(
      modules.workspaceStore.useWorkspaceListStore.getState().workspaces,
    )).toEqual(before);
    expect(modules.adapter.getGroupingStoreAdapter().getSelection()).toEqual(selectionBefore);
    expect(modules.runtime.useGroupingRuntimeStore.getState()).toMatchObject({
      operation: null,
      poisoned: false,
      undo: null,
    });
    expect(persist).not.toHaveBeenCalled();
  });

  it("poisons the boundary when a post-commit schema rollback cannot be restored", () => {
    const current = initialLayout();
    const { plan, ticket } = prepare(modules, current, "schema-exit-rollback-failure");
    const persist = vi.fn();
    modules.persistence.registerPersistenceLeader({ windowId: "main", persist });
    const workspaceStore = modules.workspaceStore.useWorkspaceListStore;
    const originalRestore = workspaceStore.getState()._restoreGroupingLayout;
    workspaceStore.setState({
      _restoreGroupingLayout: (workspaces, selection, source, capability) => {
        if (source === "grouping-rollback") throw new Error("forced schema rollback failure");
        originalRestore(workspaces, selection, source, capability);
      },
    });
    let injected = false;
    const unsubscribe = modules.runtime.useGroupingRuntimeStore.subscribe((state, previous) => {
      if (!injected && previous.transitionDepth === 1 && state.transitionDepth === 0) {
        injected = true;
        modules.runtime.recordPersistentSchemaState({ loadedSchemaVersion: 999, migrationComplete: false });
      }
    });
    const result = modules.adapter.commitGroupingAtStoreBoundary(plan, ticket);
    unsubscribe();

    expect(result).toMatchObject({ commit: { ok: false, kind: "rollback_failed" } });
    expect(modules.runtime.useGroupingRuntimeStore.getState()).toMatchObject({
      operation: null,
      poisoned: true,
      undo: null,
    });
    expect(persist).not.toHaveBeenCalled();
  });

  it("rejects an exit subscriber external mutation even when the subscriber catches it", () => {
    const current = initialLayout();
    const { plan, ticket } = prepare(modules, current, "exit-reentry");
    const before = modules.engine.persistentLayoutProjection(current);
    let attempted = false;
    const unsubscribe = modules.runtime.useGroupingRuntimeStore.subscribe((state, previous) => {
      if (!attempted && previous.transitionDepth === 1 && state.transitionDepth === 0) {
        attempted = true;
        try {
          modules.workspaceStore.useWorkspaceListStore.getState().renameWorkspace("ws-a", "subscriber-leak");
        } catch {
          // The boundary must remember the rejected attempt even if a subscriber catches it.
        }
      }
    });
    const result = modules.adapter.commitGroupingAtStoreBoundary(plan, ticket);
    unsubscribe();

    expect(result.commit.ok).toBe(false);
    expect(modules.engine.persistentLayoutProjection(
      modules.workspaceStore.useWorkspaceListStore.getState().workspaces,
    )).toEqual(before);
  });

  it("detects an exit subscriber direct setState bypass in the post-transition verification", () => {
    const current = initialLayout();
    const { plan, ticket } = prepare(modules, current, "exit-direct-bypass");
    const before = modules.engine.persistentLayoutProjection(current);
    let injected = false;
    const unsubscribe = modules.runtime.useGroupingRuntimeStore.subscribe((state, previous) => {
      if (!injected && previous.transitionDepth === 1 && state.transitionDepth === 0) {
        injected = true;
        const leaked = structuredClone(modules.workspaceStore.useWorkspaceListStore.getState().workspaces);
        leaked[0].name = "direct-set-state-leak";
        modules.workspaceStore.useWorkspaceListStore.setState({ workspaces: leaked });
      }
    });
    const result = modules.adapter.commitGroupingAtStoreBoundary(plan, ticket);
    unsubscribe();

    expect(result).toMatchObject({ commit: { ok: false, kind: "commit_mismatch" } });
    expect(modules.engine.persistentLayoutProjection(
      modules.workspaceStore.useWorkspaceListStore.getState().workspaces,
    )).toEqual(before);
  });

  it("releases the commit mutex when post-transition projection throws", () => {
    const current = initialLayout();
    const { plan, ticket } = prepare(modules, current, "exit-invalid-projection");
    let injected = false;
    const unsubscribe = modules.runtime.useGroupingRuntimeStore.subscribe((state, previous) => {
      if (!injected && previous.transitionDepth === 1 && state.transitionDepth === 0) {
        injected = true;
        const leaked = structuredClone(modules.workspaceStore.useWorkspaceListStore.getState().workspaces);
        leaked[0].createdAt = Number.NaN;
        modules.workspaceStore.useWorkspaceListStore.setState({ workspaces: leaked });
      }
    });

    expect(() => modules.adapter.commitGroupingAtStoreBoundary(plan, ticket)).toThrow(
      /non-finite persistent number/,
    );
    unsubscribe();
    expect(modules.runtime.useGroupingRuntimeStore.getState()).toMatchObject({
      operation: null,
      transitionDepth: 0,
      poisoned: false,
    });
    const next = modules.runtime.tryBeginGroupingOperation("commit");
    expect(next).not.toBeNull();
    if (next) modules.runtime.endGroupingOperation(next);
  });

  it("rejects forged internal mutation credentials while official boundary mutation succeeds", () => {
    const current = initialLayout();
    const { plan, ticket } = prepare(modules, current, "capability-forgery");
    const store = modules.workspaceStore.useWorkspaceListStore.getState();
    const next = structuredClone(current);
    next[0].name = "forged";
    for (const fake of ["grouping-commit", Symbol("grouping-commit"), {}]) {
      expect(() => store._replaceWorkspaces(next, "grouping-commit", fake)).toThrow(/capability|境界/);
      expect(() => store._restoreGroupingLayout(
        next,
        modules.adapter.getGroupingStoreAdapter().getSelection(),
        "grouping-commit",
        fake,
      ))
        .toThrow(/capability|境界/);
    }
    expect(modules.adapter.commitGroupingAtStoreBoundary(plan, ticket).commit.ok).toBe(true);
  });

  it("keeps the verified layout and undo record when persistence fails", async () => {
    const current = initialLayout();
    const beforeProjection = modules.engine.persistentLayoutProjection(current);
    const { plan, ticket } = prepare(modules, current, "save-failure");
    const persist = vi.fn(async (request) => ({
      status: "failed" as const,
      requestId: request.requestId,
      error: "disk unavailable",
      retryScheduled: true,
      failureGeneration: 1,
    }));
    modules.persistence.registerPersistenceLeader({
      windowId: "main",
      persist,
    });

    const result = modules.adapter.commitGroupingAtStoreBoundary(plan, ticket);
    expect(result).toMatchObject({ commit: { ok: true }, durability: "pending" });
    await vi.waitFor(() => expect(modules.runtime.useGroupingRuntimeStore.getState().durability).toMatchObject({
      status: "failed",
      errorCode: "persistence_failed",
      retryScheduled: true,
    }));
    expect(JSON.stringify(modules.runtime.useGroupingRuntimeStore.getState().durability))
      .not.toContain("disk unavailable");
    const committedState = modules.workspaceStore.useWorkspaceListStore.getState();
    expect(persist).toHaveBeenCalledWith({
      requestId: expect.any(String),
      revision: committedState.layoutRevision,
      signature: modules.engine.hashCanonical(
        modules.engine.persistentLayoutProjection(committedState.workspaces),
      ),
      snapshot: modules.engine.persistentLayoutProjection(committedState.workspaces),
      snapshotDigest: modules.engine.hashCanonical(
        modules.engine.persistentLayoutProjection(committedState.workspaces),
      ),
      leaderGeneration: 1,
    });
    expect(modules.engine.persistentLayoutProjection(modules.workspaceStore.useWorkspaceListStore.getState().workspaces))
      .not.toEqual(beforeProjection);
    expect(modules.runtime.useGroupingRuntimeStore.getState().undo).toMatchObject({ status: "available" });
    const revisionBeforeUndo = committedState.layoutRevision;
    expect(modules.adapter.undoGroupingAtStoreBoundary()).toEqual({ ok: true });
    expect(modules.engine.persistentLayoutProjection(modules.workspaceStore.useWorkspaceListStore.getState().workspaces))
      .toEqual(beforeProjection);
    expect(modules.workspaceStore.useWorkspaceListStore.getState().layoutRevision).toBe(revisionBeforeUndo + 1);
    expect(modules.runtime.useGroupingRuntimeStore.getState().undo).toBeNull();
  });

  it("keeps the newest commit pending when an older persist acknowledgement arrives late", async () => {
    const firstLayout = initialLayout();
    const first = prepare(modules, firstLayout, "persist-generation-1");
    const pending: Array<{
      request: {
        requestId: string;
        revision: number;
        signature: Sha256;
        snapshotDigest: Sha256;
        leaderGeneration: number;
      };
      resolve: (outcome: {
        status: "saved";
        requestId: string;
        savedRevision: number;
        savedSignature: Sha256;
        savedDigest: Sha256;
        leaderGeneration: number;
      }) => void;
    }> = [];
    modules.persistence.registerPersistenceLeader({
      windowId: "main",
      persist: vi.fn((request) => new Promise((resolve) => pending.push({ request, resolve }))),
    });

    expect(modules.adapter.commitGroupingAtStoreBoundary(first.plan, first.ticket).commit.ok).toBe(true);
    expect(pending).toHaveLength(1);
    const secondLayout = structuredClone(modules.workspaceStore.useWorkspaceListStore.getState().workspaces);
    const secondPlan = planFor(modules);
    secondPlan.planId = "plan-gate2c-second";
    secondPlan.groups[0].destination = { kind: "new_workspace", proposedName: "案件乙" };
    secondPlan.groups[0].tabIds = ["t2"];
    secondPlan.groups[0].layout = modules.grouping.defaultLayoutForTabs(["t2"], "母艦");
    secondPlan.groups[1].tabIds = ["t1", "t3"];
    const second = prepare(modules, secondLayout, "persist-generation-2", secondPlan);
    const secondCommit = modules.adapter.commitGroupingAtStoreBoundary(second.plan, second.ticket).commit;
    if (!secondCommit.ok) throw new Error(`second commit failed: ${secondCommit.kind} ${secondCommit.errors.join(" / ")}`);
    expect(pending).toHaveLength(1);
    pending[0].resolve({
      status: "saved",
      requestId: pending[0].request.requestId,
      savedRevision: pending[0].request.revision,
      savedSignature: pending[0].request.signature,
      savedDigest: pending[0].request.snapshotDigest,
      leaderGeneration: pending[0].request.leaderGeneration,
    });
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    const secondRequest = pending[1].request;
    await vi.waitFor(() => expect(modules.runtime.useGroupingRuntimeStore.getState().durability).toMatchObject({
      status: "pending",
      requestId: secondRequest.requestId,
      layoutRevision: secondRequest.revision,
      signature: secondRequest.signature,
    }));

    pending[1].resolve({
      status: "saved",
      requestId: secondRequest.requestId,
      savedRevision: secondRequest.revision,
      savedSignature: secondRequest.signature,
      savedDigest: secondRequest.snapshotDigest,
      leaderGeneration: secondRequest.leaderGeneration,
    });
    await vi.waitFor(() => expect(modules.runtime.useGroupingRuntimeStore.getState().durability).toMatchObject({
      status: "saved",
      requestId: secondRequest.requestId,
    }));
  });

  it("records a non-leader immediate persist as deferred without calling sync", async () => {
    const current = initialLayout();
    const { plan, ticket } = prepare(modules, current, "non-leader");
    const sync = vi.fn(async () => null);
    modules.persistence.registerPersistenceLeader({
      windowId: "main",
      persist: modules.persistence.createPersistenceLeaderPersist({
        isLeader: () => false,
        sync,
        failure: () => ({ error: "unused", retryScheduled: false, failureGeneration: 0 }),
      }),
    });

    const result = modules.adapter.commitGroupingAtStoreBoundary(plan, ticket);
    expect(result).toMatchObject({ commit: { ok: true }, durability: "pending" });
    await vi.waitFor(() => expect(modules.runtime.useGroupingRuntimeStore.getState().durability).toMatchObject({
      status: "deferred",
      reason: "not_leader",
    }));
    expect(sync).not.toHaveBeenCalled();
  });

  it("keeps post-Apply terminal metadata while undoing structure and persisting the merged layout", async () => {
    const current = initialLayout();
    const { plan, ticket } = prepare(modules, current, "undo-persist");
    const persist = vi.fn(async (request) => ({
      status: "saved" as const,
      requestId: request.requestId,
      savedRevision: request.revision,
      savedSignature: request.signature,
      savedDigest: request.snapshotDigest,
      leaderGeneration: request.leaderGeneration,
    }));
    const unregister = modules.persistence.registerPersistenceLeader({ windowId: "main", persist });
    expect(modules.adapter.commitGroupingAtStoreBoundary(plan, ticket).commit.ok).toBe(true);
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(modules.runtime.useGroupingRuntimeStore.getState().durability)
      .toMatchObject({ status: "saved" }));
    const liveWorkspaces = structuredClone(modules.workspaceStore.useWorkspaceListStore.getState().workspaces);
    const liveTab = liveWorkspaces
      .flatMap((item) => item.panes.flatMap((itemPane) => itemPane.tabs))
      .find((itemTab) => itemTab.id === "t1");
    expect(liveTab).toBeDefined();
    if (!liveTab) return;
    liveTab.label = "Apply後のラベル";
    liveTab.cwd = "C:/work/after-apply";
    liveTab.agentSessionId = "agent-session-after-apply";
    modules.workspaceStore.useWorkspaceListStore.setState({ workspaces: liveWorkspaces });
    expect(modules.engine.hasGroupingUndo(modules.adapter.getGroupingStoreAdapter())).toBe(true);
    const revisionBeforeUndo = modules.workspaceStore.useWorkspaceListStore.getState().layoutRevision;
    persist.mockClear();

    expect(modules.adapter.undoGroupingAtStoreBoundary()).toEqual({ ok: true });
    expect(modules.runtime.useGroupingRuntimeStore.getState().undo).toBeNull();
    expect(modules.workspaceStore.useWorkspaceListStore.getState().layoutRevision).toBe(revisionBeforeUndo + 1);
    expect(modules.runtime.useGroupingRuntimeStore.getState().durability).toMatchObject({ status: "pending" });
    expect(persist).toHaveBeenCalledTimes(1);
    const undoRequest = persist.mock.calls[0][0];
    const afterUndo = modules.workspaceStore.useWorkspaceListStore.getState();
    const restoredTab = afterUndo.workspaces
      .flatMap((item) => item.panes.flatMap((itemPane) => itemPane.tabs))
      .find((itemTab) => itemTab.id === "t1");
    expect(modules.engine.structuralUndoSignature(afterUndo.workspaces))
      .toBe(modules.engine.structuralUndoSignature(current));
    expect(restoredTab).toMatchObject({
      label: "Apply後のラベル",
      cwd: "C:/work/after-apply",
      agentSessionId: "agent-session-after-apply",
    });
    expect(undoRequest).toEqual({
      requestId: expect.any(String),
      revision: afterUndo.layoutRevision,
      signature: modules.engine.hashCanonical(modules.engine.persistentLayoutProjection(afterUndo.workspaces)),
      snapshot: modules.engine.persistentLayoutProjection(afterUndo.workspaces),
      snapshotDigest: modules.engine.hashCanonical(modules.engine.persistentLayoutProjection(afterUndo.workspaces)),
      leaderGeneration: 1,
    });
    const persistedTab = undoRequest.snapshot.workspaces
      .flatMap((item) => item.panes.flatMap((itemPane) => itemPane.tabs))
      .find((itemTab) => itemTab.id === "t1");
    expect(persistedTab).toMatchObject({
      label: "Apply後のラベル",
      cwd: "C:/work/after-apply",
      agentSessionId: "agent-session-after-apply",
    });
    await vi.waitFor(() => expect(modules.runtime.useGroupingRuntimeStore.getState().durability).toMatchObject({
      status: "saved",
      requestId: undoRequest.requestId,
      layoutRevision: afterUndo.layoutRevision,
    }));
    unregister();
  });
});
