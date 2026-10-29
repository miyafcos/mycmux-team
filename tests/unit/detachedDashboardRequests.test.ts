// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../src/types";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(async () => true) }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<object>(), invoke: mocks.invoke }));
import { requestDashboard } from "../../src/components/layout/openDashboardForTab";
import { mountDetachedDashboardHost } from "../../src/lib/dashboardHost";
import { handleDetachedDashboardKey } from "../../src/lib/detachedDashboardKeys";
import { useDashboardViewStore } from "../../src/stores/dashboardViewStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useToastStore, __resetToastStoreForTests } from "../../src/stores/toastStore";
import { useKeybindingStore } from "../../src/stores/keybindingStore";
import { openTabSweepInDashboard } from "../../src/components/layout/tabSweep";
import { tearoutStrings } from "../../src/components/layout/tearoutStrings";

let release: () => void;
beforeEach(() => {
  mocks.invoke.mockReset().mockResolvedValue(true);
  __resetToastStoreForTests();
  useDashboardViewStore.setState({ open: false, chatColumnTabIds: [], pinnedChatColumnTabIds: ["saved"], selectedTabId: "saved" });
  localStorage.setItem("mycmux:dashboard-chat-column-pins", '["saved"]');
  useWorkspaceListStore.setState({ activeWorkspaceId: "ws", workspaces: [{ id: "ws", panes: [{ id: "p", activeTabId: "visible", tabs: [
    { id: "focused", sessionId: "focus" }, { id: "visible", sessionId: "shown" }, { id: "last-focused", sessionId: "last" },
  ] }] } as Workspace] });
  useUiStore.setState({ activePaneId: "focus", lastActivePaneId: "last" });
  useKeybindingStore.getState().resetAll();
  release = mountDetachedDashboardHost();
});
afterEach(() => { release(); __resetToastStoreForTests(); vi.restoreAllMocks(); });

describe("detached dashboard requests", () => {
  it("throws local store failures synchronously without turning them into a rejection", () => {
    release();
    const error = new Error("local store failure");
    vi.spyOn(useDashboardViewStore.getState(), "setQuery").mockImplementationOnce(() => { throw error; });
    expect(() => requestDashboard({ tabId: "local" })).toThrow(error);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("routes explicit menu and reader targets and leaves local state and saved pins intact", async () => {
    const before = useDashboardViewStore.getState();
    await requestDashboard({ tabId: "menu", sessionId: "menu-session" });
    await requestDashboard({ tabId: "reader", sessionId: "reader-session", turn: "latest" });
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "open_main_dashboard", { tabId: "menu", sessionId: "menu-session", turn: null });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "open_main_dashboard", { tabId: "reader", sessionId: "reader-session", turn: "latest" });
    expect(localStorage.getItem("mycmux:dashboard-chat-column-pins")).toBe('["saved"]');
    expect(useDashboardViewStore.getState().pinnedChatColumnTabIds).toEqual(["saved"]);
    expect(useDashboardViewStore.getState()).toBe(before);
  });
  it("uses active then last focused session, then visible tab, then a plain request", async () => {
    await requestDashboard();
    expect(mocks.invoke).toHaveBeenLastCalledWith("open_main_dashboard", { tabId: "focused", sessionId: "focus", turn: null });
    useUiStore.setState({ activePaneId: null }); await requestDashboard();
    expect(mocks.invoke).toHaveBeenLastCalledWith("open_main_dashboard", { tabId: "last-focused", sessionId: "last", turn: null });
    useUiStore.setState({ activePaneId: "missing" }); await requestDashboard();
    expect(mocks.invoke).toHaveBeenLastCalledWith("open_main_dashboard", { tabId: "visible", sessionId: "shown", turn: null });
    useWorkspaceListStore.setState({ workspaces: [] }); await requestDashboard();
    expect(mocks.invoke).toHaveBeenLastCalledWith("open_main_dashboard", { tabId: null, sessionId: null, turn: null });
  });
  it("reports false and catches rejected fire-and-forget requests", async () => {
    mocks.invoke.mockResolvedValueOnce(false); await requestDashboard({ tabId: "a" });
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe(tearoutStrings.dashboardMainUnavailable);
    mocks.invoke.mockRejectedValueOnce(new Error("offline"));
    await expect(requestDashboard({ tabId: "a", turn: "latest" })).resolves.toBeUndefined();
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe(tearoutStrings.failed);
  });
  it("closes a stale local dashboard on shell mount and keeps tab sweep closed", () => {
    useDashboardViewStore.getState().openView();
    const stop = mountDetachedDashboardHost();
    expect(useDashboardViewStore.getState().open).toBe(false);
    openTabSweepInDashboard();
    expect(useDashboardViewStore.getState().open).toBe(false);
    stop();
  });
  it("accepts a synthetic xterm shortcut but excludes editable, composing, repeated and earlier actions", async () => {
    const terminal = document.createElement("div"); terminal.className = "xterm";
    const textarea = document.createElement("textarea"); terminal.append(textarea);
    const event = (target: HTMLElement, init: KeyboardEventInit = {}) => {
      const value = new KeyboardEvent("keydown", { key: "G", ctrlKey: true, shiftKey: true, cancelable: true, ...init });
      Object.defineProperty(value, "target", { value: target }); return value;
    };
    const accepted = event(textarea); handleDetachedDashboardKey(accepted); await Promise.resolve();
    expect(accepted.defaultPrevented).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledOnce();
    handleDetachedDashboardKey(event(document.createElement("input")));
    handleDetachedDashboardKey(event(textarea, { isComposing: true }));
    handleDetachedDashboardKey(event(textarea, { repeat: true }));
    vi.spyOn(useKeybindingStore.getState(), "getActionsForEvent").mockReturnValue(["workspace.new", "dashboard.open"]);
    handleDetachedDashboardKey(event(textarea));
    expect(mocks.invoke).toHaveBeenCalledOnce();
  });
  it("keeps ordinary AppShell requests local without the marker", async () => {
    release();
    await requestDashboard({ tabId: "local" });
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(useDashboardViewStore.getState()).toMatchObject({ open: true, selectedTabId: "local" });
  });
});
