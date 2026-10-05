// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ open: vi.fn(), ready: vi.fn(), send: vi.fn(), invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke }));
vi.mock("../../src/lib/tearout/runtime", async original => ({ ...await original<typeof import("../../src/lib/tearout/runtime")>(),
  waitForTearoutReceiver: mocks.ready, sendTearoutWorkspaces: mocks.send }));
vi.mock("../../src/components/terminal/XTermWrapper", () => ({ hasTerminalBuffer: () => false, getTerminalWriteCounter: () => 0, getTerminalBufferLines: () => [] }));
vi.mock("../../src/lib/tearout/sessionAttachment", async original => ({ ...await original<typeof import("../../src/lib/tearout/sessionAttachment")>(),
  expectTearoutAttachments: () => ({ ready: Promise.resolve(), dispose: () => {} }) }));
import * as ipc from "../../src/lib/ipc";
import { commitPaneDragDrop } from "../../src/hooks/usePaneDragSource";
import { tearOutWorkspaceToNewWindow } from "../../src/lib/workspaceTearOut";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useToastStore } from "../../src/stores/toastStore";
import type { Workspace } from "../../src/types";
function source(): Workspace {
  return { id: "source", name: "Source", createdAt: 1, status: "running", gridTemplateId: "1x1", splitColumns: [["pane"]],
    panes: [{ id: "pane", agentId: "shell", sessionId: "pty-two", activeTabId: "two", pinnedTabId: "one",
      tabs: ["one", "two", "three"].map(id => ({ id, sessionId: "pty-" + id, agentId: "shell", type: "terminal" })) }] };
}
beforeEach(() => {
  vi.restoreAllMocks(); vi.clearAllMocks();
  useWorkspaceListStore.setState({ workspaces: [source()], activeWorkspaceId: "source", lastActivePaneByWorkspace: { source: "pty-two" } });
  useUiStore.setState({ activePaneId: "pty-two", zoomedPaneId: "pane" }); useToastStore.setState({ toasts: [] });
  vi.spyOn(ipc, "openWorkspaceWindow").mockImplementation(mocks.open);
  vi.spyOn(ipc, "isSessionAlive").mockResolvedValue(true);
  mocks.open.mockResolvedValue("child"); mocks.ready.mockResolvedValue(undefined); mocks.send.mockResolvedValue("token"); mocks.invoke.mockResolvedValue(undefined);
});
describe("legacy tear-out confirmation and rollback", () => {
  it.each(["open", "boot", "receive"])("restores original order, pin and selection after %s failure", async stage => {
    mocks[stage === "open" ? "open" : stage === "boot" ? "ready" : "send"].mockRejectedValue(new Error("tearout_" + stage + "_failed"));
    const before = structuredClone(useWorkspaceListStore.getState().workspaces);
    commitPaneDragDrop({ kind: "tab", workspaceId: "source", paneId: "pane", tabId: "one", label: "One" },
      { kind: "new-window", screenX: 800, screenY: 600 });
    await vi.waitFor(() => expect(useToastStore.getState().toasts.some(toast => toast.kind === "error")).toBe(true), { timeout: 2000 });
    expect(useWorkspaceListStore.getState().workspaces).toEqual(before);
    expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe("source");
    expect(useWorkspaceListStore.getState().lastActivePaneByWorkspace).toEqual({ source: "pty-two" });
    expect(useUiStore.getState()).toMatchObject({ activePaneId: "pty-two", zoomedPaneId: "pane" });
    expect(mocks.invoke.mock.calls.some(([command]) => command === "kill_session" || command === "create_session")).toBe(false);
  });
  it("keeps source ownership until receiver is ready and waits for its receipt", async () => {
    let ready!: () => void, received!: () => void;
    mocks.ready.mockReturnValue(new Promise<void>(resolve => { ready = resolve; }));
    mocks.send.mockReturnValue(new Promise<void>(resolve => { received = resolve; }));
    const before = useWorkspaceListStore.getState().workspaces;
    const pending = tearOutWorkspaceToNewWindow("source");
    await vi.waitFor(() => expect(mocks.ready).toHaveBeenCalledWith("child"), { timeout: 2000 });
    try {
      expect(useWorkspaceListStore.getState().workspaces).toEqual(before);
      expect(mocks.open.mock.calls[0][0].deferredAdoption).toBe(true);
      ready(); await vi.waitFor(() => expect(mocks.send).toHaveBeenCalled(), { timeout: 2000 });
      expect(useWorkspaceListStore.getState().workspaces).toEqual([]);
    } finally { ready(); received(); await pending; }
  });
});
