// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/window", async (original) => ({
  ...await original<typeof import("@tauri-apps/api/window")>(), getCurrentWindow: () => ({ label: "main" }),
}));
import { paneHeaderInsertionIndex, resolvePaneHeaderTarget } from "../../src/lib/paneHandoff";
import { canDropTarget, commitPaneDragDrop, resolveDropTargetAtPoint } from "../../src/hooks/usePaneDragSource";
import { detachedDockTarget } from "../../src/stores/detachedDockStore";
import { restoreWorkspaceConfigs, selectPaneHeaderTab } from "../../src/lib/workspaceRestore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { usePaneDragStore, type PaneDragItem } from "../../src/stores/paneDragStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useUiStore } from "../../src/stores/uiStore";
import { focusController } from "../../src/lib/focusController";
import type { WorkspaceConfig } from "../../src/lib/ipc";
import type { Pane, PaneTab, Workspace } from "../../src/types";

const tab = (id: string): PaneTab => ({ id, sessionId: `pty-${id}`, agentId: "shell-starter", type: "terminal", label: id });
const makePane = (id: string, ids: string[]): Pane => ({ id, agentId: "shell-starter", sessionId: `pty-${ids[0]}`, activeTabId: ids[0], tabs: ids.map(tab) });
const source: PaneDragItem = { kind: "tab", workspaceId: "w", paneId: "source", tabId: "incoming", label: "Incoming" };
const destination = () => useWorkspaceListStore.getState().getWorkspace("w")!.panes.find((pane) => pane.id === "destination")!;
let hit: HTMLElement;
let hitTest: ReturnType<typeof vi.fn>;

beforeEach(() => {
  document.body.innerHTML = `<div data-dnd-workspace-id="w" data-dnd-pane-id="destination">
    <div class="pane-tabbar"><div class="pane-tab-pill" data-pane-tab-strip="destination" data-tab-id="old"><span>Active name</span></div><div class="pane-heading-spacer"></div><button>Close</button></div>
    <div data-body></div></div>`;
  const root = document.querySelector<HTMLElement>("[data-dnd-pane-id]")!;
  root.getBoundingClientRect = () => ({ left: 0, right: 600, top: 0, bottom: 400, width: 600, height: 400 }) as DOMRect;
  hit = document.querySelector<HTMLElement>(".pane-tab-pill span")!;
  hitTest = vi.fn(() => hit);
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: hitTest });
  const target = makePane("destination", ["old", "pinned", "tail"]); target.pinnedTabId = "pinned";
  const workspace: Workspace = { id: "w", name: "Synthetic", status: "running", createdAt: 1, gridTemplateId: "1x1",
    panes: [makePane("source", ["incoming", "remaining"]), target], splitColumns: [["source"], ["destination"]] };
  useWorkspaceListStore.setState({ workspaces: [workspace], activeWorkspaceId: "w" });
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {} });
  usePaneDragStore.getState().clearDrag();
  useUiStore.setState({ activePaneId: "pty-incoming" });
  vi.spyOn(focusController, "request").mockImplementation(() => {});
});
afterEach(() => { document.body.innerHTML = ""; vi.restoreAllMocks(); });

function returned(): WorkspaceConfig {
  return { id: "transfer", name: "Synthetic return", created_at: 1, grid_template_id: "1x1", split_columns: [[0]],
    panes: [{ pane_id: "returned-pane", agent_id: "shell-starter", label: null, active_tab_id: "returned-active",
      tabs: ["returned-first", "returned-active"].map((id) => ({ tab_id: id, session_id: `pty-${id}`, agent_id: "shell-starter", type: "terminal", label: id })) }] };
}

describe("isolated header merge helpers", () => {
  it("identifies the complete heading and rejects body, missing identities and detached DOM", () => {
    expect(resolvePaneHeaderTarget(hit)).toEqual({ workspaceId: "w", paneId: "destination" });
    expect(resolvePaneHeaderTarget(document.querySelector(".pane-heading-spacer"))).toEqual({ workspaceId: "w", paneId: "destination" });
    expect(resolvePaneHeaderTarget(document.querySelector(".pane-tabbar button"))).toEqual({ workspaceId: "w", paneId: "destination" });
    expect(resolvePaneHeaderTarget(document.querySelector("[data-body]"))).toBeNull();
    expect(resolvePaneHeaderTarget(null)).toBeNull();
    document.querySelector("[data-dnd-pane-id]")!.removeAttribute("data-dnd-workspace-id");
    expect(resolvePaneHeaderTarget(hit)).toBeNull();
  });
  it("chooses the append position independently of the active heading and pin", () => {
    expect(paneHeaderInsertionIndex(destination())).toBe(3);
    expect(paneHeaderInsertionIndex({ tabs: [] })).toBe(0);
    expect(paneHeaderInsertionIndex({ tabs: [tab("only")] })).toBe(1);
  });
  it("selects an owned incoming session after merge without altering the pin or order", () => {
    const before = useWorkspaceListStore.getState().workspaces;
    expect(selectPaneHeaderTab("w", "missing", "old")).toBe(false);
    expect(selectPaneHeaderTab("w", "destination", "missing")).toBe(false);
    expect(useWorkspaceListStore.getState().workspaces).toBe(before);
    expect(selectPaneHeaderTab("w", "destination", "tail")).toBe(true);
    expect(destination().activeTabId).toBe("tail"); expect(destination().sessionId).toBe("pty-tail");
    expect(destination().pinnedTabId).toBe("pinned");
    expect(destination().tabs.map((tab) => tab.id)).toEqual(["old", "pinned", "tail"]);
  });
});

describe("Stage 2a header drops", () => {
  it.each([[true, ".pane-tab-pill span"], [true, ".pane-heading-spacer"], [false, ".pane-tab-pill span"], [false, ".pane-heading-spacer"]] as const)(
    "appends and selects cross-pane drops with native tearout %s on %s", (enabled, surface) => {
    useSettingsStore.setState({ nativePaneTearoutEnabled: enabled });
    hit = document.querySelector<HTMLElement>(surface)!;
    const target = resolveDropTargetAtPoint(10, 10, source);
    expect(target).toEqual({ kind: "tab-index", workspaceId: "w", paneId: "destination", index: 3 });
    expect(detachedDockTarget({ screenX: 10, screenY: 10 }, { x: 0, y: 0, scale: 1 })).toEqual(target);
    commitPaneDragDrop(source, target);
    expect(destination().tabs.map((tab) => tab.id)).toEqual(["old", "pinned", "tail", "incoming"]);
    expect(destination().activeTabId).toBe("incoming"); expect(destination().sessionId).toBe("pty-incoming");
    expect(destination().pinnedTabId).toBe("pinned");
    expect(useWorkspaceListStore.getState().workspaces[0].splitColumns).toEqual([["source"], ["destination"]]);
    expect(useWorkspaceListStore.getState().workspaces[0].panes[0].tabs.map((tab) => tab.id)).toEqual(["remaining"]);
    expect(focusController.request).toHaveBeenCalledWith("drag", { sessionId: "pty-incoming", focus: true });
  });
  it("merges across workspaces and refuses a destination removed before release", () => {
    const workspace = useWorkspaceListStore.getState().workspaces[0];
    useWorkspaceListStore.setState({ workspaces: [{ ...workspace, panes: [workspace.panes[0]], splitColumns: [["source"]] },
      { ...workspace, id: "other", panes: [workspace.panes[1]], splitColumns: [["destination"]] }] });
    const target = { kind: "tab-index" as const, workspaceId: "other", paneId: "destination", index: 0 };
    expect(canDropTarget(source, target)).toBe(true);
    commitPaneDragDrop(source, target);
    const pane = useWorkspaceListStore.getState().getWorkspace("other")!.panes[0];
    expect(pane.activeTabId).toBe("incoming"); expect(pane.tabs.at(-1)?.id).toBe("incoming");
    expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe("other");
    const removed = { ...target, paneId: "removed" };
    const before = useWorkspaceListStore.getState().workspaces;
    expect(canDropTarget(source, removed)).toBe(false);
    commitPaneDragDrop(source, removed);
    expect(useWorkspaceListStore.getState().workspaces).toBe(before);
  });
  it("never reorders a same-pane heading drop or falls through to an upper split", () => {
    const own: PaneDragItem = { ...source, paneId: "destination", tabId: "tail" };
    const before = useWorkspaceListStore.getState().workspaces;
    expect(resolveDropTargetAtPoint(10, 10, own)).toBeNull();
    expect(canDropTarget(own, { kind: "tab-index", workspaceId: "w", paneId: "destination", index: 0 })).toBe(false);
    commitPaneDragDrop(own, { kind: "tab-index", workspaceId: "w", paneId: "destination", index: 0 });
    expect(useWorkspaceListStore.getState().workspaces).toBe(before);
  });
  it.each([[5, 200, "left"], [595, 200, "right"], [300, 35, "up"], [300, 395, "down"], [300, 200, "center"]] as const)(
    "retains body point %i,%i as the %s zone in both drop paths", (x, y, zone) => {
      hit = document.querySelector<HTMLElement>("[data-body]")!;
      expect(resolveDropTargetAtPoint(x, y, source)).toEqual({ kind: "pane", workspaceId: "w", paneId: "destination", zone });
      expect(detachedDockTarget({ screenX: x, screenY: y }, { x: 0, y: 0, scale: 1 })).toEqual({ kind: "pane-zone", workspaceId: "w", paneId: "destination", zone });
    });
  it("keeps whole-pane drags on their existing five-zone path", () => {
    const group: PaneDragItem = { kind: "pane", workspaceId: "w", paneId: "source", label: "Group", tabCount: 2 };
    expect(resolveDropTargetAtPoint(300, 10, group)).toEqual({ kind: "pane", workspaceId: "w", paneId: "destination", zone: "up" });
    expect(canDropTarget(group, { kind: "tab-index", workspaceId: "w", paneId: "destination", index: 3 })).toBe(false);
  });
  it.each([true, false])("appends and selects the returning window's active session with native tearout %s", (enabled) => {
    useSettingsStore.setState({ nativePaneTearoutEnabled: enabled });
    const result = restoreWorkspaceConfigs([returned()], { activeWorkspaceId: "transfer", placementByWorkspaceId: {
      transfer: { kind: "pane", workspaceId: "w", paneId: "destination", index: 0 },
    } });
    expect(result.restoredWorkspaceIds).toEqual(["w"]); expect(result.activePaneSessionId).toBe("pty-returned-active");
    expect(destination().tabs.map((tab) => tab.id)).toEqual(["old", "pinned", "tail", "returned-first", "returned-active"]);
    expect(destination().activeTabId).toBe("returned-active"); expect(destination().sessionId).toBe("pty-returned-active");
    expect(destination().pinnedTabId).toBe("pinned");
    expect(useWorkspaceListStore.getState().workspaces[0].splitColumns).toEqual([["source"], ["destination"]]);
  });
  it("leaves body-center adoption and origin-only restoration selection unchanged", () => {
    restoreWorkspaceConfigs([returned()], { placementByWorkspaceId: {
      transfer: { kind: "pane-zone", workspaceId: "w", paneId: "destination", zone: "center" },
    } });
    expect(destination().activeTabId).toBe("old"); expect(destination().sessionId).toBe("pty-old");
    const next = returned(); next.id = "origin-transfer"; next.detached = true;
    next.panes[0].tabs = [{ tab_id: "origin-return", session_id: "pty-origin", agent_id: "shell-starter", type: "terminal" }];
    next.detached_from = { workspace_id: "w", pane_id: "destination", tab_id: "origin-return", index: 0 };
    restoreWorkspaceConfigs([next], { dockDetached: true });
    expect(destination().tabs[0].id).toBe("origin-return"); expect(destination().activeTabId).toBe("old");
  });
});
