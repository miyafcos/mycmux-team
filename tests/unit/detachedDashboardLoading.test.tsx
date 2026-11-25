// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DetachedWorkspace } from "../../src/lib/detachedPane";
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => null),
  dashboardReady: Promise.resolve(),
}));
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
vi.mock("../../src/components/workspace/WebPaneController", () => ({ default: () => null, isChildWebviewPreview: () => false }));
vi.mock("../../src/components/workspace/WebPaneStatusBar", () => ({ default: () => null }));
vi.mock("../../src/lib/tearout/runtime", () => ({ useTearoutStore: vi.fn(), regrabTearoutWindow: vi.fn() }));
vi.mock("../../src/components/dashboard/DashboardView", async () => {
  await mocks.dashboardReady;
  return {
    DashboardView: ({ onClose }: { onClose: () => void }) => <div role="region" className="cmux-dashboard-view">
      <button data-close-dashboard onClick={onClose}>close</button>
    </div>,
  };
});
import DetachedPaneShell from "../../src/components/layout/DetachedPaneShell";
import { dashboardStrings } from "../../src/components/dashboard/dashboardStrings";
import { launcherStrings } from "../../src/components/workspace/launcherStrings";
import { useDashboardViewStore } from "../../src/stores/dashboardViewStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useKeybindingStore } from "../../src/stores/keybindingStore";
import { useSessionAttentionStore } from "../../src/stores/sessionAttentionStore";
import { cancelTerminalHistoryRequest } from "../../src/components/terminal/terminalHistoryRequests";

let root: Root, host: HTMLDivElement;
const tab = { id: "local-tab", sessionId: "local-session", agentId: "claude", agentKind: "claude" as const,
  agentSessionId: "11111111-1111-4111-8111-111111111111", label: "Local" };
const workspace: DetachedWorkspace = { id: "ws", name: "Fixture", gridTemplateId: "1x1", status: "running", createdAt: 0, detached: true,
  panes: [{ id: "pane", sessionId: tab.sessionId, agentId: "claude", activeTabId: tab.id, tabs: [tab] }] };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); mocks.invoke.mockReset().mockResolvedValue(null);
  Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
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
it("discards the pending launch while the detached dashboard is still loading and requires another press", async () => {
  Element.prototype.scrollIntoView = () => {};
  let loadDashboard!: () => void;
  mocks.dashboardReady = new Promise(resolve => { loadDashboard = resolve; });
  const home = { provider: "grok", profile_id: "grok-fixture", state: "ready" };
  let finishCheck!: (homes: typeof home[]) => void;
  let check: Promise<typeof home[]> | undefined;
  mocks.invoke.mockImplementation(async command => {
    if (command === "list_cli_accounts") return {
      profiles: [{ id: home.profile_id, provider: home.provider, label: "Grok fixture", captured_at: "" }],
    };
    if (command === "list_cli_account_homes") {
      const result = check ?? [home];
      check = undefined;
      return result;
    }
    if (command === "crsm_list_sessions" || command === "get_cli_launch_tokens") return [];
    return null;
  });
  const launcher = { ...tab, type: "launcher" as const, agentId: "shell-starter" };
  const detached = { ...workspace, panes: [{ ...workspace.panes[0], tabs: [launcher] }] };
  const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")]
    .find(button => button.textContent === label || button.title === label || button.getAttribute("aria-label") === label)!;
  const click = (label: string) => act(async () => button(label).click());
  const added = () => useWorkspaceListStore.getState().getWorkspace(detached.id)?.panes[0].tabs
    .filter(tab => tab.launchEnv?.MYCMUX_LAUNCH_ACCOUNT === home.profile_id) ?? [];
  try {
    await act(async () => {
      useWorkspaceListStore.setState({ workspaces: [detached], activeWorkspaceId: detached.id });
      root.render(<DetachedPaneShell workspace={detached} />);
    });
    await click(launcherStrings.specTooltip("Grok Build"));
    await click("Grok fixture");
    expect(button("Grok fixture").getAttribute("aria-pressed")).toBe("true");
    check = new Promise(resolve => { finishCheck = resolve; });
    await click(launcherStrings.launchButton);
    expect(button(launcherStrings.launchButton).disabled).toBe(true);
    expect(check).toBeUndefined();
    expect(added()).toHaveLength(0);

    await click(dashboardStrings.buttonTitle);
    expect(host.querySelector(`[aria-label="${dashboardStrings.viewAriaLabel}"]`)).not.toBeNull();
    expect(host.querySelector("[data-close-dashboard]")).toBeNull();
    expect(useDashboardViewStore.getState().open).toBe(true);
    const cancelledWhileLoading = !button(launcherStrings.launchButton).disabled;
    await act(async () => finishCheck([home]));
    expect(added()).toHaveLength(0);
    expect(host.querySelector("[data-detached-terminal]")?.hasAttribute("inert")).toBe(true);
    expect(cancelledWhileLoading).toBe(true);

    await act(async () => { loadDashboard(); await vi.dynamicImportSettled(); });
    await act(async () => host.querySelector<HTMLButtonElement>("[data-close-dashboard]")!.click());
    expect(useDashboardViewStore.getState().open).toBe(false);
    expect(host.querySelector("[data-detached-terminal]")?.hasAttribute("inert")).toBe(false);
    expect(added()).toHaveLength(0);
    expect(button("Grok fixture").getAttribute("aria-pressed")).toBe("true");
    await click(launcherStrings.launchButton);
    expect(added()).toHaveLength(1);
  } finally {
    loadDashboard();
    await act(async () => vi.dynamicImportSettled());
  }
});
