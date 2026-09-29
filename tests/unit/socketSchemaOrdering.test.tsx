// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  label: "main", load: vi.fn(), mapping: vi.fn(), save: vi.fn(), restore: vi.fn(), settings: vi.fn(),
  close: null as null | ((event: { preventDefault: () => void }) => Promise<void>),
  confirm: vi.fn(async () => false),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: mocks.label,
  onCloseRequested: async (handler: typeof mocks.close) => { mocks.close = handler; return () => {}; },
  destroy: vi.fn(async () => {}),
}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: mocks.confirm }));
vi.mock("../../src/lib/paneCloseConfirmation", () => ({ confirmPaneClose: vi.fn(async () => true) }));
vi.mock("../../src/lib/ipc", async (original) => ({
  ...await original<typeof import("../../src/lib/ipc")>(),
  claimLeader: vi.fn(async () => true), loadPersistentData: mocks.load,
  readAgentSessionMappings: mocks.mapping, savePersistentData: mocks.save, getAppSettings: mocks.settings,
  getWindowFragments: vi.fn(async () => []), takePendingAdoption: vi.fn(async () => []),
  publishWindowFragment: vi.fn(async () => {}), getPtyMetadataSnapshot: vi.fn(async () => ({})),
  listPets: vi.fn(async () => []), setAppFrontendVisible: vi.fn(async () => {}),
  setWindowCloseIntent: vi.fn(async () => {}), killSession: vi.fn(async () => {}),
}));
vi.mock("../../src/lib/workspaceRestore", async (original) => ({
  ...await original<typeof import("../../src/lib/workspaceRestore")>(), restoreWorkspaceConfigs: mocks.restore,
}));
import { useWorkspacePersist, toConfig } from "../../src/components/layout/SocketListener";
import { persistenceStrings } from "../../src/lib/persistenceStrings";
import { __resetPersistenceCoordinatorForTests, getPersistentSchemaState, isPersistenceWriteAllowed,
  requestImmediatePersist, subscribePersistentSchemaState } from "../../src/lib/workspacePersistenceCoordinator";
import { hashCanonical, persistentLayoutProjection } from "../../src/lib/persistentLayoutProjection";
import { resetWindowContextCacheForTests, setWindowRole } from "../../src/lib/windowContext";
import { __resetGroupingRuntimeForTests } from "../../src/stores/groupingRuntimeStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useThemeStore } from "../../src/stores/themeStore";
import { useAiSettingsStore } from "../../src/stores/aiSettingsStore";
import { useToastStore, __resetToastStoreForTests } from "../../src/stores/toastStore";
import type { Workspace } from "../../src/types";

function workspace(): Workspace {
  const tab = { id: "tab-schema", sessionId: "pty-schema", agentId: "claude-code", type: "terminal" as const,
    agentKind: "claude" as const, agentSessionId: "11111111-1111-4111-8111-111111111111" };
  return { id: "schema-ws", name: "Schema", gridTemplateId: "1x1", createdAt: 1, status: "running",
    panes: [{ id: "pane-schema", agentId: tab.agentId, sessionId: tab.sessionId, tabs: [tab], activeTabId: tab.id }],
    splitColumns: [["pane-schema"]], columnWidths: [1], rowHeightsPerCol: [[1]],
  };
}
const settings = { schema_version: 1, theme_id: "default", font_size: 14, line_height: 1.2, font_family: "monospace" };
const data = () => ({ schema_version: 1, settings, workspaces: [toConfig(workspace())] });

describe("schema quarantine call ordering", () => {
  let root: Root;
  let host: HTMLDivElement;
  let calls: string[];
  let stop: () => void;
  const original = useWorkspaceListStore.getState();
  beforeEach(() => {
    vi.useFakeTimers(); vi.resetAllMocks(); calls = [];
    __resetGroupingRuntimeForTests(); __resetPersistenceCoordinatorForTests(); __resetToastStoreForTests();
    mocks.label = "main"; mocks.close = null; resetWindowContextCacheForTests(); setWindowRole(false);
    useWorkspaceListStore.setState({ ...original, workspaces: [workspace()], activeWorkspaceId: "schema-ws" }, true);
    mocks.load.mockImplementation(async () => { calls.push("load"); return { supported: true, schemaVersion: 1, data: data() }; });
    mocks.mapping.mockImplementation(async () => { calls.push(`mapping:${getPersistentSchemaState().status}`); return {}; });
    mocks.save.mockImplementation(async () => { calls.push("save"); });
    mocks.restore.mockImplementation(() => { calls.push(`restore:${getPersistentSchemaState().status}`); return { activePaneSessionId: null }; });
    mocks.settings.mockResolvedValue(settings); mocks.confirm.mockResolvedValue(false);
    vi.spyOn(useThemeStore.getState(), "hydrateSettings").mockImplementation(() => { calls.push(`theme:${getPersistentSchemaState().status}`); });
    vi.spyOn(useAiSettingsStore.getState(), "hydrateAiSettings").mockImplementation(() => { calls.push(`ai:${getPersistentSchemaState().status}`); });
    vi.spyOn(useToastStore.getState(), "pushToast").mockImplementation(() => { calls.push(`toast:${getPersistentSchemaState().status}`); return "toast"; });
    stop = subscribePersistentSchemaState((state) => calls.push(state.status));
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); stop(); host.remove();
    __resetToastStoreForTests(); useWorkspaceListStore.setState(original, true);
    setWindowRole(false); vi.restoreAllMocks(); vi.useRealTimers();
  });
  async function mount() {
    const Harness = () => { useWorkspacePersist(); return null; };
    await act(async () => root.render(createElement(Harness)));
    await flush();
  }
  async function flush() { await act(async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); }); }
  async function dirtyAndWait(ms: number) {
    await act(async () => { useWorkspaceListStore.getState().renameWorkspace("schema-ws", `Changed ${Date.now()}`); });
    await act(async () => vi.advanceTimersByTimeAsync(ms)); await flush();
  }
  async function blockedRequest() {
    const snapshot = persistentLayoutProjection(useWorkspaceListStore.getState().workspaces);
    await expect(requestImmediatePersist({ requestId: "blocked", revision: 1,
      snapshot, snapshotDigest: hashCanonical(snapshot), signature: hashCanonical(snapshot),
    })).resolves.toMatchObject({ status: "failed", retryScheduled: false });
  }
  it.each([false, true])("quarantines unsupported startup before hydration mapping and writes (data present: %s)", async (present) => {
    mocks.load.mockImplementation(async () => { calls.push("load"); return { supported: false, schemaVersion: 999, data: present ? data() : null }; });
    await mount(); await dirtyAndWait(60_000); await blockedRequest();
    expect(calls).toEqual(["load", "quarantined", "toast:quarantined"]);
    expect(getPersistentSchemaState()).toMatchObject({ reason: "unsupportedSchema", schemaVersion: 999 });
    expect(useToastStore.getState().pushToast).toHaveBeenCalledWith(persistenceStrings.unsupportedSchema(999), "error");
    expect(mocks.mapping).not.toHaveBeenCalled(); expect(mocks.restore).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("publishes support after mapping AI hydration restore and the startup save hold", async () => {
    let release!: (value: object) => void;
    mocks.mapping.mockImplementationOnce(() => { calls.push(`mapping:${getPersistentSchemaState().status}`); return new Promise((resolve) => { release = resolve; }); });
    await mount();
    expect(calls).toEqual(["load", "mapping:pending"]);
    expect(isPersistenceWriteAllowed()).toBe(false);
    await blockedRequest();
    release({}); await flush();
    expect(calls).toEqual(["load", "mapping:pending", "theme:pending", "ai:pending", "restore:pending", "supported"]);
    expect(isPersistenceWriteAllowed()).toBe(true);
    await dirtyAndWait(600);
    expect(mocks.save).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(60_000)); await flush();
    expect(mocks.save).toHaveBeenCalled();
  });
  it("quarantines a child schema failure before any hydration or disk write", async () => {
    mocks.label = "mycmux-w2"; resetWindowContextCacheForTests();
    mocks.settings.mockRejectedValue({ kind: "unsupportedSchema", schemaVersion: 999, message: "future" });
    await mount(); await dirtyAndWait(60_000); await blockedRequest();
    expect(calls).toEqual(["quarantined", "toast:quarantined"]);
    expect(mocks.load).not.toHaveBeenCalled(); expect(mocks.mapping).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
    expect(useToastStore.getState().pushToast).toHaveBeenCalledWith(persistenceStrings.unsupportedSchema(999), "error");
  });
  it("quarantines failed hydration and uses the shared unsaved quit prompt", async () => {
    mocks.restore.mockImplementation(() => { calls.push("restore:pending"); throw new Error("restore failed"); });
    await mount(); await dirtyAndWait(60_000); await blockedRequest();
    expect(calls).toEqual(["load", "mapping:pending", "theme:pending", "ai:pending", "restore:pending", "quarantined", "toast:quarantined"]);
    expect(getPersistentSchemaState()).toMatchObject({ reason: "hydrationFailed" });
    expect(useToastStore.getState().pushToast).toHaveBeenCalledWith(persistenceStrings.hydrationFailed, "error");
    await act(async () => mocks.close!({ preventDefault: vi.fn() }));
    expect(mocks.confirm).toHaveBeenCalledWith(persistenceStrings.unsavedQuit, expect.any(Object));
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it.each([
    ["unsupportedSchema", persistenceStrings.unsupportedSchema(999)],
    ["unsupportedPlatform", persistenceStrings.unsupportedPlatform],
    ["invalidPayloadSchema", persistenceStrings.invalidPayloadSchema(999)],
  ] as const)("quarantines %s save rejection before notification and prevents retry", async (kind, diagnostic) => {
    mocks.load.mockResolvedValue({ supported: true, schemaVersion: 1, data: { ...data(), workspaces: [] } });
    await mount(); calls.length = 0;
    mocks.save.mockImplementation(async () => { calls.push("save"); throw { kind, schemaVersion: 999, message: "terminal error" }; });
    await dirtyAndWait(600);
    expect(calls.filter((item) => !item.startsWith("mapping:"))).toEqual(["save", "quarantined", "toast:quarantined"]);
    expect(getPersistentSchemaState()).toMatchObject({ reason: kind, requiresUnsavedConfirmation: true, diagnostic });
    expect(useToastStore.getState().pushToast).toHaveBeenCalledWith(diagnostic, "error");
    await dirtyAndWait(60_000); await blockedRequest();
    expect(mocks.save).toHaveBeenCalledOnce();
  });
});
