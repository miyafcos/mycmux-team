// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useKeybindingStore } from "../../src/stores/keybindingStore";
import { usePaneDragStore } from "../../src/stores/paneDragStore";
import { useSavepointDragStore } from "../../src/stores/savepointDragStore";
import { useWebPaneTranscriptStore } from "../../src/stores/webPaneTranscriptStore";
import { useUiStore } from "../../src/stores/uiStore";
import { focusController } from "../../src/lib/focusController";
import { useDashboardViewStore } from "../../src/stores/dashboardViewStore";
import { closePaneOperation, resetPaneCloseOperationsForTests } from "../../src/lib/paneCloseOperation";
import { confirmPaneClose } from "../../src/lib/paneCloseConfirmation";
import type { Workspace } from "../../src/types";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useSessionAttentionStore } from "../../src/stores/sessionAttentionStore";
import { isEditableTarget } from "../../src/lib/keybindings";
import { makeAppShellKeydown } from "./fixtures/appShellKeydown";

vi.mock("../../src/lib/ipc");
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));
vi.mock("../../src/hooks/usePaneDragSource", () => ({
  usePaneDragSource: () => ({ beginPointerDrag: vi.fn(), shouldSuppressClick: () => false }),
}));
vi.mock("../../src/components/composer/PaneComposer", () => ({ PaneComposer: () => null }));
vi.mock("../../src/components/terminal/XTermWrapper", () => ({
  default: () => <div className="xterm"><textarea className="xterm-helper-textarea" /></div>,
  hasTerminalBuffer: () => false,
}));
import { crsmListSessions, onSavepointPublishProgress } from "../../src/lib/ipc";
import TerminalPane from "../../src/components/workspace/TerminalPane";

vi.mock("../../src/components/workspace/webPaneApi", () => ({
  createWebPane: vi.fn().mockResolvedValue("web-pane-web-tab"),
  destroyWebPane: vi.fn().mockResolvedValue(undefined),
  updateWebPane: vi.fn().mockResolvedValue(undefined),
  reloadPreviewWebPane: vi.fn().mockResolvedValue(undefined),
  WEB_PANE_SIGNIN_EVENT: "mycmux:web-pane-signin",
}));
vi.mock("../../src/lib/paneCloseConfirmation", () => ({ confirmPaneClose: vi.fn().mockResolvedValue(true) }));
// Use the installed Tauri event/webview SDK, including its actual listen target.
import WebPaneController from "../../src/components/workspace/WebPaneController";

interface Subscription {
  owner: string;
  event: string;
  target: { kind: string; label?: string };
  handler: number;
}
const roots: { root: Root; container: HTMLDivElement }[] = [];
let subscriptions: Map<number, Subscription>;
let callbacks: Map<number, (event: unknown) => void>;
let metadata: { currentWebview: { label: string }; currentWindow: { label: string } };
let nextId: number;
let received: ReturnType<typeof vi.fn>;
let shellHandler: ((event: KeyboardEvent) => void) | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  subscriptions = new Map(); callbacks = new Map(); nextId = 0;
  metadata = { currentWebview: { label: "main" }, currentWindow: { label: "main" } };
  vi.stubGlobal("__TAURI_INTERNALS__", {
    metadata,
    transformCallback: (callback: (event: unknown) => void) => {
      const id = ++nextId; callbacks.set(id, callback); return id;
    },
    invoke: async (command: string, args: { event?: string; target?: Subscription["target"]; handler?: number; eventId?: number }) => {
      if (command === "plugin:event|listen") {
        const id = ++nextId;
        subscriptions.set(id, {
          owner: metadata.currentWebview.label, event: args.event!, target: args.target!, handler: args.handler!,
        });
        return id;
      }
      if (command === "plugin:event|unlisten") { subscriptions.delete(args.eventId!); return; }
      if (command === "get_test_profile") return null;
      throw new Error(`unexpected IPC in isolated subscription fixture: ${command}`);
    },
  });
  vi.stubGlobal("__TAURI_EVENT_PLUGIN_INTERNALS__", {
    unregisterListener: (_event: string, id: number) => {
      const subscription = subscriptions.get(id);
      if (subscription) callbacks.delete(subscription.handler);
    },
  });
  useKeybindingStore.getState().resetAll();
  vi.mocked(crsmListSessions).mockResolvedValue([]);
  vi.mocked(onSavepointPublishProgress).mockResolvedValue(() => {});
  useSettingsStore.setState({ paneComposerEnabled: false, showTerminalHistoryButton: false, declaredLaunchEnabled: true });
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {} });
  useSessionAttentionStore.getState().resetForTests();
  usePaneDragStore.setState({ item: null }); useSavepointDragStore.setState({ item: null });
  useWebPaneTranscriptStore.setState({ readingTabIds: [] });
  useDashboardViewStore.setState({ open: false }); resetPaneCloseOperationsForTests();
  const workspace: Workspace = {
    id: "workspace", name: "Workspace", gridTemplateId: "1x1", status: "running", createdAt: 1,
    panes: [{ id: "pane", agentId: "web", sessionId: "web-session", activeTabId: "web-tab",
      tabs: [{ id: "web-tab", agentId: "web", sessionId: "web-session", type: "web", presetId: "chatgpt" }] }],
    splitColumns: [["pane"]],
  };
  // Both controllers intentionally recognize the tab during an ownership handoff.
  useWorkspaceListStore.setState({ workspaces: [workspace], activeWorkspaceId: workspace.id });
  useUiStore.setState({ activePaneId: "previous-session", lastActivePaneId: "previous-session", focusRevision: 0, isKeybindingsOpen: false, zoomedPaneId: null });
  received = vi.fn(() => useUiStore.getState().activePaneId); window.addEventListener("keydown", received);
});

afterEach(async () => {
  if (shellHandler) window.removeEventListener("keydown", shellHandler); shellHandler = undefined;
  for (const { root, container } of roots.splice(0)) {
    await act(async () => root.unmount()); container.remove();
  }
  window.removeEventListener("keydown", received); vi.restoreAllMocks(); vi.unstubAllGlobals();
  resetPaneCloseOperationsForTests();
  vi.useRealTimers();
});

async function mount(label: string): Promise<void> {
  metadata.currentWebview.label = label; metadata.currentWindow.label = label;
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container); roots.push({ root, container });
  await act(async () => root.render(<WebPaneController />));
}
async function emitShortcut(owner: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const payload = {
    tabId: "web-tab", key: "Tab", code: "Tab", location: 0, ctrlKey: true,
    altKey: false, shiftKey: false, metaKey: false, repeat: false, isComposing: false, ...overrides,
  };
  await act(async () => {
    for (const [id, subscription] of subscriptions) {
      if (subscription.event !== "mycmux:web-pane-keydown") continue;
      // Pinned Tauri admits Any listeners for every targeted emit; Webview is exact.
      if (subscription.target.kind === "Any"
        || (subscription.target.kind === "Webview" && subscription.target.label === owner)) {
        callbacks.get(subscription.handler)?.({ event: subscription.event, id, payload });
      }
    }
  });
}

describe("F4 actual shortcut subscription", () => {
  it("registers each controller with its own Webview target", async () => {
    await mount("main"); await mount("mycmux-w1");
    const shortcutListeners = [...subscriptions.values()].filter((entry) => entry.event === "mycmux:web-pane-keydown");
    expect(shortcutListeners).toHaveLength(2);
    for (const entry of shortcutListeners) expect(entry.target).toEqual({ kind: "Webview", label: entry.owner });
  });
  it("delivers once across two windows, detach and return even with overlapping tab ownership", async () => {
    await mount("main"); await mount("mycmux-w1");
    await emitShortcut("main"); expect(received).toHaveBeenCalledTimes(1);
    await emitShortcut("mycmux-w1"); expect(received).toHaveBeenCalledTimes(2);
    await emitShortcut("main"); expect(received).toHaveBeenCalledTimes(3);
    await emitShortcut("main", { tabId: "other-tab" });
    await emitShortcut("main", { key: "r", code: "KeyR" });
    await emitShortcut("main", { isComposing: true });
    expect(received).toHaveBeenCalledTimes(3);
  });

  it.each(["web", "browser"] as const)("activates the %s shortcut source before dispatch and preserves keyboard focus", async type => {
    if (type === "browser") {
      useWorkspaceListStore.setState(state => ({ workspaces: state.workspaces.map(workspace => ({ ...workspace,
        panes: workspace.panes.map(pane => ({ ...pane, tabs: pane.tabs.map(tab => ({ ...tab,
          type: "browser" as const, presetId: undefined, sourceKind: "html" as const, htmlPath: "/synthetic/preview.html",
        })) })),
      })) }));
    }
    await mount("main");
    const input = document.createElement("textarea"); document.body.appendChild(input); input.focus();
    const focus = vi.spyOn(focusController, "request");
    try {
      await emitShortcut("main", { key: "PageDown", code: "PageDown", ctrlKey: true, altKey: true });
      expect(received).toHaveBeenCalledOnce();
      expect(received.mock.results[0].value).toBe("web-session");
      expect(useUiStore.getState().activePaneId).toBe("web-session");
      expect(useUiStore.getState().lastActivePaneId).toBe("web-session");
      expect(document.activeElement).toBe(input);
      expect(focus).not.toHaveBeenCalled();
    } finally { input.remove(); }
  });

  it.each([
    { tabId: "other-tab" }, { tabId: "" }, { key: "r", code: "KeyR" }, { isComposing: true },
    { location: 4 }, { ctrlKey: "true" }, { code: null }, { repeat: 1 },
  ])("leaves activation and dispatch unchanged for a rejected payload: %o", async overrides => {
    await mount("main");
    await emitShortcut("main", overrides);
    expect(received).not.toHaveBeenCalled();
    expect(useUiStore.getState().activePaneId).toBe("previous-session");
    expect(useUiStore.getState().focusRevision).toBe(0);
  });

  it("fails closed when a previously registered shortcut source disappeared", async () => {
    await mount("main");
    await act(async () => {
      // Emit before React refreshes desiredRef, exercising a stale registration.
      useWorkspaceListStore.setState({ workspaces: [] });
      for (const [id, subscription] of subscriptions) {
        if (subscription.event === "mycmux:web-pane-keydown") callbacks.get(subscription.handler)?.({
          id, event: subscription.event, payload: {
            tabId: "web-tab", key: "Tab", code: "Tab", location: 0, ctrlKey: true,
            altKey: false, shiftKey: false, metaKey: false, repeat: false, isComposing: false,
          },
        });
      }
    });
    expect(received).not.toHaveBeenCalled();
    expect(useUiStore.getState().activePaneId).toBe("previous-session");
  });

  it.each(["background", "hidden", "closing", "dashboard", "signin", "modal", "settings", "sweep", "zoom"])(
    "rejects activation and dispatch from a registered but %s source", async state => {
      await mount("main");
      let release: ((result: boolean) => void) | undefined;
      let closing: ReturnType<typeof closePaneOperation> | undefined;
      let modal: HTMLElement | undefined;
      if (state === "zoom") {
        await act(async () => {
          useWorkspaceListStore.setState(current => ({ workspaces: current.workspaces.map(workspace => ({ ...workspace,
            panes: [...workspace.panes.map(pane => ({ ...pane, tabs: [...pane.tabs, {
              id: "terminal-sibling", sessionId: "terminal-sibling-session", agentId: "shell-starter", type: "terminal" as const,
            }] })), { id: "preview", sessionId: "preview-session", activeTabId: "preview-tab", agentId: "shell-starter",
              tabs: [{ id: "preview-tab", sessionId: "preview-session", agentId: "shell-starter", type: "online" as const }] }],
          })) }));
          useUiStore.getState().setActivePaneId("preview-session"); useUiStore.getState().setZoomedPaneId("preview");
        });
      }
      if (state === "background") {
        await act(async () => useWorkspaceListStore.setState(current => ({ activeWorkspaceId: "other-workspace",
          workspaces: [...current.workspaces, { ...current.workspaces[0], id: "other-workspace", panes: [{
            id: "other-pane", sessionId: "other-session", activeTabId: "other-tab", agentId: "shell-starter",
            tabs: [{ id: "other-tab", sessionId: "other-session", agentId: "shell-starter", type: "terminal" as const }],
          }] }],
        })));
      }
      if (state === "hidden") {
        await act(async () => useWorkspaceListStore.setState(current => ({ workspaces: current.workspaces.map(workspace => ({ ...workspace,
          panes: workspace.panes.map(pane => ({ ...pane, activeTabId: "sibling-tab", sessionId: "sibling-session",
            tabs: [...pane.tabs, { ...pane.tabs[0], id: "sibling-tab", sessionId: "sibling-session" }] })),
        })) })));
      }
      if (state === "closing") {
        await act(async () => useWorkspaceListStore.setState(current => ({ workspaces: current.workspaces.map(workspace => ({ ...workspace,
          panes: [...workspace.panes, { id: "neighbor", sessionId: "neighbor-session", activeTabId: "neighbor-tab", agentId: "shell-starter",
            tabs: [{ id: "neighbor-tab", sessionId: "neighbor-session", agentId: "shell-starter", type: "terminal" as const }] }],
        })) })));
        vi.mocked(confirmPaneClose).mockImplementationOnce(() => new Promise<boolean>(resolve => { release = resolve; }));
        closing = closePaneOperation({ kind: "pane", workspaceId: "workspace", paneId: "pane" }, "ui");
        expect(release).toBeTypeOf("function");
      }
      if (state === "dashboard") {
        useDashboardViewStore.setState({ open: true }); useUiStore.setState({ activePaneId: null });
      }
      if (state === "signin") {
        for (const [id, subscription] of subscriptions) {
          if (subscription.event === "mycmux:web-pane-signin") callbacks.get(subscription.handler)?.({
            id, event: subscription.event, payload: { tabIds: ["web-tab"], state: "running" },
          });
        }
      }
      if (state === "modal") {
        modal = document.createElement("div"); modal.setAttribute("aria-modal", "true"); document.body.append(modal);
      }
      if (state === "sweep") {
        modal = document.createElement("div"); modal.id = "tab-sweep-panel"; document.body.append(modal);
      }
      if (state === "settings") useUiStore.getState().setIsKeybindingsOpen(true);
      const before = useUiStore.getState();
      try {
        await emitShortcut("main", { key: "PageDown", code: "PageDown", ctrlKey: true, altKey: true });
        expect(received).not.toHaveBeenCalled(); expect(useUiStore.getState().activePaneId).toBe(before.activePaneId);
        expect(useUiStore.getState().lastActivePaneId).toBe(before.lastActivePaneId);
        expect(useUiStore.getState().focusRevision).toBe(before.focusRevision);
      } finally { modal?.remove(); release?.(false); await closing; }
    },
  );
});

describe("J3 accepted Web reselection cancels older heading work", () => {
  it.each(["declared", "dormant", "dormant-record"] as const)("cancels delayed %s work after the one-tab next action", async kind => {
    vi.useFakeTimers();
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    focusController.request("tab-rename", { suppressMs: 0 });
    const deferred = { id: "deferred-tab", sessionId: "deferred-session", agentId: "shell-starter",
      agentKind: "codex" as const, agentSessionId: "11111111-1111-4111-8111-111111111111",
      ...(kind === "declared" ? { lifecycle: "declared" as const } : {}) };
    useWorkspaceListStore.setState(state => ({ workspaces: state.workspaces.map(workspace => ({ ...workspace,
      panes: [...workspace.panes, { id: "deferred-pane", sessionId: deferred.sessionId, agentId: deferred.agentId,
        activeTabId: deferred.id, tabs: [deferred] }],
    })) }));
    if (kind === "dormant-record") {
      useSessionAttentionStore.setState({ dormantCompletionsBySession: {
        [deferred.sessionId]: { tabIds: [deferred.id], attention: { sessionId: deferred.sessionId, sessionEpoch: 1,
          attentionId: "done-id", kind: "done", detail: null, uiState: "done", sessionRevision: 1,
          stateSince: 1, occurrenceOrder: 1 },
          receipt: { ptySessionId: deferred.sessionId, agentKind: "codex", agentSessionId: deferred.agentSessionId,
            ptyGeneration: 1, savedAt: 1, bytes: 100 } },
      } });
    }
    useDashboardViewStore.setState({ open: false, chatColumnTabIds: [], pinnedChatColumnTabIds: [], userTurnRequests: {} });
    useUiStore.setState({ activePaneId: "web-session", lastActivePaneId: "web-session", focusRevision: 10 });
    function DeferredPane() {
      const workspace = useWorkspaceListStore(state => state.workspaces[0]);
      return <TerminalPane pane={workspace.panes[1]} workspaceId={workspace.id} />;
    }
    const launch = vi.spyOn(useWorkspaceLayoutStore.getState(), "launchDeclaredTab").mockImplementation(() => {});
    const select = vi.spyOn(useWorkspaceLayoutStore.getState(), "setActivePaneTab");
    await mount("main");
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container); roots.push({ root, container });
    await act(async () => root.render(<DeferredPane />));
    const focus = vi.spyOn(focusController, "request");
    shellHandler = makeAppShellKeydown({ current: { isKeybindingsOpen: false, isCrsmPaletteOpen: false, dashboardOpen: false } },
      useWorkspaceListStore, useUiStore, useKeybindingStore.getState().getActionsForEvent, isEditableTarget,
      closePaneOperation, focusController, useWorkspaceLayoutStore.getState().setActivePaneTab, () => null);
    window.addEventListener("keydown", shellHandler);

    await act(async () => container.querySelector<HTMLElement>(".pane-active-heading")!.click());
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(select).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled();
    const revision = useUiStore.getState().focusRevision;
    const focused = document.activeElement;
    await emitShortcut("main"); // Ctrl+Tab: the actual AppShell handler returns for Web's single tab.
    expect(received).toHaveBeenCalledOnce();
    expect(select).not.toHaveBeenCalled();
    expect.soft(useUiStore.getState().focusRevision).toBe(revision + 1);
    expect(useUiStore.getState().activePaneId).toBe("web-session");
    await act(async () => vi.advanceTimersByTimeAsync(600));
    expect.soft(select).not.toHaveBeenCalled(); expect.soft(launch).not.toHaveBeenCalled();
    expect.soft(useUiStore.getState().activePaneId).toBe("web-session");
    expect.soft(useUiStore.getState().lastActivePaneId).toBe("web-session");
    expect.soft(useDashboardViewStore.getState().open).toBe(false);
    expect.soft(useDashboardViewStore.getState().userTurnRequests).toEqual({});
    expect.soft(focus).not.toHaveBeenCalled(); expect.soft(document.activeElement).toBe(focused);
  });

  it.each([{ tabId: "other-tab" }, { key: "r", code: "KeyR" }, { isComposing: true }])(
    "does not count a rejected same-session key as a selection: %o", async payload => {
      useUiStore.setState({ activePaneId: "web-session", lastActivePaneId: "web-session", focusRevision: 20 });
      await mount("main"); await emitShortcut("main", payload);
      expect(received).not.toHaveBeenCalled(); expect(useUiStore.getState().focusRevision).toBe(20);
      expect(useUiStore.getState().activePaneId).toBe("web-session");
    },
  );
});
