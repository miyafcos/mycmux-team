// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("../../src/lib/ipc");
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "C:/Users/test") }));
vi.mock("../../src/hooks/usePaneDragSource", () => ({
  usePaneDragSource: () => ({ beginPointerDrag: vi.fn(), shouldSuppressClick: () => false }),
}));

import PaneTabBar from "../../src/components/workspace/PaneTabBar";
import { TERMINAL_SEARCH_EVENT } from "../../src/components/terminal/XTermWrapper";
import NotificationPanel from "../../src/components/layout/NotificationPanel";
import { useSessionAttentionStore } from "../../src/stores/sessionAttentionStore";
import { notificationPanelStrings } from "../../src/components/layout/notificationPanelStrings";
import ToastHost from "../../src/components/common/ToastHost";
import CrsmPalette from "../../src/components/CommandPalette/CrsmPalette";
import { terminalPaneStrings, toastStrings, resumeStrings } from "../../src/components/workspace/terminalPaneStrings";
import { useWorkspaceListStore, useWorkspaceLayoutStore, usePaneMetadataStore, useUiStore } from "../../src/stores/workspaceStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useToastStore } from "../../src/stores/toastStore";
import { popClosedPane, pushClosedTab } from "../../src/stores/closedPaneStore";
import { TAB_RESTORE_CLOSED_EVENT } from "../../src/components/layout/tabSweep";
import { focusController } from "../../src/lib/focusController";
import { crsmListSessions } from "../../src/lib/ipc";
import type { Pane, Workspace } from "../../src/types";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let width: number;
const pane = {
  id: "pane", sessionId: "session-a", activeTabId: "tab-a", agentId: "shell",
  tabs: [
    { id: "tab-a", sessionId: "session-a", agentId: "shell", type: "terminal", label: "A" },
    { id: "tab-b", sessionId: "session-b", agentId: "shell", type: "terminal", label: "B" },
  ],
} as Pane;
const workspace = { id: "workspace", name: "Work", panes: [pane] } as Workspace;
const sessions = ["first", "second", ...Array.from({ length: 60 }, (_, index) => `older-${index}`)].map((id, index) => ({
  id, kind: "claude" as const, label: id, cwd: "C:/project", source: "native",
  started_at: "2026-09-01T00:00:00Z", last_activity: new Date(Date.UTC(2026, 8, 3) - index * 60_000).toISOString(),
  files_modified: [], incomplete_tasks: [], source_path: "C:/session.jsonl", transcript_path: "C:/session.jsonl", has_user_messages: true,
}));

function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find((node) =>
    node.textContent?.trim() === label || node.getAttribute("aria-label") === label || node.title === label,
  );
  expect(found, label).toBeTruthy();
  return found!;
}

async function click(node: HTMLElement): Promise<void> {
  await act(async () => { node.click(); });
}

// jsdom does not implement browser keyboard defaults. Dispatch real events,
// then emulate only the uncancelled native Tab/Enter/Space default. This does
// not implement application arrow navigation or select a radio for the app.
async function key(value: string, shiftKey = false): Promise<KeyboardEvent> {
  const target = document.activeElement as HTMLElement;
  const event = new KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true });
  await act(async () => {
    target.dispatchEvent(event);
    if (event.defaultPrevented) return;
    if (value === "Tab") {
      const tabbable = [...host.querySelectorAll<HTMLElement>("input, button, [tabindex]")]
        .filter((node) => node.tabIndex >= 0 && !node.hasAttribute("disabled") && !node.closest("[inert]"));
      const index = tabbable.indexOf(target);
      tabbable[index + (shiftKey ? -1 : 1)]?.focus();
    } else if ((value === "Enter" || value === " ") && target instanceof HTMLButtonElement && !target.disabled) {
      target.click();
    }
  });
  return event;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  width = 500;
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: () => void) {}
    observe() { this.callback(); }
    disconnect() {}
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function () {
    return (this as HTMLElement).classList.contains("pane-tabbar") ? width : 600;
  });
  vi.spyOn(focusController, "request").mockImplementation(() => {});
  useWorkspaceListStore.setState({ workspaces: [workspace], activeWorkspaceId: workspace.id });
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {}, lastLog: {} });
  useSessionAttentionStore.setState({ attentionBySession: {} });
  useUiStore.setState({ activePaneId: "session-a" });
  useSettingsStore.setState({ crsmShowClaude: true, crsmShowCodex: true, crsmShowClaudeCodex: true, showSplitDownButton: true });
  vi.mocked(crsmListSessions).mockResolvedValue(sessions as Awaited<ReturnType<typeof crsmListSessions>>);
  while (popClosedPane()) { /* Drain test history. */ }
  useToastStore.setState({ toasts: [] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("reachability controls", () => {
  it("reachability #1 focuses the first menu item, Down/Enter runs the second once, Escape returns to trigger", async () => {
    const add = vi.fn();
    const split = vi.fn();
    await act(async () => root.render(<PaneTabBar pane={pane} workspaceId={workspace.id} onAddTab={add} onSplitDown={split} hasTerminalBuffer={() => true} />));
    const trigger = button(terminalPaneStrings.paneActions);
    await click(trigger);
    const items = [...host.querySelectorAll<HTMLButtonElement>("[role='menuitem']")];
    expect(document.activeElement).toBe(items[0]);
    expect(items[0].type).toBe("button");
    expect(items[1].textContent).toBe("Split down");
    await key("ArrowDown");
    expect(document.activeElement).toBe(items[1]);
    await key("Enter");
    expect(split).toHaveBeenCalledTimes(1);
    expect(add).not.toHaveBeenCalled();
    expect(host.querySelector("[role='menu']")).toBeNull();
    await click(trigger);
    await key("Escape");
    expect(host.querySelector("[role='menu']")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("reachability #1 supports Up wrapping, native Space, and outside dismissal", async () => {
    const add = vi.fn();
    await act(async () => root.render(<PaneTabBar pane={pane} workspaceId={workspace.id} onAddTab={add} hasTerminalBuffer={() => true} />));
    await click(button(terminalPaneStrings.paneActions));
    const items = [...host.querySelectorAll<HTMLButtonElement>("[role='menuitem']")];
    await key("ArrowUp");
    expect(document.activeElement).toBe(items.at(-1));
    await key("ArrowDown");
    await key(" ");
    expect(add).toHaveBeenCalledTimes(1);
    await click(button(terminalPaneStrings.paneActions));
    await act(async () => { document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(host.querySelector("[role='menu']")).toBeNull();
  });

  it("reachability #2 focuses the upper row and Down/Enter crosses into unread and activates only the second", async () => {
    usePaneMetadataStore.setState({ metadata: {
      "session-a": { notificationCount: 2 }, "session-b": { notificationCount: 1 },
    } as ReturnType<typeof usePaneMetadataStore.getState>["metadata"] });
    useSessionAttentionStore.setState({ attentionBySession: {
      "session-a": { sessionId: "session-a", sessionEpoch: 1, attentionId: "question-a", kind: "input",
        detail: null, sessionRevision: 1, uiState: "WaitingInput", stateSince: 1, occurrenceOrder: 1 },
    } });
    const activate = vi.spyOn(useWorkspaceLayoutStore.getState(), "setActivePaneTab").mockImplementation(() => {});
    const setActive = vi.spyOn(useWorkspaceListStore.getState(), "setActiveWorkspace").mockImplementation(() => {});
    const clear = vi.spyOn(usePaneMetadataStore.getState(), "clearNotification").mockImplementation(() => {});
    const close = vi.fn();
    await act(async () => root.render(<NotificationPanel onClose={close} />));
    const rows = [...host.querySelectorAll<HTMLButtonElement>(".cmux-notification-item")];
    expect(host.querySelectorAll("section")).toHaveLength(2);
    expect(rows[0].textContent).toContain(notificationPanelStrings.answer);
    expect(rows[1].textContent).toContain(notificationPanelStrings.open);
    expect(document.activeElement).toBe(rows[0]);
    await key("ArrowDown");
    expect(document.activeElement).toBe(rows[1]);
    await key("Enter");
    expect(activate).toHaveBeenCalledExactlyOnceWith(workspace.id, pane.id, "tab-b");
    expect(setActive).toHaveBeenCalledExactlyOnceWith(workspace.id);
    expect(focusController.request).toHaveBeenCalledExactlyOnceWith("programmatic", { sessionId: "session-b", focus: true });
    expect(clear).toHaveBeenCalledExactlyOnceWith("session-b");
    expect(close).toHaveBeenCalledOnce();
    await key("Escape");
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("reachability #2 preserves mouse activation and does not focus a closing panel", async () => {
    usePaneMetadataStore.setState({ metadata: { "session-a": { notificationCount: 1 } } as ReturnType<typeof usePaneMetadataStore.getState>["metadata"] });
    const activate = vi.spyOn(useWorkspaceLayoutStore.getState(), "setActivePaneTab").mockImplementation(() => {});
    vi.spyOn(useWorkspaceListStore.getState(), "setActiveWorkspace").mockImplementation(() => {});
    vi.spyOn(usePaneMetadataStore.getState(), "clearNotification").mockImplementation(() => {});
    const close = vi.fn();
    await act(async () => root.render(<NotificationPanel closing onClose={close} />));
    expect(document.activeElement).toBe(document.body);
    await act(async () => root.render(<NotificationPanel onClose={close} />));
    await click(host.querySelector<HTMLButtonElement>(".cmux-notification-item")!);
    expect(activate).toHaveBeenCalledExactlyOnceWith(workspace.id, pane.id, "tab-a");
  });

  it("reachability #3 Tab reaches kind radios, arrows select kinds, Shift+Tab returns to search", async () => {
    const close = vi.fn();
    await act(async () => root.render(<CrsmPalette open onClose={close} />));
    const input = host.querySelector("input")!;
    expect(document.activeElement).toBe(input);
    const groups = host.querySelectorAll("[role='radiogroup']");
    expect(groups[0].getAttribute("aria-label")).toBe(resumeStrings.targetKind);
    const radios = groups[0].querySelectorAll<HTMLButtonElement>("[role='radio']");
    expect((await key("Tab")).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(radios[0]);
    await key("ArrowRight");
    expect(document.activeElement).toBe(radios[1]);
    expect(radios[1].getAttribute("aria-checked")).toBe("true");
    expect([...radios].filter((node) => node.tabIndex === 0)).toEqual([radios[1]]);
    await key("ArrowLeft");
    expect(document.activeElement).toBe(radios[0]);
    await key("Tab", true);
    expect(document.activeElement).toBe(input);
    await key("Escape");
    expect(close).toHaveBeenCalledOnce();
  });

  it("reachability #3 reaches filters, cwd, load-more and results without intercepting button Enter", async () => {
    const add = vi.spyOn(useWorkspaceLayoutStore.getState(), "addPaneToWorkspaceWithOptions").mockImplementation(() => {});
    await act(async () => root.render(<CrsmPalette open onClose={vi.fn()} />));
    await key("Tab");
    await key("Tab");
    expect((document.activeElement as HTMLElement).classList.contains("cmux-crsm-filter-button")).toBe(true);
    await key("ArrowRight");
    expect(document.activeElement?.getAttribute("aria-checked")).toBe("true");
    await key("Enter");
    expect(add).not.toHaveBeenCalled();
    await key("Tab");
    expect((document.activeElement as HTMLElement).classList.contains("cmux-crsm-cwd-chip")).toBe(true);
    await key("Enter");
    expect(add).not.toHaveBeenCalled();
    // Selecting cwd adds a clear button to the natural tab sequence.
    await key("Tab");
    expect((document.activeElement as HTMLElement).classList.contains("cmux-crsm-cwd-action--clear")).toBe(true);
    await key("Tab");
    expect((document.activeElement as HTMLElement).classList.contains("cmux-crsm-load-more")).toBe(true);
    await key("Tab");
    expect(document.activeElement?.textContent).toContain("first");
    await key("ArrowDown");
    expect(document.activeElement?.textContent).toContain("second");
    await key("Enter");
    expect(add).toHaveBeenCalledOnce();
    expect(add.mock.calls[0][3]).toMatchObject({ label: "second" });
  });

  it("reachability #3 keeps focus through virtualized End/Home jumps and preserves search navigation", async () => {
    await act(async () => root.render(<CrsmPalette open onClose={vi.fn()} />));
    const input = host.querySelector("input")!;
    await key("ArrowDown");
    expect(document.activeElement).toBe(input);
    const result = host.querySelector<HTMLButtonElement>(".cmux-crsm-item.is-active")!;
    expect(result.textContent).toContain("second");
    const list = result.parentElement!.parentElement!;
    expect(list.contains(host.querySelector(".cmux-crsm-load-more"))).toBe(false);
    await act(async () => result.focus());
    await key("End");
    expect(document.activeElement?.textContent).toContain("older-59");
    await key("Home");
    expect(document.activeElement?.textContent).toContain("first");
  });

  it("reachability #4 dismisses once with close click, Escape inside, body click, or action", async () => {
    const run = vi.fn();
    const dismiss = vi.spyOn(useToastStore.getState(), "dismissToast").mockImplementation(() => {});
    useToastStore.setState({ toasts: [{ id: "toast", message: "Message", kind: "info", category: "system", createdAt: 0, action: { label: "Action", run } }] });
    await act(async () => root.render(<ToastHost />));
    await click(button(toastStrings.close));
    expect(dismiss).toHaveBeenCalledExactlyOnceWith("toast");
    dismiss.mockClear();
    button("Action").focus();
    await key("Escape");
    expect(dismiss).toHaveBeenCalledExactlyOnceWith("toast");
    expect(run).not.toHaveBeenCalled();
    dismiss.mockClear();
    await click(host.querySelector<HTMLElement>("[role='status']")!);
    expect(dismiss).toHaveBeenCalledExactlyOnceWith("toast");
    dismiss.mockClear();
    await click(button("Action"));
    expect(dismiss).toHaveBeenCalledExactlyOnceWith("toast");
    expect(run).toHaveBeenCalledOnce();
    dismiss.mockClear();
    button("Action").blur();
    await key("Escape");
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("reachability #6 reaches the existing reopen handler in full mode and explains an empty history", async () => {
    width = 800;
    const reopen = vi.fn();
    window.addEventListener(TAB_RESTORE_CLOSED_EVENT, reopen);
    try {
      await act(async () => root.render(<PaneTabBar pane={pane} workspaceId={workspace.id} hasTerminalBuffer={() => true} />));
      await click(button(terminalPaneStrings.paneActions));
      let item = button(terminalPaneStrings.reopenTab);
      expect(item.getAttribute("aria-disabled")).toBe("true");
      expect(item.title).toBe(terminalPaneStrings.noClosedTab);
      await click(item);
      await act(async () => item.focus());
      await key("Enter");
      expect(reopen).not.toHaveBeenCalled();
      await key("Escape");
      pushClosedTab(pane, pane.tabs[0], { workspaceId: workspace.id });
      await click(button(terminalPaneStrings.paneActions));
      item = button(terminalPaneStrings.reopenTab);
      expect(item.getAttribute("aria-disabled")).toBe("false");
      await click(item);
      expect(reopen).toHaveBeenCalledOnce();
      const app = readFileSync(resolve(import.meta.dirname, "../../src/components/layout/AppShell.tsx"), "utf8");
      expect(app).toContain('window.addEventListener(TAB_RESTORE_CLOSED_EVENT, restoreClosedPane)');
      expect(app).toMatch(/case "pane.reopen":\s*\{\s*restoreClosedPane\(\)/);
    } finally {
      window.removeEventListener(TAB_RESTORE_CLOSED_EVENT, reopen);
    }
  });

  it.each([800, 500, 330, 240, 200, 160, 100])("reachability #5 routes search from the menu at width %i and folds the header below slim", async (barWidth) => {
    width = barWidth;
    const search = vi.fn();
    window.addEventListener(TERMINAL_SEARCH_EVENT, search);
    try {
      await act(async () => root.render(<PaneTabBar pane={pane} workspaceId={workspace.id} hasTerminalBuffer={() => true} />));
      const header = host.querySelector<HTMLButtonElement>(`button[aria-label='${terminalPaneStrings.searchTerminal}']`);
      expect(Boolean(header)).toBe(barWidth >= 360);
      if (header) {
        expect(header.title).toBe(terminalPaneStrings.searchTerminalTitle);
        await click(header);
        expect(search).toHaveBeenCalledOnce();
        expect((search.mock.calls[0][0] as CustomEvent).detail).toEqual({ sessionId: "session-a" });
        search.mockClear();
      }
      await click(button(terminalPaneStrings.paneActions));
      const item = [...host.querySelectorAll<HTMLButtonElement>("[role='menuitem']")]
        .find((node) => node.textContent === terminalPaneStrings.searchTerminal)!;
      await click(item);
      expect(search).toHaveBeenCalledOnce();
      expect((search.mock.calls[0][0] as CustomEvent).detail).toEqual({ sessionId: "session-a" });
      expect(host.querySelector("[role='menu']")).toBeNull();
    } finally {
      window.removeEventListener(TERMINAL_SEARCH_EVENT, search);
    }
  });

  it.each(["launcher", "browser", "web", "online", "declared"])("reachability #5 explains why search is unavailable for %s tabs", async (type) => {
    const inactivePane = { ...pane, tabs: [{ ...pane.tabs[0], ...(type === "declared" ? { lifecycle: "declared" } : { type }) }] } as Pane;
    const search = vi.fn();
    window.addEventListener(TERMINAL_SEARCH_EVENT, search);
    try {
      await act(async () => root.render(<PaneTabBar pane={inactivePane} workspaceId={workspace.id} hasTerminalBuffer={() => true} />));
      const header = button(terminalPaneStrings.searchTerminal);
      expect(header.getAttribute("aria-disabled")).toBe("true");
      expect(header.title).toBe(terminalPaneStrings.searchUnavailable);
      await click(header);
      await click(button(terminalPaneStrings.paneActions));
      const item = [...host.querySelectorAll<HTMLButtonElement>("[role='menuitem']")]
        .find((node) => node.textContent === terminalPaneStrings.searchTerminal)!;
      expect(item.getAttribute("aria-disabled")).toBe("true");
      expect(item.title).toBe(terminalPaneStrings.searchUnavailable);
      await click(item);
      expect(search).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(TERMINAL_SEARCH_EVENT, search);
    }
  });
});
