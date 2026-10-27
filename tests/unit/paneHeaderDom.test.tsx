// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const drag = vi.hoisted(() => ({ begin: vi.fn() }));
vi.mock("../../src/lib/ipc");
vi.mock("../../src/lib/appConfirmation", () => ({ confirm: vi.fn(async () => true) }));
vi.mock("../../src/hooks/usePaneDragSource", () => ({
  usePaneDragSource: () => ({ beginPointerDrag: drag.begin, shouldSuppressClick: () => false }),
}));
import { DashboardButton } from "../../src/components/dashboard/DashboardButton";
import { useLiveBriefStore } from "../../src/stores/liveBriefStore";
import type { LiveSessionBrief } from "../../src/lib/livebrief";
import { isManualDoneMarkValid, buildDashboardCards, resolveDisplayState, type DashboardCardModel } from "../../src/components/dashboard/dashboardModel";
import PaneTabBar from "../../src/components/workspace/PaneTabBar";
import { paneToolbarStrings, terminalPaneStrings } from "../../src/components/workspace/terminalPaneStrings";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useSessionAttentionStore, type SessionAttention } from "../../src/stores/sessionAttentionStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useDashboardViewStore } from "../../src/stores/dashboardViewStore";
import { focusController } from "../../src/lib/focusController";
import { formatShortcutLabel } from "../../src/lib/keybindings";
import { useKeybindingStore } from "../../src/stores/keybindingStore";
import { confirm } from "../../src/lib/appConfirmation";
import { killSession, readAgentSessionMappings, onSavepointPublishProgress, crsmListSessions, getWindowFragments, getPtyMetadataSnapshot, getSessionOutputSnapshot } from "../../src/lib/ipc";
import { closePaneOperation, resetPaneCloseOperationsForTests } from "../../src/lib/paneCloseOperation";
import { popClosedPane, peekClosedPane, getClosedPaneCount } from "../../src/stores/closedPaneStore";
import { persistentLayoutProjection } from "../../src/lib/persistentLayoutProjection";
import { resolvePaneHeaderTarget } from "../../src/lib/paneHandoff";
import { handleSocketCommand } from "../../src/components/layout/socketCommands";
import type { Pane, PaneTab, Workspace } from "../../src/types";

let root: Root;
let host: HTMLDivElement;
let width: number;
const close = vi.fn();
const remove = vi.fn();
const select = vi.fn();
const splitRight = vi.fn();
const splitDown = vi.fn();
const zoom = vi.fn();
const add = vi.fn();

function pane(tabCount = 1, overrides: Partial<PaneTab> = {}): Pane {
  const tabs = Array.from({ length: tabCount }, (_, index): PaneTab => ({
    id: `t${index}`, sessionId: `pty-${index}`, agentId: "shell-starter", type: "terminal", label: `Session ${index}`,
    ...(index === 0 ? overrides : {}),
  }));
  return { id: "p", sessionId: tabs[0].sessionId, agentId: "shell-starter", tabs, activeTabId: tabs[0].id };
}
function Harness() {
  const current = useWorkspaceListStore((state) => state.workspaces[0].panes.find((pane) => pane.id === "p"));
  return current ? <div data-dnd-workspace-id="w" data-dnd-pane-id="p"><PaneTabBar pane={current} workspaceId="w" hasTerminalBuffer={() => true}
    onClose={close} onRemoveTab={remove} onSelectTab={select} onAddTab={add}
    onSplitRight={splitRight} onSplitDown={splitDown} onZoomToggle={zoom} /></div> : null;
}
async function mount(current = pane(), otherPane = false) {
  const workspace: Workspace = { id: "w", name: "Synthetic", gridTemplateId: "1x1", status: "running", createdAt: 1,
    panes: [current, ...(otherPane ? [{ ...pane(), id: "neighbor", sessionId: "pty-neighbor", activeTabId: "neighbor-tab",
      tabs: [{ id: "neighbor-tab", sessionId: "pty-neighbor", agentId: "shell-starter", type: "terminal" as const }] }] : [])],
    splitColumns: otherPane ? [["p"], ["neighbor"]] : [["p"]] };
  await act(async () => {
    useWorkspaceListStore.setState({ workspaces: [workspace], activeWorkspaceId: "w" });
    root.render(<Harness />);
  });
}
async function click(element: HTMLElement | null) {
  expect(element).not.toBeNull();
  await act(async () => element!.click());
}
async function menu() { await click(host.querySelector(`button[aria-label="${terminalPaneStrings.paneActions}"]`)); }
function item(id: string) { return host.querySelector<HTMLButtonElement>(`[data-pane-action="${id}"]`); }

beforeEach(() => {
  vi.clearAllMocks();
  for (const callback of [close, remove, select, splitRight, splitDown, zoom, add]) callback.mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { constructor(private callback: () => void) {} observe() { this.callback(); } disconnect() {} });
  width = 800;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function () {
    return (this as HTMLElement).classList.contains("pane-tabbar") ? width : 600;
  });
  vi.spyOn(focusController, "request").mockImplementation(() => {});
  useSettingsStore.setState({ showTerminalHistoryButton: false, showSplitRightButton: true, showSplitDownButton: true, declaredLaunchEnabled: true });
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {} });
  useSessionAttentionStore.getState().resetForTests();
  useLiveBriefStore.getState().reset();
  usePaneMetadataStore.setState({ lastLogAt: {} });
  useUiStore.setState({ activePaneId: "pty-0" });
  resetPaneCloseOperationsForTests();
  while (popClosedPane()) { /* Drain synthetic history. */ }
  vi.mocked(killSession).mockResolvedValue(undefined);
  vi.mocked(crsmListSessions).mockResolvedValue([]);
  vi.mocked(getWindowFragments).mockResolvedValue([]);
  vi.mocked(getPtyMetadataSnapshot).mockResolvedValue({});
  vi.mocked(getSessionOutputSnapshot).mockResolvedValue({});
  vi.mocked(onSavepointPublishProgress).mockResolvedValue(() => {});
  vi.mocked(confirm).mockResolvedValue(true);
  vi.mocked(readAgentSessionMappings).mockResolvedValue({});
  host = document.createElement("div"); host.dataset.cmuxThemedRoot = "true"; document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe("Stage 2a single heading", () => {
  it.each([800, 500, 320, 244, 204, 181, 164, 120])("keeps one heading and both closing controls at width %i", async (value) => {
    width = value;
    await mount(pane());
    expect(host.querySelectorAll(".pane-tab-pill")).toHaveLength(1);
    expect(host.querySelector("[data-pane-tab-strip]")?.getAttribute("data-pane-tab-strip")).toBe("p");
    expect(host.querySelector(".pane-active-heading-name")?.textContent).toBe("Session 0");
    expect(host.querySelector(".pane-hidden-tabs")).toBeNull();
    expect(host.querySelector(".pane-tab-pin-btn, .pane-tab-pin-badge, .pane-tab-chip, .pane-tab-drop-indicator, .pane-tab-scroll")).toBeNull();
    expect(host.textContent).not.toContain("1/1");
    expect(host.querySelector(".pane-header-close")).not.toBeNull();
    expect(host.querySelector(`button[aria-label="${terminalPaneStrings.paneActions}"]`)).not.toBeNull();
    expect(Boolean(host.querySelector(".pane-tabbar-zoom"))).toBe(value >= 210);
    expect(host.querySelectorAll(".pane-heading-row .pane-tabbar-split")).toHaveLength(value >= 360 ? 2 : value >= 250 ? 1 : 0);
    expect(host.querySelector(".pane-active-heading")?.nextElementSibling?.matches(".pane-header-close")).toBe(true);
    expect(host.querySelector(".pane-place-close")).toBeNull(); // one tab: the name's × already closes the place
    await menu();
    expect(Boolean(item("zoom"))).toBe(value < 210);
    expect(item("split-right")).not.toBeNull(); expect(item("split-down")).not.toBeNull();
    expect(item("close-pane")).toBeNull();
  });

  it.each([800, 500, 320, 244, 204, 181, 164, 120])("shows only the active name plus hidden count at width %i", async (value) => {
    width = value;
    await mount(pane(4));
    const count = host.querySelector<HTMLButtonElement>(".pane-hidden-tabs")!;
    expect(count.textContent).toBe(value < 210 ? "+3" : "裏 3");
    expect(host.querySelectorAll("[data-tab-id]")).toHaveLength(1);
    const operations = host.querySelectorAll(".pane-heading-row button, .pane-active-heading-name").length;
    expect(Boolean(host.querySelector(".pane-place-close"))).toBe(value >= 250);
    // compact3 keeps the 0.88.0 count (the × moved beside the name); wider tiers add split and place ×.
    expect(operations).toBe(value < 210 ? 4 : value < 250 ? 6 : value < 360 ? 8 : 9);
    expect(Boolean(host.querySelector(".pane-heading-row [data-terminal-magnifier]"))).toBe(value >= 210);
    if (value === 181) expect(operations).toBeLessThanOrEqual(4);
    await click(count);
    expect(host.querySelectorAll("[data-menu-tab-id]")).toHaveLength(4);
    expect(host.querySelector('[data-menu-tab-id="t0"]')?.getAttribute("style")).toContain("--cmux-selected");
  });

  it("aggregates hidden severity and keeps active attention out of the count", async () => {
    const attention: SessionAttention = { sessionId: "pty-2", sessionEpoch: 1, attentionId: "error-2", kind: "error",
      detail: "synthetic error", sessionRevision: 1, uiState: "waiting", stateSince: 1, occurrenceOrder: 1 };
    usePaneMetadataStore.setState({ metadata: { "pty-1": { processIsShell: false }, "pty-3": { agentStatus: "waiting" } },
      volatileMetadata: { "pty-1": { outputActive: true } } });
    useSessionAttentionStore.setState({ attentionBySession: { "pty-2": attention } });
    await mount(pane(4));
    const count = () => host.querySelector<HTMLButtonElement>(".pane-hidden-tabs")!;
    expect(count().dataset.hiddenStatus).toBe("error");
    expect(count().style.color).toContain("--status-error");
    await act(async () => useSessionAttentionStore.getState().markSeen("t2", "error-2"));
    expect(count().dataset.hiddenStatus).toBe("waiting");
    await act(async () => usePaneMetadataStore.setState({ metadata: { "pty-0": { agentStatus: "waiting" }, "pty-1": { processIsShell: false } } }));
    expect(count().dataset.hiddenStatus).toBe("working");
    await act(async () => usePaneMetadataStore.setState({ volatileMetadata: {} }));
    expect(count().dataset.hiddenStatus).toBe("idle");
  });

  it("retains list pin, selection, rename and close operations", async () => {
    await mount(pane(3));
    await click(host.querySelector(".pane-hidden-tabs"));
    const row = () => host.querySelector<HTMLElement>('[data-menu-tab-id="t1"]')!;
    await click(row().querySelector(".pane-tab-menu-pin-btn"));
    expect(useWorkspaceListStore.getState().workspaces[0].panes[0].pinnedTabId).toBe("t1");
    expect(host.querySelector("[data-menu-tab-id]")?.getAttribute("data-menu-tab-id")).toBe("t1");
    await click(row().querySelector(`button[title="${paneToolbarStrings.closeTab}"]`));
    expect(remove).toHaveBeenCalledExactlyOnceWith("t1");
    await click(row().querySelector(".pane-tab-menu-rename-btn"));
    expect(document.querySelector("[data-pane-tab-rename-input]")).not.toBeNull();
    expect(select).not.toHaveBeenCalled();
    await act(async () => document.querySelector("[data-pane-tab-rename-input]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await click(host.querySelector(".pane-hidden-tabs"));
    await click(row());
    expect(select).toHaveBeenCalledExactlyOnceWith("t1");
    expect(host.querySelector(".pane-tab-menu")).toBeNull();
  });

  it("defines all overflow items in order and preserves history's availability check", async () => {
    useSettingsStore.setState({ showTerminalHistoryButton: true });
    usePaneMetadataStore.setState({ metadata: { "pty-0": { agentKind: "claude", agentSessionId: "synthetic-agent" } } });
    width = 164;
    await mount(pane(3), true);
    await menu();
    expect([...host.querySelectorAll(".pane-actions-menu [data-pane-action]")].map((node) => node.getAttribute("data-pane-action")))
      .toEqual(["new-tab", "rename", "reset-name", "search", "publish", "dashboard", "history", "duplicate", "split-right", "split-down", "zoom", "reopen", "close-pane"]);
    expect(readAgentSessionMappings).toHaveBeenCalledWith(["pty-0"]);
    await vi.waitFor(() => expect(host.querySelector(".pane-actions-menu [data-terminal-magnifier]")?.getAttribute("aria-disabled")).toBe("true"), { timeout: 10_000 });
    expect(item("close-pane")?.title).toBe(paneToolbarStrings.reopenActiveOnly);
    expect(item("duplicate")?.getAttribute("aria-disabled")).toBe("false");
  });

  it("applies menu gates and resets the active name without selecting it", async () => {
    useSettingsStore.setState({ showSplitRightButton: false, showSplitDownButton: false });
    await mount(pane(1, { type: "web", presetId: "browser" }), true);
    expect(host.querySelector(".pane-tabbar-split")).toBeNull();
    await menu();
    expect(item("split-right")).toBeNull(); expect(item("split-down")).toBeNull();
    expect(item("publish")).toBeNull(); expect(item("duplicate")).toBeNull();
    expect(item("search")?.getAttribute("aria-disabled")).toBe("true");
    expect(item("search")?.title).toBe(terminalPaneStrings.searchUnavailable);
    await click(item("reset-name"));
    expect(useWorkspaceListStore.getState().workspaces[0].panes[0].tabs[0].label).toBeUndefined();
    expect(select).not.toHaveBeenCalled();
    await menu();
    expect(item("reset-name")?.getAttribute("aria-disabled")).toBe("true");
    expect(item("reset-name")?.title).toBe(terminalPaneStrings.automaticName);
  });

  it("puts split buttons on the heading per setting and runs the existing callbacks", async () => {
    useSettingsStore.setState({ showSplitRightButton: true, showSplitDownButton: false });
    await mount(pane(2));
    const right = () => host.querySelector<HTMLButtonElement>(`.pane-heading-row button[aria-label="${paneToolbarStrings.splitRight}"]`);
    const down = () => host.querySelector<HTMLButtonElement>(`.pane-heading-row button[aria-label="${paneToolbarStrings.splitDown}"]`);
    const shortcut = (action: "pane.split.right" | "pane.split.down") => formatShortcutLabel(useKeybindingStore.getState().keybindings[action]);
    expect(right()?.title).toBe(paneToolbarStrings.splitRightAt(shortcut("pane.split.right")));
    expect(down()).toBeNull();
    await act(async () => right()!.dispatchEvent(new MouseEvent("pointerdown", { button: 0, bubbles: true })));
    expect(drag.begin).not.toHaveBeenCalled();
    await click(right());
    expect(splitRight).toHaveBeenCalledOnce();
    await act(async () => useSettingsStore.setState({ showSplitDownButton: true }));
    expect([...host.querySelectorAll(".pane-heading-row .pane-tabbar-split")].map((node) => node.getAttribute("aria-label")))
      .toEqual([paneToolbarStrings.splitRight, paneToolbarStrings.splitDown]);
    expect(down()?.title).toBe(paneToolbarStrings.splitDownAt(shortcut("pane.split.down")));
    await click(down());
    expect(splitDown).toHaveBeenCalledOnce();
    expect(splitRight).toHaveBeenCalledOnce();
    const order = [...host.querySelectorAll(".pane-heading-row button")].map((node) => node.className);
    expect(order.findIndex((name) => name.includes("pane-tabbar-split")))
      .toBeLessThan(order.findIndex((name) => name.includes("pane-tabbar-zoom")));
    await act(async () => useSettingsStore.setState({ showSplitRightButton: false }));
    expect(right()).toBeNull(); expect(down()).not.toBeNull();
  });

  it("creates a launcher through the existing add-tab callback and dismisses the menu", async () => {
    await mount(pane(2));
    await menu();
    await click(item("new-tab"));
    expect(add).toHaveBeenCalledOnce();
    expect(add.mock.calls[0][1]).toBe("launcher");
    expect(host.querySelector(".pane-actions-menu")).toBeNull();
  });

  it.each([800, 500, 320, 244, 204, 181, 164, 120])("routes rendered name and spacer drags and retains drop targets at width %i", async (value) => {
    width = value;
    const current = pane(3);
    current.activeTabId = "t1";
    current.sessionId = "pty-1";
    await mount(current);
    const heading = host.querySelector<HTMLElement>(".pane-active-heading")!;
    const name = heading.querySelector<HTMLElement>(".pane-active-heading-name")!;
    const spacer = host.querySelector<HTMLElement>(".pane-heading-spacer")!;
    expect(heading.dataset.savepointDropWorkspaceId).toBe("w");
    expect(heading.dataset.savepointDropPaneId).toBe("p");
    expect(heading.dataset.savepointDropTabId).toBe("t1");
    expect(spacer).not.toBeNull();
    expect(spacer.closest(".pane-tab-pill")).toBeNull();
    expect(spacer.parentElement).toBe(heading.parentElement);
    // The tab's own × sits between the name and the spacer; it is the only
    // control inside the name/spacer drop surface (right-edge controls stay out).
    const tabClose = heading.nextElementSibling as HTMLElement;
    expect(tabClose.matches("button.pane-header-close")).toBe(true);
    expect(spacer.previousElementSibling).toBe(tabClose);
    expect(spacer.textContent).toBe("");
    expect({ ...spacer.dataset }).toEqual({});
    const content = host.querySelector<HTMLElement>(".pane-heading-content")!;
    expect(content).not.toBeNull();
    expect(heading.parentElement).toBe(content);
    expect([...content.querySelectorAll("button, [role=menu]")]).toEqual([tabClose]);
    expect({ ...content.parentElement!.dataset }).toEqual({});
    for (const surface of [name, tabClose, spacer]) {
      expect(resolvePaneHeaderTarget(surface)).toEqual({ workspaceId: "w", paneId: "p" });
      const drop = surface.closest<HTMLElement>("[data-savepoint-drop-workspace-id][data-savepoint-drop-pane-id][data-savepoint-drop-tab-id]")!;
      expect(drop).not.toBeNull();
      expect(drop.dataset.savepointDropWorkspaceId).toBe("w");
      expect(drop.dataset.savepointDropPaneId).toBe("p");
      expect(drop.dataset.savepointDropTabId).toBe("t1");
    }
    await act(async () => name.dispatchEvent(new MouseEvent("pointerdown", { button: 0, bubbles: true })));
    expect(drag.begin).toHaveBeenCalledTimes(1);
    expect(drag.begin.mock.calls[0][1]).toMatchObject({ kind: "tab", workspaceId: "w", paneId: "p", tabId: "t1" });
    await act(async () => spacer.dispatchEvent(new MouseEvent("pointerdown", { button: 0, bubbles: true })));
    expect(drag.begin).toHaveBeenCalledTimes(2);
    expect(drag.begin.mock.calls[1][1]).toMatchObject({ kind: "pane", workspaceId: "w", paneId: "p", tabCount: 3 });
    expect(drag.begin.mock.calls[1][1]).not.toHaveProperty("tabId");
  });

  it("bounds the name grip to its content and assigns spare width to the spacer", () => {
    // jsdom does not lay out flex items; retain the CSS contract behind the hit surfaces.
    const css = readFileSync(join(__dirname, "../../src/global.css"), "utf8");
    const content = css.match(/\.pane-heading-content\s*\{([^}]+)\}/)?.[1] ?? "";
    const heading = css.match(/\.pane-active-heading\s*\{([^}]+)\}/)![1];
    const name = css.match(/\.pane-active-heading-name\s*\{([^}]+)\}/)![1];
    const spacer = css.match(/\.pane-heading-spacer\s*\{([^}]+)\}/)?.[1] ?? "";
    expect(heading).toMatch(/flex:\s*0\s+1\s+auto\s*;/);
    expect(heading).toMatch(/min-width:\s*0\s*;/);
    expect(heading).toMatch(/overflow:\s*hidden\s*;/);
    expect(name).toMatch(/min-width:\s*0\s*;/);
    expect(name).toMatch(/overflow:\s*hidden\s*;/);
    expect(name).toMatch(/text-overflow:\s*ellipsis\s*;/);
    expect(name).toMatch(/white-space:\s*nowrap\s*;/);
    expect(spacer).toMatch(/flex:\s*1\s+1\s+0\s*;/);
    expect(spacer).toMatch(/min-width:\s*0\s*;/);
    expect(spacer).toMatch(/align-self:\s*stretch\s*;/);
    expect(content).toMatch(/display:\s*flex\s*;/);
    expect(content).toMatch(/align-items:\s*center\s*;/);
    expect(content).toMatch(/gap:\s*2px\s*;/);
    expect(content).toMatch(/flex:\s*1\s+1\s+0\s*;/);
    expect(content).toMatch(/min-width:\s*0\s*;/);
    expect(content).toMatch(/align-self:\s*stretch\s*;/);
  });

  it.each([800, 120])("retains an unmarked whole-pane spacer without an active session at width %i", async (value) => {
    width = value;
    await mount({ ...pane(), tabs: [], activeTabId: "" });
    const content = host.querySelector<HTMLElement>(".pane-heading-content")!;
    expect(content).not.toBeNull();
    expect(content.children).toHaveLength(1);
    expect(host.querySelector(".pane-active-heading")).toBeNull();
    const spacer = content.firstElementChild!;
    expect(spacer.matches(".pane-heading-spacer")).toBe(true);
    expect(spacer.closest("[data-savepoint-drop-workspace-id][data-savepoint-drop-pane-id][data-savepoint-drop-tab-id]")).toBeNull();
    expect(host.querySelector(".pane-header-close")).not.toBeNull();
    expect(host.querySelector('button[aria-label="' + terminalPaneStrings.paneActions + '"]')).not.toBeNull();
    expect(host.querySelector(".pane-hidden-tabs")).toBeNull();
    await act(async () => spacer.dispatchEvent(new MouseEvent("pointerdown", { button: 0, bubbles: true })));
    expect(drag.begin).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({
      kind: "pane", workspaceId: "w", paneId: "p", tabCount: 0,
    }));
  });

  it.each([800, 120])("does not rename or select when the spacer is double-clicked at width %i", async (value) => {
    width = value;
    await mount(pane(3));
    const spacer = host.querySelector<HTMLElement>(".pane-heading-spacer")!;
    expect(spacer).not.toBeNull();
    await act(async () => {
      spacer.dispatchEvent(new MouseEvent("pointerdown", { button: 0, detail: 2, bubbles: true }));
      spacer.dispatchEvent(new MouseEvent("click", { button: 0, detail: 2, bubbles: true }));
      spacer.dispatchEvent(new MouseEvent("dblclick", { button: 0, detail: 2, bubbles: true }));
    });
    expect(document.querySelector("[data-pane-tab-rename-input]")).toBeNull();
    expect(select).not.toHaveBeenCalled();
    expect(drag.begin.mock.calls[0][1]).toMatchObject({ kind: "pane", paneId: "p", tabCount: 3 });
  });

  it.each([1, 3])("uses the existing close callbacks for %i sessions and leaves middle click unchanged", async (count) => {
    await mount(pane(count), true);
    expect(host.querySelector<HTMLButtonElement>(".pane-header-close")!.title)
      .toBe(count === 1 ? paneToolbarStrings.closePane(0) : paneToolbarStrings.closeTab);
    await click(host.querySelector(".pane-header-close"));
    expect(close).toHaveBeenCalledTimes(count === 1 ? 1 : 0);
    expect(remove.mock.calls).toEqual(count === 1 ? [] : [["t0"]]);
    remove.mockClear();
    await act(async () => host.querySelector(".pane-active-heading")!.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true })));
    expect(remove).toHaveBeenCalledExactlyOnceWith("t0");
  });

  it("disables the last pane's last heading and whole-pane menu while allowing an active session close", async () => {
    await mount(pane());
    const button = host.querySelector<HTMLButtonElement>(".pane-header-close")!;
    expect(button.disabled).toBe(true); expect(button.title).toBe(paneToolbarStrings.lastPaneCloseUnavailable);
    await click(button); expect(close).not.toHaveBeenCalled();
    expect(host.querySelector(".pane-place-close")).toBeNull();
    await mount(pane(3));
    const place = host.querySelector<HTMLButtonElement>(".pane-place-close")!;
    expect(place.disabled).toBe(true); expect(place.title).toBe(paneToolbarStrings.lastPaneCloseUnavailable);
    await click(place); expect(close).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLButtonElement>(".pane-header-close")!.disabled).toBe(false);
    expect(host.querySelector<HTMLButtonElement>(".pane-header-close")!.title).toBe(paneToolbarStrings.closeTab);
    await menu();
    expect(item("close-pane")?.getAttribute("aria-disabled")).toBe("true");
    expect(item("close-pane")?.title).toContain(paneToolbarStrings.lastPaneCloseUnavailable);
    expect(item("close-pane")?.title).toContain(paneToolbarStrings.reopenActiveOnly);
    await click(item("close-pane")); expect(close).not.toHaveBeenCalled();
  });

  it.each([1, 3])("preserves confirmation, undo, focus and layout through the real close operation for %i sessions", async (count) => {
    usePaneMetadataStore.setState({ metadata: { "pty-0": { processIsShell: false, cwd: "/synthetic" } } });
    await mount(pane(count), true);
    let pending: Promise<unknown> | undefined;
    close.mockImplementation(() => { pending = closePaneOperation({ kind: "pane", workspaceId: "w", paneId: "p" }, "ui"); });
    remove.mockImplementation((tabId: string) => { pending = closePaneOperation({ kind: "tab", workspaceId: "w", paneId: "p", tabId }, "ui"); });
    await click(host.querySelector(".pane-header-close"));
    await act(async () => { expect(await pending).toMatchObject({ status: "closed" }); });
    expect(confirm).toHaveBeenCalledOnce();
    expect(vi.mocked(confirm).mock.calls[0][1]?.title).toBe("このタブを閉じます");
    expect(killSession).toHaveBeenCalledExactlyOnceWith("pty-0");
    expect(getClosedPaneCount()).toBe(1); expect(peekClosedPane()?.paneSessionId).toBe("pty-0");
    const workspace = useWorkspaceListStore.getState().workspaces[0];
    expect(workspace.splitColumns).toEqual(count === 1 ? [["neighbor"]] : [["p"], ["neighbor"]]);
    expect(useUiStore.getState().activePaneId).toBe(count === 1 ? "pty-neighbor" : "pty-2");
    if (count > 1) {
      expect(workspace.panes[0].tabs.map((tab) => tab.id)).toEqual(["t1", "t2"]);
      expect(workspace.panes[0].activeTabId).toBe("t2");
    }
  });

  it("closes a whole multi-session pane from the menu and records only its active session for reopening", async () => {
    usePaneMetadataStore.setState({ metadata: { "pty-0": { processIsShell: false, cwd: "/synthetic" } } });
    await mount(pane(3), true);
    let pending: Promise<unknown> | undefined;
    close.mockImplementation(() => { pending = closePaneOperation({ kind: "pane", workspaceId: "w", paneId: "p" }, "ui"); });
    await menu();
    expect(item("close-pane")?.textContent).toBe("このタブと裏のタブ 2 個を閉じる");
    expect(item("close-pane")?.title).toBe(paneToolbarStrings.reopenActiveOnly);
    await click(item("close-pane"));
    await act(async () => { expect(await pending).toMatchObject({ status: "closed" }); });
    expect(vi.mocked(confirm).mock.calls[0][1]?.title).toBe("このタブと裏のタブ 2 個を閉じます");
    expect(vi.mocked(killSession).mock.calls.map(([sessionId]) => sessionId)).toEqual(["pty-0", "pty-1", "pty-2"]);
    expect(remove).not.toHaveBeenCalled();
    expect(getClosedPaneCount()).toBe(1);
    expect(peekClosedPane()?.paneSessionId).toBe("pty-0");
    expect(useWorkspaceListStore.getState().workspaces[0].splitColumns).toEqual([["neighbor"]]);
    expect(useUiStore.getState().activePaneId).toBe("pty-neighbor");
  });

  it("splits the closing controls: the name's × closes one tab, the right edge closes the place", async () => {
    await mount(pane(3), true);
    const tabClose = host.querySelector<HTMLButtonElement>(".pane-heading-content > .pane-header-close")!;
    const place = host.querySelector<HTMLButtonElement>(".pane-heading-row > .pane-place-close")!;
    expect(place.title).toBe(`${paneToolbarStrings.closePaneWithHidden(2)}。${paneToolbarStrings.reopenActiveOnly}`);
    expect(place.getAttribute("aria-label")).toBe(place.title);
    await act(async () => tabClose.dispatchEvent(new MouseEvent("pointerdown", { button: 0, bubbles: true })));
    expect(drag.begin).not.toHaveBeenCalled();
    await click(tabClose);
    expect(remove.mock.calls).toEqual([["t0"]]);
    expect(close).not.toHaveBeenCalled();
    remove.mockClear();
    await click(place);
    expect(close).toHaveBeenCalledOnce();
    expect(remove).not.toHaveBeenCalled();
  });

  it("closes a whole multi-session pane from the right-edge × through the real close operation", async () => {
    usePaneMetadataStore.setState({ metadata: { "pty-0": { processIsShell: false, cwd: "/synthetic" } } });
    await mount(pane(3), true);
    let pending: Promise<unknown> | undefined;
    close.mockImplementation(() => { pending = closePaneOperation({ kind: "pane", workspaceId: "w", paneId: "p" }, "ui"); });
    await click(host.querySelector(".pane-place-close"));
    await act(async () => { expect(await pending).toMatchObject({ status: "closed" }); });
    expect(vi.mocked(confirm).mock.calls[0][1]?.title).toBe("このタブと裏のタブ 2 個を閉じます");
    expect(vi.mocked(killSession).mock.calls.map(([sessionId]) => sessionId)).toEqual(["pty-0", "pty-1", "pty-2"]);
    expect(remove).not.toHaveBeenCalled();
    expect(useWorkspaceListStore.getState().workspaces[0].splitColumns).toEqual([["neighbor"]]);
  });

  it("keeps synthetic persistent data and pane.list_all structure identical while rendering and opening menus", async () => {
    await mount(pane(3), true);
    const savedBefore = JSON.stringify(persistentLayoutProjection(useWorkspaceListStore.getState().workspaces));
    const apiStructure = (value: unknown) => {
      const listing = value as {
        workspaces: Array<{ workspaceId: string; splitColumns: string[][] }>;
        panes: Array<{ workspaceId: string; id: string; activeTabId: string; tabs: PaneTab[] }>;
      };
      return { workspaces: listing.workspaces.map(({ workspaceId, splitColumns }) => ({ workspaceId, splitColumns })),
        panes: listing.panes.map(({ workspaceId, id, activeTabId, tabs }) => ({ workspaceId, id, activeTabId,
          tabs: tabs.map(({ id, type, label }) => ({ id, type, label })) })) };
    };
    const apiBefore = apiStructure(await handleSocketCommand("pane.list_all", {}));
    for (const value of [800, 500, 320, 244, 204, 181, 164, 120]) {
      width = value;
      await act(async () => root.render(<Harness key={value} />));
      await menu(); await menu();
      expect(JSON.stringify(persistentLayoutProjection(useWorkspaceListStore.getState().workspaces))).toBe(savedBefore);
    }
    expect(apiStructure(await handleSocketCommand("pane.list_all", {}))).toEqual(apiBefore);
    expect(apiBefore.panes.map((pane) => pane.activeTabId)).toEqual(["t0", "neighbor-tab"]);
    expect(apiBefore.workspaces[0].splitColumns).toEqual([["p"], ["neighbor"]]);
  });

  it.each(["F2", "dblclick"])("renames the active heading using %s without selection", async (entry) => {
    await mount(pane(2));
    const heading = host.querySelector(".pane-active-heading")!;
    await act(async () => heading.dispatchEvent(entry === "F2"
      ? new KeyboardEvent("keydown", { key: entry, bubbles: true, cancelable: true })
      : new MouseEvent("dblclick", { bubbles: true, cancelable: true })));
    expect(document.querySelector("[data-pane-tab-rename-input]")).not.toBeNull();
    expect(select).not.toHaveBeenCalled(); expect(useUiStore.getState().activePaneId).toBe("pty-0");
  });

  it.each([800, 120])("retains Enter and Space activation of the active heading at width %i", async (value) => {
    width = value;
    await mount(pane(2));
    const heading = host.querySelector<HTMLElement>(".pane-active-heading")!;
    for (const key of ["Enter", " "]) {
      select.mockClear();
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      await act(async () => heading.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(true);
      expect(select).toHaveBeenCalledExactlyOnceWith("t0");
    }
  });

  it.each([800, 120])("launches declared names and reselects dormant names at width %i", async (value) => {
    width = value;
    vi.useFakeTimers();
    const launch = vi.spyOn(useWorkspaceLayoutStore.getState(), "launchDeclaredTab").mockImplementation(() => {});
    await mount(pane(1, { lifecycle: "declared", agentKind: "codex" }));
    await click(host.querySelector(".pane-active-heading"));
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(launch).toHaveBeenCalledExactlyOnceWith("w", "p", "t0");
    expect(select).toHaveBeenCalledExactlyOnceWith("t0");
    select.mockClear(); launch.mockClear();
    await mount(pane(1, { agentKind: "codex", agentSessionId: "synthetic-resume" }));
    const openRecord = vi.spyOn(useDashboardViewStore.getState(), "openTranscriptTurnRequest").mockReturnValue(true);
    await click(host.querySelector(".pane-active-heading"));
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(select).toHaveBeenCalledExactlyOnceWith("t0"); expect(openRecord).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    const completed: SessionAttention = { sessionId: "pty-0", sessionEpoch: 1, attentionId: "synthetic-done", kind: "done",
      detail: null, sessionRevision: 1, uiState: "done", stateSince: 1, occurrenceOrder: 1 };
    await act(async () => useSessionAttentionStore.setState({ dormantCompletionsBySession: { "pty-0": {
      receipt: { ptySessionId: "pty-0", agentKind: "codex", agentSessionId: "synthetic-resume", ptyGeneration: 1, savedAt: 1, bytes: 100 },
      tabIds: ["t0"], attention: completed,
    } } }));
    select.mockClear();
    await click(host.querySelector(".pane-active-heading"));
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(openRecord).toHaveBeenCalledExactlyOnceWith("t0", { kind: "latest" });
    expect(select).not.toHaveBeenCalled();
    await mount(pane()); select.mockClear();
    await click(host.querySelector(".pane-active-heading"));
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(select).not.toHaveBeenCalled();
  });
});

describe("review fixes 3 and 4: rendered session state", () => {
  const now = 1_000_000;
  const canonical = (kind: SessionAttention["kind"] = "input", uiState: SessionAttention["uiState"] = "waiting"): SessionAttention => ({
    sessionId: "pty-0", sessionEpoch: 3, sessionRevision: 4, attentionId: "attention", kind, uiState,
    detail: null, stateSince: now - 10_000, occurrenceOrder: 1,
  });
  const publish = (kind: SessionAttention["kind"] = "input", uiState: SessionAttention["uiState"] = "waiting") => {
    useSessionAttentionStore.setState({ attentionBySession: { "pty-0": canonical(kind, uiState) },
      statusSignalsBySession: { "pty-0": { health: "fresh", activity: "idle", lastEvidenceAt: Date.now(),
        lastMonitorAt: Date.now(), lastOutputAt: now, processStartedAt: 1 } } });
  };
  const brief = (turnStartedAt: number) => ({ ptySessionId: "pty-0", ptyGeneration: 3, ptyInstanceId: "instance",
    agentKind: "codex", agentSessionId: "conversation", serviceEpoch: "service", telemetryHealth: "live",
    operationalState: "idle", autonomy: { turnState: "complete", openToolCount: 0, armedBackgroundCount: 0,
      pendingNotificationCount: 0, turnStartedAt }, lastEventAt: now - 10_000, lastSuccessfulReadAt: now, updatedAt: now } as LiveSessionBrief);
  const stateText = () => host.querySelector(".pane-session-state")?.textContent;
  it("expires the header without store updates, then recovers without the removed button", async () => {
    vi.useFakeTimers(); vi.setSystemTime(now); publish();
    await mount(pane(1, { agentKind: "codex", agentSessionId: "conversation" }));
    await act(async () => root.render(<><Harness /><DashboardButton /></>));
    expect(stateText()).toBe("要回答"); expect(host.querySelector(".cmux-your-turn")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
    expect(stateText()).toBe("状態確認不能"); expect(host.querySelector(".cmux-your-turn")).toBeNull();
    await act(async () => publish());
    expect(stateText()).toBe("要回答"); expect(host.querySelector(".cmux-your-turn")).toBeNull();
  });

  it("shares one clock, pauses when hidden, refreshes on visibility and releases on unmount", async () => {
    vi.useFakeTimers(); vi.setSystemTime(now); publish();
    const intervals = vi.spyOn(globalThis, "setInterval"), cleared = vi.spyOn(globalThis, "clearInterval");
    await mount(pane(1, { agentKind: "codex" }));
    await act(async () => root.render(<><Harness /><DashboardButton /></>));
    const ticks = intervals.mock.calls.map((call, index) => ({ call, handle: intervals.mock.results[index].value })).filter(({ call }) => call[1] === 1_000);
    expect(ticks).toHaveLength(1);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(cleared).toHaveBeenCalledWith(ticks[0].handle);
    await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(stateText()).toBe("状態確認不能"); expect(host.querySelector(".cmux-your-turn")).toBeNull();
    const current = useWorkspaceListStore.getState().workspaces[0].panes[0];
    await act(async () => root.render(<PaneTabBar pane={current} workspaceId="w" isVisible={false} hasTerminalBuffer={() => true} />));
    const lastTick = intervals.mock.results.at(-1)!.value;
    expect(cleared).toHaveBeenCalledWith(lastTick);
  });

  it("does not resurrect an old manual completion after a newer turn ends", async () => {
    vi.useFakeTimers(); vi.setSystemTime(now); publish("done", "done");
    const original = brief(now - 20_000);
    useLiveBriefStore.setState({ briefsBySession: { "pty-0": original } });
    useSessionAttentionStore.getState().markDone("t0", now - 5_000);
    await mount(pane(1, { agentKind: "codex", agentSessionId: "conversation" }));
    expect(stateText()).toBe("完了");
    await act(async () => { publish("none", "working"); useLiveBriefStore.setState({ briefsBySession: {
      "pty-0": { ...original, autonomy: { ...original.autonomy!, turnState: "active", turnStartedAt: now - 2_000 } } } }); });
    expect(stateText()).toBe("作業中");
    await act(async () => { publish("done", "done"); useLiveBriefStore.setState({ briefsBySession: { "pty-0": brief(now - 2_000) } }); });
    expect(stateText()).toBe("返答終了");
    expect(isManualDoneMarkValid({ brief: brief(now - 2_000), lastActivityAt: 0, attention: canonical("done", "done") } as DashboardCardModel, now - 5_000)).toBe(false);
  });

  it("keeps same-turn completion through output/read refresh and invalidates legacy new log activity", async () => {
    vi.useFakeTimers(); vi.setSystemTime(now); publish("done", "done");
    const original = brief(now - 20_000);
    useLiveBriefStore.setState({ briefsBySession: { "pty-0": original } });
    useSessionAttentionStore.getState().markDone("t0", now - 5_000);
    await mount(pane(1, { agentKind: "codex" }));
    await act(async () => {
      usePaneMetadataStore.setState({ lastLogAt: { "pty-0": now }, metadata: { "pty-0": { screenStatusAt: now } } });
      useLiveBriefStore.setState({ briefsBySession: { "pty-0": { ...original, lastSuccessfulReadAt: now + 1, updatedAt: now + 1 } } });
    });
    expect(stateText()).toBe("完了");
    await act(async () => useLiveBriefStore.setState({ briefsBySession: {} }));
    expect(stateText()).toBe("返答終了");
  });
  it.each(["needsHuman", "running"] as const)("renders a fresh same-owner %s brief after canonical expiry", async (operationalState) => {
    vi.useFakeTimers(); vi.setSystemTime(now); publish("none", "working");
    const current = { ...brief(now - 20_000), operationalState, autonomy: null };
    useLiveBriefStore.setState({ briefsBySession: { "pty-0": current } });
    useSessionAttentionStore.setState((state) => ({ statusSignalsBySession: {
      "pty-0": { ...state.statusSignalsBySession["pty-0"], health: "stale" },
    } }));
    await mount(pane(1, { agentKind: "codex", agentSessionId: "conversation" }));
    expect(stateText()).toBe(operationalState === "needsHuman" ? "要回答" : "作業中");
    const workspace = useWorkspaceListStore.getState().workspaces[0];
    const [card] = buildDashboardCards([workspace], { metadataBySession: {}, volatileMetadataBySession: {},
      lastLogBySession: {}, lastLogAtBySession: {}, attentionBySession: useSessionAttentionStore.getState().attentionBySession,
      statusSignalsBySession: useSessionAttentionStore.getState().statusSignalsBySession,
      briefsBySession: { "pty-0": current }, seenAttentionByTab: new Map(), doneMarkByTab: new Map(),
      stallsBySession: {}, now, hasTerminalBuffer: () => true });
    expect(resolveDisplayState(card)).toBe(operationalState === "needsHuman" ? "needsHuman" : "running");
  });

  it.each([
    ["input", "waiting", "要回答"],
    ["none", "working", "作業中"],
    ["error", "waiting", "エラー"],
  ] as const)("keeps canonical %s priority over same-turn manual completion", async (kind, uiState, label) => {
    vi.useFakeTimers(); vi.setSystemTime(now); publish("done", "done");
    useLiveBriefStore.setState({ briefsBySession: { "pty-0": brief(now - 20_000) } });
    useSessionAttentionStore.getState().markDone("t0", now - 5_000);
    await mount(pane(1, { agentKind: "codex", agentSessionId: "conversation" }));
    expect(stateText()).toBe("完了");
    await act(async () => publish(kind, uiState));
    expect(stateText()).toBe(label);
  });
});
