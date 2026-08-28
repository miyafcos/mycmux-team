// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const productionRaceMocks = vi.hoisted(() => ({
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
  restoreWorkspaceConfigs: vi.fn(),
  savePersistentData: vi.fn(),
  setAppFrontendVisible: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: productionRaceMocks.confirm,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "main",
    onCloseRequested: productionRaceMocks.onCloseRequested,
  }),
}));

vi.mock("../../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/ipc")>();
  return {
    ...actual,
    claimLeader: productionRaceMocks.claimLeader,
    getPtyMetadataSnapshot: productionRaceMocks.getPtyMetadataSnapshot,
    getWindowFragments: productionRaceMocks.getWindowFragments,
    listPets: productionRaceMocks.listPets,
    loadPersistentData: productionRaceMocks.loadPersistentData,
    quitApp: productionRaceMocks.quitApp,
    readAgentSessionMappings: productionRaceMocks.readAgentSessionMappings,
    savePersistentData: productionRaceMocks.savePersistentData,
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

describe("SocketListener production autosave subscriptions", () => {
  let host: HTMLDivElement | null = null;
  let root: Root | null = null;
  const originalWorkspaceState = useWorkspaceListStore.getState();

  beforeEach(() => {
    vi.clearAllMocks();
    __resetGroupingRuntimeForTests();
    __resetPersistenceCoordinatorForTests();
    markPersistentSchemaSupported(1);
    __resetToastStoreForTests();
    productionRaceMocks.closeHandler = null;
    productionRaceMocks.claimLeader.mockResolvedValue(true);
    productionRaceMocks.confirm.mockResolvedValue(false);
    productionRaceMocks.getPtyMetadataSnapshot.mockResolvedValue({});
    productionRaceMocks.getWindowFragments.mockResolvedValue([]);
    productionRaceMocks.listPets.mockResolvedValue([]);
    productionRaceMocks.onCloseRequested.mockImplementation(async (handler) => {
      productionRaceMocks.closeHandler = handler;
      return () => {};
    });
    productionRaceMocks.quitApp.mockResolvedValue(undefined);
    productionRaceMocks.restoreWorkspaceConfigs.mockReturnValue({ activePaneSessionId: null });
    productionRaceMocks.savePersistentData.mockResolvedValue(undefined);
    productionRaceMocks.setAppFrontendVisible.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    __resetToastStoreForTests();
    useWorkspaceListStore.setState(originalWorkspaceState, true);
    host?.remove();
    root = null;
    host = null;
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
    await vi.waitFor(() => expect(productionRaceMocks.readAgentSessionMappings).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(productionRaceMocks.closeHandler).not.toBeNull());

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
    expect(productionRaceMocks.quitApp).not.toHaveBeenCalled();

    await act(async () => {
      releaseMapping();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(productionRaceMocks.restoreWorkspaceConfigs).toHaveBeenCalledOnce());
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
    await vi.waitFor(() => expect(productionRaceMocks.readAgentSessionMappings).toHaveBeenCalledOnce());

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
      ]));
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
    await vi.waitFor(() => expect(productionRaceMocks.restoreWorkspaceConfigs).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(getPersistentSchemaState()).toMatchObject({
      status: "quarantined",
      reason: "hydrationFailed",
    }));

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
    expect(productionRaceMocks.quitApp).not.toHaveBeenCalled();
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
      await vi.waitFor(() => expect(productionRaceMocks.closeHandler).not.toBeNull());
      await vi.waitFor(() => expect(useGroupingRuntimeStore.getState().persistentSchema.migrationComplete).toBe(true));
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
      expect(productionRaceMocks.quitApp).not.toHaveBeenCalled();

      productionRaceMocks.confirm.mockResolvedValueOnce(true);
      await act(async () => productionRaceMocks.closeHandler?.({ preventDefault: vi.fn() }));
      expect(productionRaceMocks.savePersistentData).toHaveBeenCalledOnce();
      expect(productionRaceMocks.confirm).toHaveBeenCalledTimes(2);
      expect(productionRaceMocks.quitApp).toHaveBeenCalledOnce();
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
    }));
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
    }));
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
    await vi.waitFor(() => expect(productionRaceMocks.closeHandler).not.toBeNull());
    await vi.waitFor(() => expect(getPersistentSchemaState()).toMatchObject({
      status: "quarantined",
      reason: "unsupportedSchema",
      schemaVersion: 999,
      requiresUnsavedConfirmation: true,
    }));

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
    expect(productionRaceMocks.quitApp).not.toHaveBeenCalled();

    productionRaceMocks.confirm.mockResolvedValueOnce(true);
    const acceptedPreventDefault = vi.fn();
    await act(async () => productionRaceMocks.closeHandler?.({ preventDefault: acceptedPreventDefault }));

    expect(acceptedPreventDefault).toHaveBeenCalledOnce();
    expect(productionRaceMocks.savePersistentData).not.toHaveBeenCalled();
    expect(productionRaceMocks.confirm).toHaveBeenCalledTimes(2);
    expect(productionRaceMocks.quitApp).toHaveBeenCalledOnce();
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
    await vi.waitFor(() => expect(productionRaceMocks.closeHandler).not.toBeNull());

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
    expect(productionRaceMocks.quitApp).not.toHaveBeenCalled();

    productionRaceMocks.confirm.mockResolvedValueOnce(true);
    const acceptedPreventDefault = vi.fn();
    await act(async () => productionRaceMocks.closeHandler?.({
      preventDefault: acceptedPreventDefault,
    }));
    expect(acceptedPreventDefault).toHaveBeenCalledOnce();
    expect(productionRaceMocks.confirm).toHaveBeenCalledTimes(2);
    expect(productionRaceMocks.quitApp).toHaveBeenCalledOnce();
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
    await vi.waitFor(() => expect(productionRaceMocks.closeHandler).not.toBeNull());

    const snapshot = { workspaces: [] };
    const immediate = requestImmediatePersist({
      requestId: "terminal-inflight-race",
      revision: 1,
      signature: "a".repeat(64) as Sha256,
      snapshot,
      snapshotDigest: hashCanonical(snapshot),
    });
    await vi.waitFor(() => expect(productionRaceMocks.savePersistentData).toHaveBeenCalledOnce());
    const close = productionRaceMocks.closeHandler?.({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(productionRaceMocks.getPtyMetadataSnapshot).toHaveBeenCalledTimes(2));
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
    expect(productionRaceMocks.quitApp).not.toHaveBeenCalled();
    expect(productionRaceMocks.savePersistentData).toHaveBeenCalledOnce();
  });
});
