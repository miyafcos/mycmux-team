import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../src/types";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { getClosedPaneCount, popClosedPane } from "../../src/stores/closedPaneStore";
import { useUiStore } from "../../src/stores/uiStore";
import { fixture } from "./fixtures/paneClose";

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

describe("C1-C3 close transaction", () => {
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
