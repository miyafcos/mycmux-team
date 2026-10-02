import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pane, PaneTab, Workspace } from "../../src/types";
import type { PaneLeftoverProcess } from "../../src/lib/paneLeftovers";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), openSweep: vi.fn() }));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke, isTauri: () => true,
}));
vi.mock("../../src/components/layout/tabSweep", () => ({ openTabSweepInDashboard: mocks.openSweep }));

import { groupPaneLeftovers } from "../../src/lib/paneLeftovers";
import { __resetPaneLeftoverNotificationsForTests } from "../../src/lib/paneLeftoverNotifications";
import { getClosedPaneEntries, getClosedPaneCount, popClosedPane, pushClosedPane, pushClosedTab, pushClosedWorkspace } from "../../src/stores/closedPaneStore";
import { __resetToastStoreForTests, useToastStore } from "../../src/stores/toastStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { killSession } from "../../src/lib/ipc";

const tab = (id: string): PaneTab => ({ id, sessionId: id, agentId: "shell-starter", label: `監視 ${id}` });
const pane = (tabs: PaneTab[]): Pane => ({ id: "pane", sessionId: tabs[0].sessionId, agentId: "shell-starter", tabs, activeTabId: tabs[0].id });
const process = (id: string, pid = 101): PaneLeftoverProcess => ({
  pid, parentPid: null, name: "python.exe", startedAt: 100, memoryBytes: 1000,
  command: "python watch.py", paneSessionId: id, paneRunning: false,
});

beforeEach(() => {
  vi.useFakeTimers();
  mocks.invoke.mockReset().mockResolvedValue([]);
  mocks.openSweep.mockReset();
  __resetPaneLeftoverNotificationsForTests();
  __resetToastStoreForTests();
  while (popClosedPane()) { /* drain history */ }
  useSettingsStore.setState({ notificationsEnabled: true, toastUserActionEnabled: true });
});
afterEach(() => {
  __resetPaneLeftoverNotificationsForTests();
  __resetToastStoreForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("closed-pane leftover notifications", () => {
  it("batches closes within ten seconds, filters other panes and offers one sweep action", async () => {
    mocks.invoke.mockResolvedValue([process("a"), { ...process("a", 104), parentPid: 101 }, process("b", 102), { ...process("b", 105), parentPid: 102 }, process("unrelated", 103)]);
    const a = tab("a");
    pushClosedTab(pane([a]), a);
    await vi.advanceTimersByTimeAsync(2_000);
    const b = tab("b");
    pushClosedTab(pane([b]), b);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(mocks.invoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(mocks.invoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith("list_pane_leftover_processes");
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].kind).toBe("warning");
    expect(toasts[0].message).toBe("閉じたペインから起動されたプロセスが 2 件動いています");
    expect(toasts[0].action?.label).toBe("ペイン掃除で確認");
    expect(toasts[0].actions).toBeUndefined();
    toasts[0].action?.run();
    await vi.dynamicImportSettled();
    expect(mocks.openSweep).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("names one affected pane and counts its roots rather than every descendant", async () => {
    mocks.invoke.mockResolvedValue([process("a"), { ...process("a", 102), parentPid: 101 }, { ...process("a", 103), parentPid: 102 }, process("a", 104)]);
    const a = tab("a");
    pushClosedTab(pane([a]), a);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(useToastStore.getState().toasts[0].message).toBe("閉じたペイン「監視 a」から起動されたプロセスが 2 件動いています");
  });

  it("checks all terminals when a pane container closes, without changing the undo history count", async () => {
    mocks.invoke.mockResolvedValue([process("background")]);
    pushClosedPane(pane([tab("active"), tab("background")]));
    expect(getClosedPaneCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(useToastStore.getState().toasts[0].message).toContain("監視 background");
    expect(getClosedPaneEntries().some((entry) => entry.paneSessionId === "background")).toBe(false);
    expect(groupPaneLeftovers([process("background")], [], getClosedPaneEntries())[0].title).toBe("閉じたペイン「監視 background」から残っているもの");
  });

  it("checks every closed workspace terminal even beyond the five-entry undo cap", async () => {
    const tabs = Array.from({ length: 9 }, (_, index) => tab(`tab-${index}`));
    const workspace: Workspace = { id: "workspace", name: "Workspace", gridTemplateId: "1x1", panes: [pane(tabs)], status: "running", createdAt: 1 };
    mocks.invoke.mockResolvedValue([process("tab-8")]);
    expect(pushClosedWorkspace(workspace)).toBe(5);
    expect(getClosedPaneCount()).toBe(5);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(useToastStore.getState().toasts[0].message).toContain("監視 tab-8");
    expect(getClosedPaneEntries().some((entry) => entry.paneSessionId === "tab-8")).toBe(false);
    expect(groupPaneLeftovers([process("tab-8")], [], getClosedPaneEntries())[0].title).toBe("閉じたペイン「監視 tab-8」から残っているもの");
  });

  it("keeps a closed pane name after its undo entry is evicted", async () => {
    for (let index = 0; index < 11; index += 1) {
      const current = tab(`tab-${index}`);
      pushClosedTab(pane([current]), current);
    }
    expect(getClosedPaneCount()).toBe(10);
    expect(getClosedPaneEntries().some((entry) => entry.paneSessionId === "tab-0")).toBe(false);
    mocks.invoke.mockResolvedValue([process("tab-0")]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(groupPaneLeftovers([process("tab-0")], [], getClosedPaneEntries())[0].title).toBe("閉じたペイン「監視 tab-0」から残っているもの");
  });

  it("shows no toast when no process belongs to the closed pane", async () => {
    mocks.invoke.mockResolvedValue([process("unrelated")]);
    const a = tab("a");
    pushClosedTab(pane([a]), a);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("logs one scan failure without a toast or a retry", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.invoke.mockRejectedValue("scan refused");
    const a = tab("a");
    pushClosedTab(pane([a]), a);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("does not schedule a check for dormancy's killSession path", async () => {
    mocks.invoke.mockResolvedValue(undefined);
    await killSession("dormant-pane");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("kill_session", { sessionId: "dormant-pane" });
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("keeps a second batch when another pane closes during a pending scan", async () => {
    let resolve!: (value: PaneLeftoverProcess[]) => void;
    mocks.invoke.mockReturnValueOnce(new Promise<PaneLeftoverProcess[]>((done) => { resolve = done; })).mockResolvedValueOnce([process("b")]);
    const a = tab("a");
    pushClosedTab(pane([a]), a);
    await vi.advanceTimersByTimeAsync(10_000);
    const b = tab("b");
    pushClosedTab(pane([b]), b);
    resolve([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(useToastStore.getState().toasts[0].message).toContain("監視 b");
  });
});
