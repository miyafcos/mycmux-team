import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleSocketCommand } from "../../src/components/layout/socketCommands";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useUiStore } from "../../src/stores/uiStore";
import { resetPaneCloseOperationsForTests } from "../../src/lib/paneCloseOperation";
import { paneKindCapabilities } from "../../src/lib/paneKindCapabilities";
import type { PaneTab, Workspace } from "../../src/types";
const mocks = vi.hoisted(() => ({ kill: vi.fn(), write: vi.fn(), evict: vi.fn() }));
vi.mock("../../src/lib/ipc", async original => ({ ...await original<object>(), killSession: mocks.kill,
  writeToSession: mocks.write, writeToSessionGuarded: mocks.write, getWindowFragments: async () => [] }));
vi.mock("../../src/components/terminal/terminalCache", async original => ({ ...await original<object>(), evictTerminalCache: mocks.evict }));
function workspace(type?: PaneTab["type"], isDirty = false): Workspace {
  const tabs: PaneTab[] = [{ id: "target", sessionId: "pty-target", agentId: "shell", type, isDirty },
    { id: "keeper", sessionId: "pty-keeper", agentId: "shell", type: "terminal" }];
  return { id: "w", name: "Test", gridTemplateId: "1x1", createdAt: 0, status: "running",
    panes: [{ id: "p", sessionId: "pty-target", agentId: "shell", activeTabId: "target", tabs }] };
}
function replace(type?: PaneTab["type"], dirty = false) { useWorkspaceListStore.setState({ workspaces: [workspace(type, dirty)], activeWorkspaceId: "w" }); }
const retained = () => useWorkspaceListStore.getState().workspaces[0].panes[0].tabs.some(t => t.id === "target");
beforeEach(() => {
  vi.clearAllMocks(); mocks.kill.mockResolvedValue(undefined); resetPaneCloseOperationsForTests();
  replace("terminal"); usePaneMetadataStore.setState({ metadata: { "pty-target": { cwd: "/fixture" } }, volatileMetadata: {} });
  useUiStore.setState({ activePaneId: null });
});
describe("pane.close_tab kind capabilities and effects", () => {
  it.each([undefined, "terminal", "web", "browser", "launcher", "online"] as const)("closes %s and reports its actual effect", async type => {
    replace(type);
    expect(await handleSocketCommand("pane.close_tab", { sessionId: "pty-target" })).toEqual({
      workspaceId: "w", paneId: "p", tabId: "target", kind: type ?? "terminal", ...paneKindCapabilities({ type }),
      closed: true, effect: type === undefined || type === "terminal" ? "killed" : "hidden", reason: null,
    });
    expect(retained()).toBe(false);
    if (type === undefined || type === "terminal") expect(mocks.kill).toHaveBeenCalledExactlyOnceWith("pty-target");
    else expect(mocks.kill).not.toHaveBeenCalled();
  });
  it("preserves display-only close for a malformed saved null type", async () => {
    const tab = useWorkspaceListStore.getState().workspaces[0].panes[0].tabs[0];
    tab.type = null as unknown as PaneTab["type"];
    expect(await handleSocketCommand("pane.close_tab", { sessionId: "pty-target" })).toMatchObject({
      kind: "terminal", hasPty: true, closeEffect: "hide", closed: true, effect: "hidden",
    });
    expect(retained()).toBe(false); expect(mocks.kill).not.toHaveBeenCalled();
  });
  it("retains unsaved document edits and returns needs_confirmation without any termination", async () => {
    replace("browser", true);
    expect(await handleSocketCommand("pane.close_tab", { session_id: "pty-target" })).toMatchObject({
      kind: "browser", hasPty: true, persistent: false, transferable: true, closeEffect: "confirm_unsaved", sendable: false,
      closed: false, effect: "needs_confirmation", reason: "unsaved",
    });
    expect(retained()).toBe(true); expect(mocks.kill).not.toHaveBeenCalled(); expect(mocks.evict).not.toHaveBeenCalled();
    expect(usePaneMetadataStore.getState().metadata["pty-target"]).toBeDefined();
  });
  it("force explicitly closes an unsaved document without killing a process", async () => {
    replace("browser", true);
    expect(await handleSocketCommand("pane.close_tab", { sessionId: "pty-target", force: true })).toMatchObject({ kind: "browser", closed: true, effect: "hidden", reason: null });
    expect(retained()).toBe(false); expect(mocks.kill).not.toHaveBeenCalled();
  });
  it("force=false keeps the unsaved document", async () => {
    replace("browser", true);
    expect(await handleSocketCommand("pane.close_tab", { sessionId: "pty-target", force: false })).toMatchObject({ effect: "needs_confirmation", closed: false });
    expect(retained()).toBe(true);
  });
  it("declared terminals report hidden because no process was started", async () => {
    useWorkspaceListStore.getState().workspaces[0].panes[0].tabs[0].lifecycle = "declared";
    expect(await handleSocketCommand("pane.close_tab", { sessionId: "pty-target" })).toMatchObject({ kind: "terminal", closed: true, effect: "hidden" });
    expect(mocks.kill).not.toHaveBeenCalled();
  });
  it("waits for terminal termination and keeps the display until success", async () => {
    let done!: () => void;
    mocks.kill.mockReturnValueOnce(new Promise<void>(resolve => { done = resolve; }));
    const pending = handleSocketCommand("pane.close_tab", { sessionId: "pty-target" });
    await vi.waitFor(() => expect(mocks.kill).toHaveBeenCalledOnce());
    expect(retained()).toBe(true); expect(mocks.evict).not.toHaveBeenCalled(); done();
    expect(await pending).toMatchObject({ closed: true, effect: "killed" }); expect(retained()).toBe(false);
  });
  it("kill failure keeps the display and remains an error even with force", async () => {
    mocks.kill.mockRejectedValueOnce(new Error("denied"));
    await expect(handleSocketCommand("pane.close_tab", { sessionId: "pty-target", force: true })).rejects.toThrow("pane close termination failed");
    expect(retained()).toBe(true); expect(mocks.evict).not.toHaveBeenCalled();
  });
  it("force does not bypass the last-tab guard", async () => {
    useWorkspaceListStore.getState().workspaces[0].panes[0].tabs.pop();
    await expect(handleSocketCommand("pane.close_tab", { sessionId: "pty-target", force: true })).rejects.toThrow("refusing to close the last tab of the last pane");
    expect(mocks.kill).not.toHaveBeenCalled(); expect(retained()).toBe(true);
  });
  it("missing sessions retain the existing error", async () => {
    await expect(handleSocketCommand("pane.close_tab", { sessionId: "missing" })).rejects.toThrow("pane.close_tab session not found");
    expect(mocks.kill).not.toHaveBeenCalled();
  });
  it("rejects non-boolean force before closing", async () => {
    await expect(handleSocketCommand("pane.close_tab", { sessionId: "pty-target", force: "true" })).rejects.toThrow("force must be a boolean");
    expect(retained()).toBe(true); expect(mocks.kill).not.toHaveBeenCalled();
  });
  it.each(["web", "browser", "launcher", "online"] as const)("does not broaden terminal send to %s", async type => {
    replace(type);
    await expect(handleSocketCommand("pane.send_text", { sessionId: "pty-target", text: "hello" })).rejects.toThrow("requires a terminal tab");
    expect(mocks.write).not.toHaveBeenCalled(); expect(retained()).toBe(true);
  });
});
