import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../src/types";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useComposerStore } from "../../src/stores/composerStore";
import { getClosedPaneCount, popClosedPane } from "../../src/stores/closedPaneStore";
import { useUiStore } from "../../src/stores/uiStore";
import { presendTab, setPresendTabEnabled } from "../../src/lib/presendReading";
import { fixture } from "./fixtures/paneClose";
import { applySweep, scanTabs } from "../../src/components/layout/tabSweep";
import { handleSocketCommand } from "../../src/components/layout/socketCommands";
import { toConfig } from "../../src/components/layout/SocketListener";
import { confirmPtyExit, publishCodexRestoreNoticeEpoch } from "../../src/lib/codexRestoreLifecycle";

const mocks = vi.hoisted(() => ({ kill: vi.fn(), confirm: vi.fn(), evict: vi.fn(), toast: vi.fn(), dismiss: vi.fn() }));
vi.mock("../../src/lib/ipc", async (original) => ({ ...await original<object>(), killSession: mocks.kill }));
vi.mock("../../src/lib/paneCloseConfirmation", () => ({ confirmPaneClose: mocks.confirm }));
vi.mock("../../src/components/terminal/terminalCache", async (original) => ({ ...await original<object>(), evictTerminalCache: mocks.evict }));
vi.mock("../../src/stores/toastStore", () => ({ useToastStore: { getState: () => ({ pushToast: mocks.toast, dismissToast: mocks.dismiss }) } }));
const { closePaneOperation, resetPaneCloseOperationsForTests, PANE_CLOSE_TIMEOUT_MS } = await import("../../src/lib/paneCloseOperation");
const target = { kind: "tab", workspaceId: "w", paneId: "p0", tabId: "t0-0" } as const;
function deferred() {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function replace(w: Workspace) { useWorkspaceListStore.setState({ workspaces: [w], activeWorkspaceId: "w" }); }
const bulkOptions = { commitBulkLayout: (workspaces: Workspace[]) => useWorkspaceListStore.getState()._replaceWorkspaces(workspaces) };
function retained() { return useWorkspaceListStore.getState().getWorkspace("w")!.panes.some(p => p.tabs.some(t => t.id === "t0-0")); }

beforeEach(() => {
  vi.clearAllMocks(); mocks.kill.mockResolvedValue(undefined); mocks.confirm.mockResolvedValue(true); mocks.toast.mockReturnValue("toast");
  resetPaneCloseOperationsForTests();
  while (popClosedPane()) { /* empty the undo stack */ }
  replace(fixture(2));
  useUiStore.setState({ activePaneId: "pty-0-0" });
  usePaneMetadataStore.setState({ metadata: { "pty-0-0": { cwd: "C:/fixture", processIsShell: false } }, volatileMetadata: {} });
});
afterEach(() => vi.useRealTimers());

it("saves dormant Codex siblings when the exited foreground tab is cleaned up", async () => {
  const layout = fixture(2, 3);
  const pane = layout.panes[0];
  pane.tabs = pane.tabs.map((tab) => ({ ...tab, agentId: "codex", agentKind: "codex" }));
  layout.panes[1].tabs = layout.panes[1].tabs.slice(0, 1);
  replace(layout);
  const survivingPane = layout.panes[1].tabs[0].sessionId;
  publishCodexRestoreNoticeEpoch(pane.tabs[0].sessionId, 901);
  confirmPtyExit(pane.tabs[0].sessionId, 901);

  const scan = (id?: string) => scanTabs({
    workspaces: useWorkspaceListStore.getState().workspaces,
    activeWorkspaceId: layout.id,
    activeSessionId: pane.tabs[0].sessionId,
    processMetadata: {
      [survivingPane]: { session_id: survivingPane, cwd: "C:/fixture", agent_active: true, process_status: "working" },
    },
    processMetadataAvailable: true,
    metadata: {},
    lastOutputBySession: {},
    isScreenObserved: () => false,
    readTail: async () => [],
    now: 1,
  }, id === undefined ? undefined : new Set([id]));
  const planned = await scan();
  const result = await applySweep({ closeDeadTabIds: planned.dead.map(tab => tab.id) },
    { scan, command: handleSocketCommand });
  const written = toConfig(useWorkspaceListStore.getState().getWorkspace(layout.id)!);

  expect(written.panes.map(pane => [pane.pane_id, pane.tabs?.map(tab => tab.tab_id)])).toEqual([
    ["p0", ["t0-1", "t0-2"]],
    ["p1", ["t1-0"]],
  ]);
  expect(result).toMatchObject({ closed: 1, errors: [] });
  expect(mocks.kill.mock.calls).toEqual([["pty-0-0"]]);
});

describe("C1-C3 close transaction", () => {
  it("passes the operation kind and selected preflight tabs to confirmation", async () => {
    mocks.confirm.mockResolvedValue(false);
    expect(await closePaneOperation(target, "ui")).toMatchObject({ status: "cancelled" });
    expect(mocks.confirm.mock.calls[0][1]).toBe("tab");
    expect(mocks.confirm.mock.calls[0][2]).toEqual({ targetKind: "tab" });
    mocks.confirm.mockClear();
    replace(fixture(2, 3));
    expect(await closePaneOperation({ kind: "pane", workspaceId: "w", paneId: "p0" }, "ui")).toMatchObject({ status: "cancelled" });
    expect(mocks.confirm.mock.calls[0][2]).toEqual({ targetKind: "pane" });
    expect(mocks.confirm.mock.calls[0][0][0].tabs).toHaveLength(3);
    mocks.confirm.mockClear();
    expect(await closePaneOperation({ kind: "tabs", tabIds: ["t0-0", "t0-2", "missing"] }, "ui", bulkOptions)).toMatchObject({ status: "cancelled" });
    expect(mocks.confirm.mock.calls[0][1]).toBe("pane");
    expect(mocks.confirm.mock.calls[0][2]).toEqual({ targetKind: "tabs" });
    expect(mocks.confirm.mock.calls[0][0].flatMap((pane: Workspace["panes"][number]) => pane.tabs.map(tab => tab.id))).toEqual(["t0-0", "t0-2"]);
    expect(mocks.kill).not.toHaveBeenCalled();
  });

  it("has zero side effects on last-tab refusal", async () => {
    replace(fixture());
    const before = JSON.stringify(useWorkspaceListStore.getState().workspaces);
    expect(await closePaneOperation(target, "ui")).toMatchObject({ status: "refused" });
    expect(mocks.confirm).not.toHaveBeenCalled(); expect(mocks.kill).not.toHaveBeenCalled(); expect(mocks.evict).not.toHaveBeenCalled();
    expect(getClosedPaneCount()).toBe(0); expect(usePaneMetadataStore.getState().metadata["pty-0-0"]).toBeDefined();
    expect(JSON.stringify(useWorkspaceListStore.getState().workspaces)).toBe(before);
  });

  it("does not send a kill before confirmation or on cancellation", async () => {
    let decide!: (yes: boolean) => void;
    mocks.confirm.mockImplementationOnce(() => new Promise<boolean>(resolve => { decide = resolve; }));
    const closing = closePaneOperation(target, "ui");
    await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce(), { timeout: 1000 });
    expect(mocks.kill).not.toHaveBeenCalled(); expect(retained()).toBe(true);
    decide(false);
    expect(await closing).toMatchObject({ status: "cancelled" });
    expect(mocks.kill).not.toHaveBeenCalled(); expect(getClosedPaneCount()).toBe(0);
  });

  it("CLI remains explicit and never asks", async () => {
    expect(await closePaneOperation(target, "cli")).toMatchObject({ status: "closed" });
    expect(mocks.confirm).not.toHaveBeenCalled(); expect(mocks.kill).toHaveBeenCalledOnce();
  });

  it("drops pre-send state only after the owning tab closes", async () => {
    const closedSession = "pty-0-0";
    const openSession = "pty-1-0";
    setPresendTabEnabled(closedSession, false);
    setPresendTabEnabled(openSession, false);
    mocks.kill.mockRejectedValueOnce(new Error("denied"));
    expect(await closePaneOperation(target, "cli")).toMatchObject({ status: "failed" });
    expect(presendTab(closedSession)?.enabled).toBe(false);
    expect(await closePaneOperation(target, "cli")).toMatchObject({ status: "closed" });
    expect(presendTab(closedSession)).toBeUndefined();
    expect(presendTab(openSession)?.enabled).toBe(false);
  });

  it("clears only the shared draft of a successfully closed PTY", async () => {
    const composer = useComposerStore.getState();
    const closedSession = "pty-0-0";
    const openSession = "pty-1-0";
    composer.setDraft(closedSession, "draft in the closing tab");
    composer.setDraft(openSession, "draft in the other tab");
    const kill = deferred();
    mocks.kill.mockReturnValueOnce(kill.promise);
    try {
      const closing = closePaneOperation(target, "cli");
      await vi.waitFor(() => expect(mocks.kill).toHaveBeenCalledOnce());
      expect(useComposerStore.getState().draftBySession[closedSession]).toBe("draft in the closing tab");
      kill.reject(new Error("denied"));
      expect(await closing).toMatchObject({ status: "failed" });
      expect(useComposerStore.getState().draftBySession[closedSession]).toBe("draft in the closing tab");

      expect(await closePaneOperation(target, "cli")).toMatchObject({ status: "closed" });
      expect(useComposerStore.getState().draftBySession).not.toHaveProperty(closedSession);
      expect(useComposerStore.getState().draftBySession[openSession]).toBe("draft in the other tab");
    } finally {
      composer.clearDraft(closedSession);
      composer.clearDraft(openSession);
    }
  });

  it("keeps live UI, metadata, cache and history when termination fails, then retries", async () => {
    mocks.kill.mockRejectedValueOnce(new Error("denied"));
    expect(await closePaneOperation(target, "ui")).toMatchObject({ status: "failed" });
    expect(retained()).toBe(true); expect(mocks.evict).not.toHaveBeenCalled(); expect(getClosedPaneCount()).toBe(0);
    expect(usePaneMetadataStore.getState().metadata["pty-0-0"]).toBeDefined();
    expect(mocks.toast.mock.calls[0][2]).toMatchObject({ run: expect.any(Function) });
    expect(await closePaneOperation(target, "ui")).toMatchObject({ status: "closed" });
    expect(retained()).toBe(false); expect(getClosedPaneCount()).toBe(1);
  });

  it("waits for a delayed kill and coalesces duplicate closes and history", async () => {
    const kill = deferred(); mocks.kill.mockReturnValueOnce(kill.promise);
    const first = closePaneOperation(target, "ui"); const duplicate = closePaneOperation(target, "ui");
    await vi.waitFor(() => expect(mocks.kill).toHaveBeenCalledOnce(), { timeout: 1000 });
    expect(retained()).toBe(true); expect(getClosedPaneCount()).toBe(0); expect(mocks.evict).not.toHaveBeenCalled();
    kill.resolve(); await Promise.all([first, duplicate]);
    expect(retained()).toBe(false); expect(getClosedPaneCount()).toBe(1); expect(mocks.evict).toHaveBeenCalledOnce();
    expect(await closePaneOperation(target, "ui")).toMatchObject({ status: "refused" }); expect(mocks.kill).toHaveBeenCalledOnce();
  });

  it("timeout retains the view and a retry never duplicates a late kill", async () => {
    vi.useFakeTimers(); const kill = deferred(); mocks.kill.mockReturnValueOnce(kill.promise);
    const first = closePaneOperation(target, "ui");
    await vi.advanceTimersByTimeAsync(PANE_CLOSE_TIMEOUT_MS + 1);
    expect(await first).toMatchObject({ status: "pending" }); expect(retained()).toBe(true); expect(getClosedPaneCount()).toBe(0);
    const again = closePaneOperation(target, "ui");
    await vi.advanceTimersByTimeAsync(PANE_CLOSE_TIMEOUT_MS + 1);
    expect(await again).toMatchObject({ status: "pending" }); expect(mocks.kill).toHaveBeenCalledOnce();
    kill.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(retained()).toBe(false); expect(getClosedPaneCount()).toBe(1); expect(mocks.kill).toHaveBeenCalledOnce();
  });

  it("rechecks a changed target after each confirmation", async () => {
    mocks.confirm.mockImplementationOnce(async () => {
      const w = fixture(2); w.panes[0].tabs[0].sessionId = "replacement"; replace(w); return true;
    }).mockResolvedValueOnce(false);
    expect(await closePaneOperation(target, "ui")).toMatchObject({ status: "cancelled" });
    expect(mocks.confirm).toHaveBeenCalledTimes(2); expect(mocks.kill).not.toHaveBeenCalled();
  });

  it("rechecks the last-pane guard after a confirmation", async () => {
    mocks.confirm.mockImplementationOnce(async () => { replace(fixture()); return true; });
    expect(await closePaneOperation(target, "ui")).toMatchObject({ status: "refused" });
    expect(mocks.kill).not.toHaveBeenCalled(); expect(getClosedPaneCount()).toBe(0);
  });

  it("declared and launcher tabs close without a kill", async () => {
    for (const type of ["launcher", "terminal"] as const) {
      const w = fixture(2, 1, type); w.panes[0].tabs[0].lifecycle = "declared"; replace(w);
      expect(await closePaneOperation(target, "cli")).toMatchObject({ status: "closed" });
    }
    expect(mocks.kill).not.toHaveBeenCalled();
  });

  it("a whole-pane failure retains every tab and does not re-kill successful sessions on retry", async () => {
    replace(fixture(2, 2)); mocks.kill.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("denied"));
    const paneTarget = { kind: "pane", workspaceId: "w", paneId: "p0" } as const;
    expect(await closePaneOperation(paneTarget, "ui")).toMatchObject({ status: "failed" });
    expect(retained()).toBe(true); expect(getClosedPaneCount()).toBe(0);
    expect(await closePaneOperation(paneTarget, "ui")).toMatchObject({ status: "closed" });
    expect(mocks.kill.mock.calls.map(call => call[0])).toEqual(["pty-0-0", "pty-0-1", "pty-0-1"]);
  });

  it("keeps a newly-added tab during a delayed whole-pane close", async () => {
    const kill = deferred(); mocks.kill.mockReturnValueOnce(kill.promise);
    const closing = closePaneOperation({ kind: "pane", workspaceId: "w", paneId: "p0" }, "ui");
    await vi.waitFor(() => expect(mocks.kill).toHaveBeenCalledOnce(), { timeout: 1000 });
    const w = fixture(2, 1); w.panes[0].tabs.push({ id: "new", sessionId: "new-session", type: "launcher", agentId: "shell" }); replace(w);
    kill.resolve(); await closing;
    expect(useWorkspaceListStore.getState().getWorkspace("w")!.panes[0].tabs.map(t => t.id)).toEqual(["new"]);
  });

  it("concurrent closes cannot terminate the last remaining tab", async () => {
    replace(fixture(1, 2)); const kill = deferred(); mocks.kill.mockReturnValueOnce(kill.promise);
    const first = closePaneOperation(target, "cli");
    const second = await closePaneOperation({ ...target, tabId: "t0-1" }, "cli");
    expect(second.status).toBe("refused"); kill.resolve(); await first; expect(mocks.kill).toHaveBeenCalledOnce();
  });

  it("bulk failure retains the layout and every undo entry until all kills succeed", async () => {
    mocks.kill.mockRejectedValueOnce(new Error("denied"));
    const bulk = { kind: "tabs", tabIds: ["t0-0", "missing"] } as const;
    expect(await closePaneOperation(bulk, "cli", bulkOptions)).toMatchObject({ status: "failed" });
    expect(retained()).toBe(true); expect(getClosedPaneCount()).toBe(0);
    expect(await closePaneOperation(bulk, "cli", bulkOptions)).toMatchObject({ status: "closed", summary: { skipped: ["missing"], closed: ["t0-0"] } });
    expect(getClosedPaneCount()).toBe(1);
  });

  it("rejects a bulk caller without layout commit capability before any side effect", async () => {
    expect(await closePaneOperation({ kind: "tabs", tabIds: ["t0-0"] }, "cli")).toMatchObject({ status: "failed" });
    expect(retained()).toBe(true); expect(mocks.kill).not.toHaveBeenCalled(); expect(getClosedPaneCount()).toBe(0);
  });

  it("keeps unknown bulk ids as skipped without a kill", async () => {
    expect(await closePaneOperation({ kind: "tabs", tabIds: ["missing"] }, "cli", bulkOptions)).toMatchObject({ status: "closed", summary: { closed: [], skipped: ["missing"] } });
    expect(mocks.kill).not.toHaveBeenCalled(); expect(getClosedPaneCount()).toBe(0);
  });

  it("starts the kill deadline after confirmation rather than timing out a user", async () => {
    vi.useFakeTimers(); let decide!: (yes: boolean) => void;
    mocks.confirm.mockImplementationOnce(() => new Promise<boolean>(resolve => { decide = resolve; }));
    const closing = closePaneOperation(target, "ui");
    await vi.advanceTimersByTimeAsync(PANE_CLOSE_TIMEOUT_MS * 2);
    expect(mocks.kill).not.toHaveBeenCalled(); expect(mocks.toast).not.toHaveBeenCalled();
    decide(false); expect(await closing).toMatchObject({ status: "cancelled" });
  });

  it("late rejection stays visible and can retry without a duplicate undo", async () => {
    vi.useFakeTimers(); const kill = deferred(); mocks.kill.mockReturnValueOnce(kill.promise);
    const closing = closePaneOperation(target, "ui");
    await vi.advanceTimersByTimeAsync(PANE_CLOSE_TIMEOUT_MS + 1);
    expect(await closing).toMatchObject({ status: "pending" });
    kill.reject(new Error("late rejection")); await vi.advanceTimersByTimeAsync(0);
    expect(retained()).toBe(true); expect(getClosedPaneCount()).toBe(0);
    expect(await closePaneOperation(target, "ui")).toMatchObject({ status: "closed" });
    expect(mocks.kill).toHaveBeenCalledTimes(2); expect(getClosedPaneCount()).toBe(1);
  });

  it("a whole-pane late success leaves the logical focus on a remaining session", async () => {
    vi.useFakeTimers(); const kill = deferred(); mocks.kill.mockReturnValueOnce(kill.promise);
    const closing = closePaneOperation({ kind: "pane", workspaceId: "w", paneId: "p0" }, "ui");
    await vi.advanceTimersByTimeAsync(PANE_CLOSE_TIMEOUT_MS + 1);
    expect(await closing).toMatchObject({ status: "pending" }); expect(useUiStore.getState().activePaneId).toBe("pty-0-0");
    kill.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(useUiStore.getState().activePaneId).toBe("pty-1-0"); expect(getClosedPaneCount()).toBe(1);
  });
});
