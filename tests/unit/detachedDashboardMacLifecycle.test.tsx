// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DetachedWorkspace } from "../../src/lib/detachedPane";
vi.hoisted(() => {
  Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Macintosh" });
});
const mocks = vi.hoisted(() => ({ invoke: vi.fn(async (_command: string, _args?: unknown) => null) }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<object>(), invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(async () => {}), listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({
  label: "mycmux-w1", setTitle: async () => {}, listen: async () => () => {},
  isMaximized: async () => false, onResized: async () => () => {}, onMoved: async () => () => {},
}) }));
vi.mock("../../src/components/layout/SocketListener", () => ({ closeWindowWorkspacesAndDestroy: vi.fn() }));
vi.mock("../../src/components/workspace/WorkspaceView", () => ({ default: () => <div className="xterm"><textarea /></div> }));
vi.mock("../../src/components/workspace/PaneDragOverlay", () => ({ default: () => null }));
vi.mock("../../src/components/terminal/XTermWrapper", () => ({ default: () => <div className="xterm"><textarea /></div> }));
vi.mock("../../src/components/workspace/BrowserPane", () => ({ default: () => null }));
vi.mock("../../src/components/workspace/LauncherPane", () => ({ default: () => null }));
vi.mock("../../src/components/workspace/WebPaneController", () => ({ default: () => null, isChildWebviewPreview: () => false }));
vi.mock("../../src/components/workspace/WebPaneStatusBar", () => ({ default: () => null }));
vi.mock("../../src/lib/tearout/runtime", () => ({ useTearoutStore: vi.fn(), regrabTearoutWindow: vi.fn() }));
vi.mock("../../src/components/dashboard/DashboardView", () => ({
  DashboardView: ({ onClose }: { onClose: () => void }) => <div role="region" className="cmux-dashboard-view">
    <button data-close-dashboard onClick={onClose}>close</button>
  </div>,
}));
import NativePaneShell from "../../src/components/layout/NativePaneShell";
import DetachedPaneShell from "../../src/components/layout/DetachedPaneShell";
import { dashboardStrings } from "../../src/components/dashboard/dashboardStrings";
import { requestDashboard } from "../../src/components/layout/openDashboardForTab";
import { useDashboardViewStore } from "../../src/stores/dashboardViewStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useKeybindingStore } from "../../src/stores/keybindingStore";
import { useSessionAttentionStore } from "../../src/stores/sessionAttentionStore";
import { openDormantCompletionRecord } from "../../src/lib/dormantCompletion";
import { beginTerminalHistoryRequest, isTerminalHistoryRequestCurrent, cancelTerminalHistoryRequest } from "../../src/components/terminal/terminalHistoryRequests";

let root: Root, host: HTMLDivElement;
const tab = { id: "local-tab", sessionId: "local-session", agentId: "claude", agentKind: "claude" as const,
  agentSessionId: "11111111-1111-4111-8111-111111111111", label: "Local" };
const workspace: DetachedWorkspace = { id: "ws", name: "Fixture", gridTemplateId: "1x1", status: "running", createdAt: 0, detached: true,
  panes: [{ id: "pane", sessionId: tab.sessionId, agentId: "claude", activeTabId: tab.id, tabs: [tab] }] };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); mocks.invoke.mockClear();
  Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  useKeybindingStore.getState().resetAll();
  useDashboardViewStore.setState({ open: false, chatColumnIdFilter: null, selectedTabId: "main-selection", pinnedChatColumnTabIds: ["saved"] });
  localStorage.setItem("mycmux:dashboard-chat-column-pins", '["saved"]');
  useWorkspaceListStore.setState({ workspaces: [workspace], activeWorkspaceId: workspace.id });
  useUiStore.setState({ activePaneId: tab.sessionId, lastActivePaneId: tab.sessionId });
  useSessionAttentionStore.setState({ dormantCompletionsBySession: { [tab.sessionId]: {
    tabIds: [tab.id], attention: { sessionId: tab.sessionId, attentionId: "done", kind: "done", detail: null,
      sessionRevision: 1, uiState: "idle", stateSince: 1, occurrenceOrder: 1 },
    receipt: { ptySessionId: tab.sessionId, agentKind: "claude", agentSessionId: tab.agentSessionId, ptyGeneration: 1, savedAt: 1, bytes: 10 },
  } } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); cancelTerminalHistoryRequest(tab.sessionId);
  vi.unstubAllGlobals();
});
describe.each(["native", "legacy"] as const)("%s macOS detached dashboard lifecycle", shell => {
  it.each(["band", "shortcut", "menu", "history", "dormant"] as const)("opens visibly from %s and restores terminal history and shortcuts after close", async source => {
    await act(async () => root.render(shell === "native" ? <NativePaneShell /> : <DetachedPaneShell workspace={workspace} />));
    const input = host.querySelector<HTMLTextAreaElement>(".xterm textarea")!; input.focus();
    expect(isTerminalHistoryRequestCurrent(beginTerminalHistoryRequest(tab.sessionId))).toBe(true);
    await act(async () => {
      if (source === "band") host.querySelector<HTMLButtonElement>(`button[aria-label="${dashboardStrings.buttonTitle}"]`)!.click();
      else if (source === "shortcut") input.dispatchEvent(new KeyboardEvent("keydown", { key: "G", metaKey: true, shiftKey: true, bubbles: true, cancelable: true }));
      else if (source === "dormant") expect(openDormantCompletionRecord(tab, true)).toBe(true);
      else await requestDashboard({ tabId: tab.id, sessionId: tab.sessionId, ...(source === "history" ? { turn: "latest" as const } : {}) });
    });
    expect(useDashboardViewStore.getState()).toMatchObject({ open: true, selectedTabId: tab.id });
    expect(host.querySelector("[role=region]")).not.toBeNull();
    expect(host.querySelector<HTMLElement>("[data-detached-terminal]")!.style.visibility).toBe("hidden");
    expect(host.querySelector<HTMLTextAreaElement>(".xterm textarea")).toBe(input);
    expect(isTerminalHistoryRequestCurrent(beginTerminalHistoryRequest(tab.sessionId))).toBe(false);
    expect(mocks.invoke.mock.calls.some(([command]) => command === "open_main_dashboard" || command === "focus_window")).toBe(false);
    if (source === "history" || source === "dormant") expect(useDashboardViewStore.getState().userTurnRequests[tab.id]?.kind).toBe("latest");
    await act(async () => host.querySelector<HTMLButtonElement>("[data-close-dashboard]")!.click());
    expect(useDashboardViewStore.getState().open).toBe(false); expect(host.querySelector("[role=region]")).toBeNull();
    expect(host.querySelector<HTMLElement>("[data-detached-terminal]")!.style.visibility).toBe("visible");
    input.focus(); expect(isTerminalHistoryRequestCurrent(beginTerminalHistoryRequest(tab.sessionId))).toBe(true);
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "G", metaKey: true, shiftKey: true, bubbles: true })));
    expect(useDashboardViewStore.getState().open).toBe(true); expect(host.querySelector("[role=region]")).not.toBeNull();
    expect(localStorage.getItem("mycmux:dashboard-chat-column-pins")).toBe('["saved"]');
    await act(async () => root.render(null));
    expect(useDashboardViewStore.getState()).toMatchObject({ open: false, selectedTabId: "main-selection", pinnedChatColumnTabIds: ["saved"] });
    expect(host.querySelector(".cmux-detached-dashboard-host")).toBeNull();
  });
});
