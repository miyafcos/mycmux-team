// @vitest-environment jsdom

import { listen } from "@tauri-apps/api/event";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const productionRaceMocks = vi.hoisted(() => ({
  claimLeader: vi.fn(),
  closeHandler: null as null | ((event: { preventDefault: () => void }) => Promise<void>),
  dockSaveHandler: null as null | (() => void),
  confirm: vi.fn(),
  getPtyMetadataSnapshot: vi.fn(),
  getAppSettings: vi.fn(),
  listRunningSessionIds: vi.fn(async () => [] as string[]),
  getWindowFragments: vi.fn(),
  listPets: vi.fn(),
  loadPersistentData: vi.fn(),
  onCloseRequested: vi.fn(),
  destroy: vi.fn(),
  emitTo: vi.fn(async () => {}),
  killSession: vi.fn(async () => {}),
  publishWindowFragment: vi.fn<(fragment: WindowFragment, requirePublished?: true) => Promise<void>>(),
  quitPrepared: vi.fn(async () => {}),
  quitSaved: vi.fn(async () => {}),
  readAgentSessionMappings: vi.fn(),
  restoreWorkspaceConfigs: vi.fn(),
  savePersistentData: vi.fn(),
  sendSocketResponse: vi.fn(async () => {}),
  setAppFrontendVisible: vi.fn(),
  windowLabel: "main",
}));

vi.mock("../../src/lib/paneCloseConfirmation", () => ({ confirmPaneClose: vi.fn(async () => true) }));

vi.mock("../../src/lib/appConfirmation", () => ({ cancelAppConfirmations: vi.fn(() => false),
  confirm: productionRaceMocks.confirm,
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => {}),
  emitTo: productionRaceMocks.emitTo,
  listen: vi.fn(async (event: string, handler: () => void) => {
    if (event === "mycmux://dock-save") productionRaceMocks.dockSaveHandler = handler;
    return () => {};
  }),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: productionRaceMocks.windowLabel,
    onCloseRequested: productionRaceMocks.onCloseRequested,
    destroy: productionRaceMocks.destroy,
  }),
}));

vi.mock("../../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/ipc")>();
  return {
    ...actual,
    claimLeader: productionRaceMocks.claimLeader,
    setWindowCloseIntent: vi.fn(async () => {}),
    takePendingAdoption: vi.fn(async () => []),
    killSession: productionRaceMocks.killSession,
    discardSessionScrollback: vi.fn(async () => {}),
    publishWindowFragment: productionRaceMocks.publishWindowFragment,
    quitPrepared: productionRaceMocks.quitPrepared,
    quitSaved: productionRaceMocks.quitSaved,
    getPtyMetadataSnapshot: productionRaceMocks.getPtyMetadataSnapshot,
    getAppSettings: productionRaceMocks.getAppSettings,
    listRunningSessionIds: productionRaceMocks.listRunningSessionIds,
    getWindowFragments: productionRaceMocks.getWindowFragments,
    listPets: productionRaceMocks.listPets,
    loadPersistentData: productionRaceMocks.loadPersistentData,
    readAgentSessionMappings: productionRaceMocks.readAgentSessionMappings,
    savePersistentData: productionRaceMocks.savePersistentData,
    sendSocketResponse: productionRaceMocks.sendSocketResponse,
    setAppFrontendVisible: productionRaceMocks.setAppFrontendVisible,
  };
});

vi.mock("../../src/lib/workspaceRestore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/workspaceRestore")>();
  return {
    ...actual,
    restoreWorkspaceConfigs: productionRaceMocks.restoreWorkspaceConfigs,
  };
});

import {
  __resetWindowCloseStateForTests,
  installWorkspacePersistenceAutosaveController,
  publishPersistentSchemaAfterHydration,
  useWorkspacePersist,
} from "../../src/components/layout/SocketListener";
import {
  __resetGroupingRuntimeForTests,
  assertGroupingSchemaCompatible,
  runLayoutTransition,
  useGroupingRuntimeStore,
} from "../../src/stores/groupingRuntimeStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import {
  __resetPersistenceCoordinatorForTests,
  createTransitionAwareAutosaveGate,
  getPersistentSchemaState,
  markPersistentSchemaSupported,
  quarantinePersistentWrites,
  registerPersistenceLeader,
  requestImmediatePersist,
  subscribePersistentSchemaState,
} from "../../src/lib/workspacePersistenceCoordinator";
import { hashCanonical, type Sha256 } from "../../src/lib/persistentLayoutProjection";
import { __resetToastStoreForTests, useToastStore } from "../../src/stores/toastStore";
import type { Workspace } from "../../src/types";
import { setWindowRole, hasWindowRole, resetWindowContextCacheForTests } from "../../src/lib/windowContext";
import { restoreWorkspaceConfigs } from "../../src/lib/workspaceRestore";
import { discardSessionScrollback, QUIT_PREPARE_EVENT, QUIT_SAVE_EVENT, type WindowFragment } from "../../src/lib/ipc";
import { closePaneOperation, type PaneCloseResult } from "../../src/lib/paneCloseOperation";
import { PEER_COMMAND_EVENTS } from "../../src/lib/socketCommandWindows";
import { webPaneCommandContext } from "../../src/components/workspace/webPaneCommandQueue";

describe("SocketListener production autosave subscriptions", () => {
  let host: HTMLDivElement | null = null;
  let root: Root | null = null;
  const originalWorkspaceState = useWorkspaceListStore.getState();

  beforeEach(() => {
    vi.clearAllMocks();
    __resetGroupingRuntimeForTests();
    __resetPersistenceCoordinatorForTests();
    __resetWindowCloseStateForTests();
    markPersistentSchemaSupported(1);
    __resetToastStoreForTests();
    productionRaceMocks.closeHandler = null;
    productionRaceMocks.dockSaveHandler = null;
    productionRaceMocks.claimLeader.mockResolvedValue(true);
    productionRaceMocks.confirm.mockResolvedValue(false);
    productionRaceMocks.getPtyMetadataSnapshot.mockResolvedValue({});
    productionRaceMocks.listRunningSessionIds.mockReset().mockResolvedValue([]);
    productionRaceMocks.getWindowFragments.mockResolvedValue([]);
    productionRaceMocks.listPets.mockResolvedValue([]);
    productionRaceMocks.onCloseRequested.mockImplementation(async (handler) => {
      productionRaceMocks.closeHandler = handler;
      return () => {};
    });
    productionRaceMocks.destroy.mockResolvedValue(undefined);
    productionRaceMocks.killSession.mockReset().mockResolvedValue(undefined);
    productionRaceMocks.publishWindowFragment.mockReset().mockResolvedValue(undefined);
    productionRaceMocks.restoreWorkspaceConfigs.mockReturnValue({ activePaneSessionId: null });
    productionRaceMocks.savePersistentData.mockResolvedValue(undefined);
    productionRaceMocks.setAppFrontendVisible.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    productionRaceMocks.windowLabel = "main";
    resetWindowContextCacheForTests();
    __resetToastStoreForTests();
    useWorkspaceListStore.setState(originalWorkspaceState, true);
    host?.remove();
    root = null;
    host = null;
  });

  it("restores all four main workspaces when startup already shows only one persistable tab", async () => {
    const { restoreWorkspaceConfigs: restore } =
      await vi.importActual<typeof import("../../src/lib/workspaceRestore")>("../../src/lib/workspaceRestore");
    vi.mocked(restoreWorkspaceConfigs).mockImplementationOnce(restore);
    const saved = [10, 9, 9, 9].map((tabCount, index) => ({
      id: `saved-${index}`, name: `Saved ${index}`, grid_template_id: "1x1", created_at: index,
      window_group: { label: "main" },
      panes: [{
        pane_id: `pane-${index}`, agent_id: "shell", active_tab_id: `tab-${index}-0`,
        tabs: Array.from({ length: tabCount }, (_, tab) => ({
          tab_id: `tab-${index}-${tab}`, agent_id: "shell", type: "terminal",
        })),
      }],
    }));
    const visible: Workspace = {
      id: "new-visible-workspace", name: "Visible", gridTemplateId: "1x1", createdAt: 8, status: "running",
      panes: [{
        id: "new-pane", sessionId: "new-session", agentId: "shell", activeTabId: "new-tab",
        tabs: [{ id: "new-tab", sessionId: "new-session", agentId: "shell", type: "terminal" }],
      }],
    };
    useWorkspaceListStore.setState({ workspaces: [visible], activeWorkspaceId: visible.id });
    productionRaceMocks.readAgentSessionMappings.mockResolvedValue({});
    productionRaceMocks.loadPersistentData.mockResolvedValue({
      supported: true, schemaVersion: 1,
      data: {
        schema_version: 1, settings: { theme_id: "default" }, workspaces: saved,
        active_workspace_id: "saved-0", active_pane_id: "pane-0", active_tab_id: "tab-0-0",
      },
    });

    const Harness = () => { useWorkspacePersist(); return null; };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(createElement(Harness)));
    await vi.waitFor(() => expect(productionRaceMocks.claimLeader).toHaveBeenCalledTimes(2));

    const snapshot = { workspaces: useWorkspaceListStore.getState().workspaces };
    await act(async () => {
      await requestImmediatePersist({
        requestId: "first-startup-snapshot", revision: 1, signature: "a".repeat(64) as Sha256,
        snapshot, snapshotDigest: hashCanonical(snapshot),
      });
    });
    const written = productionRaceMocks.savePersistentData.mock.calls.at(-1)?.[0];
    expect(written.workspaces.map((workspace: {id: string}) => workspace.id)).toEqual(
      [...saved.map((workspace) => workspace.id), visible.id],
    );
    expect(written.workspaces.map((workspace: {panes: {tabs: unknown[]}[]}) =>
      workspace.panes[0].tabs.length)).toEqual([10, 9, 9, 9, 1]);
  });

  it("L3 93 keeps the newly created workspace and its tab after the restored list", async () => {
    const { restoreWorkspaceConfigs: restore } =
      await vi.importActual<typeof import("../../src/lib/workspaceRestore")>("../../src/lib/workspaceRestore");
    vi.mocked(restoreWorkspaceConfigs).mockImplementationOnce(restore);
    const saved = {
      id: "saved-workspace", name: "Saved", grid_template_id: "1x1", created_at: 1,
      panes: [{
        pane_id: "saved-pane", agent_id: "shell", active_tab_id: "saved-tab",
        tabs: [{ tab_id: "saved-tab", agent_id: "shell", type: "terminal" }],
      }],
    };
    const envelope = {
      supported: true, schemaVersion: 1,
      data: { schema_version: 1, settings: { theme_id: "default" }, workspaces: [saved] },
    };
    let finishLoad!: (result: typeof envelope) => void;
    productionRaceMocks.loadPersistentData.mockReturnValueOnce(new Promise((resolve) => { finishLoad = resolve; }));
    productionRaceMocks.readAgentSessionMappings.mockResolvedValue({});
    useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null });

    const Harness = () => { useWorkspacePersist(); return null; };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(createElement(Harness)));
    expect(productionRaceMocks.loadPersistentData).toHaveBeenCalledOnce();
    expect(useWorkspaceListStore.getState().workspaces).toHaveLength(0);

    const [, onSocketRequest] = vi.mocked(listen).mock.calls.find(([event]) => event === "socket-request")!;
    await act(async () => {
      await onSocketRequest({ event: "socket-request", id: 0, payload: {
        id: "create-during-load", cmd: "workspace.new", args: { name: "Created through socket" },
      } });
    });
    const { workspaces } = useWorkspaceListStore.getState();
    expect(workspaces).toHaveLength(1);
    const [created] = workspaces;
    expect(productionRaceMocks.sendSocketResponse).toHaveBeenCalledWith(
      "create-during-load", expect.objectContaining({ workspaceId: created.id }), null,
    );
    await act(async () => {
      useWorkspaceLayoutStore.getState().addTabToPane(created.id, created.panes[0].id, "shell", "terminal");
    });
    const tab = useWorkspaceListStore.getState().getWorkspace(created.id)?.panes[0].tabs.find(({ type }) => type === "terminal");
    expect(tab).toBeDefined();

    await act(async () => { finishLoad(envelope); });
    expect(useWorkspaceListStore.getState().workspaces.map(({ id }) => id)).toEqual([saved.id, created.id]);
    expect(useWorkspaceListStore.getState().getWorkspace(created.id)?.panes[0].tabs).toContainEqual(tab);
  });

  it("acknowledges quit preparation even when publishing the window fragment fails", async () => {
    productionRaceMocks.readAgentSessionMappings.mockResolvedValue({});
    productionRaceMocks.loadPersistentData.mockResolvedValue({
      supported: true, schemaVersion: 1,
      data: { schema_version: 1, workspaces: [], settings: { theme_id: "default" } },
    });
    const Harness = () => { useWorkspacePersist(); return null; };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(createElement(Harness)));
    await vi.waitFor(() => expect(productionRaceMocks.publishWindowFragment).toHaveBeenCalled());

    const [, prepareQuit] = vi.mocked(listen).mock.calls.find(([event]) => event === QUIT_PREPARE_EVENT)!;
    const error = new Error("publish failed");
    productionRaceMocks.publishWindowFragment.mockRejectedValueOnce(error);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await act(async () => {
        prepareQuit({ event: QUIT_PREPARE_EVENT, id: 0, payload: undefined });
      });
      expect(warn).toHaveBeenCalledWith("[quit] Failed to prepare this window:", error);
      expect(productionRaceMocks.quitPrepared).toHaveBeenCalledExactlyOnceWith(false);
    } finally {
      warn.mockRestore();
    }
  });

  it("acknowledges quit preparation even when a child window fails to load", async () => {
    productionRaceMocks.windowLabel = "mycmux-w1";
    resetWindowContextCacheForTests();
    const error = new Error("child settings failed to load");
    productionRaceMocks.getAppSettings.mockRejectedValueOnce(error);
    const Harness = () => { useWorkspacePersist(); return null; };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await act(async () => root?.render(createElement(Harness)));
      expect(warn).toHaveBeenCalledWith("[persist] Failed to hydrate child window:", error);
      productionRaceMocks.publishWindowFragment.mockClear();
      const [, prepareQuit] = vi.mocked(listen).mock.calls.find(([event]) => event === QUIT_PREPARE_EVENT)!;
      await act(async () => {
        prepareQuit({ event: QUIT_PREPARE_EVENT, id: 0, payload: undefined });
      });
      expect(productionRaceMocks.quitPrepared).toHaveBeenCalledExactlyOnceWith(false);
      expect(productionRaceMocks.publishWindowFragment).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  function quitWorkspace(id: string): Workspace {
    return {
      id, name: id, gridTemplateId: "1x1", createdAt: 1, status: "running",
      panes: [{
        id: `${id}-pane`, sessionId: `${id}-keep-session`, agentId: "shell", activeTabId: `${id}-keep`,
        tabs: ["keep", "closing"].map((tab) => ({
          id: `${id}-${tab}`, sessionId: `${id}-${tab}-session`, agentId: "shell", type: "terminal",
        })),
      }],
    };
  }

  async function mountQuitWindow(label: string, workspace: Workspace) {
    productionRaceMocks.windowLabel = label;
    resetWindowContextCacheForTests();
    useWorkspaceListStore.setState({ workspaces: [workspace], activeWorkspaceId: workspace.id });
    productionRaceMocks.readAgentSessionMappings.mockResolvedValue({});
    productionRaceMocks.getAppSettings.mockResolvedValue({ schema_version: 1, theme_id: "default" });
    productionRaceMocks.loadPersistentData.mockResolvedValue({
      supported: true, schemaVersion: 1,
      data: { schema_version: 1, workspaces: [], settings: { theme_id: "default" } },
    });
    const Harness = () => { useWorkspacePersist(); return null; };
    host ??= document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => root?.render(createElement(Harness)));
    expect(productionRaceMocks.publishWindowFragment).toHaveBeenCalledWith(
      expect.objectContaining({ window_label: label }),
    );
  }

  function dispatchQuitTestEvent(event: string, payload?: unknown) {
    const registration = vi.mocked(listen).mock.calls.findLast(([name]) => name === event);
    if (!registration) throw new Error(`No listener for ${event}`);
    return registration[1]({ event, id: 0, payload });
  }

  async function beginSlowTabClose(workspace: Workspace) {
    let finish!: () => void;
    productionRaceMocks.killSession.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
    let close!: Promise<PaneCloseResult>;
    await act(async () => {
      close = closePaneOperation({
        kind: "tab", workspaceId: workspace.id, paneId: workspace.panes[0].id, tabId: `${workspace.id}-closing`,
      }, "ui");
    });
    expect(productionRaceMocks.killSession).toHaveBeenCalledWith(`${workspace.id}-closing-session`);
    return { finish, close };
  }

  it("L3 81 clears duplicate resume ownership without deleting a remaining tab's terminal history", async () => {
    const workspaces = ["first", "second"].map(id => ({
      id, name: id, created_at: 1, grid_template_id: "1x1",
      panes: [{ pane_id: id + "-pane", agent_id: "codex", tabs: [{
        tab_id: id + "-tab", session_id: "pty-" + id, agent_id: "codex",
        agent_kind: "codex", agent_session_id: "same-conversation", type: "terminal",
      }] }],
    }));
    productionRaceMocks.loadPersistentData.mockResolvedValue({
      supported: true, schemaVersion: 1,
      data: { schema_version: 1, workspaces, settings: { theme_id: "default" } },
    });
    productionRaceMocks.readAgentSessionMappings.mockResolvedValue({});
    const Harness = () => { useWorkspacePersist(); return null; };
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => root?.render(createElement(Harness)));
    expect(productionRaceMocks.restoreWorkspaceConfigs).toHaveBeenCalled();
    expect(discardSessionScrollback).not.toHaveBeenCalled();
  });

  it("L3 91 retries a transient list-fragment IPC error before the last save", async () => {
    await mountQuitWindow("main", quitWorkspace("main-workspace"));
    await act(async () => { dispatchQuitTestEvent(QUIT_PREPARE_EVENT); });
    productionRaceMocks.getWindowFragments.mockRejectedValueOnce(new Error("transient IPC"));
    await act(async () => { dispatchQuitTestEvent(QUIT_SAVE_EVENT); });
    expect(productionRaceMocks.quitSaved).toHaveBeenCalledOnce();
  });

  it("L3 97 publishes a background rename after a child acknowledges preparation", async () => {
    const child = quitWorkspace("child");
    await mountQuitWindow("mycmux-w1", child);
    await act(async () => { dispatchQuitTestEvent(QUIT_PREPARE_EVENT); });
    expect(productionRaceMocks.quitPrepared).toHaveBeenCalledExactlyOnceWith(true);
    productionRaceMocks.publishWindowFragment.mockClear();
    await act(async () => {
      useWorkspaceListStore.setState({ workspaces: [{ ...child, name: "Late background rename" }] });
    });
    expect(productionRaceMocks.publishWindowFragment.mock.lastCall?.[0]).toMatchObject({
      workspaces: [expect.objectContaining({ name: "Late background rename" })],
    });
  });

  it("L3 fix2 05 saves the child generation that changed during its initial publication", async () => {
    const child = quitWorkspace("child");
    await mountQuitWindow("mycmux-w1", child);
    let finishFirst!: () => void;
    productionRaceMocks.publishWindowFragment.mockImplementationOnce(() => new Promise(resolve => {
      finishFirst = resolve;
    }));
    await act(async () => { dispatchQuitTestEvent(QUIT_PREPARE_EVENT); });
    expect(finishFirst).toBeTypeOf("function");
    await act(async () => {
      useWorkspaceListStore.setState({ workspaces: [{ ...child, name: "New child name" }] });
    });
    expect(productionRaceMocks.quitPrepared).not.toHaveBeenCalled();
    await act(async () => { finishFirst(); });
    expect(productionRaceMocks.quitPrepared).toHaveBeenCalledExactlyOnceWith(true);
    const childFragment = productionRaceMocks.publishWindowFragment.mock.lastCall?.[0];

    await act(async () => root?.unmount());
    __resetWindowCloseStateForTests();
    productionRaceMocks.getWindowFragments.mockResolvedValue([childFragment]);
    await mountQuitWindow("main", quitWorkspace("main-workspace"));
    await act(async () => { dispatchQuitTestEvent(QUIT_PREPARE_EVENT); });
    await act(async () => { dispatchQuitTestEvent(QUIT_SAVE_EVENT); });
    expect(productionRaceMocks.quitSaved).toHaveBeenCalledOnce();
    expect(productionRaceMocks.savePersistentData.mock.lastCall?.[0].workspaces)
      .toContainEqual(expect.objectContaining({ id: child.id, name: "New child name" }));
  });

  it("L3 fix3 02 saves a child rename made after its seal acknowledgement", async () => {
    const child = quitWorkspace("child");
    await mountQuitWindow("mycmux-w1", child);
    const peerFragments: WindowFragment[] = [];
    productionRaceMocks.publishWindowFragment.mockImplementation(async (fragment) => {
      if (fragment.window_label === "mycmux-w1") peerFragments.splice(0, 1, fragment);
    });
    await act(async () => { dispatchQuitTestEvent(QUIT_PREPARE_EVENT); });
    await act(async () => { dispatchQuitTestEvent(QUIT_PREPARE_EVENT, "seal"); });
    expect(productionRaceMocks.quitPrepared).toHaveBeenLastCalledWith(true, true);
    expect(peerFragments[0].workspaces[0].name).toBe(child.name);

    // A has already replied. The leader has yet to receive the remaining peers' replies.
    await act(async () => useWorkspaceListStore.getState().renameWorkspace(child.id, "Updated after seal"));
    await act(async () => root?.unmount());
    __resetWindowCloseStateForTests();
    productionRaceMocks.getWindowFragments.mockImplementation(async () => [...peerFragments]);
    await mountQuitWindow("main", quitWorkspace("main-workspace"));
    await act(async () => { dispatchQuitTestEvent(QUIT_PREPARE_EVENT); });
    await act(async () => { dispatchQuitTestEvent(QUIT_SAVE_EVENT); });
    expect(productionRaceMocks.quitSaved).toHaveBeenCalledOnce();
    expect(productionRaceMocks.savePersistentData.mock.lastCall?.[0].workspaces)
      .toContainEqual(expect.objectContaining({ id: child.id, name: "Updated after seal" }));
  });

  it("L3 fix2 05 waits for the final child generation before reporting it sealed", async () => {
    const child = quitWorkspace("child");
    await mountQuitWindow("mycmux-w1", child);
    await act(async () => { dispatchQuitTestEvent(QUIT_PREPARE_EVENT); });
    let completePublish!: () => void;
    productionRaceMocks.publishWindowFragment.mockImplementationOnce(() => new Promise(resolve => {
      completePublish = resolve;
    }));
    await act(async () => {
      useWorkspaceListStore.setState({ workspaces: [{ ...child, name: "Earlier update" }] });
    });
    await act(async () => { dispatchQuitTestEvent(QUIT_PREPARE_EVENT, "seal"); });
    await act(async () => {
      useWorkspaceListStore.setState({ workspaces: [{ ...child, name: "Latest update" }] });
    });
    expect(productionRaceMocks.quitPrepared.mock.calls).toEqual([[true]]);
    await act(async () => { completePublish(); });
    expect(productionRaceMocks.quitPrepared.mock.calls).toEqual([[true], [true, true]]);
    expect(productionRaceMocks.publishWindowFragment.mock.lastCall?.[0].workspaces[0].name).toBe("Latest update");
  });

  it("L3 fix2 15 sends the changed selection with the persisted workspace snapshot", async () => {
    const initiallySelected = quitWorkspace("initial");
    const userSelected = quitWorkspace("selected");
    await mountQuitWindow("main", initiallySelected);
    await act(async () => {
      const list = useWorkspaceListStore.getState();
      list._replaceWorkspaces([initiallySelected, userSelected]);
      list.setActiveWorkspace(userSelected.id);
    });
    await act(async () => { dispatchQuitTestEvent(QUIT_PREPARE_EVENT); });
    await act(async () => { dispatchQuitTestEvent(QUIT_SAVE_EVENT); });
    expect(productionRaceMocks.savePersistentData.mock.lastCall).toEqual([
      expect.objectContaining({ active_workspace_id: userSelected.id }), true,
    ]);
  });

  it("L3 fix2 19 restores the saved order before saving after quit during hydration", async () => {
    const { restoreWorkspaceConfigs: restore } =
      await vi.importActual<typeof import("../../src/lib/workspaceRestore")>("../../src/lib/workspaceRestore");
    vi.mocked(restoreWorkspaceConfigs).mockImplementationOnce(restore);
    const saved = {
      id: "earlier", name: "Saved", grid_template_id: "1x1", created_at: 1,
      panes: [{ pane_id: "saved-pane", agent_id: "shell", tabs: [
        { tab_id: "saved-tab", agent_id: "shell", type: "terminal" },
      ] }],
    };
    let finishLoad!: () => void;
    productionRaceMocks.loadPersistentData.mockImplementationOnce(() => new Promise(resolve => {
      finishLoad = () => resolve({
        supported: true, schemaVersion: 1,
        data: { schema_version: 1, settings: { theme_id: "default" }, workspaces: [saved] },
      });
    }));
    productionRaceMocks.readAgentSessionMappings.mockResolvedValue({});
    const created = quitWorkspace("added-during-load");
    useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null });
    const Harness = () => { useWorkspacePersist(); return null; };
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => root?.render(createElement(Harness)));
    await act(async () => {
      useWorkspaceListStore.setState({ workspaces: [created], activeWorkspaceId: created.id });
      dispatchQuitTestEvent(QUIT_PREPARE_EVENT);
    });
    await act(async () => { finishLoad(); });
    await act(async () => { dispatchQuitTestEvent(QUIT_SAVE_EVENT); });
    expect(productionRaceMocks.quitSaved).toHaveBeenCalledOnce();
    expect(productionRaceMocks.savePersistentData.mock.lastCall?.[0].workspaces
      .map((row: { id: string }) => row.id)).toEqual([saved.id, created.id]);
  });

  it("L3 fix2 16 retains the conversation on the explicitly selected tab across save and load", async () => {
    const { restoreWorkspaceConfigs: restore } =
      await vi.importActual<typeof import("../../src/lib/workspaceRestore")>("../../src/lib/workspaceRestore");
    vi.mocked(restoreWorkspaceConfigs).mockImplementationOnce(restore);
    const workspaces = ["first", "selected"].map(tabId => ({
      id: "saved", name: "Saved", created_at: 1, grid_template_id: "1x1",
      panes: [{ pane_id: "pane", agent_id: "codex", active_tab_id: tabId, tabs: [{
        tab_id: tabId, agent_id: "codex", agent_kind: "codex",
        agent_session_id: "shared-conversation", type: "terminal",
      }] }],
    }));
    productionRaceMocks.loadPersistentData.mockResolvedValue({
      supported: true, schemaVersion: 1,
      data: { schema_version: 1, workspaces, settings: { theme_id: "default" },
        active_workspace_id: "saved", active_pane_id: "pane", active_tab_id: "selected" },
    });
    productionRaceMocks.readAgentSessionMappings.mockResolvedValue({});
    useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null });
    const Harness = () => { useWorkspacePersist(); return null; };
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => root?.render(createElement(Harness)));
    await act(async () => { dispatchQuitTestEvent(QUIT_PREPARE_EVENT); });
    await act(async () => { dispatchQuitTestEvent(QUIT_SAVE_EVENT); });
    const saved = productionRaceMocks.savePersistentData.mock.lastCall?.[0];
    expect(saved.active_tab_id).toBe("selected");
    const savedTabs = saved.workspaces[0].panes[0].tabs;
    expect(savedTabs.find((tab: { tab_id: string }) => tab.tab_id === "selected")?.agent_session_id)
      .toBe("shared-conversation");
    expect(savedTabs.find((tab: { tab_id: string }) => tab.tab_id === "first")?.agent_session_id)
      .toBeFalsy();

    useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null });
    const reloaded = restore(saved.workspaces, {
      activeWorkspaceId: saved.active_workspace_id, activePaneId: saved.active_pane_id,
      activeTabId: saved.active_tab_id,
    });
    const tab = useWorkspaceListStore.getState().getWorkspace("saved")?.panes[0].tabs
      .find(({ id }) => id === "selected");
    expect(tab?.agentSessionId).toBe("shared-conversation");
    expect(reloaded.activePaneSessionId).toBe(tab?.sessionId);
  });

  it("L3 fix2 04 keeps the unique legacy conversation when its pane already has a current row", async () => {
    const { restoreWorkspaceConfigs: restore } =
      await vi.importActual<typeof import("../../src/lib/workspaceRestore")>("../../src/lib/workspaceRestore");
    vi.mocked(restoreWorkspaceConfigs).mockImplementationOnce(restore);
    const workspace = { id: "saved", name: "Saved", created_at: 1, grid_template_id: "1x1" };
    const workspaces = [
      { ...workspace, panes: [{ pane_id: "same-pane", agent_id: "shell", tabs: [
        { tab_id: "ordinary", agent_id: "shell", type: "terminal" },
      ] }] },
      { ...workspace, panes: [{ pane_id: "same-pane", agent_id: "codex", agent_kind: "codex",
        agent_session_id: "only-in-legacy-row", label: "Legacy tab" }] },
    ];
    productionRaceMocks.loadPersistentData.mockResolvedValue({
      supported: true, schemaVersion: 1,
      data: { schema_version: 1, workspaces, settings: { theme_id: "default" } },
    });
    productionRaceMocks.readAgentSessionMappings.mockResolvedValue({});
    useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null });
    const Harness = () => { useWorkspacePersist(); return null; };
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => root?.render(createElement(Harness)));
    await act(async () => { dispatchQuitTestEvent(QUIT_PREPARE_EVENT); });
    await act(async () => { dispatchQuitTestEvent(QUIT_SAVE_EVENT); });
    const saved = productionRaceMocks.savePersistentData.mock.lastCall?.[0];
    useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null });
    restore(saved.workspaces);
    const panes = useWorkspaceListStore.getState().getWorkspace("saved")?.panes;
    expect(panes).toHaveLength(1);
    expect(panes?.[0].tabs).toMatchObject([
      { id: "ordinary" }, { label: "Legacy tab", agentSessionId: "only-in-legacy-row" },
    ]);
  });

  it.each([
    {
      finding: "07 replaces an unsupported duplicate with its restorable row",
      first: [{ tab_id: "match", agent_id: "codex", lifecycle: "unknown-fixture" }],
      later: { tabs: [{ tab_id: "match", agent_id: "codex", agent_kind: "codex", agent_session_id: "unique-conversation" }] },
    },
    {
      finding: "14 preserves a legacy conversation when a selection names a different tab",
      first: [],
      later: { active_tab_id: "ordinary", agent_kind: "codex", agent_session_id: "unique-conversation" },
    },
  ])("L3 fix3 $finding across restore, save and reload", async ({ first, later }) => {
    const { restoreWorkspaceConfigs: restore } =
      await vi.importActual<typeof import("../../src/lib/workspaceRestore")>("../../src/lib/workspaceRestore");
    vi.mocked(restoreWorkspaceConfigs).mockImplementationOnce(restore);
    const workspace = { id: "saved", name: "Saved", created_at: 1, grid_template_id: "1x1" };
    const workspaces = [
      { ...workspace, panes: [{ pane_id: "same-pane", agent_id: "shell", tabs: [
        { tab_id: "ordinary", agent_id: "shell", type: "terminal" }, ...first,
      ] }] },
      { ...workspace, panes: [{ pane_id: "same-pane", agent_id: "codex", ...later }] },
    ];
    productionRaceMocks.loadPersistentData.mockResolvedValue({
      supported: true, schemaVersion: 1,
      data: { schema_version: 1, workspaces, settings: { theme_id: "default" } },
    });
    productionRaceMocks.readAgentSessionMappings.mockResolvedValue({});
    useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null });
    const Harness = () => { useWorkspacePersist(); return null; };
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => root?.render(createElement(Harness)));
    await act(async () => { dispatchQuitTestEvent(QUIT_PREPARE_EVENT); });
    await act(async () => { dispatchQuitTestEvent(QUIT_SAVE_EVENT); });
    const saved = productionRaceMocks.savePersistentData.mock.lastCall?.[0];
    useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null });
    restore(saved.workspaces);
    const panes = useWorkspaceListStore.getState().getWorkspace("saved")?.panes;
    expect(panes).toHaveLength(1);
    expect(panes?.[0].tabs).toMatchObject([
      { id: "ordinary" }, { agentSessionId: "unique-conversation" },
    ]);
    expect(panes?.[0].tabs[1].id).not.toBe("ordinary");
  });

  it("L3 fix2 29 describes an ordinary window creation failure without claiming a startup restore", async () => {
    await mountQuitWindow("main", quitWorkspace("source"));
    await act(async () => {
      dispatchQuitTestEvent("mycmux://window-open-failed", 1);
      dispatchQuitTestEvent("mycmux://window-open-failed", {
        label: "mycmux-w1", creation_id: "fixture-request", kind: "move", moved_count: 0,
      });
    });
    const messages = useToastStore.getState().toasts.map(toast => toast.message);
    expect(messages).toContain("\u65b0\u3057\u3044\u30a6\u30a3\u30f3\u30c9\u30a6\u3092\u958b\u3051\u307e\u305b\u3093\u3067\u3057\u305f\u3002");
    expect(messages.some(message => message.includes("\u524d\u56de"))).toBe(false);
  });

  it("L3 98 lets a peer read wait for hydration during preparation", async () => {
    const label = "mycmux-w1";
    productionRaceMocks.windowLabel = label;
    resetWindowContextCacheForTests();
    useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null });
    let release!: () => void;
    productionRaceMocks.getAppSettings.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve({ schema_version: 1, theme_id: "default" });
    }));
    const Harness = () => { useWorkspacePersist(); return null; };
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => root?.render(createElement(Harness)));
    const workspace = quitWorkspace("loading");
    const context = webPaneCommandContext("workspace.select");
    let reply!: Promise<unknown>;
    await act(async () => {
      dispatchQuitTestEvent(QUIT_PREPARE_EVENT);
      reply = Promise.resolve(dispatchQuitTestEvent(PEER_COMMAND_EVENTS.request, {
        requestId: "read-during-prepare", targetWindow: label, replyWindow: "main", cmd: "workspace.select",
        args: { workspaceId: workspace.id }, expiresAt: context.deadline, context,
      }));
    });
    await act(async () => {
      useWorkspaceListStore.setState({ workspaces: [workspace], activeWorkspaceId: workspace.id });
      release();
      await reply;
    });
    expect(productionRaceMocks.emitTo).toHaveBeenCalledWith("main", PEER_COMMAND_EVENTS.response, expect.objectContaining({
      requestId: "read-during-prepare", result: expect.objectContaining({ requestedWorkspaceId: workspace.id, foregroundChanged: false }),
    }));
  });

  it("saves the closed tab's absence when a child starts closing it before another window answers quit", async () => {
    const child = quitWorkspace("child");
    await mountQuitWindow("mycmux-w1", child);
    const { finish, close } = await beginSlowTabClose(child);
    await act(async () => { dispatchQuitTestEvent(QUIT_PREPARE_EVENT); });
    const answersBeforeClose = productionRaceMocks.quitPrepared.mock.calls.length;

    await act(async () => {
      finish();
      expect(await close).toMatchObject({ status: "closed" });
    });
    expect(productionRaceMocks.quitPrepared).toHaveBeenCalledExactlyOnceWith(true);
    const childFragment = productionRaceMocks.publishWindowFragment.mock.calls
      .findLast(([fragment, required]) => required && fragment.window_label === "mycmux-w1")?.[0];
    expect(childFragment).toBeDefined();

    // A separate webview owns the final save and answers after this child.
    await act(async () => root?.unmount());
    __resetWindowCloseStateForTests();
    productionRaceMocks.getWindowFragments.mockResolvedValue([childFragment]);
    await mountQuitWindow("main", quitWorkspace("main-workspace"));
    await act(async () => { dispatchQuitTestEvent(QUIT_PREPARE_EVENT); });
    expect(productionRaceMocks.quitPrepared.mock.calls).toEqual([[true], [true]]);
    await act(async () => { dispatchQuitTestEvent(QUIT_SAVE_EVENT); });
    expect(productionRaceMocks.quitSaved).toHaveBeenCalledOnce();
    const saved = productionRaceMocks.savePersistentData.mock.lastCall?.[0];
    const tabIds = saved.workspaces.find((workspace: { id: string }) => workspace.id === child.id)
      ?.panes[0].tabs.map((tab: { tab_id: string }) => tab.tab_id);
    expect({ answersBeforeClose, tabIds }).toEqual({ answersBeforeClose: 0, tabIds: ["child-keep"] });
  });

  it("answers quit without a published fragment when a tab close outlasts the preparation budget", async () => {
    const workspace = quitWorkspace("slow");
    await mountQuitWindow("main", workspace);
    vi.useFakeTimers();
    const { finish, close } = await beginSlowTabClose(workspace);
    try {
      await act(async () => {
        dispatchQuitTestEvent(QUIT_PREPARE_EVENT);
        await vi.advanceTimersByTimeAsync(1_100);
      });
      const responses = productionRaceMocks.quitPrepared.mock.calls.slice();
      await act(async () => { dispatchQuitTestEvent(QUIT_SAVE_EVENT); });
      expect(productionRaceMocks.quitSaved).toHaveBeenCalledOnce();
      expect(responses).toEqual([[false]]);
      expect(productionRaceMocks.publishWindowFragment.mock.calls.some(([, required]) => required)).toBe(false);
    } finally {
      await act(async () => { finish(); await close; });
      vi.useRealTimers();
    }
    expect(productionRaceMocks.quitPrepared.mock.calls).toEqual([[false]]);
  });

  it("refuses UI and peer socket tab additions after a child answers quit", async () => {
    const child = quitWorkspace("prepared-child");
    const label = "mycmux-w1";
    await mountQuitWindow(label, child);
    await act(async () => { dispatchQuitTestEvent(QUIT_PREPARE_EVENT); });
    expect(productionRaceMocks.quitPrepared).toHaveBeenCalledExactlyOnceWith(true);

    const pane = child.panes[0];
    const context = webPaneCommandContext("pane.declare_tab");
    await act(async () => {
      useWorkspaceLayoutStore.getState().addTabToPane(child.id, pane.id, "shell", "terminal");
      await dispatchQuitTestEvent(PEER_COMMAND_EVENTS.request, {
        requestId: "add-after-prepare", targetWindow: label, replyWindow: "main", cmd: "pane.declare_tab",
        args: { paneId: pane.id, label: "Late tab" }, expiresAt: context.deadline, context,
      });
    });
    const reply = productionRaceMocks.emitTo.mock.calls.find((call: unknown[]) => call[1] === PEER_COMMAND_EVENTS.response);
    const tabIds = useWorkspaceListStore.getState().getWorkspace(child.id)?.panes[0].tabs.map((tab) => tab.id);
    expect({ tabIds, reply }).toEqual({
      tabIds: pane.tabs.map((tab) => tab.id),
      reply: ["main", PEER_COMMAND_EVENTS.response, {
        requestId: "add-after-prepare", ownerWindow: label, error: expect.stringMatching(/quit|shut/i),
      }],
    });
  });

  it("refreshes live PTYs on every save and falls back with one warning when the IPC fails", async () => {
    const source: Workspace = {
      id: "live-workspace", name: "Live", gridTemplateId: "1x1", status: "running", createdAt: 1,
      panes: [{ id: "live-pane", sessionId: "cold-pty", agentId: "codex", activeTabId: "cold-tab", tabs: [
        { id: "cold-tab", sessionId: "cold-pty", agentId: "codex", type: "terminal", agentKind: "codex", agentSessionId: "conversation" },
        { id: "live-tab", sessionId: "live-pty", agentId: "codex", type: "terminal", agentKind: "codex", agentSessionId: "conversation" },
      ] }],
    };
    productionRaceMocks.readAgentSessionMappings.mockResolvedValue({});
    productionRaceMocks.loadPersistentData.mockResolvedValue({
      supported: true, schemaVersion: 1,
      data: { schema_version: 1, workspaces: [], settings: { theme_id: "default" } },
    });
    const Harness = () => { useWorkspacePersist(); return null; };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(createElement(Harness)));
    await vi.waitFor(() => expect(getPersistentSchemaState().status).toBe("supported"), { timeout: 10_000 });
    useWorkspaceListStore.setState({ workspaces: [source], activeWorkspaceId: source.id });
    productionRaceMocks.listRunningSessionIds.mockResolvedValueOnce(["live-pty"]);
    const snapshot = { workspaces: [source] };
    const signature = "a".repeat(64) as Sha256;
    await act(async () => {
      await requestImmediatePersist({ requestId: "live-first", revision: 1, signature, snapshot, snapshotDigest: hashCanonical(snapshot) });
    });
    expect(productionRaceMocks.listRunningSessionIds).toHaveBeenCalledTimes(1);
    const first = productionRaceMocks.savePersistentData.mock.calls.at(-1)![0];
    expect(first.workspaces[0].panes[0].tabs[1].agent_session_id).toBe("conversation");
    expect(first.workspaces[0].panes[0].tabs[0].agent_session_id).toBeNull();

    const error = new Error("running ids unavailable");
    productionRaceMocks.listRunningSessionIds.mockRejectedValueOnce(error);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await act(async () => {
        await requestImmediatePersist({ requestId: "live-fallback", revision: 2, signature, snapshot, snapshotDigest: hashCanonical(snapshot) });
      });
      expect(productionRaceMocks.listRunningSessionIds).toHaveBeenCalledTimes(2);
      const fallback = productionRaceMocks.savePersistentData.mock.calls.at(-1)![0];
      expect(fallback.workspaces[0].panes[0].tabs[0].agent_session_id).toBe("conversation");
      expect(fallback.workspaces[0].panes[0].tabs[1].agent_session_id).toBeNull();
      expect(warn.mock.calls.filter(([message]) => message === "[persist] Failed to list running session ids:")).toEqual([["[persist] Failed to list running session ids:", error]]);
    } finally {
      warn.mockRestore();
    }
  });

  it("writes committed dock ownership immediately even when the layout payload is unchanged", async () => {
    productionRaceMocks.readAgentSessionMappings.mockResolvedValue({});
    productionRaceMocks.loadPersistentData.mockResolvedValue({
      supported: true, schemaVersion: 1,
      data: { schema_version: 1, workspaces: [], settings: { theme_id: "default" } },
    });
    const Harness = () => { useWorkspacePersist(); return null; };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(createElement(Harness)));
    await vi.waitFor(() => expect(productionRaceMocks.claimLeader).toHaveBeenCalledTimes(2));
    vi.useFakeTimers();
    try {
      expect(productionRaceMocks.savePersistentData).not.toHaveBeenCalled();
      expect(productionRaceMocks.dockSaveHandler).not.toBeNull();
      await act(async () => productionRaceMocks.dockSaveHandler?.());
      expect(productionRaceMocks.savePersistentData).toHaveBeenCalledTimes(1);
      await act(async () => productionRaceMocks.dockSaveHandler?.());
      expect(productionRaceMocks.savePersistentData).toHaveBeenCalledTimes(2);
      expect(productionRaceMocks.savePersistentData.mock.calls[0][0])
        .toEqual(productionRaceMocks.savePersistentData.mock.calls[1][0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("schedules once after transition exit and never after cleanup", () => {
    const schedule = vi.fn();
    const markDirty = vi.fn();
    const original = useWorkspaceListStore.getState();
    const controller = installWorkspacePersistenceAutosaveController({ schedule, markDirty });
    try {
      runLayoutTransition("grouping-commit", () => {
        useWorkspaceListStore.setState({ layoutRevision: original.layoutRevision + 1 });
        useWorkspaceListStore.setState({ layoutRevision: original.layoutRevision + 2 });
        expect(schedule).not.toHaveBeenCalled();
      });
      expect(markDirty).toHaveBeenCalledTimes(2);
      expect(schedule).toHaveBeenCalledTimes(1);
      controller.dispose();
      useWorkspaceListStore.setState({ layoutRevision: original.layoutRevision + 3 });
      expect(schedule).toHaveBeenCalledTimes(1);
    } finally {
      controller.dispose();
      useWorkspaceListStore.setState(original, true);
    }
  });

  it("keeps close-like immediate and deferred autosaves sealed until hydration finishes", async () => {
    __resetPersistenceCoordinatorForTests();
    const schedule = vi.fn();
    const persist = vi.fn();
    const gate = createTransitionAwareAutosaveGate(schedule);
    registerPersistenceLeader({ windowId: "main", persist });
    let releaseMapping!: () => void;
    const delayedMapping = new Promise<void>((resolve) => { releaseMapping = resolve; });

    const hydration = publishPersistentSchemaAfterHydration(1, async () => {
      await delayedMapping;
    });
    gate.request();
    const snapshot = { workspaces: [] };
    const signature = "a".repeat(64) as Sha256;
    await expect(requestImmediatePersist({
      requestId: "close-during-hydrate",
      revision: 1,
      signature,
      snapshot,
      snapshotDigest: hashCanonical(snapshot),
    })).resolves.toMatchObject({ status: "failed", retryScheduled: false });

    expect(getPersistentSchemaState()).toEqual({ status: "pending" });
    expect(persist).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();

    releaseMapping();
    await hydration;

    expect(getPersistentSchemaState()).toEqual({ status: "supported", schemaVersion: 1 });
    expect(schedule).toHaveBeenCalledOnce();
    gate.dispose();
  });

  it("keeps the real close and autosave paths sealed through startup mapping and restore", async () => {
    __resetPersistenceCoordinatorForTests();
    const original = useWorkspaceListStore.getState();
    let releaseMapping!: () => void;
    productionRaceMocks.readAgentSessionMappings.mockImplementationOnce(() => new Promise((resolve) => {
      releaseMapping = () => resolve({});
    }));
    productionRaceMocks.loadPersistentData.mockResolvedValue({
      schemaVersion: 1,
      supported: true,
      data: {
        schema_version: 1,
        workspaces: [{
          id: "persisted-workspace",
          name: "Persisted workspace",
          grid_template_id: "single",
          panes: [{ pane_id: "persisted-pane", agent_id: "shell", label: null, tabs: null }],
          created_at: 1,
        }],
        settings: {
          font_size: 14,
          line_height: 1.2,
          font_family: "monospace",
          theme_id: "default",
        },
      },
    });

    const Harness = () => {
      useWorkspacePersist();
      return null;
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(createElement(Harness)));
    await vi.waitFor(() => expect(productionRaceMocks.readAgentSessionMappings).toHaveBeenCalledOnce(), { timeout: 10_000 });
    await vi.waitFor(() => expect(productionRaceMocks.closeHandler).not.toBeNull(), { timeout: 10_000 });

    act(() => {
      useWorkspaceListStore.setState({ layoutRevision: original.layoutRevision + 1 });
    });
    const preventDefault = vi.fn();
    await act(async () => {
      await productionRaceMocks.closeHandler?.({ preventDefault });
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(getPersistentSchemaState()).toEqual({ status: "pending" });
    expect(productionRaceMocks.restoreWorkspaceConfigs).not.toHaveBeenCalled();
    expect(productionRaceMocks.savePersistentData).not.toHaveBeenCalled();
    expect(productionRaceMocks.confirm).toHaveBeenCalledWith(
      "ワークスペースを保存できていません。保存せずに終了しますか？",
      expect.objectContaining({ kind: "warning" }),
    );
    expect(productionRaceMocks.destroy).not.toHaveBeenCalled();

    await act(async () => {
      releaseMapping();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(productionRaceMocks.restoreWorkspaceConfigs).toHaveBeenCalledOnce(), { timeout: 10_000 });
    expect(getPersistentSchemaState()).toEqual({ status: "supported", schemaVersion: 1 });
    expect(productionRaceMocks.savePersistentData).not.toHaveBeenCalled();

    await act(async () => root?.unmount());
    root = null;
    useWorkspaceListStore.setState(original, true);
  });

  it("stamps grouping current only after canonical hydration succeeds", async () => {
    __resetPersistenceCoordinatorForTests();
    let releaseMapping!: () => void;
    productionRaceMocks.readAgentSessionMappings.mockImplementationOnce(() => new Promise((resolve) => {
      releaseMapping = () => resolve({});
    }));
    productionRaceMocks.loadPersistentData.mockResolvedValue({
      schemaVersion: 1,
      supported: true,
      data: {
        schema_version: 1,
        workspaces: [],
        settings: {
          font_size: 14,
          line_height: 1.2,
          font_family: "monospace",
          theme_id: "default",
        },
      },
    });

    const Harness = () => {
      useWorkspacePersist();
      return null;
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(createElement(Harness)));
    await vi.waitFor(() => expect(productionRaceMocks.readAgentSessionMappings).toHaveBeenCalledOnce(), { timeout: 10_000 });

    const schemaEvents: string[] = [];
    const unsubscribeCanonical = subscribePersistentSchemaState((state) => {
      if (state.status === "supported") schemaEvents.push("canonical:supported");
    });
    const unsubscribeGrouping = useGroupingRuntimeStore.subscribe((state, previous) => {
      if (!previous.persistentSchema.migrationComplete && state.persistentSchema.migrationComplete) {
        schemaEvents.push("grouping:current");
      }
    });
    try {
      expect(getPersistentSchemaState()).toEqual({ status: "pending" });
      expect(useGroupingRuntimeStore.getState().persistentSchema).toMatchObject({
        loadedSchemaVersion: null,
        migrationComplete: false,
      });
      expect(() => assertGroupingSchemaCompatible()).toThrowError(/schema/);

      await act(async () => {
        releaseMapping();
        await Promise.resolve();
      });
      await vi.waitFor(() => expect(schemaEvents).toEqual([
        "canonical:supported",
        "grouping:current",
      ]), { timeout: 10_000 });
      expect(getPersistentSchemaState()).toEqual({ status: "supported", schemaVersion: 1 });
      expect(useGroupingRuntimeStore.getState().persistentSchema).toMatchObject({
        loadedSchemaVersion: 1,
        migrationComplete: true,
      });
    } finally {
      unsubscribeGrouping();
      unsubscribeCanonical();
    }
  });

  it("quarantines a hydrate exception and requires an explicit unsaved close choice", async () => {
    __resetPersistenceCoordinatorForTests();
    const initialGroupingSchemaEpoch = useGroupingRuntimeStore.getState().persistentSchema.schemaEpoch;
    productionRaceMocks.loadPersistentData.mockResolvedValue({
      schemaVersion: 1,
      supported: true,
      data: {
        schema_version: 1,
        workspaces: [{
          id: "hydrate-failure-workspace",
          name: "Hydrate failure workspace",
          grid_template_id: "single",
          panes: [{ pane_id: "hydrate-failure-pane", agent_id: "shell", label: null, tabs: null }],
          created_at: 1,
        }],
        settings: {
          font_size: 14,
          line_height: 1.2,
          font_family: "monospace",
          theme_id: "default",
        },
      },
    });
    productionRaceMocks.readAgentSessionMappings.mockResolvedValue({});
    productionRaceMocks.restoreWorkspaceConfigs.mockImplementation(() => {
      throw new Error("restore exploded");
    });

    const Harness = () => {
      useWorkspacePersist();
      return null;
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(createElement(Harness)));
    await vi.waitFor(() => expect(productionRaceMocks.restoreWorkspaceConfigs).toHaveBeenCalledOnce(), { timeout: 10_000 });
    await vi.waitFor(() => expect(getPersistentSchemaState()).toMatchObject({
      status: "quarantined",
      reason: "hydrationFailed",
    }), { timeout: 10_000 });

    expect(useToastStore.getState().toasts.map((toast) => toast.message)).toContain(
      "保存データの読み込みに失敗したため、この起動中は保存を停止しました。ワークスペースは保存できていません。",
    );
    expect(useGroupingRuntimeStore.getState().persistentSchema).toMatchObject({
      migrationComplete: false,
      schemaEpoch: initialGroupingSchemaEpoch + 1,
    });
    expect(() => assertGroupingSchemaCompatible()).toThrowError(/schema/);
    const preventDefault = vi.fn();
    await act(async () => productionRaceMocks.closeHandler?.({ preventDefault }));

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(productionRaceMocks.savePersistentData).not.toHaveBeenCalled();
    expect(productionRaceMocks.confirm).toHaveBeenCalledWith(
      "ワークスペースを保存できていません。保存せずに終了しますか？",
      expect.objectContaining({ kind: "warning" }),
    );
    expect(productionRaceMocks.destroy).not.toHaveBeenCalled();
  });

  it.each([
    [
      { kind: "unsupportedPlatform", message: "unsupported platform" },
      "unsupportedPlatform",
      "この環境では data.json を安全に保存できないため、この起動中は保存を停止しました。元の data.json は変更していません。",
    ],
    [
      { kind: "invalidPayloadSchema", schemaVersion: 999, message: "payload mismatch" },
      "invalidPayloadSchema",
      "保存しようとした data.json の schema 999 が現在の形式と一致しないため、この起動中は保存を停止しました。元の data.json は変更していません。",
    ],
  ] as const)(
    "stops retry and close saves for terminal %s failures",
    async (saveError, reason, diagnostic) => {
      productionRaceMocks.loadPersistentData.mockResolvedValue({
        schemaVersion: 1,
        supported: true,
        data: {
          schema_version: 1,
          workspaces: [],
          settings: {
            font_size: 14,
            line_height: 1.2,
            font_family: "monospace",
            theme_id: "default",
          },
        },
      });
      productionRaceMocks.readAgentSessionMappings.mockResolvedValue({});
      productionRaceMocks.savePersistentData.mockRejectedValue(saveError);

      const Harness = () => {
        useWorkspacePersist();
        return null;
      };
      host = document.createElement("div");
      document.body.appendChild(host);
      root = createRoot(host);
      await act(async () => root?.render(createElement(Harness)));
      await vi.waitFor(() => expect(productionRaceMocks.closeHandler).not.toBeNull(), { timeout: 10_000 });
      await vi.waitFor(() => expect(useGroupingRuntimeStore.getState().persistentSchema.migrationComplete).toBe(true), { timeout: 10_000 });
      const groupingSchemaEpochBeforeFailure = useGroupingRuntimeStore.getState().persistentSchema.schemaEpoch;

      const snapshot = { workspaces: [] };
      await expect(requestImmediatePersist({
        requestId: `terminal-${reason}`,
        revision: 1,
        signature: "a".repeat(64) as Sha256,
        snapshot,
        snapshotDigest: hashCanonical(snapshot),
      })).resolves.toMatchObject({ status: "failed", retryScheduled: false });

      expect(getPersistentSchemaState()).toMatchObject({
        status: "quarantined",
        reason,
        requiresUnsavedConfirmation: true,
      });
      expect(useGroupingRuntimeStore.getState().persistentSchema).toMatchObject({
        migrationComplete: false,
        schemaEpoch: groupingSchemaEpochBeforeFailure + 1,
      });
      expect(() => assertGroupingSchemaCompatible()).toThrowError(/schema/);
      expect(productionRaceMocks.savePersistentData).toHaveBeenCalledOnce();
      expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual([diagnostic]);
      await act(async () => productionRaceMocks.closeHandler?.({ preventDefault: vi.fn() }));
      expect(productionRaceMocks.savePersistentData).toHaveBeenCalledOnce();
      expect(productionRaceMocks.confirm).toHaveBeenCalledWith(
        "ワークスペースを保存できていません。保存せずに終了しますか？",
        expect.objectContaining({ kind: "warning" }),
      );
      expect(productionRaceMocks.destroy).not.toHaveBeenCalled();

      productionRaceMocks.confirm.mockResolvedValueOnce(true);
      await act(async () => productionRaceMocks.closeHandler?.({ preventDefault: vi.fn() }));
      expect(productionRaceMocks.savePersistentData).toHaveBeenCalledOnce();
      expect(productionRaceMocks.confirm).toHaveBeenCalledTimes(2);
      expect(productionRaceMocks.destroy).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["leadership chain", "claim"],
    ["loadPersistentData", "load"],
  ] as const)("quarantines an untyped %s rejection instead of leaving schema pending", async (_label, stage) => {
    __resetPersistenceCoordinatorForTests();
    if (stage === "claim") {
      productionRaceMocks.claimLeader.mockRejectedValueOnce(new Error("leadership failed"));
    } else {
      productionRaceMocks.loadPersistentData.mockRejectedValueOnce(new Error("load failed"));
    }

    const Harness = () => {
      useWorkspacePersist();
      return null;
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(createElement(Harness)));

    await vi.waitFor(() => expect(getPersistentSchemaState()).toMatchObject({
      status: "quarantined",
      reason: "hydrationFailed",
      requiresUnsavedConfirmation: true,
    }), { timeout: 10_000 });
    expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual([
      "保存データの読み込みに失敗したため、この起動中は保存を停止しました。ワークスペースは保存できていません。",
    ]);
    expect(() => assertGroupingSchemaCompatible()).toThrowError(/schema/);
    expect(productionRaceMocks.savePersistentData).not.toHaveBeenCalled();
  });

  it("classifies a typed load rejection before quarantining persistence", async () => {
    __resetPersistenceCoordinatorForTests();
    productionRaceMocks.loadPersistentData.mockRejectedValueOnce({
      kind: "unsupportedPlatform",
      message: "unsupported platform",
    });

    const Harness = () => {
      useWorkspacePersist();
      return null;
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(createElement(Harness)));

    await vi.waitFor(() => expect(getPersistentSchemaState()).toMatchObject({
      status: "quarantined",
      reason: "unsupportedPlatform",
      requiresUnsavedConfirmation: true,
    }), { timeout: 10_000 });
    expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual([
      "この環境では data.json を安全に保存できないため、この起動中は保存を停止しました。元の data.json は変更していません。",
    ]);
    expect(() => assertGroupingSchemaCompatible()).toThrowError(/schema/);
  });

  it("requires an unsaved close choice after load-time future-schema quarantine with new workspace tabs", async () => {
    __resetPersistenceCoordinatorForTests();
    productionRaceMocks.loadPersistentData.mockResolvedValueOnce({
      schemaVersion: 999,
      supported: false,
      data: null,
    });

    const Harness = () => {
      useWorkspacePersist();
      return null;
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(createElement(Harness)));
    await vi.waitFor(() => expect(productionRaceMocks.closeHandler).not.toBeNull(), { timeout: 10_000 });
    await vi.waitFor(() => expect(getPersistentSchemaState()).toMatchObject({
      status: "quarantined",
      reason: "unsupportedSchema",
      schemaVersion: 999,
      requiresUnsavedConfirmation: true,
    }), { timeout: 10_000 });

    const unsavedWorkspace: Workspace = {
      id: "load-future-schema-unsaved-workspace",
      name: "Unsaved workspace",
      gridTemplateId: "single",
      panes: [{
        id: "load-future-schema-unsaved-pane",
        agentId: "shell",
        sessionId: "load-future-schema-unsaved-session",
        tabs: [{
          id: "load-future-schema-unsaved-tab",
          sessionId: "load-future-schema-unsaved-session",
          agentId: "shell",
          type: "terminal",
        }],
        activeTabId: "load-future-schema-unsaved-tab",
      }],
      splitColumns: [["load-future-schema-unsaved-pane"]],
      columnWidths: [1],
      rowHeightsPerCol: [[1]],
      status: "running",
      createdAt: 1,
    };
    act(() => {
      useWorkspaceListStore.setState((state) => ({
        workspaces: [unsavedWorkspace],
        activeWorkspaceId: unsavedWorkspace.id,
        layoutRevision: state.layoutRevision + 1,
      }));
    });

    const rejectedPreventDefault = vi.fn();
    await act(async () => productionRaceMocks.closeHandler?.({ preventDefault: rejectedPreventDefault }));

    expect(rejectedPreventDefault).toHaveBeenCalledOnce();
    expect(productionRaceMocks.savePersistentData).not.toHaveBeenCalled();
    expect(productionRaceMocks.confirm).toHaveBeenCalledWith(
      "新しい形式の設定ファイルを検出したため、この起動中の変更は保存されません。終了しますか？",
      expect.objectContaining({ kind: "warning" }),
    );
    expect(productionRaceMocks.destroy).not.toHaveBeenCalled();

    productionRaceMocks.confirm.mockResolvedValueOnce(true);
    const acceptedPreventDefault = vi.fn();
    await act(async () => productionRaceMocks.closeHandler?.({ preventDefault: acceptedPreventDefault }));

    expect(acceptedPreventDefault).toHaveBeenCalledOnce();
    expect(productionRaceMocks.savePersistentData).not.toHaveBeenCalled();
    expect(productionRaceMocks.confirm).toHaveBeenCalledTimes(2);
    expect(productionRaceMocks.destroy).toHaveBeenCalledOnce();
  });

  it("requires an explicit unsaved close choice after a future-schema save failure", async () => {
    productionRaceMocks.loadPersistentData.mockResolvedValue({
      schemaVersion: 1,
      supported: true,
      data: {
        schema_version: 1,
        workspaces: [],
        settings: {
          font_size: 14,
          line_height: 1.2,
          font_family: "monospace",
          theme_id: "default",
        },
      },
    });
    productionRaceMocks.readAgentSessionMappings.mockResolvedValue({});

    const Harness = () => {
      useWorkspacePersist();
      return null;
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(createElement(Harness)));
    await vi.waitFor(() => expect(productionRaceMocks.closeHandler).not.toBeNull(), { timeout: 10_000 });

    const snapshot = { workspaces: [] };
    const signature = "a".repeat(64) as Sha256;
    const snapshotDigest = hashCanonical(snapshot);
    let saveAttempt = 0;
    productionRaceMocks.savePersistentData.mockImplementation(async () => {
      saveAttempt += 1;
      if (saveAttempt === 2) {
        throw {
          kind: "unsupportedSchema",
          schemaVersion: 999,
          message: "future schema",
        };
      }
    });
    await expect(requestImmediatePersist({
      requestId: "same-snapshot-first",
      revision: 1,
      signature,
      snapshot,
      snapshotDigest,
    })).resolves.toMatchObject({ status: "saved" });
    expect(productionRaceMocks.savePersistentData).toHaveBeenCalledOnce();

    const unsavedWorkspace: Workspace = {
      id: "future-schema-unsaved-workspace",
      name: "Unsaved workspace",
      gridTemplateId: "single",
      panes: [{
        id: "future-schema-unsaved-pane",
        agentId: "shell",
        sessionId: "future-schema-unsaved-session",
        tabs: [{
          id: "future-schema-unsaved-tab",
          sessionId: "future-schema-unsaved-session",
          agentId: "shell",
          type: "terminal",
        }],
        activeTabId: "future-schema-unsaved-tab",
      }],
      splitColumns: [["future-schema-unsaved-pane"]],
      columnWidths: [1],
      rowHeightsPerCol: [[1]],
      status: "running",
      createdAt: 1,
    };
    act(() => {
      useWorkspaceListStore.setState((state) => ({
        workspaces: [unsavedWorkspace],
        activeWorkspaceId: unsavedWorkspace.id,
        layoutRevision: state.layoutRevision + 1,
      }));
    });

    await expect(requestImmediatePersist({
      requestId: "same-snapshot-second",
      revision: 2,
      signature,
      snapshot,
      snapshotDigest,
    })).resolves.toMatchObject({ status: "failed", retryScheduled: false });

    expect(productionRaceMocks.savePersistentData).toHaveBeenCalledTimes(2);
    expect(getPersistentSchemaState()).toMatchObject({
      status: "quarantined",
      reason: "unsupportedSchema",
      schemaVersion: 999,
      requiresUnsavedConfirmation: true,
    });
    expect(() => assertGroupingSchemaCompatible()).toThrowError(/schema/);

    const rejectedPreventDefault = vi.fn();
    await act(async () => productionRaceMocks.closeHandler?.({
      preventDefault: rejectedPreventDefault,
    }));
    expect(rejectedPreventDefault).toHaveBeenCalledOnce();
    expect(productionRaceMocks.confirm).toHaveBeenCalledWith(
      "新しい形式の設定ファイルを検出したため、この起動中の変更は保存されません。終了しますか？",
      expect.objectContaining({ kind: "warning" }),
    );
    expect(productionRaceMocks.destroy).not.toHaveBeenCalled();

    productionRaceMocks.confirm.mockResolvedValueOnce(true);
    const acceptedPreventDefault = vi.fn();
    await act(async () => productionRaceMocks.closeHandler?.({
      preventDefault: acceptedPreventDefault,
    }));
    expect(acceptedPreventDefault).toHaveBeenCalledOnce();
    expect(productionRaceMocks.confirm).toHaveBeenCalledTimes(2);
    expect(productionRaceMocks.destroy).toHaveBeenCalledOnce();
  });

  it("does not report a close save as successful when quarantine wins an in-flight race", async () => {
    productionRaceMocks.loadPersistentData.mockResolvedValue({
      schemaVersion: 1,
      supported: true,
      data: {
        schema_version: 1,
        workspaces: [],
        settings: {
          font_size: 14,
          line_height: 1.2,
          font_family: "monospace",
          theme_id: "default",
        },
      },
    });
    productionRaceMocks.readAgentSessionMappings.mockResolvedValue({});
    let rejectSave!: (error: unknown) => void;
    productionRaceMocks.savePersistentData.mockReturnValue(new Promise((_, reject) => {
      rejectSave = reject;
    }));

    const Harness = () => {
      useWorkspacePersist();
      return null;
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(createElement(Harness)));
    await vi.waitFor(() => expect(productionRaceMocks.closeHandler).not.toBeNull(), { timeout: 10_000 });

    const snapshot = { workspaces: [] };
    const immediate = requestImmediatePersist({
      requestId: "terminal-inflight-race",
      revision: 1,
      signature: "a".repeat(64) as Sha256,
      snapshot,
      snapshotDigest: hashCanonical(snapshot),
    });
    await vi.waitFor(() => expect(productionRaceMocks.savePersistentData).toHaveBeenCalledOnce(), { timeout: 10_000 });
    const close = productionRaceMocks.closeHandler?.({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(productionRaceMocks.getPtyMetadataSnapshot).toHaveBeenCalledTimes(2), { timeout: 10_000 });
    quarantinePersistentWrites({
      reason: "hydrationFailed",
      diagnostic: "hydrate failed during an in-flight save",
      requiresUnsavedConfirmation: true,
    });
    rejectSave({ kind: "unsupportedPlatform", message: "unsupported platform" });

    await immediate;
    await close;
    expect(productionRaceMocks.confirm).toHaveBeenCalledWith(
      "ワークスペースを保存できていません。保存せずに終了しますか？",
      expect.objectContaining({ kind: "warning" }),
    );
    expect(productionRaceMocks.destroy).not.toHaveBeenCalled();
    expect(productionRaceMocks.savePersistentData).toHaveBeenCalledOnce();
  });
  it.each(["mappings", "fragments"] as const)(
    "does not write after losing the role while awaiting %s",
    async (pausedRead) => {
      productionRaceMocks.loadPersistentData.mockResolvedValue({
        schemaVersion: 1, supported: true,
        data: { schema_version: 1, workspaces: [], settings: {
          font_size: 14, line_height: 1.2, font_family: "monospace", theme_id: "default",
        } },
      });
      productionRaceMocks.readAgentSessionMappings.mockResolvedValue({});
      const Harness = () => { useWorkspacePersist(); return null; };
      host = document.createElement("div");
      document.body.appendChild(host);
      root = createRoot(host);
      await act(async () => root?.render(createElement(Harness)));
      await vi.waitFor(() => expect(productionRaceMocks.claimLeader).toHaveBeenCalledTimes(2), { timeout: 10_000 });
      expect(hasWindowRole()).toBe(true);
      expect(getPersistentSchemaState().status).toBe("supported");

      let resume!: () => void;
      let entered = false;
      const read = pausedRead === "mappings"
        ? productionRaceMocks.readAgentSessionMappings : productionRaceMocks.getWindowFragments;
      read.mockImplementationOnce(() => new Promise((resolve) => {
        entered = true;
        resume = () => resolve(pausedRead === "mappings" ? {} : []);
      }));
      const snapshot = { workspaces: [] };
      const request = {
        requestId: `role-loss-${pausedRead}`, revision: 1,
        signature: "a".repeat(64) as Sha256,
        snapshot, snapshotDigest: hashCanonical(snapshot),
      };
      const pending = requestImmediatePersist(request);
      await vi.waitFor(() => expect(entered).toBe(true), { timeout: 10_000 });
      setWindowRole(false);
      expect(getPersistentSchemaState().status).toBe("supported");
      await act(async () => { resume(); await pending; });
      expect(productionRaceMocks.savePersistentData).not.toHaveBeenCalled();

      // A new owner can still write: role loss must not quarantine storage.
      setWindowRole(true);
      await act(async () => { await requestImmediatePersist({ ...request, requestId: "successor" }); });
      expect(productionRaceMocks.savePersistentData).toHaveBeenCalledOnce();
    },
  );

});
