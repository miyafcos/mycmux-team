// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isEditableTarget } from "../../src/lib/keybindings";
import { useKeybindingStore } from "../../src/stores/keybindingStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { closePaneOperation, resetPaneCloseOperationsForTests } from "../../src/lib/paneCloseOperation";
import { popClosedPane } from "../../src/stores/closedPaneStore";
import { deriveWebPaneForwardedShortcuts, dispatchWebPaneKeydown } from "../../src/components/workspace/webPaneShortcuts";
import type { Pane, PaneTab, Workspace } from "../../src/types";

const mocks = vi.hoisted(() => ({ kill: vi.fn(), evict: vi.fn(), confirm: vi.fn() }));
vi.mock("../../src/lib/ipc", async original => ({ ...await original<object>(), killSession: mocks.kill }));
vi.mock("../../src/lib/paneCloseConfirmation", () => ({ confirmPaneClose: mocks.confirm }));
vi.mock("../../src/components/terminal/terminalCache", async original => ({ ...await original<object>(), evictTerminalCache: mocks.evict }));

// Like paneHeaderKeyboard.test.ts, execute AppShell's actual handler without
// mounting the native app. Keep its render snapshot deliberately stale.
const shell = readFileSync("src/components/layout/AppShell.tsx", "utf8");
const plainKeys = shell.slice(shell.indexOf("const TERMINAL_PLAIN_INPUT_KEYS ="), shell.indexOf("// Read back"));
const helpers = shell.slice(shell.indexOf("function paneMatchesSession("), shell.indexOf("// Compact fallback"));
const keydown = shell.slice(shell.indexOf("const onKeyDown = (e: KeyboardEvent) =>"), shell.indexOf('window.addEventListener("keydown", onKeyDown)'));
const makeHandler = new Function("stateRef", "useWorkspaceListStore", "useUiStore", "getActionsForEvent", "isEditableTarget",
  "closePaneOperation", "focusController", "setActivePaneTab", "findPaneInDirection",
  ts.transpile(`${plainKeys}\n${helpers}\n${keydown}\nreturn onKeyDown;`));
const close = vi.fn(closePaneOperation);
const focus = { request: vi.fn(), focusPaneSoon: vi.fn() };
let handler: (event: KeyboardEvent) => void;

function pane(id: string, type: PaneTab["type"], count = 2): Pane {
  const tabs: PaneTab[] = Array.from({ length: count }, (_, index) => ({
    id: `${id}-tab-${index}`, sessionId: `${id}-session-${index}`, agentId: "shell-starter", type,
  }));
  return { id, sessionId: tabs[0].sessionId, agentId: "shell-starter", activeTabId: tabs[0].id, tabs };
}

function workspace(panes: Pane[]): Workspace {
  return { id: "workspace", name: "Synthetic", gridTemplateId: "1x1", status: "running", createdAt: 1, panes };
}

function setup(panes: Pane[]): void {
  const current = workspace(panes);
  useWorkspaceListStore.setState({ workspaces: [current], activeWorkspaceId: current.id, lastActivePaneByWorkspace: {} });
  handler = makeHandler({ current: {
    workspaces: [workspace([pane("terminal", "terminal")])], activeId: current.id,
    activePaneId: "terminal-session-0", lastActivePaneId: "terminal-session-0",
    isKeybindingsOpen: false, isCrsmPaletteOpen: false, dashboardOpen: false,
  } }, useWorkspaceListStore, useUiStore, useKeybindingStore.getState().getActionsForEvent, isEditableTarget,
  close, focus, useWorkspaceLayoutStore.getState().setActivePaneTab, () => "terminal-session-0");
  window.addEventListener("keydown", handler);
}

beforeEach(() => {
  vi.clearAllMocks(); mocks.kill.mockResolvedValue(undefined); mocks.confirm.mockResolvedValue(true);
  useKeybindingStore.getState().resetAll(); resetPaneCloseOperationsForTests();
  while (popClosedPane()) { /* Drain synthetic history. */ }
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {} });
  useUiStore.setState({ activePaneId: "terminal-session-0", lastActivePaneId: "terminal-session-0", focusRevision: 0 });
});
afterEach(() => window.removeEventListener("keydown", handler));

describe("AppShell shortcut routing immediately after non-terminal activation", () => {
  it.each(["PageDown", "PageUp"])("cycles the originating Web pane for %s before a React rerender", key => {
    setup([pane("terminal", "terminal"), pane("web", "web")]);
    dispatchWebPaneKeydown({ tabId: "web-tab-0", key, code: key, location: 0, ctrlKey: true,
      altKey: true, metaKey: false, shiftKey: false, repeat: false, isComposing: false },
    new Set(deriveWebPaneForwardedShortcuts(useKeybindingStore.getState().keybindings)), new Set(["web-tab-0"]), () => {
      useUiStore.getState().setActivePaneId("web-session-0"); return true;
    });
    const panes = useWorkspaceListStore.getState().workspaces[0].panes;
    expect(panes.find(pane => pane.id === "web")!.activeTabId).toBe("web-tab-1");
    expect(panes.find(pane => pane.id === "terminal")!.activeTabId).toBe("terminal-tab-0");
    expect(focus.request).not.toHaveBeenCalled();
  });

  it.each([1, 2])("closes the just-activated preview with %i tabs using the existing close rules", async count => {
    setup([pane("terminal", "terminal"), pane("preview", "browser", count)]);
    useUiStore.getState().setActivePaneId("preview-session-0");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "w", code: "KeyW", ctrlKey: true, altKey: true,
      bubbles: true, cancelable: true }));
    expect(close).toHaveBeenCalledExactlyOnceWith(count === 1
      ? { kind: "pane", workspaceId: "workspace", paneId: "preview" }
      : { kind: "tab", workspaceId: "workspace", paneId: "preview", tabId: "preview-tab-0" }, "ui");
    expect(await close.mock.results[0].value).toMatchObject({ status: "closed" });
    const panes = useWorkspaceListStore.getState().workspaces[0].panes;
    expect(panes.find(pane => pane.id === "terminal")!.tabs).toHaveLength(2);
    expect(panes.find(pane => pane.id === "preview")?.tabs.map(tab => tab.id) ?? [])
      .toEqual(count === 1 ? [] : ["preview-tab-1"]);
    expect(mocks.kill).not.toHaveBeenCalled();
  });

  it("preserves the last-tab guard after preview activation", async () => {
    setup([pane("preview", "browser", 1)]);
    useUiStore.getState().setActivePaneId("preview-session-0");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "w", code: "KeyW", ctrlKey: true, altKey: true,
      bubbles: true, cancelable: true }));
    expect(close).toHaveBeenCalledExactlyOnceWith({ kind: "pane", workspaceId: "workspace", paneId: "preview" }, "ui");
    expect(await close.mock.results[0].value).toMatchObject({ status: "refused", reason: "last" });
    expect(useWorkspaceListStore.getState().workspaces[0].panes[0].tabs).toHaveLength(1);
    expect(mocks.kill).not.toHaveBeenCalled(); expect(focus.request).not.toHaveBeenCalled();
  });
});
