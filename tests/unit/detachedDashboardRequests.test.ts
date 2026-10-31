// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../src/types";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(async () => true) }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<object>(), invoke: mocks.invoke }));
import { requestDashboard, toggleDetachedDashboard } from "../../src/components/layout/openDashboardForTab";
import { mountDetachedDashboardHost } from "../../src/lib/dashboardHost";
import { handleDetachedDashboardKey } from "../../src/lib/detachedDashboardKeys";
import { useDashboardViewStore } from "../../src/stores/dashboardViewStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useKeybindingStore } from "../../src/stores/keybindingStore";

let release: () => void;
beforeEach(() => {
  mocks.invoke.mockReset().mockResolvedValue(true);
  useDashboardViewStore.setState({ open: false, chatColumnTabIds: [], pinnedChatColumnTabIds: ["saved"], selectedTabId: "saved", chatColumnIdFilter: null });
  localStorage.setItem("mycmux:dashboard-chat-column-pins", '["saved"]');
  useWorkspaceListStore.setState({ activeWorkspaceId: "ws", workspaces: [{ id: "ws", panes: [{ id: "p", activeTabId: "visible", tabs: [
    { id: "focused", sessionId: "focus" }, { id: "visible", sessionId: "shown" }, { id: "last-focused", sessionId: "last" },
  ] }] } as Workspace] });
  useUiStore.setState({ activePaneId: "focus", lastActivePaneId: "last" });
  useKeybindingStore.getState().resetAll();
  release = mountDetachedDashboardHost();
});
afterEach(() => { release(); vi.restoreAllMocks(); });
describe("detached dashboard requests", () => {
  it("throws local store failures synchronously without turning them into a rejection", () => {
    release();
    const error = new Error("local store failure");
    vi.spyOn(useDashboardViewStore.getState(), "setQuery").mockImplementationOnce(() => { throw error; });
    expect(() => requestDashboard({ tabId: "local" })).toThrow(error);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("opens explicit menu and reader targets locally without changing saved pins", async () => {
    await requestDashboard({ tabId: "visible", sessionId: "shown" });
    expect(useDashboardViewStore.getState()).toMatchObject({ open: true, selectedTabId: "visible" });
    await requestDashboard({ tabId: "focused", sessionId: "focus", turn: "latest" });
    expect(useDashboardViewStore.getState()).toMatchObject({ open: true, selectedTabId: "focused",
      userTurnRequests: { focused: { kind: "latest" } } });
    expect(localStorage.getItem("mycmux:dashboard-chat-column-pins")).toBe('["saved"]');
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("uses active then last focused session, then visible tab, then a plain request", async () => {
    await requestDashboard(); expect(useDashboardViewStore.getState().selectedTabId).toBe("focused");
    useUiStore.setState({ activePaneId: null }); await requestDashboard();
    expect(useDashboardViewStore.getState().selectedTabId).toBe("last-focused");
    useUiStore.setState({ activePaneId: "missing" }); await requestDashboard();
    expect(useDashboardViewStore.getState().selectedTabId).toBe("visible");
    useWorkspaceListStore.setState({ workspaces: [] }); useDashboardViewStore.getState().close(); await requestDashboard();
    expect(useDashboardViewStore.getState().open).toBe(true);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("rejects unknown columns and never depends on the main IPC being available", async () => {
    mocks.invoke.mockRejectedValue(new Error("offline"));
    await requestDashboard({ tabId: "missing", turn: "latest" });
    expect(useDashboardViewStore.getState().chatColumnTabIds).toEqual([]);
    await requestDashboard({ tabId: "visible" });
    expect(useDashboardViewStore.getState()).toMatchObject({ open: true, selectedTabId: "visible" });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("clears stale layout on first mount, keeps nested hosts live, and closes on last cleanup", async () => {
    release(); useDashboardViewStore.getState().openView();
    release = mountDetachedDashboardHost();
    expect(useDashboardViewStore.getState().open).toBe(false);
    await requestDashboard({ tabId: "visible" });
    const stop = mountDetachedDashboardHost();
    expect(useDashboardViewStore.getState().open).toBe(true);
    stop(); expect(useDashboardViewStore.getState().open).toBe(true);
    release(); expect(useDashboardViewStore.getState().open).toBe(false);
  });
  it("toggles for xterm keys but excludes editable, composing, repeated and earlier actions", () => {
    const terminal = document.createElement("div"); terminal.className = "xterm";
    const textarea = document.createElement("textarea"); terminal.append(textarea);
    const event = (target: HTMLElement, init: KeyboardEventInit = {}) => {
      const value = new KeyboardEvent("keydown", { key: "G", ctrlKey: true, shiftKey: true, cancelable: true, ...init });
      Object.defineProperty(value, "target", { value: target }); return value;
    };
    const accepted = event(textarea); handleDetachedDashboardKey(accepted);
    expect(accepted.defaultPrevented).toBe(true); expect(useDashboardViewStore.getState().open).toBe(true);
    handleDetachedDashboardKey(event(textarea)); expect(useDashboardViewStore.getState().open).toBe(false);
    handleDetachedDashboardKey(event(document.createElement("input")));
    handleDetachedDashboardKey(event(textarea, { isComposing: true })); handleDetachedDashboardKey(event(textarea, { repeat: true }));
    vi.spyOn(useKeybindingStore.getState(), "getActionsForEvent").mockReturnValue(["workspace.new", "dashboard.open"]);
    handleDetachedDashboardKey(event(textarea)); expect(useDashboardViewStore.getState().open).toBe(false);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("keeps ordinary AppShell requests local without the marker", async () => {
    release(); await requestDashboard({ tabId: "local" });
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(useDashboardViewStore.getState()).toMatchObject({ open: true, selectedTabId: "local" });
  });
  it("keeps all layout preferences temporary and restores the main snapshot when the shell leaves", () => {
    const saved = Object.fromEntries(["mycmux:dashboard-chat-column-pins", "mycmux:dashboard-chat-column-limit", "mycmux:dashboard-minimap-width", "mycmux:dashboard-session-list-collapsed"].map(key => [key, localStorage.getItem(key)]));
    const view = useDashboardViewStore.getState();
    view.focusChatColumn("visible"); view.toggleChatColumnPin("visible");
    view.setChatColumnLimit(1); view.setMinimapWidth(280); view.toggleSessionListCollapsed();
    expect(useDashboardViewStore.getState().pinnedChatColumnTabIds).toEqual(["visible"]);
    expect(localStorage.getItem("mycmux:dashboard-chat-column-pins")).toBe('["saved"]');
    for (const [key, value] of Object.entries(saved)) expect(localStorage.getItem(key)).toBe(value);
    toggleDetachedDashboard(); expect(useDashboardViewStore.getState().open).toBe(true);
    release(); expect(useDashboardViewStore.getState()).toMatchObject({ open: false, pinnedChatColumnTabIds: ["saved"], selectedTabId: "saved" });
  });
});
