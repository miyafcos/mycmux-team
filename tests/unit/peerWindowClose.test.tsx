// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  label: "main",
  handoff: vi.fn(async (_label: string, _event: string, _payload: unknown) => {}),
  takePending: vi.fn(async (): Promise<import("../../src/lib/ipc").WorkspaceConfig[]> => []),
  close: null as null | ((event: { preventDefault: () => void }) => Promise<void>),
  confirm: vi.fn(async () => true),
  intent: vi.fn(async (_closing: boolean) => {}),
  kill: vi.fn(async (_id: string) => {}),
  destroy: vi.fn(async () => {}),
  save: vi.fn(async (_data: import("../../src/lib/ipc").PersistentData) => {}),
  publish: vi.fn(async (_fragment: import("../../src/lib/ipc").WindowFragment) => {}),
  release: vi.fn(async () => 0),
  response: vi.fn(async (_id: string, _result: unknown, _error: string | null) => {}),
  quit: vi.fn(async () => {}),
  fragments: [] as Array<Record<string, unknown>>,
  events: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({
  label: mocks.label,
  outerPosition: async () => ({ x: 0, y: 0 }), scaleFactor: async () => 1,
  onCloseRequested: async (handler: typeof mocks.close) => { mocks.close = handler; return () => {}; },
  destroy: mocks.destroy,
}) }));
vi.mock("@tauri-apps/api/event", () => ({ emitTo: mocks.handoff, listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
  mocks.events.set(name, handler); return () => { mocks.events.delete(name); };
} }));
vi.mock("../../src/lib/paneCloseConfirmation", () => ({ confirmPaneClose: mocks.confirm }));
vi.mock("../../src/lib/ipc", async (original) => {
  const actual = await original<typeof import("../../src/lib/ipc")>();
  const settings = { schema_version: 1, theme_id: "default", font_size: 14, line_height: 1.2, font_family: "monospace" };
  return { ...actual,
    claimLeader: async () => true,
    loadPersistentData: async () => ({ supported: true, schemaVersion: 1, data: { schema_version: 1, workspaces: [], settings } }),
    getAppSettings: async () => settings,
    takePendingAdoption: mocks.takePending, getWindowFragments: async () => mocks.fragments,
    releaseWorkspaces: mocks.release, publishWindowFragment: mocks.publish, sendSocketResponse: mocks.response, getPtyMetadataSnapshot: async () => ({}),
    readAgentSessionMappings: async () => ({}), listPets: async () => [], setAppFrontendVisible: async () => {},
    savePersistentData: mocks.save, setWindowCloseIntent: mocks.intent,
    killSession: mocks.kill, quitApp: mocks.quit,
  };
});
import { useWorkspacePersist, toTransferConfig } from "../../src/components/layout/SocketListener";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { resetWindowContextCacheForTests, setWindowRole } from "../../src/lib/windowContext";
import { __resetPersistenceCoordinatorForTests, getPersistentSchemaState } from "../../src/lib/workspacePersistenceCoordinator";
import { __resetGroupingRuntimeForTests } from "../../src/stores/groupingRuntimeStore";
import type { Workspace } from "../../src/types";

function workspace(): Workspace {
  const tabs = ["victim-a", "victim-b"].map((sessionId) => ({ id: sessionId, sessionId, agentId: "shell", type: "terminal" as const }));
  return { id: "victim-ws", name: "Victim", gridTemplateId: "single", status: "running", createdAt: 1,
    panes: [{ id: "victim-pane", agentId: "shell", sessionId: "victim-a", tabs, activeTabId: "victim-a" }],
    splitColumns: [["victim-pane"]], columnWidths: [1], rowHeightsPerCol: [[1]],
  };
}
describe("native close-request path scopes its victims to the closing window", () => {
  let root: Root; let host: HTMLDivElement;
  const original = useWorkspaceListStore.getState();
  const alive = new Set<string>();
  beforeEach(() => {
    vi.clearAllMocks(); mocks.close = null; mocks.events.clear();
    __resetGroupingRuntimeForTests(); __resetPersistenceCoordinatorForTests();
    setWindowRole(false); resetWindowContextCacheForTests();
    mocks.confirm.mockResolvedValue(true);
    mocks.takePending.mockReset().mockResolvedValue([]);
    alive.clear(); ["victim-a", "victim-b", "keeper-a", "keeper-b"].forEach((id) => alive.add(id));
    mocks.kill.mockImplementation(async (id) => { alive.delete(id); });
    const keeper = workspace();
    keeper.id = "keeper-ws";
    keeper.panes[0].id = "keeper-pane";
    keeper.panes[0].sessionId = "keeper-a";
    keeper.panes[0].activeTabId = "keeper-a";
    keeper.panes[0].tabs = ["keeper-a", "keeper-b"].map((sessionId) => ({
      id: sessionId, sessionId, agentId: "shell", type: "terminal" as const,
    }));
    mocks.fragments = [{ window_label: "mycmux-w9", workspaces: [toTransferConfig(keeper)] }];
    useWorkspaceListStore.setState({ workspaces: [workspace()], activeWorkspaceId: "victim-ws" });
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); host.remove();
    useWorkspaceListStore.setState(original, true); setWindowRole(false);
  });
  async function boot(label: string) {
    mocks.label = label; resetWindowContextCacheForTests();
    const Harness = () => { useWorkspacePersist(); return null; };
    await act(async () => root.render(createElement(Harness)));
    await vi.waitFor(() => expect(getPersistentSchemaState().status).toBe("supported"));
    expect(mocks.close).not.toBeNull();
  }
  it.each([false, true])("a new-workspace drop creates a normal peer workspace (existing origin: %s)", async (hasOrigin) => {
    if (!hasOrigin) useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null });
    await boot("mycmux-w2");
    const dropRow = document.createElement("button");
    dropRow.dataset.dndNewWorkspaceTarget = "true"; document.body.appendChild(dropRow);
    const oldHit = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => dropRow });
    let frame: FrameRequestCallback | undefined;
    const frameSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { frame = callback; return 1; });
    const cancelSpy = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    try {
      for (const phase of ["start", "end"]) {
        await act(async () => {
          mocks.events.get("mycmux://detached-drag")!({ payload: {
            label: "mycmux-w8", workspaceId: "incoming", sessionId: "pty-carried", tabId: "carried",
            screenX: 10, screenY: 10, phase,
          } });
          frame?.(0);
          for (let i = 0; i < 12; i++) await Promise.resolve();
        });
      }
      expect(mocks.handoff).toHaveBeenCalledWith("mycmux-w8", "mycmux://detached-dock-request", {
        toLabel: "mycmux-w2", workspaceId: "incoming",
      });
      const incoming = toTransferConfig(workspace());
      incoming.id = "incoming"; incoming.detached = true;
      incoming.detached_from = { workspace_id: "victim-ws", pane_id: "victim-pane", tab_id: "carried", index: 1 };
      incoming.panes[0].pane_id = "carried-pane";
      incoming.panes[0].tabs = [{ tab_id: "carried", session_id: "pty-carried", agent_id: "shell", type: "terminal" }];
      incoming.panes[0].active_tab_id = "carried";
      mocks.takePending.mockResolvedValueOnce([incoming]);
      await act(async () => {
        mocks.events.get("mycmux://window-adopt")!({ payload: { to_label: "mycmux-w2" } });
        for (let i = 0; i < 12; i++) await Promise.resolve();
      });
      const owned = useWorkspaceListStore.getState().workspaces;
      expect(owned).toHaveLength(hasOrigin ? 2 : 1);
      const adopted = owned.find((ws) => ws.id === "incoming")!;
      expect(adopted.panes[0].tabs[0].sessionId).toBe("pty-carried");
      expect(adopted).not.toHaveProperty("detached", true);
      expect(mocks.events.has("mycmux://detached-drag")).toBe(true);
      expect(mocks.kill).not.toHaveBeenCalled();
      if (hasOrigin) expect(owned.find((ws) => ws.id === "victim-ws")!.panes[0].tabs).toHaveLength(2);
    } finally {
      frameSpy.mockRestore(); cancelSpy.mockRestore(); dropRow.remove();
      if (oldHit) Object.defineProperty(document, "elementFromPoint", oldHit);
      else Reflect.deleteProperty(document, "elementFromPoint");
    }
  });
  it("reactively enables docking for peer sidebars and excludes detached shells", async () => {
    await boot("mycmux-w2");
    expect(mocks.events.has("mycmux://detached-drag")).toBe(true);
    const detached = { ...workspace(), detached: true };
    detached.panes[0].tabs = detached.panes[0].tabs.slice(0, 1);
    await act(async () => useWorkspaceListStore.setState({ workspaces: [detached] }));
    expect(mocks.events.has("mycmux://detached-drag")).toBe(false);
    await act(async () => useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null }));
    expect(mocks.events.has("mycmux://detached-drag")).toBe(true);
  });
  it("adopts a detached return into the peer's own workspace preserving its PTY", async () => {
    const incoming = toTransferConfig(workspace());
    incoming.id = "incoming";
    incoming.detached = true;
    incoming.detached_from = { workspace_id: "victim-ws", pane_id: "victim-pane", tab_id: "carried", index: 1 };
    incoming.panes[0].pane_id = "carried-pane";
    incoming.panes[0].tabs = [{ tab_id: "carried", session_id: "pty-carried", agent_id: "shell", type: "terminal" }];
    incoming.panes[0].active_tab_id = "carried";
    mocks.takePending.mockResolvedValueOnce([incoming]);
    await boot("mycmux-w2");
    const owned = useWorkspaceListStore.getState().workspaces;
    expect(owned).toHaveLength(1);
    expect(owned[0].id).toBe("victim-ws");
    expect(owned[0].panes[0].tabs.map((tab) => tab.sessionId)).toEqual(["victim-a", "pty-carried", "victim-b"]);
    expect(mocks.kill).not.toHaveBeenCalled();
  });
  it.each(["main", "mycmux-w2"])("closing %s confirms its panes and leaves the keeper PTYs alive", async (label) => {
    await boot(label);
    mocks.save.mockClear();
    const preventDefault = vi.fn();
    await act(async () => mocks.close?.({ preventDefault }));
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(mocks.confirm).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ id: "victim-pane" })]), "workspace");
    expect(mocks.kill.mock.calls.map(([id]) => id)).toEqual(["victim-a", "victim-b"]);
    expect([...alive].sort()).toEqual(["keeper-a", "keeper-b"]);
    expect(mocks.intent).toHaveBeenCalledWith(true);
    expect(mocks.intent.mock.invocationCallOrder[0]).toBeLessThan(mocks.kill.mock.invocationCallOrder[0]);
    expect(mocks.kill.mock.invocationCallOrder[1]).toBeLessThan(mocks.destroy.mock.invocationCallOrder[0]);
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(mocks.quit).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
    expect(preventDefault.mock.invocationCallOrder[0]).toBeLessThan(mocks.confirm.mock.invocationCallOrder[0]);
    expect(mocks.intent.mock.invocationCallOrder[0]).toBeLessThan(mocks.takePending.mock.invocationCallOrder.at(-1)!);
    if (label === "main") {
      expect(mocks.save).toHaveBeenCalledOnce();
      expect(mocks.save.mock.invocationCallOrder[0]).toBeLessThan(mocks.intent.mock.invocationCallOrder[0]);
      expect(mocks.save.mock.calls[0][0].workspaces.map((ws) => ws.id).sort()).toEqual(["keeper-ws", "victim-ws"]);
    }
  });
  it.each(["main", "mycmux-w2"])("dispatches socket success and error only while %s owns the role", async (label) => {
    await boot(label);
    const socket = mocks.events.get("socket-request")!;
    await act(async () => { setWindowRole(false); });
    const count = useWorkspaceListStore.getState().workspaces.length;
    await act(async () => { await socket({ payload: { id: "ignored", cmd: "workspace.new", args: { name: "Ignored" } } }); });
    expect(useWorkspaceListStore.getState().workspaces).toHaveLength(count);
    expect(mocks.response).not.toHaveBeenCalled();
    await act(async () => { setWindowRole(true); });
    await act(async () => { await socket({ payload: { id: "success", cmd: "workspace.new", args: { name: "Socket" } } }); });
    expect(useWorkspaceListStore.getState().workspaces).toHaveLength(count + 1);
    expect(mocks.response).toHaveBeenCalledExactlyOnceWith("success", expect.objectContaining({ name: "Socket" }), null);
    await act(async () => { await socket({ payload: { id: "failure", cmd: "unknown-command", args: {} } }); });
    expect(mocks.response).toHaveBeenLastCalledWith("failure", null, "Unknown socket command: unknown-command");
  });
  it.each(["main", "mycmux-w2"])("publishes %s workspace changes regardless of its role", async (label) => {
    await boot(label);
    await act(async () => { setWindowRole(false); });
    mocks.publish.mockClear();
    await act(async () => useWorkspaceListStore.getState().renameWorkspace("victim-ws", "Changed"));
    await vi.waitFor(() => expect(mocks.publish).toHaveBeenCalled());
    expect(mocks.publish.mock.calls.at(-1)![0]).toMatchObject({ window_label: label,
      workspaces: [expect.objectContaining({ id: "victim-ws", name: "Changed" })] });
  });
  it("closes already committed incoming PTYs after recording close intent", async () => {
    await boot("mycmux-w2");
    const incoming = toTransferConfig(workspace());
    incoming.id = "incoming";
    incoming.panes[0].pane_id = "incoming-pane";
    incoming.panes[0].tabs = [{ tab_id: "incoming-tab", session_id: "pty-incoming-incoming-pane-incoming-tab", agent_id: "shell", type: "terminal" }];
    incoming.panes[0].active_tab_id = "incoming-tab";
    mocks.takePending.mockClear().mockResolvedValueOnce([incoming]);
    await act(async () => mocks.close!({ preventDefault: vi.fn() }));
    expect(mocks.kill.mock.calls.map(([id]) => id).sort()).toEqual(["pty-incoming-incoming-pane-incoming-tab", "victim-a", "victim-b"]);
    expect(mocks.intent.mock.invocationCallOrder[0]).toBeLessThan(mocks.takePending.mock.invocationCallOrder[0]);
    expect(mocks.takePending.mock.invocationCallOrder[0]).toBeLessThan(mocks.kill.mock.invocationCallOrder[0]);
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(mocks.quit).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });
  it("cancellation leaves all sessions and both windows untouched", async () => {
    mocks.confirm.mockResolvedValue(false);
    await boot("main");
    await act(async () => mocks.close?.({ preventDefault: vi.fn() }));
    expect(alive.size).toBe(4);
    expect(mocks.intent).not.toHaveBeenCalled();
    expect(mocks.kill).not.toHaveBeenCalled(); expect(mocks.destroy).not.toHaveBeenCalled();
  });
  it("leaves the window open and clears close intent when a local kill fails", async () => {
    mocks.kill.mockRejectedValueOnce(new Error("kill failed"));
    await boot("main");
    await act(async () => mocks.close?.({ preventDefault: vi.fn() }));
    expect(mocks.intent.mock.calls.map(([closing]) => closing)).toEqual([true, false]);
    expect(mocks.destroy).not.toHaveBeenCalled();
    expect(alive.has("keeper-a")).toBe(true);
    expect(alive.has("keeper-b")).toBe(true);
    expect(useWorkspaceListStore.getState().workspaces).toHaveLength(1);
  });
  it("coalesces repeated close requests while confirmation is pending", async () => {
    let decide!: (confirmed: boolean) => void;
    mocks.confirm.mockReturnValueOnce(new Promise((resolve) => { decide = resolve; }));
    await boot("main");
    const first = mocks.close?.({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce());
    const secondPrevent = vi.fn();
    await mocks.close?.({ preventDefault: secondPrevent });
    expect(secondPrevent).toHaveBeenCalledOnce();
    expect(mocks.confirm).toHaveBeenCalledOnce();
    await act(async () => { decide(false); await first; });
    expect(mocks.kill).not.toHaveBeenCalled();
    expect(mocks.destroy).not.toHaveBeenCalled();
  });

});
