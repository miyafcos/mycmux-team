// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LayoutMinimapPanel } from "../../src/components/dashboard/LayoutMinimapPanel";
import type { DashboardDisplayState } from "../../src/components/dashboard/dashboardModel";
import { buildMinimapModel } from "../../src/components/dashboard/minimapModel";
import * as layoutMutation from "../../src/lib/layoutMutation";
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
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useUiStore.setState({ activePaneId: null, lastActivePaneId: null, focusRevision: 0, zoomedPaneId: null });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  usePaneDragStore.getState().clearDrag();
  useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
  const states = new Map<string, DashboardDisplayState>([["a", "working"], ["b", "working"]]);
  await act(async () => root.render(<LayoutMinimapPanel workspaces={workspaces} displayStateByTabId={states} selectedTabId="a" activePaneSessionId={null} onSelect={onSelect} />));
}

describe("LayoutMinimapPanel", () => {
  it("projects buildMinimapModel shares for an uneven two-workspace layout", async () => {
    const wsA: Workspace = { id: "ws-a", name: "A", gridTemplateId: "1x1", status: "running", createdAt: 1,
      panes: [pane("a", [tab("a")]), pane("b", [tab("b")]), pane("c", [tab("c")])], splitColumns: [["a", "b"], ["c"]], columnWidths: [1, 3], rowHeightsPerCol: [[1, 3], [1]] };
    const wsB: Workspace = { id: "ws-b", name: "B", gridTemplateId: "1x1", status: "running", createdAt: 1, panes: [pane("d", [tab("d")])], splitColumns: [["d"]] };
    const displayStateByTabId = new Map<string, DashboardDisplayState>([["a", "working"], ["b", "working"], ["c", "working"], ["d", "working"]]);
    await act(async () => root.render(<LayoutMinimapPanel workspaces={[wsA, wsB]} displayStateByTabId={displayStateByTabId} selectedTabId="d" activePaneSessionId="session-b" onSelect={vi.fn()} />));
    const workspace = container.querySelector<HTMLElement>("[data-minimap-workspace='ws-a']")!;
    const model = buildMinimapModel(wsA, { activePaneId: "b" });
    for (const column of model.columns) {
      expect(workspace.querySelectorAll<HTMLElement>(".cmux-minimap-column")[column.index].style.flexGrow).toBe(String(column.widthShare));
      for (const cell of column.cells) expect(workspace.querySelector<HTMLElement>(`[data-minimap-pane='${cell.paneId}']`)!.style.flexGrow).toBe(String(cell.heightShare));
    }
    expect(workspace.querySelector("[data-minimap-pane='b']")?.classList.contains("is-active-pane")).toBe(true);
    expect(container.querySelector("[data-minimap-workspace='ws-b'] > button")?.getAttribute("aria-expanded")).toBe("true");
  });

  it("selects chips without launching declared tabs and toggles workspace expansion", async () => {
    const declared = tab("declared", "declared");
    const wsA: Workspace = { id: "ws-a", name: "A", gridTemplateId: "1x1", status: "running", createdAt: 1, panes: [pane("a", [tab("a"), declared])], splitColumns: [["a"]] };
    const wsB: Workspace = { id: "ws-b", name: "B", gridTemplateId: "1x1", status: "running", createdAt: 1, panes: [pane("b", [tab("b")])], splitColumns: [["b"]] };
    const onSelect = vi.fn();
    const displayStateByTabId = new Map<string, DashboardDisplayState>([["a", "working"], ["declared", "needsHuman"], ["b", "idle"]]);
    await act(async () => root.render(<LayoutMinimapPanel workspaces={[wsA, wsB]} displayStateByTabId={displayStateByTabId} selectedTabId="a" activePaneSessionId={null} onSelect={onSelect} />));
    const chip = container.querySelector<HTMLElement>("[data-minimap-tab='declared']")!;
    expect(chip.dataset.declared).toBe("true");
    expect(chip.classList.contains("is-declared")).toBe(true);
    expect(chip.textContent).toContain("＋");
    expect(chip.querySelector(".cmux-minimap-question")).not.toBeNull();
    await act(async () => chip.click());
    expect(onSelect).toHaveBeenCalledWith("declared");
    const header = container.querySelector<HTMLElement>("[data-minimap-workspace='ws-b'] > button")!;
    expect(header.getAttribute("aria-expanded")).toBe("false");
    await act(async () => header.click());
    expect(header.getAttribute("aria-expanded")).toBe("true");
  });

  it("shows each expanded list label in full without a line clamp", async () => {
    const longName = "とても長い日本語のワークスペース名でも途中で固定文字数に切られないこと";
    const longLabel = "とても長い日本語のセッションラベルでも途中で固定文字数に切られないこと";
    const ws: Workspace = { id: "ws", name: longName, gridTemplateId: "1x1", status: "running", createdAt: 1,
      panes: [pane("p", [{ ...tab("tab"), label: longLabel }])], splitColumns: [["p"]] };
    await act(async () => root.render(<LayoutMinimapPanel workspaces={[ws]} displayStateByTabId={new Map([["tab", "working"]])} selectedTabId="tab" activePaneSessionId={null} onSelect={vi.fn()} />));
    const chip = container.querySelector<HTMLElement>("[data-minimap-tab='tab']")!;
    const name = container.querySelector<HTMLElement>(".cmux-minimap-workspace-name")!;
    expect(chip.querySelector(".cmux-minimap-label")?.textContent).toBe(longLabel);
    expect(chip.title).toBe(longLabel);
    expect(name.textContent).toBe(longName);
    expect(name.title).toBe(longName);
    expect(chip.classList.contains("is-expanded")).toBe(true);
    const minimapCss = readFileSync("src/components/dashboard/MinimapPanel.css", "utf8");
    expect(minimapCss).toContain(".cmux-minimap-cell.is-list-row .cmux-minimap-label { overflow: visible; overflow-wrap: anywhere; text-overflow: clip; white-space: normal; }");
    expect(minimapCss).not.toContain("-webkit-line-clamp");
  });

  it("fits four equal columns without a horizontal scrolling surface and switches to full-label rows when expanded", async () => {
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
    for (const [index, label] of labels.entries()) {
      const chip = block.querySelector<HTMLElement>(`[data-minimap-tab='tab-${index}']`)!;
      expect(chip.querySelector(".cmux-minimap-label")).toBeNull();
      expect(chip.textContent).not.toContain(label);
      expect(chip.title).toBe(label);
      expect(chip.getAttribute("aria-label")).toContain(label);
    }
    const minimapCss = readFileSync("src/components/dashboard/MinimapPanel.css", "utf8");
    const minimapBlockSource = readFileSync("src/components/dashboard/MinimapWorkspaceBlock.tsx", "utf8");
    expect(minimapCss).not.toMatch(/overflow-x\s*:/);
    expect(minimapBlockSource).not.toContain("mapMinimumWidth");

    const header = block.querySelector<HTMLElement>(".cmux-minimap-workspace-header")!;
    await act(async () => header.click());
    expect(block.querySelector(".cmux-minimap-map")).toBeNull();
    const rows = Array.from(block.querySelectorAll<HTMLElement>(".cmux-minimap-cell.is-list-row"));
    expect(rows).toHaveLength(4);
    for (const [index, label] of labels.entries()) {
      const chip = block.querySelector<HTMLElement>(`[data-minimap-tab='tab-${index}']`)!;
      expect(rows[index].querySelector(".cmux-minimap-pane-list-label")?.textContent).toBe(`P${index + 1} ─`);
      expect(chip.querySelector(".cmux-minimap-label")?.textContent).toBe(label);
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

  it("keeps the new-workspace button disabled without a selected tab and uses the passive action when selected", async () => {
    const workspaces = newWorkspaceDndWorkspaces();
    useWorkspaceListStore.setState({ workspaces, activeWorkspaceId: "ws-a" });
    const states = new Map<string, DashboardDisplayState>([["a", "working"], ["b", "working"]]);
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
    const targetHeader = container.querySelector<HTMLElement>("[data-minimap-workspace='ws-b'] > button")!;
    await act(async () => targetHeader.click());
    const source = container.querySelector<HTMLElement>("[data-minimap-tab='a']")!;
    const target = container.querySelector<HTMLElement>("[data-minimap-dnd-pane-id='b']")!;
    expect(target.classList.contains("is-list-row")).toBe(true);
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
    const targetHeader = container.querySelector<HTMLElement>("[data-minimap-workspace='ws-b'] > button")!;
    await act(async () => targetHeader.click());
    const source = container.querySelector<HTMLElement>("[data-minimap-tab='a']")!;
    const target = container.querySelector<HTMLElement>("[data-minimap-dnd-pane-id='b']")!;
    expect(target.classList.contains("is-list-row")).toBe(true);
    stubMinimapTarget(target);
    const mutationSpy = vi.spyOn(layoutMutation, "applyLayoutMutation");
    const replaceSpy = vi.spyOn(useWorkspaceListStore.getState(), "_replaceWorkspaces");
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
});
