// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardView } from "../../src/components/dashboard/DashboardView";
import { DASHBOARD_INBOX_COLUMN_ID, DASHBOARD_PREVIEW_COLUMN_ID, useDashboardViewStore } from "../../src/stores/dashboardViewStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useKeybindingStore } from "../../src/stores/keybindingStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useSessionAttentionStore } from "../../src/stores/sessionAttentionStore";
import { useLiveBriefStore } from "../../src/stores/liveBriefStore";
import { isEditableTarget } from "../../src/lib/keybindings";
import { focusController } from "../../src/lib/focusController";
import { makeAppShellKeydown } from "./fixtures/appShellKeydown";
import { artifactEditorStrings } from "../../src/components/workspace/artifactEditorStrings";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false, invoke: vi.fn().mockResolvedValue(null), Channel: class {}, convertFileSrc: (path: string) => path }));
vi.mock("../../src/lib/ipc", async original => ({ ...await original<object>(),
  onSessionStatusChanged: vi.fn().mockResolvedValue(() => {}), onSavepointPublishProgress: vi.fn().mockResolvedValue(() => {}),
  readEditableArtifact: vi.fn(async () => ({ content: "<p>Dashboard preview</p>", sourceKind: "markdown", sourcePath: "/preview.md" })),
}));
vi.mock("../../src/stores/liveBriefStore", async original => ({ ...await original<object>(), connectLiveBriefStore: () => () => {}, syncDashboardEvents: vi.fn(), stopEventPolling: vi.fn() }));
vi.mock("../../src/lib/backgroundAiScheduler", async original => ({ ...await original<object>(), observeActiveSession: vi.fn() }));
vi.mock("../../src/components/dashboard/AttentionCards", () => ({ AttentionCards: () => <div /> }));
vi.mock("../../src/components/dashboard/WatchStatusRow", () => ({ WatchStatusRow: () => <div /> }));
vi.mock("../../src/components/terminal/XTermWrapper", () => ({ getTerminalWriteCounter: () => 0, hasMountedTerminal: () => false, hasTerminalBuffer: () => false }));

let host: HTMLDivElement; let root: Root; let doc: Document; let handler: (event: KeyboardEvent) => void;
const closePane = vi.fn();
const stateRef = { current: { dashboardOpen: true, isKeybindingsOpen: false, isCrsmPaletteOpen: false } };
function Harness() {
  const open = useDashboardViewStore(state => state.open); stateRef.current.dashboardOpen = open;
  return open ? <DashboardView onClose={() => useDashboardViewStore.getState().close()} /> : null;
}
beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  vi.clearAllMocks(); useKeybindingStore.getState().resetAll();
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {}, lastLog: {}, lastLogAt: {} });
  useSessionAttentionStore.getState().resetForTests(); useLiveBriefStore.getState().reset();
  useWorkspaceListStore.setState({ activeWorkspaceId: "workspace", workspaces: [{ id: "workspace", name: "Synthetic", createdAt: 1,
    gridTemplateId: "1x1", status: "running", panes: [{ id: "terminal", sessionId: "terminal-session", agentId: "shell-starter",
      activeTabId: "terminal-tab", tabs: [{ id: "terminal-tab", sessionId: "terminal-session", agentId: "shell-starter", type: "terminal" }] }] }] });
  useUiStore.setState({ activePaneId: null, lastActivePaneId: "terminal-session", focusRevision: 0, zoomedPaneId: null });
  useDashboardViewStore.setState({ open: true, chatColumnTabIds: [DASHBOARD_INBOX_COLUMN_ID], pinnedChatColumnTabIds: [],
    selectedTabId: DASHBOARD_INBOX_COLUMN_ID, activeChatColumn: 0, query: "", workspaceFilter: null, agentFilter: null, stateFilter: null,
    previewColumn: null, chatColumnLimit: 3 });
  useDashboardViewStore.getState().openOrReloadPreviewColumn({ previewPath: "/preview.html", sourcePath: "/preview.md", sourceKind: "markdown" });
  handler = makeAppShellKeydown(stateRef, useWorkspaceListStore, useUiStore, useKeybindingStore.getState().getActionsForEvent,
    isEditableTarget, closePane, focusController, useWorkspaceLayoutStore.getState().setActivePaneTab, () => null,
    () => useDashboardViewStore.getState().toggle(), () => useDashboardViewStore.getState().openView());
  window.addEventListener("keydown", handler);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<Harness />)); await loadFrame();
});
afterEach(async () => {
  window.removeEventListener("keydown", handler); await act(async () => root.unmount()); host.remove();
  useDashboardViewStore.setState({ open: false, chatColumnTabIds: [], previewColumn: null });
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});
async function loadFrame(): Promise<void> {
  const frame = host.querySelector("iframe")!; expect(frame).not.toBeNull();
  const source = frame.srcdoc; frame.removeAttribute("srcdoc"); frame.src = "about:blank";
  doc = frame.contentDocument!; doc.open(); doc.write(source); doc.close();
  await act(async () => frame.dispatchEvent(new Event("load")));
  expect(doc.querySelector("p")?.textContent).toBe("Dashboard preview");
}
async function key(key: string, options: KeyboardEventInit = { ctrlKey: true, shiftKey: true }): Promise<void> {
  await act(async () => doc.dispatchEvent(new KeyboardEvent("keydown", { key, ...options, bubbles: true, cancelable: true })));
}

describe("dashboard preview keys reach the real DashboardView consumer", () => {
  it("L1 returns keyboard cancellation to the actual surviving dashboard preview header", async () => {
    const article = host.querySelector<HTMLElement>("article[data-dashboard-chat-column='" + DASHBOARD_PREVIEW_COLUMN_ID + "']")!;
    expect(article.closest("[data-dnd-pane-id]")).toBeNull();
    const edit = article.querySelector<HTMLButtonElement>(`button[aria-label='${artifactEditorStrings.startEdit}']`)!;
    edit.focus(); await act(async () => edit.click());
    const cancel = article.querySelector<HTMLButtonElement>(`button[aria-label='${artifactEditorStrings.discardEdits}']`)!;
    cancel.focus(); await act(async () => cancel.click());
    expect(cancel.isConnected).toBe(false); expect(document.activeElement).toBe(article.querySelector("header"));
    expect(useUiStore.getState().activePaneId).toBeNull();
  });
  it("L3 returns normal edit-content cancellation to the dashboard preview header", async () => {
    const article = host.querySelector<HTMLElement>(`article[data-dashboard-chat-column='${DASHBOARD_PREVIEW_COLUMN_ID}']`)!;
    const edit = article.querySelector<HTMLButtonElement>(`button[aria-label='${artifactEditorStrings.startEdit}']`)!;
    await act(async () => edit.click());
    const editor = article.querySelector<HTMLTextAreaElement>("textarea")!; editor.focus();
    const cancel = article.querySelector<HTMLButtonElement>(`button[aria-label='${artifactEditorStrings.discardEdits}']`)!;
    await act(async () => expect(cancel.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))).toBe(false));
    expect(document.activeElement).toBe(editor);
    await act(async () => cancel.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
    expect(editor.isConnected).toBe(false); expect(document.activeElement).toBe(article.querySelector("header"));
  });
  it("moves the active column in both directions through its document capture listener", async () => {
    expect(useDashboardViewStore.getState().activeChatColumn).toBe(1);
    await key("ArrowLeft"); expect(useDashboardViewStore.getState().activeChatColumn).toBe(0);
    await key("ArrowRight"); expect(useDashboardViewStore.getState().activeChatColumn).toBe(1);
    expect(useUiStore.getState().activePaneId).toBeNull(); expect(closePane).not.toHaveBeenCalled();
  });
  it("pins and unpins the actual preview column", async () => {
    await key("p"); expect(useDashboardViewStore.getState().pinnedChatColumnTabIds).toEqual([DASHBOARD_PREVIEW_COLUMN_ID]);
    await key("p"); expect(useDashboardViewStore.getState().pinnedChatColumnTabIds).toEqual([]);
  });
  it("closes the preview column without closing a workspace pane", async () => {
    expect(host.querySelectorAll("[data-dashboard-chat-column]")).toHaveLength(2);
    await key("Backspace"); expect(useDashboardViewStore.getState().chatColumnTabIds).toEqual([DASHBOARD_INBOX_COLUMN_ID]);
    // The real view retains the closing column for its exit animation.
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(host.querySelectorAll("[data-dashboard-chat-column]")).toHaveLength(1); expect(host.querySelector("iframe")).toBeNull();
    expect(closePane).not.toHaveBeenCalled();
  });
  it("lets the iframe toggle close the dashboard through AppShell and the normal opener restore it", async () => {
    await key("g"); expect(useDashboardViewStore.getState().open).toBe(false); expect(host.querySelector("iframe")).toBeNull();
    await act(async () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "g", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })));
    expect(useDashboardViewStore.getState().open).toBe(true); await loadFrame();
  });
  it.each([{ key: "w", ctrlKey: true, altKey: true }, { key: "Tab", ctrlKey: true }])("does not forward pane/workspace keys %j", async keys => {
    const received = vi.fn(); document.addEventListener("keydown", received, true); const before = useUiStore.getState();
    try {
      await key(keys.key, keys); expect(received).not.toHaveBeenCalled(); expect(closePane).not.toHaveBeenCalled();
      expect(useDashboardViewStore.getState().chatColumnTabIds).toHaveLength(2);
      expect(useUiStore.getState().activePaneId).toBe(before.activePaneId); expect(useUiStore.getState().focusRevision).toBe(before.focusRevision);
    } finally { document.removeEventListener("keydown", received, true); }
  });
});
