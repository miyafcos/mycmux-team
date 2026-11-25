// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ open: vi.fn(), ready: vi.fn(), send: vi.fn(), invoke: vi.fn(), visit: vi.fn(), attachment: vi.fn(), reading: vi.fn() }));
vi.mock("../../src/lib/presendReadingClient", () => ({ requestPresendReading: mocks.reading, cancelPresendReading: vi.fn() }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke }));
vi.mock("../../src/lib/tearout/runtime", async original => ({ ...await original<typeof import("../../src/lib/tearout/runtime")>(),
  waitForTearoutReceiver: mocks.ready, sendTearoutWorkspaces: mocks.send, visitTearoutLocation: mocks.visit }));
vi.mock("../../src/components/terminal/XTermWrapper", () => ({ hasTerminalBuffer: () => false, getTerminalWriteCounter: () => 0, getTerminalBufferLines: () => [] }));
vi.mock("../../src/lib/tearout/sessionAttachment", async original => ({ ...await original<typeof import("../../src/lib/tearout/sessionAttachment")>(),
  expectTearoutAttachments: (ids: string[]) => ({ prepared: Promise.resolve(), ready: mocks.attachment(ids), dispose: () => {} }) }));
import * as ipc from "../../src/lib/ipc";
import { usePresendReading } from "../../src/components/composer/usePresendReading";
import { ensurePresendTab, forgetPresendTab, presendTab, setPresendTabEnabled } from "../../src/lib/presendReading";
import { restoreWorkspaceConfigs } from "../../src/lib/workspaceRestore";
import { useAiSettingsStore } from "../../src/stores/aiSettingsStore";
import { useComposerStore } from "../../src/stores/composerStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
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

  it("keeps a tab off and sends no reading after its workspace returns", async () => {
    const sessionId = "pty-two";
    const draft = "A draft waiting in the original window";
    const settings = useSettingsStore.getState();
    const aiEnabled = useAiSettingsStore.getState().aiEnabled;
    const remainder = { ...source(), id: "remainder", panes: [], splitColumns: [] };
    useWorkspaceListStore.setState({ workspaces: [source(), remainder] });
    setPresendTabEnabled(sessionId, false);
    ensurePresendTab(sessionId).attempted.add("earlier-attempt");
    useComposerStore.getState().setDraft(sessionId, draft);
    mocks.reading.mockResolvedValue(null);
    const root = createRoot(document.createElement("div"));
    function ReturnedTab() {
      usePresendReading(sessionId, draft, "claude");
      return null;
    }
    try {
      expect(await tearOutWorkspaceToNewWindow("source")).toBe("child");
      expect(useWorkspaceListStore.getState().workspaces).toEqual([remainder]);
      restoreWorkspaceConfigs(mocks.send.mock.calls[0][1]);
      expect(useWorkspaceListStore.getState().getWorkspace("source")?.panes[0].tabs[1].sessionId).toBe(sessionId);
      useSettingsStore.setState({ presendReadingEnabled: true, paneComposerEnabled: true });
      useAiSettingsStore.setState({ aiEnabled: true });
      vi.useFakeTimers();
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      act(() => root.render(createElement(ReturnedTab)));
      await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
      expect(mocks.reading).not.toHaveBeenCalled();
      expect(presendTab(sessionId)?.enabled).toBe(false);
      expect(presendTab(sessionId)?.attempted.size).toBe(0);
      expect(useComposerStore.getState().draftBySession[sessionId]).toBe(draft);
    } finally {
      act(() => root.unmount());
      vi.useRealTimers();
      vi.unstubAllGlobals();
      useSettingsStore.setState({ presendReadingEnabled: settings.presendReadingEnabled, paneComposerEnabled: settings.paneComposerEnabled });
      useAiSettingsStore.setState({ aiEnabled });
      forgetPresendTab(sessionId);
      useComposerStore.getState().clearDraft(sessionId);
    }
  });

  it("preserves the source tab's choice and attempts after a rejected workspace receipt", async () => {
    const sessionId = "pty-two";
    setPresendTabEnabled(sessionId, false);
    ensurePresendTab(sessionId).attempted.add("earlier-attempt");
    mocks.send.mockRejectedValueOnce(new Error("tearout_receive_failed"));
    try {
      await expect(tearOutWorkspaceToNewWindow("source")).rejects.toThrow("tearout_receive_failed");
      expect(presendTab(sessionId)).toEqual({ enabled: false, attempted: new Set(["earlier-attempt"]) });
    } finally {
      forgetPresendTab(sessionId);
    }
  });
  it("keeps source ownership until receiver is ready and waits for its receipt", async () => {
    let ready!: () => void, received!: () => void;
    mocks.ready.mockReturnValue(new Promise<void>(resolve => { ready = resolve; }));
    mocks.send.mockReturnValue(new Promise<void>(resolve => { received = resolve; }));
    const before = useWorkspaceListStore.getState().workspaces;
    const pending = tearOutWorkspaceToNewWindow("source");
    await vi.waitFor(() => {
      const creationId = mocks.open.mock.calls[0][0].creationId;
      expect(creationId).toEqual(expect.any(String));
      expect(mocks.ready).toHaveBeenCalledWith("child", creationId, expect.any(AbortSignal));
    }, { timeout: 2000 });
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
      await vi.waitFor(() => expect(mocks.ready).toHaveBeenCalledOnce(), { timeout: 10000 }); feed(8); ready();
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
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledOnce(), { timeout: 10000 });
    expect(settled).toBe(false);
    expect(mocks.invoke.mock.calls.some(([command, args]) => command === "tearout_phase" && args.phase === "received")).toBe(false);
    received();
    expect(await pending).toMatchObject({ operationId: request.operationId, status: "moved", phase: "cleaned", receipt: "acknowledged", destinationWindow: "child" });
  });

  it("reports a rejected receipt as rolled back and keeps the original display", async () => {
    const original = useWorkspaceListStore.getState().workspaces;
    mocks.send.mockRejectedValueOnce(new Error("receipt_rejected"));
    const request = createPaneMoveRequest({ kind: "workspace", workspaceId: "source", label: "Source" }, { kind: "window" });
    const result = await executePaneMove(request);
    expect(result).toMatchObject({ status: "failed", phase: "rolled_back", receipt: "pending", reason: "receipt_rejected" });
    expect(useWorkspaceListStore.getState().workspaces).toEqual(original);
    expect(mocks.invoke).toHaveBeenCalledWith("tearout_retire", { label: "child", creationId: request.operationId });
  });
});

it("keeps reading off in the receiving window and after returning until the tab is explicitly enabled", async () => {
  const sessionId = "pty-two";
  const draft = "A draft waiting in the original window";
  const remainder = { ...source(), id: "remainder", panes: [], splitColumns: [] };
  useWorkspaceListStore.setState({ workspaces: [source(), remainder] });
  setPresendTabEnabled(sessionId, false);
  ensurePresendTab(sessionId).attempted.add("earlier-attempt");
  useComposerStore.getState().setDraft(sessionId, draft);
  let sharedEnabled = false;
  let releasePreference: (() => void) | undefined;
  mocks.invoke.mockImplementation(async (command: string, input?: { sessionId?: string; tabEnabled?: boolean }) => {
    if (command !== "configure_presend_reading" || input?.sessionId !== sessionId) return undefined;
    if (typeof input.tabEnabled === "boolean") {
      sharedEnabled = input.tabEnabled;
      return sharedEnabled;
    }
    return new Promise(resolve => { releasePreference = () => resolve(sharedEnabled); });
  });
  mocks.reading.mockResolvedValue(null);
  const root = createRoot(document.createElement("div"));

  async function arrive(configs: Parameters<typeof restoreWorkspaceConfigs>[0]) {
    vi.resetModules();
    const [
      { usePresendReading: readInWindow }, { presendTab: tabInWindow },
      { restoreWorkspaceConfigs: restoreInWindow }, { useWorkspaceListStore: workspacesInWindow },
      { useSettingsStore: settingsInWindow }, { useAiSettingsStore: aiInWindow },
      { useComposerStore: composerInWindow }, { publishCodexRestoreNoticeEpoch },
      { tearOutWorkspaceToNewWindow: transferInWindow }, ipcInWindow,
    ] = await Promise.all([
      import("../../src/components/composer/usePresendReading"), import("../../src/lib/presendReading"),
      import("../../src/lib/workspaceRestore"), import("../../src/stores/workspaceListStore"),
      import("../../src/stores/settingsStore"), import("../../src/stores/aiSettingsStore"),
      import("../../src/stores/composerStore"), import("../../src/lib/codexRestoreLifecycle"),
      import("../../src/lib/workspaceTearOut"), import("../../src/lib/ipc"),
    ]);
    expect(tabInWindow(sessionId)).toBeUndefined();
    workspacesInWindow.setState({ workspaces: [] });
    restoreInWindow(configs);
    expect(workspacesInWindow.getState().getWorkspace("source")?.panes[0].tabs[1].sessionId).toBe(sessionId);
    settingsInWindow.setState({ presendReadingEnabled: true, paneComposerEnabled: true, presendReadingProvider: "claude" });
    aiInWindow.setState({ aiEnabled: true });
    publishCodexRestoreNoticeEpoch(sessionId, 7);
    let reading!: ReturnType<typeof readInWindow>;
    function ArrivedTab() {
      const text = composerInWindow(state => state.draftBySession[sessionId] ?? "");
      reading = readInWindow(sessionId, text, "claude", true);
      return null;
    }
    await act(async () => root.render(createElement(ArrivedTab)));
    return {
      edit: (text: string) => act(() => {
        reading.recordEdit(text);
        composerInWindow.getState().setDraft(sessionId, text);
      }),
      isEnabled: () => reading.tabEnabled,
      toggle: () => act(async () => reading.toggle()),
      returnToParent: async () => {
        const open = vi.spyOn(ipcInWindow, "openWorkspaceWindow").mockResolvedValue("parent");
        const alive = vi.spyOn(ipcInWindow, "isSessionAlive").mockResolvedValue(true);
        try {
          expect(await transferInWindow("source")).toBe("parent");
          return mocks.send.mock.calls[mocks.send.mock.calls.length - 1]![1];
        } finally {
          open.mockRestore();
          alive.mockRestore();
        }
      },
    };
  }
  const wait = () => act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  try {
    expect(await tearOutWorkspaceToNewWindow("source")).toBe("child");
    expect(useWorkspaceListStore.getState().workspaces).toEqual([remainder]);
    expect(presendTab(sessionId)?.attempted.size).toBe(0);
    const payload = mocks.send.mock.calls[0][1];
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const child = await arrive(payload);
    child.edit("synthetic edit before the receiving window reads the preference");
    await wait();
    expect(mocks.reading).not.toHaveBeenCalled();
    await act(async () => releasePreference?.());
    child.edit("synthetic edit with the tab off in the receiving window");
    await wait();
    expect(child.isEnabled()).toBe(false);
    expect(mocks.reading).not.toHaveBeenCalled();
    act(() => root.render(null));
    const returned = await child.returnToParent();
    expect(mocks.send.mock.calls.map(([window]) => window)).toEqual(["child", "parent"]);
    const parent = await arrive(returned);
    await act(async () => releasePreference?.());
    parent.edit("synthetic edit after returning to the original window");
    await wait();
    expect(parent.isEnabled()).toBe(false);
    expect(mocks.reading).not.toHaveBeenCalled();
    await parent.toggle();
    await wait();
    expect(mocks.reading).not.toHaveBeenCalled();
    parent.edit("synthetic edit after explicitly enabling the tab");
    await wait();
    expect(mocks.reading).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
    forgetPresendTab(sessionId);
    useComposerStore.getState().clearDraft(sessionId);
  }
});
