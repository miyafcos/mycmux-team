// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ open: vi.fn(), ready: vi.fn(), send: vi.fn(), invoke: vi.fn(), visit: vi.fn(), attachment: vi.fn() }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke }));
vi.mock("../../src/lib/tearout/runtime", async original => ({ ...await original<typeof import("../../src/lib/tearout/runtime")>(),
  waitForTearoutReceiver: mocks.ready, sendTearoutWorkspaces: mocks.send, visitTearoutLocation: mocks.visit }));
vi.mock("../../src/components/terminal/XTermWrapper", () => ({ hasTerminalBuffer: () => false, getTerminalWriteCounter: () => 0, getTerminalBufferLines: () => [] }));
vi.mock("../../src/lib/tearout/sessionAttachment", async original => ({ ...await original<typeof import("../../src/lib/tearout/sessionAttachment")>(),
  expectTearoutAttachments: (ids: string[]) => ({ ready: mocks.attachment(ids), dispose: () => {} }) }));
import * as ipc from "../../src/lib/ipc";
import { termCache, type CachedTerm } from "../../src/components/terminal/terminalCache";
import { commitPaneDragDrop } from "../../src/hooks/usePaneDragSource";
import { tearOutWorkspaceToNewWindow } from "../../src/lib/workspaceTearOut";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useSessionAttentionStore } from "../../src/stores/sessionAttentionStore";
import { createPaneMoveRequest, executePaneMove } from "../../src/lib/paneMoveOperation";
import { useUiStore } from "../../src/stores/uiStore";
import { useToastStore } from "../../src/stores/toastStore";
import type { Workspace } from "../../src/types";
function source(): Workspace {
  return { id: "source", name: "Source", createdAt: 1, status: "running", gridTemplateId: "1x1", splitColumns: [["pane"]],
    panes: [{ id: "pane", agentId: "shell", sessionId: "pty-two", activeTabId: "two", pinnedTabId: "one",
      tabs: ["one", "two", "three"].map(id => ({ id, sessionId: "pty-" + id, agentId: "shell", type: "terminal" })) }] };
}
beforeEach(() => {
  vi.restoreAllMocks(); vi.clearAllMocks(); mocks.attachment.mockResolvedValue(undefined);
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
    useToastStore.getState().toasts.find(toast => toast.kind === "error")!.actions![0].run();
    expect(mocks.visit).toHaveBeenCalledWith("source", "pty-one");
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

it("retries failed legacy attachment with fresh live terminal cache entries", async () => {
  mocks.send.mockRejectedValue(new Error("tearout_receive_failed"));
  mocks.attachment.mockRejectedValueOnce(new Error("tearout_restore_attachment_timeout"));
  await expect(tearOutWorkspaceToNewWindow("source")).rejects.toThrow("tearout_receive_failed");
  expect(useToastStore.getState().toasts.some(toast => toast.message.includes("\u623b\u3057\u307e\u3057\u305f"))).toBe(false);
  const failed = useToastStore.getState().toasts.find(toast => toast.actions?.some(a => a.label.includes("\u4ed8\u3051\u76f4\u3057")))!;
  const ids = ["pty-one", "pty-two", "pty-three"], disposed = vi.fn();
  for (const id of ids) termCache.set(id, { term: { dispose: disposed }, unlistenExit: null } as unknown as CachedTerm);
  mocks.attachment.mockImplementation((sessions: string[]) => sessions.some(id => termCache.has(id))
    ? Promise.reject(new Error("tearout_restore_cached_attachment_failed")) : Promise.resolve());
  try {
    failed.actions![0].run();
    await vi.waitFor(() => expect(useToastStore.getState().toasts.some(toast => toast.message.includes("\u623b\u3057\u307e\u3057\u305f"))).toBe(true), { timeout: 2000 });
    expect(ids.every(id => !termCache.has(id))).toBe(true);
    expect(disposed).toHaveBeenCalledTimes(3);
  } finally { for (const id of ids) termCache.delete(id); }
});


describe("ordinary transport common move result", () => {
  it("retains source ownership if the execution changes while the receiver boots", async () => {
    const feed = (epoch: number) => useSessionAttentionStore.getState().applySnapshot({ server_epoch: "move-server", seq: epoch,
      sessions: [{ session_id: "pty-one", session_revision: epoch, status: { session_epoch: epoch, lifecycle: "alive", ui_state: "working",
        attention: { attention_id: null, kind: "none", detail: null, state_since: 0 } } }] });
    useSessionAttentionStore.getState().resetForTests(); feed(7);
    let ready!: () => void;
    mocks.ready.mockReturnValue(new Promise<void>(resolve => { ready = resolve; }));
    const original = useWorkspaceListStore.getState().workspaces;
    const pending = executePaneMove(createPaneMoveRequest({ kind: "workspace", workspaceId: "source", label: "Source" }, { kind: "window" }));
    try {
      await vi.waitFor(() => expect(mocks.ready).toHaveBeenCalledOnce()); feed(8); ready();
      expect(await pending).toMatchObject({ status: "failed", phase: "rolled_back", receipt: "pending", reason: expect.stringContaining("execution_changed") });
      expect(useWorkspaceListStore.getState().workspaces).toEqual(original); expect(mocks.send).not.toHaveBeenCalled();
    } finally { ready(); useSessionAttentionStore.getState().resetForTests(); }
  });

  it("does not report a received or cleaned move while its real receiver receipt is pending", async () => {
    let received!: () => void;
    mocks.send.mockReturnValue(new Promise<string>(resolve => { received = () => resolve("token"); }));
    const request = createPaneMoveRequest({ kind: "workspace", workspaceId: "source", label: "Source" }, { kind: "window" });
    let settled = false;
    const pending = executePaneMove(request).then(result => { settled = true; return result; });
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    expect(mocks.invoke.mock.calls.some(([command, args]) => command === "tearout_phase" && args.phase === "received")).toBe(false);
    received();
    expect(await pending).toMatchObject({ operationId: request.operationId, status: "moved", phase: "cleaned", receipt: "acknowledged", destinationWindow: "child" });
  });

  it("reports a rejected receipt as rolled back and keeps the original display", async () => {
    const original = useWorkspaceListStore.getState().workspaces;
    mocks.send.mockRejectedValueOnce(new Error("receipt_rejected"));
    const result = await executePaneMove(createPaneMoveRequest({ kind: "workspace", workspaceId: "source", label: "Source" }, { kind: "window" }));
    expect(result).toMatchObject({ status: "failed", phase: "rolled_back", receipt: "pending", reason: "receipt_rejected" });
    expect(useWorkspaceListStore.getState().workspaces).toEqual(original);
    expect(mocks.invoke).toHaveBeenCalledWith("tearout_retire", { label: "child" });
  });
});
