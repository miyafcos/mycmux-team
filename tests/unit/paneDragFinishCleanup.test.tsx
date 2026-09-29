// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { paneDndStrings } from "../../src/components/workspace/paneDndStrings";
import { usePaneDragSource } from "../../src/hooks/usePaneDragSource";
import { clearTearOutDiagnosticEvents, getTearOutDiagnosticEvents } from "../../src/lib/tearOutDiagnostics";
import { usePaneDragStore, type PaneDragItem } from "../../src/stores/paneDragStore";
import { __resetToastStoreForTests, useToastStore } from "../../src/stores/toastStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import type { Pane, PaneTab, Workspace } from "../../src/types";

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

// A pane (日本語のペイン) dragged from one tab onto the middle of the other.
// 日本語のペイン is `kind: "tab"` in the code (a PaneTab) and 日本語のタブ is `kind: "pane"` (a Pane).
const draggedPane: PaneDragItem = {
  kind: "tab",
  workspaceId: "source",
  paneId: "source-pane",
  tabId: "three",
  label: "Three",
};

// A whole tab (日本語のタブ, `kind: "pane"`) dragged onto the middle of the other tab.
const draggedTab: PaneDragItem = {
  kind: "pane",
  workspaceId: "source",
  paneId: "source-pane",
  label: "Source",
  tabCount: 3,
};

// The harness's click suppression, read back by the tests that check clicks work again.
let shouldSuppressClick: () => boolean = () => false;

function DragHarness({ item }: { item: PaneDragItem }) {
  const drag = usePaneDragSource();
  shouldSuppressClick = drag.shouldSuppressClick;
  return <div data-testid="drag-source" onPointerDown={(event) => drag.beginPointerDrag(event, item)} />;
}

// Lets the tasks already queued run, the drop's click-suppression reset among them.
async function nextTask(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
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

function getWorkspace(id: string): Workspace {
  const found = useWorkspaceListStore.getState().getWorkspace(id);
  if (!found) throw new Error(`Workspace not found: ${id}`);
  return found;
}

let container: HTMLDivElement;
let root: Root;
let dropTarget: HTMLDivElement;
// What a window listener throws never reaches dispatchEvent's caller; jsdom reports it as a
// window "error" event instead, which is where a drop exception would surface.
const uncaught: unknown[] = [];
const recordUncaught = (event: ErrorEvent) => {
  uncaught.push(event.error);
  event.preventDefault();
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // The other tab's body, marked the way TerminalPane marks it for drop hit-testing.
  dropTarget = document.createElement("div");
  dropTarget.setAttribute("data-dnd-workspace-id", "source");
  dropTarget.setAttribute("data-dnd-pane-id", "keep-pane");
  document.body.appendChild(dropTarget);
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: vi.fn(() => dropTarget),
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  __resetToastStoreForTests();
  clearTearOutDiagnosticEvents();
  useUiStore.setState({ activePaneId: null, lastActivePaneId: null, focusRevision: 0, zoomedPaneId: null });
  usePaneDragStore.getState().clearDrag();
  useWorkspaceListStore.setState({
    workspaces: [
      workspace(
        "source",
        [pane("source-pane", ["one", "two", "three"]), pane("keep-pane", ["keep"])],
        [["source-pane", "keep-pane"]],
      ),
    ],
    activeWorkspaceId: "source",
    lastActivePaneByWorkspace: {},
  });
  uncaught.length = 0;
  window.addEventListener("error", recordUncaught);
});

afterEach(async () => {
  window.removeEventListener("error", recordUncaught);
  await act(async () => root.unmount());
  container.remove();
  dropTarget.remove();
  usePaneDragStore.getState().clearDrag();
  __resetToastStoreForTests();
  useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null, lastActivePaneByWorkspace: {} });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function dropOnKeepPaneCenter(item: PaneDragItem = draggedPane): Promise<void> {
  await act(async () => root.render(<DragHarness item={item} />));
  const source = container.querySelector<HTMLElement>("[data-testid='drag-source']")!;
  await act(async () => {
    source.dispatchEvent(pointer("pointerdown", 10, 10, 110, 110));
    window.dispatchEvent(pointer("pointermove", 200, 120, 300, 220));
    expect(usePaneDragStore.getState().target).toEqual({
      kind: "pane",
      workspaceId: "source",
      paneId: "keep-pane",
      zone: "center",
    });
    window.dispatchEvent(pointer("pointerup", 200, 120, 300, 220));
    await Promise.resolve();
  });
}

describe("pane drop clean-up", () => {
  it("moves the pane into the other tab on a normal drop", async () => {
    await dropOnKeepPaneCenter();

    expect(getWorkspace("source").panes.find((item) => item.id === "keep-pane")?.tabs.map((item) => item.id))
      .toEqual(["keep", "three"]);
    expect(getWorkspace("source").panes.find((item) => item.id === "source-pane")?.tabs.map((item) => item.id))
      .toEqual(["one", "two"]);
    expect(usePaneDragStore.getState().item).toBeNull();
    expect(usePaneDragStore.getState().target).toBeNull();
    expect(useToastStore.getState().toasts).toEqual([]);
    expect(uncaught).toEqual([]);
  });

  it("ends the drag and says so when the move throws", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new TypeError("Illegal invocation");
    const moveTabToPane = vi.spyOn(useWorkspaceLayoutStore.getState(), "moveTabToPane")
      .mockImplementation(() => { throw failure; });

    await dropOnKeepPaneCenter();

    expect(moveTabToPane).toHaveBeenCalledTimes(1);
    expect(usePaneDragStore.getState().item).toBeNull();
    expect(usePaneDragStore.getState().target).toBeNull();
    expect(useToastStore.getState().toasts).toHaveLength(1);
    expect(useToastStore.getState().toasts[0]).toMatchObject({
      message: paneDndStrings.dropFailed,
      kind: "error",
    });
    expect(consoleError).toHaveBeenCalledWith("[mycmux] drop commit failed", failure);
    expect(getTearOutDiagnosticEvents().at(-1)).toMatchObject({ state: "transfer-failed", reason: String(failure) });
    expect(uncaught).toEqual([]);
    // Nothing moved: the pane is still where the drag started.
    expect(getWorkspace("source").panes.find((item) => item.id === "source-pane")?.tabs.map((item) => item.id))
      .toEqual(["one", "two", "three"]);
  });

  it("still ends the drag when resolving the release point throws", async () => {
    const failure = new TypeError("hit-test failed");
    await act(async () => root.render(<DragHarness item={draggedPane} />));
    const source = container.querySelector<HTMLElement>("[data-testid='drag-source']")!;
    await act(async () => {
      source.dispatchEvent(pointer("pointerdown", 10, 10, 110, 110));
      window.dispatchEvent(pointer("pointermove", 200, 120, 300, 220));
      vi.mocked(document.elementFromPoint).mockImplementation(() => { throw failure; });
      window.dispatchEvent(pointer("pointerup", 200, 120, 300, 220));
      await Promise.resolve();
    });

    expect(usePaneDragStore.getState().item).toBeNull();
    expect(usePaneDragStore.getState().target).toBeNull();
    // Only a commit failure is caught and explained; this one still surfaces as an error.
    expect(uncaught).toEqual([failure]);
    expect(useToastStore.getState().toasts).toEqual([]);

    // The window listeners went with the drag: a later move changes nothing.
    await act(async () => {
      window.dispatchEvent(pointer("pointermove", 220, 140, 320, 240));
    });
    expect(usePaneDragStore.getState().pointer).toBeNull();
  });

  it("ends the drag and says so when moving a whole tab throws", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new TypeError("Illegal invocation");
    const movePaneToPane = vi.spyOn(useWorkspaceLayoutStore.getState(), "movePaneToPane")
      .mockImplementation(() => { throw failure; });

    await dropOnKeepPaneCenter(draggedTab);

    expect(movePaneToPane).toHaveBeenCalledTimes(1);
    expect(movePaneToPane).toHaveBeenCalledWith("source", "source-pane", "source", "keep-pane");
    expect(usePaneDragStore.getState().item).toBeNull();
    expect(usePaneDragStore.getState().target).toBeNull();
    expect(useToastStore.getState().toasts).toHaveLength(1);
    expect(useToastStore.getState().toasts[0]).toMatchObject({
      message: paneDndStrings.dropFailed,
      kind: "error",
    });
    expect(consoleError).toHaveBeenCalledWith("[mycmux] drop commit failed", failure);
    expect(uncaught).toEqual([]);
    // Nothing moved: both tabs are still there with their panes.
    expect(getWorkspace("source").panes.map((item) => [item.id, item.tabs.map((tab) => tab.id)]))
      .toEqual([["source-pane", ["one", "two", "three"]], ["keep-pane", ["keep"]]]);
  });
});

describe("click suppression after a drop", () => {
  it("lets clicks through again when a drag store listener throws as the drag clears", async () => {
    const failure = new TypeError("drag store listener failed");
    const unsubscribe = usePaneDragStore.subscribe((state, previous) => {
      if (previous.item !== null && state.item === null) throw failure;
    });
    try {
      await dropOnKeepPaneCenter();
    } finally {
      unsubscribe();
    }

    // zustand swaps the state in before it calls the listeners, so the drag did clear.
    expect(usePaneDragStore.getState().item).toBeNull();
    // The listener's own exception is not the drop's to explain; it surfaces as an error.
    expect(uncaught).toEqual([failure]);
    await nextTask();
    expect(shouldSuppressClick()).toBe(false);
  });

  it("clears the drag and lets clicks through when the listener clean-up throws", async () => {
    const failure = new TypeError("removeEventListener failed");
    await act(async () => root.render(<DragHarness item={draggedPane} />));
    const source = container.querySelector<HTMLElement>("[data-testid='drag-source']")!;
    const removeListener = vi.spyOn(source, "removeEventListener");
    await act(async () => {
      source.dispatchEvent(pointer("pointerdown", 10, 10, 110, 110));
      window.dispatchEvent(pointer("pointermove", 200, 120, 300, 220));
      removeListener.mockImplementation(() => { throw failure; });
      window.dispatchEvent(pointer("pointerup", 200, 120, 300, 220));
      await Promise.resolve();
    });
    removeListener.mockRestore();

    expect(usePaneDragStore.getState().item).toBeNull();
    expect(usePaneDragStore.getState().target).toBeNull();
    expect(uncaught).toEqual([failure]);
    await nextTask();
    expect(shouldSuppressClick()).toBe(false);
    // The clean-up failed before the drop was committed, so nothing moved.
    expect(getWorkspace("source").panes.find((item) => item.id === "source-pane")?.tabs.map((item) => item.id))
      .toEqual(["one", "two", "three"]);
  });

  it("clears the drag and lets clicks through when the release point and then the clean-up throw", async () => {
    const hitTestFailure = new TypeError("hit-test failed");
    const cleanupFailure = new TypeError("removeEventListener failed");
    await act(async () => root.render(<DragHarness item={draggedPane} />));
    const source = container.querySelector<HTMLElement>("[data-testid='drag-source']")!;
    const removeListener = vi.spyOn(source, "removeEventListener");
    await act(async () => {
      source.dispatchEvent(pointer("pointerdown", 10, 10, 110, 110));
      window.dispatchEvent(pointer("pointermove", 200, 120, 300, 220));
      // applyMove throws first; the clean-up then owed in the finally throws too.
      vi.mocked(document.elementFromPoint).mockImplementation(() => { throw hitTestFailure; });
      removeListener.mockImplementation(() => { throw cleanupFailure; });
      window.dispatchEvent(pointer("pointerup", 200, 120, 300, 220));
      await Promise.resolve();
    });
    removeListener.mockRestore();

    expect(usePaneDragStore.getState().item).toBeNull();
    expect(usePaneDragStore.getState().target).toBeNull();
    // An exception thrown in a finally takes the place of the one it interrupted.
    expect(uncaught).toEqual([cleanupFailure]);
    await nextTask();
    expect(shouldSuppressClick()).toBe(false);
    // The window listeners were removed before the clean-up threw: a later move changes nothing.
    await act(async () => {
      window.dispatchEvent(pointer("pointermove", 220, 140, 320, 240));
    });
    expect(usePaneDragStore.getState().pointer).toBeNull();
  });
});
