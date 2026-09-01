// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { moveMinimapItemToNewWorkspace } from "../../src/components/dashboard/minimapWorkspaceActions";
import { usePaneDragSource } from "../../src/hooks/usePaneDragSource";
import { usePaneDragStore, type PaneDragItem } from "../../src/stores/paneDragStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import type { Pane, PaneTab, Workspace } from "../../src/types";

const tearOutMocks = vi.hoisted(() => ({
  tearOutWorkspaceToNewWindow: vi.fn(async () => "window-detached"),
}));

vi.mock("../../src/lib/workspaceTearOut", () => tearOutMocks);

function tab(id: string): PaneTab {
  return {
    id,
    sessionId: `session-${id}`,
    agentId: `agent-${id}`,
    type: "terminal",
  };
}

function pane(id: string, tabIds: string[], activeTabId = tabIds[0]): Pane {
  const tabs = tabIds.map(tab);
  const activeTab = tabs.find((candidate) => candidate.id === activeTabId) ?? tabs[0];
  return {
    id,
    agentId: activeTab.agentId,
    sessionId: activeTab.sessionId,
    tabs,
    activeTabId: activeTab.id,
  };
}

function workspace(id: string, panes: Pane[], splitColumns: string[][]): Workspace {
  return {
    id,
    name: id,
    gridTemplateId: "1x1",
    status: "running",
    createdAt: 1,
    panes,
    splitColumns,
  };
}

const bundle: Extract<PaneDragItem, { kind: "tab-bundle" }> = {
  kind: "tab-bundle",
  workspaceId: "source",
  paneId: "source-pane",
  tabIds: ["three", "one"],
  anchorTabId: "three",
  label: "2 tabs",
  surface: "minimap",
};

function DragHarness({ item }: { item: PaneDragItem }) {
  const { beginPointerDrag } = usePaneDragSource();
  return <div data-testid="drag-source" onPointerDown={(event) => beginPointerDrag(event, item)} />;
}

function pointer(
  type: string,
  clientX: number,
  clientY: number,
  screenX: number,
  screenY: number,
  pointerId = 1,
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    button: { value: 0 },
    clientX: { value: clientX },
    clientY: { value: clientY },
    screenX: { value: screenX },
    screenY: { value: screenY },
    pointerId: { value: pointerId },
  });
  return event;
}

function setSourceWorkspaces(): void {
  useWorkspaceListStore.setState({
    workspaces: [
      workspace(
        "source",
        [pane("source-pane", ["one", "two", "three", "four"], "three"), pane("keep-pane", ["keep"])],
        [["source-pane", "keep-pane"]],
      ),
      workspace("other", [pane("other-pane", ["other"])], [["other-pane"]]),
    ],
    activeWorkspaceId: "source",
    lastActivePaneByWorkspace: {},
  });
}

function getWorkspace(id: string): Workspace {
  const found = useWorkspaceListStore.getState().getWorkspace(id);
  if (!found) throw new Error(`Workspace not found: ${id}`);
  return found;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "workspace-detached") });
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: vi.fn(() => null),
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useUiStore.setState({ activePaneId: null, lastActivePaneId: null, focusRevision: 0, zoomedPaneId: null });
  usePaneDragStore.getState().clearDrag();
  setSourceWorkspaces();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  usePaneDragStore.getState().clearDrag();
  useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null, lastActivePaneByWorkspace: {} });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function dragBundleToNewWindow(): Promise<void> {
  await act(async () => root.render(<DragHarness item={bundle} />));
  const source = container.querySelector<HTMLElement>("[data-testid='drag-source']")!;
  await act(async () => {
    source.dispatchEvent(pointer("pointerdown", 10, 10, 100, 100));
    window.dispatchEvent(pointer("pointermove", -50, 10, 500, 600));
    window.dispatchEvent(pointer("pointerup", -50, 10, 500, 600));
    await Promise.resolve();
  });
}

describe("tab-bundle tear-out", () => {
  it("moves selected tabs into one pane in source order and removes them from the source", () => {
    const moved = moveMinimapItemToNewWorkspace({
      ...bundle,
      tabIds: ["three", "missing", "one"],
    });

    expect(moved).toBe(true);
    expect(getWorkspace("workspace-detached").panes).toHaveLength(1);
    expect(getWorkspace("workspace-detached").panes[0].tabs.map((item) => item.id)).toEqual(["one", "three"]);
    expect(getWorkspace("workspace-detached").panes[0].activeTabId).toBe("three");
    expect(getWorkspace("source").panes[0].tabs.map((item) => item.id)).toEqual(["two", "four"]);
  });

  it("calls workspace tear-out for a minimap bundle new-window drop", async () => {
    await dragBundleToNewWindow();

    expect(tearOutMocks.tearOutWorkspaceToNewWindow).toHaveBeenCalledTimes(1);
    expect(tearOutMocks.tearOutWorkspaceToNewWindow).toHaveBeenCalledWith(
      "workspace-detached",
      { x: 460, y: 580 },
    );
    expect(getWorkspace("workspace-detached").panes[0].tabs.map((item) => item.id)).toEqual(["one", "three"]);
  });

  it("keeps the original window active during a minimap bundle new-window drop", async () => {
    await dragBundleToNewWindow();

    expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe("source");
    expect(useUiStore.getState().focusRevision).toBe(0);
    expect(useWorkspaceListStore.getState().workspaces).toHaveLength(3);
    expect(tearOutMocks.tearOutWorkspaceToNewWindow).toHaveBeenCalledTimes(1);
  });

  it("returns false and performs no store write when no requested tab exists", () => {
    const before = structuredClone(useWorkspaceListStore.getState().workspaces);
    const updateSpy = vi.spyOn(useWorkspaceListStore.getState(), "_updateWorkspacePanes");
    const createSpy = vi.spyOn(useWorkspaceListStore.getState(), "createWorkspace");

    const moved = useWorkspaceLayoutStore.getState().moveTabsToNewWorkspace(
      "source",
      "source-pane",
      ["missing-a", "missing-b"],
      "missing-a",
      "workspace-detached",
      "Detached",
      { activate: false },
    );

    expect(moved).toBe(false);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
    expect(useWorkspaceListStore.getState().workspaces).toEqual(before);
  });

  it("collapses a source pane after all of its tabs move", () => {
    const moved = useWorkspaceLayoutStore.getState().moveTabsToNewWorkspace(
      "source",
      "source-pane",
      ["four", "two", "three", "one"],
      "missing-anchor",
      "workspace-detached",
      "Detached",
      { activate: false },
    );

    expect(moved).toBe(true);
    expect(getWorkspace("source").panes.map((item) => item.id)).toEqual(["keep-pane"]);
    expect(getWorkspace("source").splitColumns).toEqual([["keep-pane"]]);
    expect(getWorkspace("workspace-detached").panes[0].tabs.map((item) => item.id))
      .toEqual(["one", "two", "three", "four"]);
    expect(getWorkspace("workspace-detached").panes[0].activeTabId).toBe("one");
  });
});
