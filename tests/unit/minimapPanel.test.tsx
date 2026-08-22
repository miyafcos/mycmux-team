// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LayoutMinimapPanel, MINIMAP_COLLAPSED_WORKSPACE_IDS_STORAGE_KEY } from "../../src/components/dashboard/LayoutMinimapPanel";
import { minimapCellHeightPx, minimapMapHeightPx } from "../../src/components/dashboard/MinimapWorkspaceBlock";
import PaneDragOverlay from "../../src/components/workspace/PaneDragOverlay";
import type { DashboardDisplayState } from "../../src/components/dashboard/dashboardModel";
import { buildMinimapModel, resolveMinimapDropZone } from "../../src/components/dashboard/minimapModel";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import * as layoutMutation from "../../src/lib/layoutMutation";
import * as socketCommands from "../../src/components/layout/socketCommands";
import { focusController } from "../../src/lib/focusController";
import { usePaneDragStore } from "../../src/stores/paneDragStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import type { PaneTab, Workspace } from "../../src/types";

function tab(id: string, lifecycle?: PaneTab["lifecycle"]): PaneTab {
  return { id, sessionId: `session-${id}`, agentId: "codex", agentKind: "codex", label: id, type: "terminal", lifecycle };
}

const pane = (id: string, tabs: PaneTab[]) => ({ id, sessionId: tabs[0]?.sessionId ?? id, agentId: "codex", activeTabId: tabs[0]?.id ?? "", tabs });

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useUiStore.setState({ activePaneId: null, lastActivePaneId: null, focusRevision: 0, zoomedPaneId: null });
});

afterEach(async () => {
  await act(async () => root.unmount());
  usePaneMetadataStore.setState({ volatileMetadata: {} });
  container.remove();
  usePaneDragStore.getState().clearDrag();
  useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

function pointer(type: string, x: number, y: number, pointerId = 1): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    button: { value: 0 },
    clientX: { value: x },
    clientY: { value: y },
    pointerId: { value: pointerId },
  });
  return event;
}

function dndWorkspaces(): Workspace[] {
  return [
    { id: "ws-a", name: "長いワークスペース名A", gridTemplateId: "1x1", status: "running", createdAt: 1,
      panes: [pane("a", [tab("a")])], splitColumns: [["a"]] },
    { id: "ws-b", name: "長いワークスペース名B", gridTemplateId: "1x1", status: "running", createdAt: 1,
      panes: [pane("b", [tab("b")])], splitColumns: [["b"]] },
  ];
}

function newWorkspaceDndWorkspaces(): Workspace[] {
  return [
    { id: "ws-a", name: "長いワークスペース名A", gridTemplateId: "1x1", status: "running", createdAt: 1,
      panes: [pane("a", [tab("stay"), tab("a")])], splitColumns: [["a"]] },
    { id: "ws-b", name: "長いワークスペース名B", gridTemplateId: "1x1", status: "running", createdAt: 1,
      panes: [pane("b", [tab("b")])], splitColumns: [["b"]] },
  ];
}

function stubMinimapTarget(target: HTMLElement): void {
  Object.defineProperty(target, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ left: 0, right: 100, top: 0, bottom: 60, width: 100, height: 60 }),
  });
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => target) });
}

async function renderDndPanel(workspaces: Workspace[], onSelect = vi.fn()): Promise<void> {
  useWorkspaceListStore.setState({ workspaces, activeWorkspaceId: "ws-a" });
  const states = new Map<string, DashboardDisplayState>([["a", "running"], ["b", "running"]]);
  await act(async () => root.render(<LayoutMinimapPanel workspaces={workspaces} displayStateByTabId={states} selectedTabId="a" activePaneSessionId={null} onSelect={onSelect} />));
}

describe("minimapMapHeightPx", () => {
  it("uses chip counts per cell and does not clamp", () => {
    // expanded: pad 5*2 + border 2 + grip 7 + gap 5 + chips * 53 + (chips-1)*5
    expect(minimapCellHeightPx(1, true)).toBe(77);
    expect(minimapCellHeightPx(6, true)).toBe(367);
    expect(minimapMapHeightPx([[1]], true)).toBe(93);
    expect(minimapMapHeightPx([[6]], true)).toBe(383);
    expect(minimapMapHeightPx([[3, 3, 3, 3]], true)).toBe(800);
    expect(minimapMapHeightPx([[1], [1]], true)).toBe(93);
    expect(minimapMapHeightPx([[1, 1, 1]], true)).toBe(255);
    expect(minimapMapHeightPx([Array.from({ length: 8 }, () => 1)], true)).toBe(660);
    expect(minimapMapHeightPx([Array.from({ length: 8 }, () => 1)], true)).toBeGreaterThan(248);
    // collapsed: pad 4*2 + border 2 + grip 7 + gap 4 + chips * 26 + (chips-1)*4
    expect(minimapCellHeightPx(1, false)).toBe(47);
    expect(minimapMapHeightPx([[1]], false)).toBe(63);
  });
});

describe("LayoutMinimapPanel", () => {
  it("projects buildMinimapModel shares for an uneven two-workspace layout", async () => {
    const wsA: Workspace = { id: "ws-a", name: "A", gridTemplateId: "1x1", status: "running", createdAt: 1,
      panes: [pane("a", [tab("a")]), pane("b", [tab("b")]), pane("c", [tab("c")])], splitColumns: [["a", "b"], ["c"]], columnWidths: [1, 3], rowHeightsPerCol: [[1, 3], [1]] };
    const wsB: Workspace = { id: "ws-b", name: "B", gridTemplateId: "1x1", status: "running", createdAt: 1, panes: [pane("d", [tab("d")])], splitColumns: [["d"]] };
    const displayStateByTabId = new Map<string, DashboardDisplayState>([["a", "running"], ["b", "running"], ["c", "running"], ["d", "running"]]);
    await act(async () => root.render(<LayoutMinimapPanel workspaces={[wsA, wsB]} displayStateByTabId={displayStateByTabId} selectedTabId="d" activePaneSessionId="session-b" onSelect={vi.fn()} />));
    const workspace = container.querySelector<HTMLElement>("[data-minimap-workspace='ws-a']")!;
    const model = buildMinimapModel(wsA, { activePaneId: "b" });
    for (const column of model.columns) {
      expect(workspace.querySelectorAll<HTMLElement>(".cmux-minimap-column")[column.index].style.flexGrow).toBe(String(column.widthShare));
      for (const cell of column.cells) expect(workspace.querySelector<HTMLElement>(`[data-minimap-pane='${cell.paneId}']`)!.style.flexGrow).toBe(String(cell.heightShare));
    }
    expect(workspace.querySelector("[data-minimap-pane='b']")?.classList.contains("is-active-pane")).toBe(true);
    expect(workspace.querySelector(".cmux-minimap-workspace-header")?.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector("[data-minimap-workspace='ws-b'] > button")?.getAttribute("aria-expanded")).toBe("true");
    const header = workspace.querySelector<HTMLElement>(".cmux-minimap-workspace-header")!;
    await act(async () => header.click());
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("[data-minimap-workspace='ws-b'] > button")?.getAttribute("aria-expanded")).toBe("true");
    expect(workspace.querySelectorAll<HTMLElement>(".cmux-minimap-column")).toHaveLength(2);
    expect(workspace.querySelector<HTMLElement>("[data-minimap-pane='a']")?.parentElement?.classList.contains("cmux-minimap-column")).toBe(true);
    expect(workspace.querySelector<HTMLElement>("[data-minimap-pane='b']")?.parentElement?.classList.contains("cmux-minimap-column")).toBe(true);
    expect(workspace.querySelector<HTMLElement>("[data-minimap-pane='c']")?.parentElement?.classList.contains("cmux-minimap-column")).toBe(true);
    expect(workspace.querySelectorAll(".cmux-minimap-cell.is-list-row")).toHaveLength(0);
  });

  it("fits the map height to the row count instead of a fixed box", async () => {
    const shallow: Workspace = { id: "ws-shallow", name: "浅い", gridTemplateId: "1x1", status: "running", createdAt: 1,
      panes: [pane("s0", [tab("s0")]), pane("s1", [tab("s1")])], splitColumns: [["s0"], ["s1"]] };
    const deep: Workspace = { id: "ws-deep", name: "深い", gridTemplateId: "1x1", status: "running", createdAt: 1,
      panes: [pane("d0", [tab("d0")]), pane("d1", [tab("d1")]), pane("d2", [tab("d2")])], splitColumns: [["d0", "d1", "d2"]] };
    await act(async () => root.render(<LayoutMinimapPanel workspaces={[shallow, deep]} displayStateByTabId={new Map()} selectedTabId={null} activePaneSessionId={null} onSelect={vi.fn()} />));

    const mapOf = (workspaceId: string) => container
      .querySelector<HTMLElement>(`[data-minimap-workspace='${workspaceId}'] .cmux-minimap-map`)!;
    const heightOf = (workspaceId: string) => Number.parseInt(
      mapOf(workspaceId).style.getPropertyValue("--minimap-map-height"),
      10,
    );

    expect(mapOf("ws-shallow").dataset.minimapRowCount).toBe("1");
    expect(mapOf("ws-deep").dataset.minimapRowCount).toBe("3");
    expect(heightOf("ws-shallow")).toBe(minimapMapHeightPx([[1], [1]], true));
    expect(heightOf("ws-deep")).toBe(minimapMapHeightPx([[1, 1, 1]], true));
    expect(heightOf("ws-shallow")).toBeLessThan(heightOf("ws-deep"));

    const wide: Workspace = { id: "ws-wide", name: "広い", gridTemplateId: "1x1", status: "running", createdAt: 1,
      panes: Array.from({ length: 8 }, (_, index) => pane(`w${index}`, [tab(`w${index}`)])),
      splitColumns: [Array.from({ length: 8 }, (_, index) => `w${index}`)] };
    await act(async () => root.render(<LayoutMinimapPanel workspaces={[wide]} displayStateByTabId={new Map()} selectedTabId={null} activePaneSessionId={null} onSelect={vi.fn()} />));
    expect(heightOf("ws-wide")).toBe(minimapMapHeightPx([Array.from({ length: 8 }, () => 1)], true));
    expect(heightOf("ws-wide")).toBeGreaterThan(248);
  });

  it("sizes the map from each cell's chip count so six stacked chips stay unclipped", async () => {
    const crowded: Workspace = { id: "ws-crowded", name: "密集", gridTemplateId: "1x1", status: "running", createdAt: 1,
      panes: [pane("p", [tab("t0"), tab("t1"), tab("t2"), tab("t3"), tab("t4"), tab("t5")])], splitColumns: [["p"]] };
    await act(async () => root.render(<LayoutMinimapPanel workspaces={[crowded]} displayStateByTabId={new Map()} selectedTabId={null} activePaneSessionId={null} onSelect={vi.fn()} />));
    const map = container.querySelector<HTMLElement>("[data-minimap-workspace='ws-crowded'] .cmux-minimap-map")!;
    const cell = container.querySelector<HTMLElement>("[data-minimap-pane='p']")!;
    const mapHeight = Number.parseInt(map.style.getPropertyValue("--minimap-map-height"), 10);
    expect(mapHeight).toBe(minimapMapHeightPx([[6]], true));
    expect(cell.style.minHeight).toBe(`${minimapCellHeightPx(6, true)}px`);
    expect(container.querySelectorAll("[data-minimap-tab]")).toHaveLength(6);
  });

  it("selects chips without launching declared tabs and toggles workspace expansion", async () => {
    const declared = tab("declared", "declared");
    const wsA: Workspace = { id: "ws-a", name: "A", gridTemplateId: "1x1", status: "running", createdAt: 1, panes: [pane("a", [tab("a"), declared])], splitColumns: [["a"]] };
    const wsB: Workspace = { id: "ws-b", name: "B", gridTemplateId: "1x1", status: "running", createdAt: 1, panes: [pane("b", [tab("b")])], splitColumns: [["b"]] };
    const onSelect = vi.fn();
    const displayStateByTabId = new Map<string, DashboardDisplayState>([["a", "running"], ["declared", "needsHuman"], ["b", "idle"]]);
    await act(async () => root.render(<LayoutMinimapPanel workspaces={[wsA, wsB]} displayStateByTabId={displayStateByTabId} selectedTabId="a" activePaneSessionId={null} onSelect={onSelect} />));
    const chip = container.querySelector<HTMLElement>("[data-minimap-tab='declared']")!;
    expect(chip.dataset.declared).toBe("true");
    expect(chip.classList.contains("is-declared")).toBe(true);
    // The declared chip carries "宣言のみ" in the meta row and a plain title: no
    // "＋ …（まだ）" decoration, no status dot, no elapsed value.
    expect(chip.querySelector(".cmux-minimap-agent")?.textContent).toBe("宣言のみ");
    expect(chip.querySelector(".cmux-minimap-label")?.textContent).toBe("declared");
    expect(chip.textContent).not.toContain("＋");
    expect(chip.querySelector(".cmux-minimap-meta .cmux-minimap-status")).toBeNull();
    expect(chip.querySelector(".cmux-minimap-age")).toBeNull();
    expect(chip.querySelector(".cmux-minimap-question")).not.toBeNull();
    await act(async () => chip.click());
    expect(onSelect).toHaveBeenCalledWith("declared");
    const header = container.querySelector<HTMLElement>("[data-minimap-workspace='ws-b'] > button")!;
    expect(header.getAttribute("aria-expanded")).toBe("true");
    await act(async () => header.click());
    expect(header.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps an expanded label in its layout cell with a two-line readable limit", async () => {
    const longName = "とても長い日本語のワークスペース名でも途中で固定文字数に切られないこと";
    const longLabel = "とても長い日本語のセッションラベルでも途中で固定文字数に切られないこと";
    const ws: Workspace = { id: "ws", name: longName, gridTemplateId: "1x1", status: "running", createdAt: 1,
      panes: [pane("p", [{ ...tab("tab"), label: longLabel }])], splitColumns: [["p"]] };
    await act(async () => root.render(<LayoutMinimapPanel workspaces={[ws]} displayStateByTabId={new Map([["tab", "running"]])} selectedTabId="tab" activePaneSessionId={null} onSelect={vi.fn()} />));
    const chip = container.querySelector<HTMLElement>("[data-minimap-tab='tab']")!;
    const name = container.querySelector<HTMLElement>(".cmux-minimap-workspace-name")!;
    expect(chip.querySelector(".cmux-minimap-label")?.textContent).toBe(longLabel);
    expect(chip.title).toBe(longLabel);
    expect(chip.getAttribute("aria-label")).toContain(`${longLabel} — `);
    expect(chip.getAttribute("aria-label")).toContain("ダブルクリックで元の画面に戻る");
    expect(chip.getAttribute("aria-label")).toContain("Alt+クリックでグループ選択");
    expect(name.textContent).toBe(longName);
    expect(name.title).toBe(longName);
    expect(chip.classList.contains("is-expanded")).toBe(true);
    expect(chip.closest("[data-minimap-expanded='true']")).not.toBeNull();
    expect(chip.querySelector(".cmux-minimap-meta")).not.toBeNull();
    const minimapCss = readFileSync("src/components/dashboard/MinimapPanel.css", "utf8");
    expect(minimapCss).toContain(".cmux-minimap-map.is-expanded .cmux-minimap-label");
    // Two lines, not three: the chip is capped at the same 53px the height
    // budget hands it, and the label may not out-grow what is left over.
    expect(minimapCss).toContain("max-block-size: 2.7em");
    expect(minimapCss).toContain("max-block-size: 53px");
    expect(minimapCss).not.toContain("max-block-size: 4.05em");
    expect(minimapCss).not.toContain("-webkit-line-clamp");
    // padding 4+5, meta row 11 (the Japanese state word floor), gap 3, and two
    // 11px lines at 1.35 have to fit inside the 53px row.
    const chipBudget = 4 + 11 + 3 + Math.ceil(11 * 1.35 * 2) + 5;
    expect(chipBudget).toBeLessThanOrEqual(53);
    expect(4 + 11 + 3 + Math.ceil(11 * 1.35 * 3) + 5).toBeGreaterThan(53);
  });

  it("keeps four equal columns in their screen geometry without horizontal scrolling when expanded", async () => {
    const labels = ["第一タブ名", "第二タブ名", "第三タブ名", "第四タブ名"];
    const workspace: Workspace = { id: "ws", name: "4列", gridTemplateId: "1x1", status: "running", createdAt: 1,
      panes: labels.map((label, index) => pane(`pane-${index}`, [{ ...tab(`tab-${index}`), label }])),
      splitColumns: [["pane-0"], ["pane-1"], ["pane-2"], ["pane-3"]] };
    const selectedWorkspace: Workspace = { id: "selected", name: "選択中", gridTemplateId: "1x1", status: "running", createdAt: 1,
      panes: [pane("selected-pane", [tab("selected-tab")])], splitColumns: [["selected-pane"]] };
    await act(async () => root.render(<LayoutMinimapPanel workspaces={[workspace, selectedWorkspace]} displayStateByTabId={new Map()} selectedTabId="selected-tab" activePaneSessionId={null} onSelect={vi.fn()} />));

    const block = container.querySelector<HTMLElement>("[data-minimap-workspace='ws']")!;
    const map = block.querySelector<HTMLElement>(".cmux-minimap-map")!;
    const columns = Array.from(block.querySelectorAll<HTMLElement>(".cmux-minimap-column"));
    expect(map.style.minWidth).toBe("");
    expect(columns.map((column) => column.style.flexGrow)).toEqual(["0.25", "0.25", "0.25", "0.25"]);
    const minimapCss = readFileSync("src/components/dashboard/MinimapPanel.css", "utf8");
    const minimapBlockSource = readFileSync("src/components/dashboard/MinimapWorkspaceBlock.tsx", "utf8");
    expect(minimapCss).not.toMatch(/overflow-x\s*:/);
    expect(minimapBlockSource).not.toContain("mapMinimumWidth");

    expect(block.querySelector<HTMLElement>("[data-minimap-expanded='true']")).not.toBeNull();
    expect(block.querySelectorAll<HTMLElement>(".cmux-minimap-column")).toHaveLength(4);
    expect(block.querySelectorAll(".cmux-minimap-cell.is-list-row")).toHaveLength(0);
    for (const [index, label] of labels.entries()) {
      const chip = block.querySelector<HTMLElement>(`[data-minimap-tab='tab-${index}']`)!;
      expect(chip.querySelector(".cmux-minimap-label")?.textContent).toBe(label);
      expect(chip.closest<HTMLElement>(".cmux-minimap-column")?.style.flexGrow).toBe("0.25");
    }
  });

  it("moves one minimap tab to the new-workspace zone without activating or focusing it", async () => {
    const workspaces = newWorkspaceDndWorkspaces();
    await renderDndPanel(workspaces);
    const source = container.querySelector<HTMLElement>("[data-minimap-tab='a']")!;
    const target = container.querySelector<HTMLElement>("[data-minimap-new-workspace-target='true']")!;
    stubMinimapTarget(target);
    const moveSpy = vi.spyOn(useWorkspaceLayoutStore.getState(), "moveTabToNewWorkspace");
    const setActiveWorkspaceSpy = vi.spyOn(useWorkspaceListStore.getState(), "setActiveWorkspace");
    const focusSpy = vi.spyOn(focusController, "request");
    await act(async () => {
      source.dispatchEvent(pointer("pointerdown", 50, 30));
      window.dispatchEvent(pointer("pointermove", 56, 30));
      window.dispatchEvent(pointer("pointerup", 56, 30));
    });

    expect(moveSpy).toHaveBeenCalledTimes(1);
    expect(moveSpy).toHaveBeenLastCalledWith("ws-a", "a", "a", expect.any(String), "Workspace 3", { activate: false });
    expect(setActiveWorkspaceSpy).not.toHaveBeenCalled();
    expect(focusSpy).not.toHaveBeenCalled();
    expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe("ws-a");
    expect(useUiStore.getState().focusRevision).toBe(0);
    const newWorkspace = useWorkspaceListStore.getState().workspaces.at(-1)!;
    expect(newWorkspace.panes[0].tabs.map((item) => item.id)).toEqual(["a"]);
    expect(newWorkspace.splitColumns).toEqual([[newWorkspace.panes[0].id]]);
  });

  it("uses a pane-cell background as a pane drag source without arming the marquee", async () => {
    const workspaces = dndWorkspaces();
    await renderDndPanel(workspaces);
    const stack = container.querySelector<HTMLElement>(".cmux-minimap-stack")!;
    const source = container.querySelector<HTMLElement>("[data-minimap-pane='a'] [data-minimap-pane-grip]")!;
    const sourceCell = container.querySelector<HTMLElement>(".cmux-minimap-cell[data-minimap-dnd-pane-id='a']")!;
    const target = container.querySelector<HTMLElement>(".cmux-minimap-cell[data-minimap-dnd-pane-id='b']")!;
    stubMinimapTarget(target);
    const mutationSpy = vi.spyOn(layoutMutation, "applyLayoutMutation");
    const replaceSpy = vi.spyOn(useWorkspaceListStore.getState(), "_replaceWorkspaces");
    const focusSpy = vi.spyOn(focusController, "request");
    mutationSpy.mockClear();
    replaceSpy.mockClear();
    focusSpy.mockClear();

    await act(async () => {
      source.dispatchEvent(pointer("pointerdown", 50, 30));
      window.dispatchEvent(pointer("pointermove", 56, 30));
    });

    expect(usePaneDragStore.getState().item).toMatchObject({ kind: "pane", surface: "minimap", workspaceId: "ws-a", paneId: "a" });
    expect(sourceCell.classList.contains("is-drag-source")).toBe(true);
    expect(sourceCell.classList.contains("is-minimap-drop-target")).toBe(false);
    expect(target.classList.contains("is-minimap-drop-target")).toBe(true);
    expect(stack.classList.contains("is-minimap-dragging")).toBe(true);
    expect(target.dataset.minimapDropZone).toBe("center");
    expect(container.querySelector(".cmux-minimap-selection-marquee")).toBeNull();

    await act(async () => window.dispatchEvent(pointer("pointerup", 56, 30)));
    expect(mutationSpy).toHaveBeenCalledTimes(1);
    expect(replaceSpy).toHaveBeenCalledTimes(1);
    expect(useWorkspaceListStore.getState().getWorkspace("ws-b")?.panes[0].tabs.map((item) => item.id)).toEqual(["b", "a"]);
    expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe("ws-a");
    expect(focusSpy).not.toHaveBeenCalled();
    expect(useUiStore.getState().focusRevision).toBe(0);
  });

  it("lifts a minimap pane with the existing ghost while dimming its source", async () => {
    const workspaces = dndWorkspaces();
    const states = new Map<string, DashboardDisplayState>([["a", "running"], ["b", "running"]]);
    useWorkspaceListStore.setState({ workspaces, activeWorkspaceId: "ws-a" });
    await act(async () => root.render(<><LayoutMinimapPanel workspaces={workspaces} displayStateByTabId={states} selectedTabId="a" activePaneSessionId={null} onSelect={vi.fn()} /><PaneDragOverlay /></>));
    const source = container.querySelector<HTMLElement>("[data-minimap-pane='a'] [data-minimap-pane-grip]")!;
    const sourceCell = container.querySelector<HTMLElement>(".cmux-minimap-cell[data-minimap-dnd-pane-id='a']")!;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => source) });
    const mutationSpy = vi.spyOn(layoutMutation, "applyLayoutMutation");
    const focusSpy = vi.spyOn(focusController, "request");
    mutationSpy.mockClear();
    focusSpy.mockClear();

    await act(async () => {
      source.dispatchEvent(pointer("pointerdown", 50, 30));
      window.dispatchEvent(pointer("pointermove", 60, 30));
    });

    const ghost = container.querySelector<HTMLElement>(".pane-drag-ghost--pane");
    expect(ghost).not.toBeNull();
    expect(ghost?.style.transform).toContain("translate3d");
    expect(sourceCell.classList.contains("is-drag-source")).toBe(true);
    expect(sourceCell.classList.contains("is-active-pane")).toBe(false);
    expect(sourceCell.classList.contains("is-minimap-drop-target")).toBe(false);
    expect(sourceCell.dataset.minimapDropZone).toBeUndefined();
    expect(sourceCell.querySelector<HTMLElement>("[data-minimap-tab='a']")?.classList.contains("is-selected")).toBe(false);
    expect(usePaneDragStore.getState().target).toBeNull();
    await act(async () => window.dispatchEvent(pointer("pointerup", 60, 30)));
    expect(mutationSpy).not.toHaveBeenCalled();
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it("arms the marquee from pane empty space and workspace padding, not from chips, grips, or headers", async () => {
    const workspace: Workspace = { id: "ws", name: "Marquee boundary", gridTemplateId: "1x1", status: "running", createdAt: 1,
      panes: [pane("a", [tab("a")]), pane("b", [tab("b")])], splitColumns: [["a"], ["b"]] };
    await act(async () => root.render(<LayoutMinimapPanel workspaces={[workspace]} displayStateByTabId={new Map()} selectedTabId="a" activePaneSessionId={null} onSelect={vi.fn()} />));
    const stack = container.querySelector<HTMLElement>(".cmux-minimap-stack")!;
    Object.defineProperty(stack, "getBoundingClientRect", { configurable: true, value: () => ({ left: 0, top: 0, right: 200, bottom: 200, width: 200, height: 200 }) });
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => stack) });
    const workspaceBlock = container.querySelector<HTMLElement>("[data-minimap-workspace='ws']")!;
    const map = workspaceBlock.querySelector<HTMLElement>(".cmux-minimap-map")!;
    const column = workspaceBlock.querySelector<HTMLElement>(".cmux-minimap-column")!;
    const cell = workspaceBlock.querySelector<HTMLElement>(".cmux-minimap-cell[data-minimap-dnd-pane-id='a']")!;
    const grip = workspaceBlock.querySelector<HTMLElement>("[data-minimap-pane='a'] [data-minimap-pane-grip]")!;
    const chip = workspaceBlock.querySelector<HTMLElement>("[data-minimap-tab='a']")!;
    const header = workspaceBlock.querySelector<HTMLElement>(".cmux-minimap-workspace-header")!;

    const expectNoMarquee = async (target: HTMLElement, pointerId: number) => {
      await act(async () => {
        target.dispatchEvent(pointer("pointerdown", 20, 20, pointerId));
        target.dispatchEvent(pointer("pointermove", 30, 20, pointerId));
      });
      expect(container.querySelector(".cmux-minimap-selection-marquee")).toBeNull();
      await act(async () => window.dispatchEvent(pointer("pointerup", 30, 20, pointerId)));
    };
    const expectMarquee = async (target: HTMLElement, pointerId: number) => {
      await act(async () => {
        target.dispatchEvent(pointer("pointerdown", 20, 20, pointerId));
        target.dispatchEvent(pointer("pointermove", 30, 20, pointerId));
      });
      expect(container.querySelector(".cmux-minimap-selection-marquee")).not.toBeNull();
      await act(async () => window.dispatchEvent(pointer("pointerup", 30, 20, pointerId)));
    };

    await expectNoMarquee(chip, 81);
    await expectNoMarquee(grip, 82);
    await expectNoMarquee(header, 83);
    await expectMarquee(cell, 84);
    await expectMarquee(column, 85);
    await expectMarquee(map, 86);

    await act(async () => {
      stack.dispatchEvent(pointer("pointerdown", 0, 0, 87));
      stack.dispatchEvent(pointer("pointermove", 10, 10, 87));
    });
    expect(container.querySelector(".cmux-minimap-selection-marquee")).not.toBeNull();
    await act(async () => stack.dispatchEvent(pointer("pointerup", 10, 10, 87)));
  });

  it("never grows a marquee out of a chip that is already being dragged", async () => {
    const workspace: Workspace = { id: "ws", name: "Chip drag", gridTemplateId: "1x1", status: "running", createdAt: 1,
      panes: [pane("a", [tab("a")]), pane("b", [tab("b")])], splitColumns: [["a"], ["b"]] };
    await act(async () => root.render(<LayoutMinimapPanel workspaces={[workspace]} displayStateByTabId={new Map()} selectedTabId="a" activePaneSessionId={null} onSelect={vi.fn()} />));
    const stack = container.querySelector<HTMLElement>(".cmux-minimap-stack")!;
    Object.defineProperty(stack, "getBoundingClientRect", { configurable: true, value: () => ({ left: 0, top: 0, right: 200, bottom: 200, width: 200, height: 200 }) });
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => stack) });
    const chip = container.querySelector<HTMLElement>("[data-minimap-tab='a']")!;

    // The second move is the one that used to flip the chip drag into a marquee.
    await act(async () => {
      chip.dispatchEvent(pointer("pointerdown", 20, 20, 91));
      chip.dispatchEvent(pointer("pointermove", 40, 20, 91));
      chip.dispatchEvent(pointer("pointermove", 90, 60, 91));
      chip.dispatchEvent(pointer("pointermove", 140, 120, 91));
    });
    expect(container.querySelector(".cmux-minimap-selection-marquee")).toBeNull();
    await act(async () => window.dispatchEvent(pointer("pointerup", 140, 120, 91)));
  });

  it("keeps tab and bundle dragging ahead of the pane-cell drag source", async () => {
    const workspaces = dndWorkspaces();
    await renderDndPanel(workspaces);
    const source = container.querySelector<HTMLElement>("[data-minimap-tab='a']")!;
    const sourceCell = container.querySelector<HTMLElement>("[data-minimap-dnd-pane-id='a']")!;
    const target = container.querySelector<HTMLElement>("[data-minimap-dnd-pane-id='b']")!;
    stubMinimapTarget(target);

    await act(async () => {
      source.dispatchEvent(pointer("pointerdown", 50, 30));
      window.dispatchEvent(pointer("pointermove", 56, 30));
    });

    expect(usePaneDragStore.getState().item).toMatchObject({ kind: "tab", surface: "minimap", tabId: "a" });
    expect(sourceCell.classList.contains("is-drag-source")).toBe(false);
    expect(container.querySelector(".cmux-minimap-selection-marquee")).toBeNull();
    await act(async () => window.dispatchEvent(pointer("pointercancel", 56, 30)));
  });

  it("keeps the new-workspace button disabled without a selected tab and uses the passive action when selected", async () => {
    const workspaces = newWorkspaceDndWorkspaces();
    useWorkspaceListStore.setState({ workspaces, activeWorkspaceId: "ws-a" });
    const states = new Map<string, DashboardDisplayState>([["a", "running"], ["b", "running"]]);
    await act(async () => root.render(<LayoutMinimapPanel workspaces={workspaces} displayStateByTabId={states} selectedTabId={null} activePaneSessionId={null} onSelect={vi.fn()} />));
    const button = container.querySelector<HTMLButtonElement>("[data-minimap-new-workspace-button='true']")!;
    expect(button.disabled).toBe(true);
    const moveSpy = vi.spyOn(useWorkspaceLayoutStore.getState(), "moveTabToNewWorkspace");
    await act(async () => root.render(<LayoutMinimapPanel workspaces={workspaces} displayStateByTabId={states} selectedTabId="a" activePaneSessionId={null} onSelect={vi.fn()} />));

    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(moveSpy).toHaveBeenCalledTimes(1);
    expect(moveSpy).toHaveBeenLastCalledWith("ws-a", "a", "a", expect.any(String), "Workspace 3", { activate: false });
    expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe("ws-a");
    expect(useUiStore.getState().focusRevision).toBe(0);
  });

  it("commits one atomic center drop across workspaces without changing active workspace or focus", async () => {
    const workspaces = dndWorkspaces();
    await renderDndPanel(workspaces);
    const source = container.querySelector<HTMLElement>("[data-minimap-tab='a']")!;
    const target = container.querySelector<HTMLElement>("[data-minimap-dnd-pane-id='b']")!;
    expect(target.classList.contains("is-expanded")).toBe(true);
    expect(target.closest("[data-minimap-expanded='true']")).not.toBeNull();
    stubMinimapTarget(target);
    const mutationSpy = vi.spyOn(layoutMutation, "applyLayoutMutation");
    const replaceSpy = vi.spyOn(useWorkspaceListStore.getState(), "_replaceWorkspaces");
    const focusSpy = vi.spyOn(focusController, "request");
    mutationSpy.mockClear();
    replaceSpy.mockClear();
    focusSpy.mockClear();
    await act(async () => {
      source.dispatchEvent(pointer("pointerdown", 50, 30));
      window.dispatchEvent(pointer("pointermove", 56, 30));
      window.dispatchEvent(pointer("pointerup", 56, 30));
    });
    expect(mutationSpy).toHaveBeenCalledTimes(1);
    expect(replaceSpy).toHaveBeenCalledTimes(1);
    expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe("ws-a");
    expect(focusSpy).not.toHaveBeenCalled();
    expect(useWorkspaceListStore.getState().getWorkspace("ws-b")?.panes[0].tabs.map((item) => item.id)).toEqual(["b", "a"]);
  });

  it.each([
    { zone: "left", x: 1, y: 30 },
    { zone: "right", x: 99, y: 30 },
    { zone: "up", x: 50, y: 1 },
    { zone: "down", x: 50, y: 59 },
  ] as const)("commits one atomic $zone-edge split without changing active workspace", async ({ zone, x, y }) => {
    const workspaces = dndWorkspaces();
    await renderDndPanel(workspaces);
    const source = container.querySelector<HTMLElement>("[data-minimap-tab='a']")!;
    const target = container.querySelector<HTMLElement>("[data-minimap-dnd-pane-id='b']")!;
    expect(target.classList.contains("is-expanded")).toBe(true);
    expect(target.closest("[data-minimap-expanded='true']")).not.toBeNull();
    stubMinimapTarget(target);
    const mutationSpy = vi.spyOn(layoutMutation, "applyLayoutMutation");
    const replaceSpy = vi.spyOn(useWorkspaceListStore.getState(), "_replaceWorkspaces");
    const focusSpy = vi.spyOn(focusController, "request");
    mutationSpy.mockClear();
    replaceSpy.mockClear();
    focusSpy.mockClear();
    mutationSpy.mockClear();
    replaceSpy.mockClear();
    await act(async () => {
      source.dispatchEvent(pointer("pointerdown", 50, 30));
      window.dispatchEvent(pointer("pointermove", x, y));
    });
    expect(target.dataset.minimapDropZone).toBe(zone);
    await act(async () => window.dispatchEvent(pointer("pointerup", x, y)));
    expect(mutationSpy).toHaveBeenCalledTimes(1);
    expect(replaceSpy).toHaveBeenCalledTimes(1);
    const targetWorkspace = useWorkspaceListStore.getState().getWorkspace("ws-b")!;
    const movedPane = targetWorkspace.panes.find((candidate) => candidate.tabs.some((item) => item.id === "a"))!;
    const targetPane = targetWorkspace.panes.find((candidate) => candidate.id === "b")!;
    const columns = targetWorkspace.splitColumns!;
    if (zone === "left") expect(columns).toEqual([[movedPane.id], [targetPane.id]]);
    if (zone === "right") expect(columns).toEqual([[targetPane.id], [movedPane.id]]);
    if (zone === "up") expect(columns).toEqual([[movedPane.id, targetPane.id]]);
    if (zone === "down") expect(columns).toEqual([[targetPane.id, movedPane.id]]);
    expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe("ws-a");
    expect(useUiStore.getState().focusRevision).toBe(0);
  });

  it.each([
    { zone: "left", x: 1, y: 30 },
    { zone: "right", x: 99, y: 30 },
    { zone: "up", x: 50, y: 1 },
    { zone: "down", x: 50, y: 59 },
  ] as const)("commits one atomic pane $zone-edge split without changing active workspace", async ({ zone, x, y }) => {
    const workspaces = dndWorkspaces();
    await renderDndPanel(workspaces);
    const source = container.querySelector<HTMLElement>("[data-minimap-pane='a'] [data-minimap-pane-grip]")!;
    const target = container.querySelector<HTMLElement>(".cmux-minimap-cell[data-minimap-dnd-pane-id='b']")!;
    stubMinimapTarget(target);
    const mutationSpy = vi.spyOn(layoutMutation, "applyLayoutMutation");
    mutationSpy.mockClear();
    await act(async () => {
      source.dispatchEvent(pointer("pointerdown", 50, 30));
      window.dispatchEvent(pointer("pointermove", x, y));
    });
    expect(target.dataset.minimapDropZone).toBe(zone);
    await act(async () => window.dispatchEvent(pointer("pointerup", x, y)));
    expect(mutationSpy).toHaveBeenCalledTimes(1);
    const targetWorkspace = useWorkspaceListStore.getState().getWorkspace("ws-b")!;
    const movedPane = targetWorkspace.panes.find((candidate) => candidate.tabs.some((item) => item.id === "a"))!;
    const targetPane = targetWorkspace.panes.find((candidate) => candidate.id === "b")!;
    if (zone === "left") expect(targetWorkspace.splitColumns).toEqual([[movedPane.id], [targetPane.id]]);
    if (zone === "right") expect(targetWorkspace.splitColumns).toEqual([[targetPane.id], [movedPane.id]]);
    if (zone === "up") expect(targetWorkspace.splitColumns).toEqual([[movedPane.id, targetPane.id]]);
    if (zone === "down") expect(targetWorkspace.splitColumns).toEqual([[targetPane.id, movedPane.id]]);
    expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe("ws-a");
    expect(useUiStore.getState().focusRevision).toBe(0);
  });

  it.each(["Escape", "pointercancel", "blur"] as const)("cancels an active minimap drag with %s without changing layout", async (cancel) => {
    const workspaces = dndWorkspaces();
    await renderDndPanel(workspaces);
    const source = container.querySelector<HTMLElement>("[data-minimap-tab='a']")!;
    const target = container.querySelector<HTMLElement>("[data-minimap-dnd-pane-id='b']")!;
    stubMinimapTarget(target);
    const before = structuredClone(useWorkspaceListStore.getState().workspaces);
    const mutationSpy = vi.spyOn(layoutMutation, "applyLayoutMutation");
    await act(async () => {
      source.dispatchEvent(pointer("pointerdown", 50, 30));
      window.dispatchEvent(pointer("pointermove", 56, 30));
      if (cancel === "Escape") window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      else if (cancel === "pointercancel") window.dispatchEvent(pointer("pointercancel", 56, 30));
      else window.dispatchEvent(new Event("blur"));
    });
    expect(mutationSpy).not.toHaveBeenCalled();
    expect(useWorkspaceListStore.getState().workspaces).toEqual(before);
    expect(usePaneDragStore.getState().item).toBeNull();
  });

  it("refuses a minimap drop when the source layout changed during the drag", async () => {
    const workspaces = dndWorkspaces();
    await renderDndPanel(workspaces);
    const source = container.querySelector<HTMLElement>("[data-minimap-tab='a']")!;
    const target = container.querySelector<HTMLElement>("[data-minimap-dnd-pane-id='b']")!;
    stubMinimapTarget(target);
    const mutationSpy = vi.spyOn(layoutMutation, "applyLayoutMutation");
    const replaceSpy = vi.spyOn(useWorkspaceListStore.getState(), "_replaceWorkspaces");
    await act(async () => {
      source.dispatchEvent(pointer("pointerdown", 50, 30));
      window.dispatchEvent(pointer("pointermove", 56, 30));
    });
    const changed = structuredClone(useWorkspaceListStore.getState().workspaces);
    changed[0].panes[0].tabs.push(tab("new-layout-tab"));
    useWorkspaceListStore.setState({ workspaces: changed });
    mutationSpy.mockClear();
    replaceSpy.mockClear();
    await act(async () => window.dispatchEvent(pointer("pointerup", 56, 30)));
    expect(mutationSpy).toHaveBeenCalledTimes(1);
    expect(replaceSpy).not.toHaveBeenCalled();
    expect(useWorkspaceListStore.getState().getWorkspace("ws-b")?.panes[0].tabs.map((item) => item.id)).toEqual(["b"]);
  });

  it("keeps a sub-threshold pointer gesture as a chip selection click", async () => {
    const workspaces = dndWorkspaces();
    const onSelect = vi.fn();
    await renderDndPanel(workspaces, onSelect);
    const source = container.querySelector<HTMLElement>("[data-minimap-tab='a']")!;
    await act(async () => {
      source.dispatchEvent(pointer("pointerdown", 50, 30));
      window.dispatchEvent(pointer("pointermove", 54, 30));
      window.dispatchEvent(pointer("pointerup", 54, 30));
      source.click();
    });
    expect(onSelect).toHaveBeenCalledWith("a");
    expect(usePaneDragStore.getState().item).toBeNull();
  });

  it("keeps Ctrl additions and Shift ranges visibly selected", async () => {
    const workspace: Workspace = { id: "ws", name: "選択", gridTemplateId: "1x1", status: "running", createdAt: 1,
      panes: [pane("p", [tab("a"), tab("b"), tab("c")])], splitColumns: [["p"]] };
    await act(async () => root.render(<LayoutMinimapPanel workspaces={[workspace]} displayStateByTabId={new Map()} selectedTabId="a" activePaneSessionId={null} onSelect={vi.fn()} />));
    const chipB = container.querySelector<HTMLElement>("[data-minimap-tab='b']")!;
    const chipC = container.querySelector<HTMLElement>("[data-minimap-tab='c']")!;
    await act(async () => chipB.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true })));
    expect(chipB.classList.contains("is-bundle-selected")).toBe(true);
    await act(async () => chipC.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })));
    expect(container.querySelector<HTMLElement>("[data-minimap-tab='a']")!.classList.contains("is-bundle-selected")).toBe(false);
    expect(chipB.classList.contains("is-bundle-selected")).toBe(true);
    expect(chipC.classList.contains("is-bundle-selected")).toBe(true);
    expect(container.querySelector(".cmux-minimap-selection-summary")?.textContent).toContain("2本");
  });

  it("keeps minimap multi-selection local but replaces it after an external primary selection", async () => {
    const wsA: Workspace = { id: "ws-a", name: "A", gridTemplateId: "1x1", status: "running", createdAt: 1,
      panes: [pane("a", [tab("a"), tab("b")])], splitColumns: [["a"]] };
    const wsB: Workspace = { id: "ws-b", name: "B", gridTemplateId: "1x1", status: "running", createdAt: 1,
      panes: [pane("c", [tab("c")])], splitColumns: [["c"]] };
    const states = new Map<string, DashboardDisplayState>([["a", "running"], ["b", "running"], ["c", "running"]]);
    await act(async () => root.render(<LayoutMinimapPanel workspaces={[wsA, wsB]} displayStateByTabId={states} selectedTabId="a" activePaneSessionId={null} onSelect={vi.fn()} />));
    const chipA = container.querySelector<HTMLElement>("[data-minimap-tab='a']")!;
    const chipB = container.querySelector<HTMLElement>("[data-minimap-tab='b']")!;
    await act(async () => chipB.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true })));
    expect(chipA.classList.contains("is-bundle-selected")).toBe(true);
    expect(chipB.classList.contains("is-bundle-selected")).toBe(true);

    await act(async () => root.render(<LayoutMinimapPanel workspaces={[wsA, wsB]} displayStateByTabId={states} selectedTabId="b" activePaneSessionId={null} onSelect={vi.fn()} />));
    expect(chipA.classList.contains("is-bundle-selected")).toBe(true);
    expect(chipB.classList.contains("is-bundle-selected")).toBe(true);

    await act(async () => root.render(<LayoutMinimapPanel workspaces={[wsA, wsB]} displayStateByTabId={states} selectedTabId="c" activePaneSessionId={null} onSelect={vi.fn()} />));

    expect(chipA.classList.contains("is-bundle-selected")).toBe(false);
    expect(chipB.classList.contains("is-bundle-selected")).toBe(false);
    expect(container.querySelector<HTMLElement>("[data-minimap-tab='c']")?.classList.contains("is-bundle-selected")).toBe(true);
    expect(container.querySelector<HTMLElement>("[data-minimap-workspace='ws-b'] > button")?.getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps collapsed workspaces collapsed while scrolling the selected workspace into view", async () => {
    const workspaces = dndWorkspaces();
    const states = new Map<string, DashboardDisplayState>([["a", "running"], ["b", "running"]]);
    await act(async () => root.render(<LayoutMinimapPanel workspaces={workspaces} displayStateByTabId={states} selectedTabId="a" activePaneSessionId={null} onSelect={vi.fn()} />));
    const stack = container.querySelector<HTMLElement>(".cmux-minimap-stack")!;
    const workspaceB = container.querySelector<HTMLElement>("[data-minimap-workspace='ws-b']")!;
    const workspaceA = container.querySelector<HTMLElement>("[data-minimap-workspace='ws-a']")!;
    await act(async () => workspaceB.querySelector<HTMLElement>(".cmux-minimap-workspace-header")!.click());
    expect(workspaceB.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
    Object.defineProperty(stack, "getBoundingClientRect", { configurable: true, value: () => ({ left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100 }) });
    Object.defineProperty(workspaceB, "getBoundingClientRect", { configurable: true, value: () => ({ left: 0, top: 150, right: 200, bottom: 190, width: 200, height: 40 }) });
    Object.defineProperty(stack, "scrollTop", { configurable: true, writable: true, value: 0 });

    await act(async () => root.render(<LayoutMinimapPanel workspaces={workspaces} displayStateByTabId={states} selectedTabId="b" activePaneSessionId={null} onSelect={vi.fn()} />));

    expect(stack.scrollTop).toBe(90);
    expect(workspaceB.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
    expect(workspaceA.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
    expect(workspaceB.querySelector("[data-minimap-tab='b']")?.classList.contains("is-selected")).toBe(true);
  });

  it("persists manually collapsed workspaces without collapsing the others", async () => {
    const workspaces = dndWorkspaces();
    const states = new Map<string, DashboardDisplayState>([["a", "running"], ["b", "running"]]);
    await act(async () => root.render(<LayoutMinimapPanel workspaces={workspaces} displayStateByTabId={states} selectedTabId="a" activePaneSessionId={null} onSelect={vi.fn()} />));
    const workspaceA = container.querySelector<HTMLElement>("[data-minimap-workspace='ws-a']")!;
    const workspaceB = container.querySelector<HTMLElement>("[data-minimap-workspace='ws-b']")!;
    await act(async () => workspaceB.querySelector<HTMLElement>(".cmux-minimap-workspace-header")!.click());
    expect(workspaceA.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
    expect(workspaceB.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
    expect(window.localStorage.getItem(MINIMAP_COLLAPSED_WORKSPACE_IDS_STORAGE_KEY)).toBe(JSON.stringify(["ws-b"]));

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<LayoutMinimapPanel workspaces={workspaces} displayStateByTabId={states} selectedTabId="a" activePaneSessionId={null} onSelect={vi.fn()} />));

    expect(container.querySelector("[data-minimap-workspace='ws-a'] > button")?.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector("[data-minimap-workspace='ws-b'] > button")?.getAttribute("aria-expanded")).toBe("false");
  });

  it("places the tab sweep control in the minimap footer and removes it from the title bar", async () => {
    await renderDndPanel(dndWorkspaces());
    const sweepButton = container.querySelector<HTMLElement>("[aria-label='タブ掃除']")!;
    expect(sweepButton.closest(".cmux-minimap-footer")).not.toBeNull();
    expect(readFileSync("src/components/layout/TitleBar.tsx", "utf8")).not.toContain("TabSweepButton");
  });

  it("selects the exact cross-workspace group on Alt+click", async () => {
    const wsA: Workspace = { id: "ws-a", name: "A", gridTemplateId: "1x1", status: "running", createdAt: 1,
      panes: [{ ...pane("a", [tab("a")]), cwd: "C:\\Work\\M1" }], splitColumns: [["a"]] };
    const wsB: Workspace = { id: "ws-b", name: "B", gridTemplateId: "1x1", status: "running", createdAt: 1,
      panes: [{ ...pane("b", [tab("b")]), cwd: "c:/work/m1/" }], splitColumns: [["b"]] };
    const wsC: Workspace = { id: "ws-c", name: "C", gridTemplateId: "1x1", status: "running", createdAt: 1,
      panes: [{ ...pane("c", [tab("c")]), cwd: "C:/Other" }], splitColumns: [["c"]] };
    await act(async () => root.render(<LayoutMinimapPanel workspaces={[wsA, wsB, wsC]} displayStateByTabId={new Map()} selectedTabId="a" activePaneSessionId={null} onSelect={vi.fn()} />));
    const chipA = container.querySelector<HTMLElement>("[data-minimap-tab='a']")!;
    await act(async () => chipA.dispatchEvent(new MouseEvent("click", { bubbles: true, altKey: true })));
    expect(chipA.classList.contains("is-bundle-selected")).toBe(true);
    expect(container.querySelector<HTMLElement>("[data-minimap-tab='b']")!.classList.contains("is-bundle-selected")).toBe(true);
    expect(container.querySelector<HTMLElement>("[data-minimap-tab='c']")!.classList.contains("is-bundle-selected")).toBe(false);
    expect(container.querySelector(".cmux-minimap-selection-summary")?.textContent).toContain("2本");
  });

  it("jumps from a chip double-click without selecting the group", async () => {
    const onJump = vi.fn();
    const workspace: Workspace = { id: "ws", name: "Jump", gridTemplateId: "1x1", status: "running", createdAt: 1,
      panes: [pane("p", [tab("a"), tab("b")])], splitColumns: [["p"]] };
    await act(async () => root.render(<LayoutMinimapPanel workspaces={[workspace]} displayStateByTabId={new Map()} selectedTabId="a" activePaneSessionId={null} onSelect={vi.fn()} onJump={onJump} />));
    const chipB = container.querySelector<HTMLElement>("[data-minimap-tab='b']")!;
    await act(async () => chipB.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenCalledWith("ws", "p", "b");
    expect(container.querySelector<HTMLElement>("[data-minimap-tab='a']")!.classList.contains("is-bundle-selected")).toBe(true);
    expect(chipB.classList.contains("is-bundle-selected")).toBe(false);
  });

  it("commits a selected bundle in one atomic layout mutation", async () => {
    const workspaces: Workspace[] = [
      { id: "ws-a", name: "A", gridTemplateId: "1x1", status: "running", createdAt: 1,
        panes: [pane("a", [tab("a"), tab("c")])], splitColumns: [["a"]] },
      { id: "ws-b", name: "B", gridTemplateId: "1x1", status: "running", createdAt: 1,
        panes: [pane("b", [tab("b")])], splitColumns: [["b"]] },
    ];
    useWorkspaceListStore.setState({ workspaces, activeWorkspaceId: "ws-a" });
    await act(async () => root.render(<LayoutMinimapPanel workspaces={workspaces} displayStateByTabId={new Map()} selectedTabId="a" activePaneSessionId={null} onSelect={vi.fn()} />));
    const chipC = container.querySelector<HTMLElement>("[data-minimap-tab='c']")!;
    await act(async () => chipC.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true })));
    const source = container.querySelector<HTMLElement>("[data-minimap-tab='a']")!;
    const target = container.querySelector<HTMLElement>("[data-minimap-dnd-pane-id='b']")!;
    stubMinimapTarget(target);
    const mutationSpy = vi.spyOn(layoutMutation, "applyLayoutMutation");
    const replaceSpy = vi.spyOn(useWorkspaceListStore.getState(), "_replaceWorkspaces");
    const focusSpy = vi.spyOn(focusController, "request");
    mutationSpy.mockClear();
    replaceSpy.mockClear();
    focusSpy.mockClear();
    await act(async () => {
      source.dispatchEvent(pointer("pointerdown", 50, 30));
      window.dispatchEvent(pointer("pointermove", 56, 30));
      window.dispatchEvent(pointer("pointerup", 56, 30));
    });
    expect(mutationSpy).toHaveBeenCalledTimes(1);
    expect(mutationSpy.mock.calls[0][1]).toMatchObject({ kind: "move-tabs", tabIds: ["a", "c"], anchorTabId: "a" });
    expect(replaceSpy).toHaveBeenCalledTimes(1);
    expect(useWorkspaceListStore.getState().getWorkspace("ws-b")?.panes[0].tabs.map((item) => item.id)).toEqual(["b", "a", "c"]);
    expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe("ws-a");
    expect(focusSpy).not.toHaveBeenCalled();
    expect(useUiStore.getState().focusRevision).toBe(0);
  });

  it("uses a 5px marquee state machine, recomputes in scroll content coordinates, and restores on Escape", async () => {
    const workspace: Workspace = { id: "ws", name: "マーキー", gridTemplateId: "1x1", status: "running", createdAt: 1,
      panes: [pane("p", [tab("a"), tab("b"), tab("c")])], splitColumns: [["p"]] };
    await act(async () => root.render(<LayoutMinimapPanel workspaces={[workspace]} displayStateByTabId={new Map()} selectedTabId="b" activePaneSessionId={null} onSelect={vi.fn()} />));
    const stack = container.querySelector<HTMLElement>(".cmux-minimap-stack")!;
    Object.defineProperty(stack, "getBoundingClientRect", { configurable: true, value: () => ({ left: 0, top: 0, right: 200, bottom: 200, width: 200, height: 200 }) });
    const chipA = container.querySelector<HTMLElement>("[data-minimap-tab='a']")!;
    const chipB = container.querySelector<HTMLElement>("[data-minimap-tab='b']")!;
    const chipC = container.querySelector<HTMLElement>("[data-minimap-tab='c']")!;
    Object.defineProperty(chipA, "getBoundingClientRect", { configurable: true, value: () => ({ left: 15, top: 15, right: 25, bottom: 25 }) });
    Object.defineProperty(chipB, "getBoundingClientRect", { configurable: true, value: () => ({ left: 45, top: 15, right: 55, bottom: 25 }) });
    Object.defineProperty(chipC, "getBoundingClientRect", { configurable: true, value: () => ({ left: 5, top: 5, right: 15, bottom: 15 }) });
    await act(async () => {
      stack.dispatchEvent(pointer("pointerdown", 0, 0));
      stack.dispatchEvent(pointer("pointermove", 4, 0));
      stack.dispatchEvent(pointer("pointerup", 4, 0));
    });
    expect(chipB.classList.contains("is-bundle-selected")).toBe(true);
    await act(async () => {
      stack.dispatchEvent(pointer("pointerdown", 0, 0));
      stack.dispatchEvent(pointer("pointermove", 30, 30));
    });
    expect(container.querySelector(".cmux-minimap-selection-marquee")).not.toBeNull();
    expect(chipA.classList.contains("is-bundle-selected")).toBe(true);
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector(".cmux-minimap-selection-marquee")).toBeNull();
    expect(chipB.classList.contains("is-bundle-selected")).toBe(true);
    Object.defineProperty(stack, "scrollTop", { configurable: true, value: 100, writable: true });
    await act(async () => {
      stack.dispatchEvent(pointer("pointerdown", 0, 0, 2));
      stack.dispatchEvent(pointer("pointermove", 10, 10, 2));
      stack.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(chipC.classList.contains("is-bundle-selected")).toBe(true);
  });

  it("lists the selection and calls close_tabs once only after confirmation", async () => {
    const workspaces: Workspace[] = [
      { id: "ws-a", name: "A", gridTemplateId: "1x1", status: "running", createdAt: 1, panes: [pane("a", [tab("a")])], splitColumns: [["a"]] },
      { id: "ws-b", name: "B", gridTemplateId: "1x1", status: "running", createdAt: 1, panes: [pane("b", [tab("b")])], splitColumns: [["b"]] },
    ];
    const closeSpy = vi.spyOn(socketCommands, "handleSocketCommand").mockResolvedValue({ closed: ["a", "b"] });
    await act(async () => root.render(<LayoutMinimapPanel workspaces={workspaces} displayStateByTabId={new Map()} selectedTabId="a" activePaneSessionId={null} onSelect={vi.fn()} />));
    const chipB = container.querySelector<HTMLElement>("[data-minimap-tab='b']")!;
    await act(async () => chipB.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true })));
    await act(async () => container.querySelector<HTMLButtonElement>("[data-minimap-close-selection='true']")!.click());
    const confirmation = container.querySelector<HTMLElement>("[data-minimap-close-confirm='true']")!;
    expect(confirmation.textContent).toContain("a");
    expect(confirmation.textContent).toContain("b");
    expect(closeSpy).not.toHaveBeenCalled();
    await act(async () => confirmation.querySelector<HTMLButtonElement>(".cmux-minimap-bundle-confirm-actions button")!.click());
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledWith("pane.close_tabs", { tabIds: ["a", "b"] });
  });

  it("gives a tab-less pane a full row of budget so all five drop zones stay reachable", async () => {
    const workspace: Workspace = { id: "ws", name: "空き", gridTemplateId: "1x1", status: "running", createdAt: 1,
      panes: [pane("empty", []), pane("full", [tab("a")])], splitColumns: [["empty"], ["full"]] };
    await act(async () => root.render(<LayoutMinimapPanel workspaces={[workspace]} displayStateByTabId={new Map()} selectedTabId={null} activePaneSessionId={null} onSelect={vi.fn()} />));
    const cell = container.querySelector<HTMLElement>("[data-minimap-pane='empty']")!;

    expect(cell.querySelector(".cmux-minimap-pane-empty")?.textContent).toBe("空きペイン");
    expect(container.querySelectorAll("[data-minimap-pane='empty'] [data-minimap-tab]")).toHaveLength(0);
    // A 0-tab pane is budgeted as one row, exactly like a 1-tab pane.
    expect(minimapCellHeightPx(0, true)).toBe(minimapCellHeightPx(1, true));
    expect(minimapCellHeightPx(0, true)).toBe(77);
    expect(minimapCellHeightPx(0, false)).toBe(47);
    expect(cell.style.minHeight).toBe(`${minimapCellHeightPx(0, true)}px`);

    // At that real height the five zones are all distinct; at the pre-fix 19px
    // the top and bottom edges covered the whole cell and the centre vanished.
    const height = minimapCellHeightPx(0, true);
    const rect = { left: 0, right: 100, top: 0, bottom: height, width: 100, height };
    expect(resolveMinimapDropZone(rect, 50, height / 2)).toBe("center");
    expect(resolveMinimapDropZone(rect, 1, height / 2)).toBe("left");
    expect(resolveMinimapDropZone(rect, 99, height / 2)).toBe("right");
    expect(resolveMinimapDropZone(rect, 50, 1)).toBe("up");
    expect(resolveMinimapDropZone(rect, 50, height - 1)).toBe("down");
  });

  it("orders chip states so the waiting face wins and the selection ring always survives", async () => {
    const workspace: Workspace = { id: "ws", name: "状態", gridTemplateId: "1x1", status: "running", createdAt: 1,
      panes: [pane("p", [tab("wait"), tab("open"), tab("plain"), tab("decl", "declared"), tab("waitopen"), tab("waitdecl", "declared")])], splitColumns: [["p"]] };
    const states = new Map<string, DashboardDisplayState>([["wait", "needsHuman"], ["open", "running"], ["plain", "idle"], ["decl", "idle"], ["waitopen", "needsHuman"], ["waitdecl", "needsHuman"]]);
    await act(async () => root.render(<LayoutMinimapPanel workspaces={[workspace]} displayStateByTabId={states} openTabIds={["open", "waitopen"]} selectedTabId="wait" activePaneSessionId={null} onSelect={vi.fn()} />));
    const chipOf = (id: string) => container.querySelector<HTMLElement>(`[data-minimap-tab='${id}']`)!;

    // The waiting chip is also the primary selection: both classes coexist.
    expect(chipOf("wait").classList.contains("is-waiting")).toBe(true);
    expect(chipOf("wait").classList.contains("is-selected")).toBe(true);
    expect(chipOf("wait").classList.contains("is-bundle-selected")).toBe(true);
    expect(chipOf("wait").querySelector(".cmux-minimap-question")?.textContent).toBe("返答待ち");
    expect(chipOf("open").classList.contains("is-open")).toBe(true);
    expect(chipOf("open").classList.contains("is-waiting")).toBe(false);
    expect(chipOf("plain").className).not.toMatch(/is-(waiting|open|selected)/);
    expect(chipOf("decl").classList.contains("is-declared")).toBe(true);
    // wait x open: both classes ride together, and the column-colour outline the
    // parent chose to keep is still supplied inline.
    expect(chipOf("waitopen").classList.contains("is-waiting")).toBe(true);
    expect(chipOf("waitopen").classList.contains("is-open")).toBe(true);
    expect(chipOf("waitopen").style.outlineColor).not.toBe("");
    // wait x declared: the declared meta wins the label, the waiting face wins
    // the background, and neither drops a status dot into the meta row.
    expect(chipOf("waitdecl").classList.contains("is-waiting")).toBe(true);
    expect(chipOf("waitdecl").classList.contains("is-declared")).toBe(true);
    expect(chipOf("waitdecl").querySelector(".cmux-minimap-agent")?.textContent).toBe("宣言のみ");
    expect(chipOf("waitdecl").querySelector(".cmux-minimap-question")?.textContent).toBe("返答待ち");
    expect(chipOf("waitdecl").querySelector(".cmux-minimap-status")).toBeNull();

    // Cascade order is the contract: the later rule wins the background, so the
    // ladder has to read declared < hover < open < bundle-selected < selected < waiting.
    const css = readFileSync("src/components/dashboard/MinimapPanel.css", "utf8");
    const at = (needle: string) => {
      const index = css.indexOf(needle);
      expect(index, needle).toBeGreaterThan(-1);
      return index;
    };
    expect(at(".cmux-minimap-chip.is-declared {")).toBeLessThan(at(".cmux-minimap-chip:hover:not(.is-open)"));
    expect(at(".cmux-minimap-chip:hover:not(.is-open)")).toBeLessThan(at(".cmux-minimap-chip.is-open {"));
    expect(at(".cmux-minimap-chip.is-open {")).toBeLessThan(at(".cmux-minimap-chip.is-bundle-selected {"));
    expect(at(".cmux-minimap-chip.is-bundle-selected {")).toBeLessThan(at(".cmux-minimap-chip.is-selected {"));
    expect(at(".cmux-minimap-chip.is-selected {")).toBeLessThan(at(".cmux-minimap-chip.is-waiting {"));
    // Hover may not take the face back off a selected or waiting chip.
    expect(css).toContain(".cmux-minimap-chip:hover:not(.is-open):not(.is-selected):not(.is-bundle-selected):not(.is-waiting)");
    // The amber band is a pseudo-element, so it never overwrites the 2px ring.
    expect(css).toContain(".cmux-minimap-chip.is-waiting::before");
    // Light themes resolve surface === popover, so the chip's own edge ring is
    // the only thing separating it from the map. Every later box-shadow has to
    // compose it rather than replace it.
    expect(css).toContain("--minimap-chip-ring: inset 0 0 0 1px");
    for (const rule of css.split(String.fromCharCode(10))) {
      if (!rule.includes(".cmux-minimap-chip") || !rule.includes("box-shadow:")) continue;
      expect(rule, rule.trim().slice(0, 60)).toContain("box-shadow: var(--minimap-chip-ring)");
    }
    const waitingFaceRule = css.slice(at(".cmux-minimap-chip.is-waiting {"));
    expect(waitingFaceRule.slice(0, waitingFaceRule.indexOf("}"))).not.toContain("box-shadow");
  });

  it("collapses a chip to its title and status dot only", async () => {
    const workspace: Workspace = { id: "ws", name: "畳み", gridTemplateId: "1x1", status: "running", createdAt: 1,
      panes: [pane("p", [tab("a")])], splitColumns: [["p"]] };
    const states = new Map<string, DashboardDisplayState>([["a", "needsHuman"]]);
    await act(async () => root.render(<LayoutMinimapPanel workspaces={[workspace]} displayStateByTabId={states} selectedTabId="a" activePaneSessionId={null} onSelect={vi.fn()} />));
    const chip = () => container.querySelector<HTMLElement>("[data-minimap-tab='a']")!;
    expect(chip().querySelector(".cmux-minimap-meta")).not.toBeNull();

    await act(async () => container.querySelector<HTMLElement>(".cmux-minimap-workspace-header")!.click());

    expect(chip().classList.contains("is-collapsed")).toBe(true);
    expect(chip().querySelector(".cmux-minimap-meta")).toBeNull();
    expect(chip().querySelector(".cmux-minimap-question")).toBeNull();
    expect(chip().querySelector(".cmux-minimap-glyph")).toBeNull();
    expect(chip().querySelector(".cmux-minimap-label")?.textContent).toBe("a");
    expect(chip().querySelector(".cmux-minimap-status")).not.toBeNull();
    // Waiting still reads at a glance through the amber band.
    expect(chip().classList.contains("is-waiting")).toBe(true);
    expect(readFileSync("src/components/dashboard/MinimapPanel.css", "utf8")).toContain(".cmux-minimap-chip.is-collapsed.is-waiting");
  });

  it("keeps a declared chip free of a status dot in both modes", async () => {
    const workspace: Workspace = { id: "ws", name: "宣言", gridTemplateId: "1x1", status: "running", createdAt: 1,
      panes: [pane("p", [tab("d", "declared")])], splitColumns: [["p"]] };
    const states = new Map<string, DashboardDisplayState>([["d", "idle"]]);
    await act(async () => root.render(<LayoutMinimapPanel workspaces={[workspace]} displayStateByTabId={states} selectedTabId={null} activePaneSessionId={null} onSelect={vi.fn()} />));
    const chip = () => container.querySelector<HTMLElement>("[data-minimap-tab='d']")!;

    expect(chip().classList.contains("is-expanded")).toBe(true);
    expect(chip().querySelector(".cmux-minimap-status")).toBeNull();

    await act(async () => container.querySelector<HTMLElement>(".cmux-minimap-workspace-header")!.click());

    expect(chip().classList.contains("is-collapsed")).toBe(true);
    expect(chip().querySelector(".cmux-minimap-status")).toBeNull();
    // The "宣言のみ" meta is tertiary and 11px, not the 10px mono the ASCII
    // agent name uses.
    const css = readFileSync("src/components/dashboard/MinimapPanel.css", "utf8");
    expect(css).toContain(".cmux-minimap-chip.is-declared .cmux-minimap-meta { color: var(--cmux-text-tertiary); }");
    expect(css).toContain(".cmux-minimap-chip.is-declared .cmux-minimap-agent { color: var(--cmux-text-tertiary); font-family: var(--cmux-dash-ui-font); font-size: var(--cmux-font-size-xs); }");
    // Japanese in the meta row never sits at 10px.
    expect(css).toContain(".cmux-minimap-age { margin-left: auto; flex: 0 0 auto; color: var(--cmux-text-tertiary); font-family: var(--cmux-dash-ui-font); font-size: var(--cmux-font-size-xs); }");
  });

  it("summarises the header with a swatch, caps at 12 ticks, and shows +N", async () => {
    const tabs = Array.from({ length: 13 }, (_, index) => tab(`t${index}`));
    const workspace: Workspace = { id: "ws", name: "十三本", gridTemplateId: "1x1", status: "running", createdAt: 1,
      panes: [pane("p", tabs)], splitColumns: [["p"]] };
    const states = new Map<string, DashboardDisplayState>([["t0", "needsHuman"], ["t1", "running"]]);
    await act(async () => root.render(<LayoutMinimapPanel workspaces={[workspace]} displayStateByTabId={states} selectedTabId={null} activePaneSessionId={null} onSelect={vi.fn()} />));
    const header = container.querySelector<HTMLElement>(".cmux-minimap-workspace-header")!;

    // The swatch renders even without an authored workspace colour (CSS falls
    // back to tertiary), so the three-column header grid never shifts.
    expect(header.querySelector(".cmux-minimap-workspace-swatch")).not.toBeNull();
    expect(header.querySelectorAll(".cmux-minimap-strip-tick")).toHaveLength(12);
    expect(header.querySelector(".cmux-minimap-strip-overflow")?.textContent).toBe("+1");
    expect(header.querySelector(".cmux-minimap-workspace-count")?.textContent).toBe("13");
    expect(header.querySelector(".cmux-minimap-strip-tick.is-waiting")).not.toBeNull();
    expect(header.querySelector(".cmux-minimap-strip-tick.is-working")).not.toBeNull();
    // The old glyph summary is gone; the waiting count moved into the aria label.
    expect(header.textContent).not.toContain("❓");
    expect(header.textContent).not.toContain("●");
    expect(header.getAttribute("aria-label")).toBe("十三本 — 13本、返答待ち1本");
  });

  it("re-evaluates the elapsed value on the panel clock without subscribing to PTY output", async () => {
    vi.useFakeTimers();
    try {
      const start = new Date("2026-08-21T09:00:00Z").getTime();
      vi.setSystemTime(start);
      usePaneMetadataStore.setState({ volatileMetadata: { "session-a": { backendLastOutputAt: start - 10_000 } } });
      const workspace: Workspace = { id: "ws", name: "経過", gridTemplateId: "1x1", status: "running", createdAt: 1,
        panes: [pane("p", [tab("a")])], splitColumns: [["p"]] };
      await act(async () => root.render(<LayoutMinimapPanel workspaces={[workspace]} displayStateByTabId={new Map()} selectedTabId={null} activePaneSessionId={null} onSelect={vi.fn()} />));
      const chip = () => container.querySelector<HTMLElement>("[data-minimap-tab='a']")!;

      expect(chip().querySelector(".cmux-minimap-age")?.textContent).toBe("10秒");
      expect(chip().title).toContain("最終出力から10秒");
      expect(chip().getAttribute("aria-label")).toContain("最終出力から10秒");

      await act(async () => { vi.advanceTimersByTime(30_000); });
      expect(chip().querySelector(".cmux-minimap-age")?.textContent).toBe("40秒");

      await act(async () => { vi.advanceTimersByTime(60_000); });
      expect(chip().querySelector(".cmux-minimap-age")?.textContent).toBe("1分");
    } finally {
      vi.useRealTimers();
    }
  });

  it("omits the elapsed value when the session has never reported output", async () => {
    const workspace: Workspace = { id: "ws", name: "未出力", gridTemplateId: "1x1", status: "running", createdAt: 1,
      panes: [pane("p", [tab("a")])], splitColumns: [["p"]] };
    await act(async () => root.render(<LayoutMinimapPanel workspaces={[workspace]} displayStateByTabId={new Map()} selectedTabId={null} activePaneSessionId={null} onSelect={vi.fn()} />));
    const chip = container.querySelector<HTMLElement>("[data-minimap-tab='a']")!;
    expect(chip.querySelector(".cmux-minimap-age")).toBeNull();
    expect(chip.title).toBe("a");
    expect(chip.getAttribute("aria-label")).toContain("a — codex・");
  });

  it("hides the bulk-close entry point when no tabs are selected", async () => {
    const workspace: Workspace = { id: "ws", name: "選択なし", gridTemplateId: "1x1", status: "running", createdAt: 1,
      panes: [pane("p", [tab("a")])], splitColumns: [["p"]] };
    await act(async () => root.render(<LayoutMinimapPanel workspaces={[workspace]} displayStateByTabId={new Map()} selectedTabId={null} activePaneSessionId={null} onSelect={vi.fn()} />));
    expect(container.querySelector("[data-minimap-close-selection='true']")).toBeNull();
    expect(container.querySelector(".cmux-minimap-selection-summary")).toBeNull();
  });
});
