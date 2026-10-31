import { act, useLayoutEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DetachedWorkspace } from "../../../src/lib/detachedPane";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), keys: [] as string[] }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<object>(), invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(async () => {}), listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({
  label: "mycmux-w1", setTitle: async () => {}, listen: async () => () => {},
  isMaximized: async () => false, onResized: async () => () => {}, onMoved: async () => () => {},
}) }));
vi.mock("../../../src/components/layout/SocketListener", () => ({ closeWindowWorkspacesAndDestroy: vi.fn() }));
vi.mock("../../../src/components/workspace/WorkspaceView", () => ({ default: () => {
  const workspaces = useWorkspaceListStore(state => state.workspaces);
  return <>{workspaces.flatMap(workspace => workspace.panes.flatMap(pane => pane.tabs.filter(tab => !tab.type || tab.type === "terminal").map(tab => <RegisteredTerminal key={tab.id} sessionId={tab.sessionId} />)))}</>;
} }));
vi.mock("../../../src/components/workspace/PaneDragOverlay", () => ({ default: () => null }));
vi.mock("../../../src/components/terminal/XTermWrapper", () => ({
  default: RegisteredTerminal, getTerminalWriteCounter: () => 0, hasMountedTerminal: () => true, hasTerminalBuffer: () => true,
}));
vi.mock("../../../src/components/workspace/BrowserPane", () => ({ default: () => null }));
vi.mock("../../../src/components/workspace/LauncherPane", () => ({ default: () => null }));
vi.mock("../../../src/components/workspace/WebPaneController", () => ({ default: () => null, isChildWebviewPreview: () => false }));
vi.mock("../../../src/components/workspace/WebPaneStatusBar", () => ({ default: () => null }));
vi.mock("../../../src/lib/tearout/runtime", () => ({ useTearoutStore: vi.fn(), regrabTearoutWindow: vi.fn() }));

import NativePaneShell from "../../../src/components/layout/NativePaneShell";
import DetachedPaneShell from "../../../src/components/layout/DetachedPaneShell";
import { dashboardStrings } from "../../../src/components/dashboard/dashboardStrings";
import { requestDashboard } from "../../../src/components/layout/openDashboardForTab";
import { focusController } from "../../../src/lib/focusController";
import { IS_MAC } from "../../../src/lib/keybindings";
import { isExplicitHistoryKey } from "../../../src/components/terminal/conversationHistoryAdmission";
import { beginTerminalHistoryRequest, isTerminalHistoryRequestCurrent, cancelTerminalHistoryRequest } from "../../../src/components/terminal/terminalHistoryRequests";
import { useDashboardViewStore } from "../../../src/stores/dashboardViewStore";
import { useWorkspaceListStore } from "../../../src/stores/workspaceListStore";
import { useUiStore } from "../../../src/stores/uiStore";
import { useKeybindingStore } from "../../../src/stores/keybindingStore";
import { useLiveBriefStore } from "../../../src/stores/liveBriefStore";
import { usePaneMetadataStore } from "../../../src/stores/paneMetadataStore";
import { useSessionAttentionStore } from "../../../src/stores/sessionAttentionStore";
import { useSettingsStore } from "../../../src/stores/settingsStore";

function RegisteredTerminal({ sessionId }: { sessionId: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => focusController.registerTerminal(sessionId, {
    focus: () => ref.current?.focus(),
    containsActiveElement: () => document.activeElement === ref.current,
    isEligible: () => Boolean(ref.current?.isConnected && !useDashboardViewStore.getState().open),
  }), [sessionId]);
  return <div className="xterm" data-session-id={sessionId}><textarea ref={ref} className="xterm-helper-textarea" onKeyDown={event => {
    if (!focusController.shouldAcceptTerminalInput(sessionId)) return;
    if (useKeybindingStore.getState().getActionsForEvent(event.nativeEvent).includes("terminal.search")) {
      mocks.keys.push("search:" + sessionId); event.preventDefault(); event.stopPropagation();
    } else if (isExplicitHistoryKey(event.nativeEvent, IS_MAC)
      && isTerminalHistoryRequestCurrent(beginTerminalHistoryRequest(sessionId))) {
      mocks.keys.push("history:" + sessionId); event.preventDefault(); event.stopPropagation();
    }
  }} /></div>;
}

const tab = { id: "focus-local-tab", sessionId: "focus-local-session", agentId: "claude", agentKind: "claude" as const,
  agentSessionId: "11111111-1111-4111-8111-111111111111", label: "Focus local" };
const workspace: DetachedWorkspace = { id: "focus-ws", name: "Focus fixture", gridTemplateId: "1x1", status: "running", createdAt: 0, detached: true,
  panes: [{ id: "focus-pane", sessionId: tab.sessionId, agentId: "claude", activeTabId: tab.id, tabs: [tab] }] };
let root: Root, host: HTMLDivElement;
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); }); }
function key(key: string, extra: KeyboardEventInit = {}) {
  document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra }));
}
const primary = () => IS_MAC ? { metaKey: true } : { ctrlKey: true };

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); mocks.keys.length = 0; mocks.invoke.mockReset();
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  useKeybindingStore.getState().resetAll();
  useSettingsStore.setState({ conversationHistoryMode: "agent-wheel", nativePaneTearoutEnabled: true });
  useDashboardViewStore.setState({ open: false, query: "", chatColumnIdFilter: null, selectedTabId: null, chatColumnTabIds: [], pinnedChatColumnTabIds: [] });
  useWorkspaceListStore.setState({ workspaces: [workspace], activeWorkspaceId: workspace.id });
  useUiStore.setState({ activePaneId: tab.sessionId, lastActivePaneId: tab.sessionId });
  useSessionAttentionStore.getState().resetForTests(); useLiveBriefStore.getState().reset();
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {}, lastLog: {}, lastLogAt: {} });
  mocks.invoke.mockImplementation(async (command: string, args: any) => {
    if (command === "get_jev_settings") return { enabled: false, model: "fixture-disabled", hasApiKey: false, revision: "fixture" };
    if (command === "get_window_tab_index" || command === "get_window_fragments" || command === "get_live_briefs" || command === "get_live_events" || command === "get_live_read_observations") return [];
    if (command === "read_agent_session_mappings") return { [tab.sessionId]: { agent_kind: "claude", session_id: tab.agentSessionId } };
    if (command === "open_transcript_history") return { readerId: args.request.ptySessionId, sourceGeneration: "fixture", snapshotEnd: "0", items: [], olderCursor: null, newerCursor: "tail", latestCursor: "latest", scanContinuation: null, reachedStart: true, reachedFence: true, diagnostics: [] };
    if (command === "get_pty_metadata_snapshot" || command === "get_session_output_snapshot") return {};
    return null;
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  focusController.clearSession(tab.sessionId); cancelTerminalHistoryRequest(tab.sessionId);
  useDashboardViewStore.setState({ open: false, chatColumnTabIds: [], selectedTabId: null });
  vi.unstubAllGlobals();
});
async function open(shell: "native" | "legacy") {
  await act(async () => root.render(shell === "native" ? <NativePaneShell /> : <DetachedPaneShell workspace={workspace} />));
  focusController.request("programmatic", { sessionId: tab.sessionId, focus: true });
  await settle();
  const terminal = host.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")!;
  expect(document.activeElement).toBe(terminal);
  await act(async () => requestDashboard({ tabId: tab.id }));
  await settle();
  for (let attempt = 0; attempt < 100; attempt++) {
    const ready = host.querySelector<HTMLElement>(".cmux-dashboard-view[tabindex]");
    if (ready && document.activeElement === ready) break;
    await settle();
  }
  const dashboard = host.querySelector<HTMLElement>(".cmux-dashboard-view[tabindex]")!;
  expect(dashboard).not.toBeNull();
  expect(document.activeElement).toBe(dashboard);
  expect(useUiStore.getState().activePaneId).toBeNull();
  return terminal;
}

describe.each(["native", "legacy"] as const)(`D1R-001 ${IS_MAC ? "Mac" : "Windows"} %s real dashboard focus return`, shell => {
  it.each(["escape", "band", "shortcut", "view"] as const)("restores terminal selection, focus, search and history after %s", async source => {
    const terminal = await open(shell);
    await act(async () => {
      if (source === "escape") key("Escape");
      else if (source === "band") host.querySelector<HTMLButtonElement>(`button[aria-label="${dashboardStrings.buttonTitle}"]`)!.click();
      else if (source === "shortcut") key("G", { ...primary(), shiftKey: true });
      else host.querySelector<HTMLButtonElement>(`button[aria-label="${dashboardStrings.backToSession}"]`)!.click();
    });
    await settle();
    expect(useDashboardViewStore.getState().open).toBe(false);
    expect(useUiStore.getState().activePaneId).toBe(tab.sessionId);
    expect(document.activeElement).toBe(terminal);
    await act(async () => {
      key("f", { ...primary(), shiftKey: true });
      key("PageUp", { ...primary(), altKey: true });
    });
    expect(mocks.keys).toEqual(["search:" + tab.sessionId, "history:" + tab.sessionId]);
    expect(mocks.invoke.mock.calls.some(([command]) => command === "open_main_dashboard" || command === "focus_window")).toBe(false);
  });
  it("rejects a foreign last-active session and returns to its own saved terminal", async () => {
    const terminal = await open(shell);
    const foreign = vi.fn();
    const release = focusController.registerTerminal("foreign-session", { focus: foreign, containsActiveElement: () => false, isEligible: () => true });
    try {
      useUiStore.setState({ activePaneId: null, lastActivePaneId: "foreign-session" });
      await act(async () => useDashboardViewStore.getState().close()); await settle();
      expect(foreign).not.toHaveBeenCalled();
      expect(useUiStore.getState().activePaneId).toBe(tab.sessionId);
      expect(document.activeElement).toBe(terminal);
    } finally { release(); }
  });
  it("does not focus the saved terminal after its tab has closed", async () => {
    const terminal = await open(shell);
    const focus = vi.spyOn(terminal, "focus");
    const web = { id: "remaining-web", sessionId: "remaining-web-session", agentId: "", type: "web" as const, label: "Web" };
    await act(async () => useWorkspaceListStore.setState({ workspaces: [{ ...workspace, panes: [{ ...workspace.panes[0], sessionId: web.sessionId, activeTabId: web.id, tabs: [web] }] }] }));
    await act(async () => useDashboardViewStore.getState().close()); await settle();
    expect(focus).not.toHaveBeenCalled();
    expect(useUiStore.getState().activePaneId).not.toBe(tab.sessionId);
  });
});
