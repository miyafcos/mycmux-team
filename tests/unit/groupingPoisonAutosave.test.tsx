// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PersistentData } from "../../src/lib/ipc";
import type { Pane, PaneTab, Workspace } from "../../src/types";

const persistenceMocks = vi.hoisted(() => ({
  claimLeader: vi.fn(),
  closeHandler: null as null | ((event: { preventDefault: () => void }) => Promise<void>),
  confirm: vi.fn(),
  getPtyMetadataSnapshot: vi.fn(),
  getWindowFragments: vi.fn(),
  listPets: vi.fn(),
  loadPersistentData: vi.fn(),
  onCloseRequested: vi.fn(),
  quitApp: vi.fn(),
  readAgentSessionMappings: vi.fn(),
  savePersistentData: vi.fn(),
  setAppFrontendVisible: vi.fn(),
  takePendingAdoption: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: persistenceMocks.confirm }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "main",
    onCloseRequested: persistenceMocks.onCloseRequested,
  }),
}));
vi.mock("../../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/ipc")>();
  return {
    ...actual,
    claimLeader: persistenceMocks.claimLeader,
    getPtyMetadataSnapshot: persistenceMocks.getPtyMetadataSnapshot,
    getWindowFragments: persistenceMocks.getWindowFragments,
    listPets: persistenceMocks.listPets,
    loadPersistentData: persistenceMocks.loadPersistentData,
    quitApp: persistenceMocks.quitApp,
    readAgentSessionMappings: persistenceMocks.readAgentSessionMappings,
    savePersistentData: persistenceMocks.savePersistentData,
    setAppFrontendVisible: persistenceMocks.setAppFrontendVisible,
    takePendingAdoption: persistenceMocks.takePendingAdoption,
  };
});

import { useWorkspacePersist } from "../../src/components/layout/SocketListener";
import { loadGroupingInternalsForTests } from "./helpers/groupingTestEntrypoint";
import { defaultLayoutForTabs, type GroupingCompileContext, type GroupingPlan } from "../../src/components/layout/tabGrouping";
import {
  __resetGroupingRuntimeForTests,
  recordPersistentSchemaState,
  useGroupingRuntimeStore,
} from "../../src/stores/groupingRuntimeStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useUiStore } from "../../src/stores/uiStore";
import {
  __resetPersistenceCoordinatorForTests,
  getPersistentSchemaState,
} from "../../src/lib/workspacePersistenceCoordinator";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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

function pane(id: string, tabs: PaneTab[]): Pane {
  return {
    id,
    agentId: tabs[0].agentId,
    sessionId: tabs[0].sessionId,
    activeTabId: tabs[0].id,
    tabs,
    label: `ペイン${id}`,
    cwd: tabs[0].cwd,
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

function contextFor(workspaces: readonly Workspace[], seed: string): GroupingCompileContext {
  return {
    baseline: workspaces.flatMap((item) => item.panes.flatMap((itemPane) => itemPane.tabs.map((itemTab) => ({
      tabId: itemTab.id,
      workspaceId: item.id,
      paneId: itemPane.id,
      sessionId: itemTab.sessionId,
    })))),
    activeWorkspaceId: "ws-a",
    activeSessionId: "session-t1",
    allocationSeed: seed,
    createdAt: NOW,
    newWorkspaceDefaults: { status: "running", pet: "clawd" },
  };
}

function plan(): GroupingPlan {
  return {
    planId: "gate6-poison",
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

function seedGroupingStores(): Workspace[] {
  const workspaces = initialLayout();
  useWorkspaceListStore.setState({
    workspaces: structuredClone(workspaces),
    layoutRevision: 0,
    activeWorkspaceId: "ws-a",
    lastActivePaneByWorkspace: { "ws-a": "session-t1", "ws-b": "session-t3" },
  });
  useUiStore.setState({ activePaneId: "session-t1", lastActivePaneId: "session-t1", focusRevision: 0 });
  return workspaces;
}

function prepare(current: Workspace[], seed: string) {
  const groupingPlan = plan();
  const selection = groupingInternals.adapter.getGroupingStoreAdapter().getSelection();
  const prepared = groupingInternals.adapter.prepareGroupingAtStoreBoundary(groupingPlan, {
    ...contextFor(current, seed),
    activeWorkspaceId: selection.activeWorkspaceId,
    activeSessionId: selection.activeSessionId,
  });
  if (!prepared.ok) throw new Error(`prepare failed: ${prepared.errors.join(" / ")}`);
  return { groupingPlan, ticket: prepared.ticket };
}

let host: HTMLDivElement;
let root: Root;
let diskData: PersistentData;
let groupingInternals: Awaited<ReturnType<typeof loadGroupingInternalsForTests>>;
const originalWorkspaceState = useWorkspaceListStore.getState();
const originalUiState = useUiStore.getState();

async function mountProductionPersistence(): Promise<void> {
  const Harness = () => {
    useWorkspacePersist();
    return null;
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(Harness)));
  await vi.waitFor(() => expect(persistenceMocks.closeHandler).not.toBeNull());
  await vi.waitFor(() => expect(useGroupingRuntimeStore.getState().persistentSchema.migrationComplete).toBe(true));
  persistenceMocks.savePersistentData.mockClear();
}

async function expectPoisonSealsPersistence(): Promise<void> {
  expect(useGroupingRuntimeStore.getState()).toMatchObject({
    poisoned: true,
    transitionDepth: 0,
    operation: null,
  });
  expect(getPersistentSchemaState()).toMatchObject({
    status: "quarantined",
    reason: "groupingPoisoned",
    requiresUnsavedConfirmation: true,
  });

  vi.useFakeTimers();
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(persistenceMocks.savePersistentData).not.toHaveBeenCalled();

  await act(async () => {
    window.dispatchEvent(new Event("beforeunload"));
    await Promise.resolve();
  });
  expect(persistenceMocks.savePersistentData).not.toHaveBeenCalled();

  const preventDefault = vi.fn();
  await act(async () => persistenceMocks.closeHandler?.({ preventDefault }));
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(persistenceMocks.savePersistentData).not.toHaveBeenCalled();
  expect(persistenceMocks.confirm).toHaveBeenCalledWith(
    "ワークスペースを保存できていません。保存せずに終了しますか？",
    expect.objectContaining({ kind: "warning" }),
  );
  expect(persistenceMocks.quitApp).not.toHaveBeenCalled();
}

async function restartFromKnownGoodDisk(): Promise<string[]> {
  vi.useRealTimers();
  await act(async () => root.unmount());
  host.remove();
  useWorkspaceListStore.setState({
    ...originalWorkspaceState,
    workspaces: [],
    activeWorkspaceId: null,
    lastActivePaneByWorkspace: {},
  }, true);
  useUiStore.setState(originalUiState, true);
  __resetGroupingRuntimeForTests();
  __resetPersistenceCoordinatorForTests();
  persistenceMocks.closeHandler = null;
  persistenceMocks.savePersistentData.mockClear();
  await mountProductionPersistence();
  return useWorkspaceListStore.getState().workspaces.map((workspace) => workspace.id);
}

beforeEach(async () => {
  vi.useRealTimers();
  vi.clearAllMocks();
  groupingInternals = await loadGroupingInternalsForTests();
  __resetGroupingRuntimeForTests();
  __resetPersistenceCoordinatorForTests();
  persistenceMocks.closeHandler = null;
  persistenceMocks.claimLeader.mockResolvedValue(true);
  persistenceMocks.confirm.mockResolvedValue(false);
  persistenceMocks.getPtyMetadataSnapshot.mockResolvedValue({});
  persistenceMocks.getWindowFragments.mockResolvedValue([]);
  persistenceMocks.listPets.mockResolvedValue([]);
  diskData = {
    schema_version: 1,
    workspaces: [],
    settings: { font_size: 14, line_height: 1.2, font_family: "monospace", theme_id: "default" },
  };
  persistenceMocks.loadPersistentData.mockImplementation(async () => ({
    schemaVersion: 1,
    supported: true,
    data: structuredClone(diskData),
  }));
  persistenceMocks.onCloseRequested.mockImplementation(async (handler) => {
    persistenceMocks.closeHandler = handler;
    return () => {};
  });
  persistenceMocks.quitApp.mockResolvedValue(undefined);
  persistenceMocks.readAgentSessionMappings.mockResolvedValue({});
  persistenceMocks.savePersistentData.mockImplementation(async (data: PersistentData) => {
    diskData = structuredClone(data);
  });
  persistenceMocks.setAppFrontendVisible.mockResolvedValue(undefined);
  persistenceMocks.takePendingAdoption.mockResolvedValue(null);
  await mountProductionPersistence();
});

afterEach(async () => {
  vi.useRealTimers();
  await act(async () => root.unmount());
  host.remove();
  useWorkspaceListStore.setState(originalWorkspaceState, true);
  useUiStore.setState(originalUiState, true);
});

describe("grouping poison persistence quarantine", () => {
  it("persists live terminal metadata after structural Undo", async () => {
    const current = seedGroupingStores();
    const { groupingPlan, ticket } = prepare(current, "undo-live-terminal-metadata");
    expect(groupingInternals.adapter.commitGroupingAtStoreBoundary(groupingPlan, ticket).commit.ok).toBe(true);
    await vi.waitFor(() => expect(persistenceMocks.savePersistentData).toHaveBeenCalled());
    persistenceMocks.savePersistentData.mockClear();

    const applied = structuredClone(useWorkspaceListStore.getState().workspaces);
    const appliedStructuralSignature = groupingInternals.engine.structuralUndoSignature(applied);
    const liveTab = applied
      .flatMap((item) => item.panes.flatMap((itemPane) => itemPane.tabs))
      .find((itemTab) => itemTab.id === "t1");
    expect(liveTab).toBeDefined();
    if (!liveTab) return;
    liveTab.label = "Apply後のラベル";
    liveTab.cwd = "C:/work/after-apply";
    liveTab.agentSessionId = "agent-session-after-apply";
    useWorkspaceListStore.setState({ workspaces: applied });

    expect(groupingInternals.engine.structuralUndoSignature(useWorkspaceListStore.getState().workspaces))
      .toBe(appliedStructuralSignature);
    expect(groupingInternals.engine.hasGroupingUndo(groupingInternals.adapter.getGroupingStoreAdapter())).toBe(true);
    expect(groupingInternals.adapter.undoGroupingAtStoreBoundary()).toEqual({ ok: true });
    await vi.waitFor(() => expect(persistenceMocks.savePersistentData).toHaveBeenCalled());

    const afterUndo = useWorkspaceListStore.getState().workspaces;
    const restoredTab = afterUndo
      .flatMap((item) => item.panes.flatMap((itemPane) => itemPane.tabs))
      .find((itemTab) => itemTab.id === "t1");
    expect(groupingInternals.engine.structuralUndoSignature(afterUndo))
      .toBe(groupingInternals.engine.structuralUndoSignature(current));
    expect(restoredTab).toMatchObject({
      label: "Apply後のラベル",
      cwd: "C:/work/after-apply",
      agentSessionId: "agent-session-after-apply",
    });

    const savedData = persistenceMocks.savePersistentData.mock.calls.at(-1)?.[0] as PersistentData | undefined;
    const savedTab = savedData?.workspaces
      .flatMap((item) => item.panes.flatMap((itemPane) => itemPane.tabs ?? []))
      .find((itemTab) => itemTab.tab_id === "t1");
    expect(savedTab).toMatchObject({
      label: "Apply後のラベル",
      cwd: "C:/work/after-apply",
      agent_session_id: "agent-session-after-apply",
    });
  });

  it("keeps the known-good disk generation after Apply rollback_failed", async () => {
    const current = seedGroupingStores();
    const { groupingPlan, ticket } = prepare(current, "apply-poison");
    const workspaceStore = useWorkspaceListStore;
    const originalRestore = workspaceStore.getState()._restoreGroupingLayout;
    workspaceStore.setState({
      _restoreGroupingLayout: (workspaces, selection, source, capability) => {
        if (source === "grouping-rollback") throw new Error("forced schema rollback failure");
        originalRestore(workspaces, selection, source, capability);
      },
    });
    let injected = false;
    const unsubscribe = useGroupingRuntimeStore.subscribe((state, previous) => {
      if (!injected && previous.transitionDepth === 1 && state.transitionDepth === 0) {
        injected = true;
        recordPersistentSchemaState({ loadedSchemaVersion: 999, migrationComplete: false });
      }
    });
    const result = groupingInternals.adapter.commitGroupingAtStoreBoundary(groupingPlan, ticket);
    unsubscribe();

    expect(result.commit).toMatchObject({ ok: false, kind: "rollback_failed" });
    await expectPoisonSealsPersistence();
    expect(await restartFromKnownGoodDisk()).toEqual([]);
  });

  it("keeps the known-good disk generation after Undo restore_failed", async () => {
    const current = seedGroupingStores();
    const { groupingPlan, ticket } = prepare(current, "undo-poison");
    expect(groupingInternals.adapter.commitGroupingAtStoreBoundary(groupingPlan, ticket).commit.ok).toBe(true);
    await vi.waitFor(() => expect(persistenceMocks.savePersistentData).toHaveBeenCalled());
    const knownGoodWorkspaceIds = diskData.workspaces.map((workspace) => workspace.id);
    persistenceMocks.savePersistentData.mockClear();

    const workspaceStore = useWorkspaceListStore;
    const originalRestore = workspaceStore.getState()._restoreGroupingLayout;
    workspaceStore.setState({
      _restoreGroupingLayout: (workspaces, selection, source, capability) => {
        const next = structuredClone(workspaces);
        next[0].name = "undo-restore-corrupt";
        originalRestore(next, selection, source, capability);
      },
    });

    expect(groupingInternals.adapter.undoGroupingAtStoreBoundary()).toMatchObject({ ok: false, kind: "restore_failed" });
    await expectPoisonSealsPersistence();
    expect(await restartFromKnownGoodDisk()).toEqual(knownGoodWorkspaceIds);
  });
});
