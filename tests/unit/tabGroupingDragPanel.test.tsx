// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const analysisHarness = vi.hoisted(() => ({ value: null as unknown }));
const editHarness = vi.hoisted(() => ({ commands: [] as unknown[], sessions: [] as unknown[] }));
const boundaryHarness = vi.hoisted(() => ({
  previewCalls: 0,
  prepareCalls: 0,
  commitCalls: 0,
  previews: [] as Array<{ plan: unknown; result: unknown }>,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => true) }));
vi.mock("../../src/components/layout/tabGrouping", async (importActual) => {
  const actual = await importActual<typeof import("../../src/components/layout/tabGrouping")>();
  return { ...actual, runGroupingAnalysis: vi.fn(async () => analysisHarness.value) };
});
vi.mock("../../src/components/layout/groupingEdit", async (importActual) => {
  const actual = await importActual<typeof import("../../src/components/layout/groupingEdit")>();
  return {
    ...actual,
    applyEditCommand: (...args: Parameters<typeof actual.applyEditCommand>) => {
      editHarness.commands.push(args[1]);
      const result = actual.applyEditCommand(...args);
      editHarness.sessions.push(result);
      return result;
    },
  };
});
vi.mock("../../src/components/layout/groupingBoundary", async (importActual) => {
  const actual = await importActual<typeof import("../../src/components/layout/groupingBoundary")>();
  return {
    ...actual,
    groupingBoundary: {
      ...actual.groupingBoundary,
      preview: (...args: Parameters<typeof actual.groupingBoundary.preview>) => {
        boundaryHarness.previewCalls += 1;
        const result = actual.groupingBoundary.preview(...args);
        boundaryHarness.previews.push({ plan: args[0], result });
        return result;
      },
      prepare: (...args: Parameters<typeof actual.groupingBoundary.prepare>) => {
        boundaryHarness.prepareCalls += 1;
        return actual.groupingBoundary.prepare(...args);
      },
      commit: (...args: Parameters<typeof actual.groupingBoundary.commit>) => {
        boundaryHarness.commitCalls += 1;
        return actual.groupingBoundary.commit(...args);
      },
    },
  };
});

import { tabGroupingStrings } from "../../src/components/dashboard/dashboardStrings";
import { TabGroupingPanel } from "../../src/components/layout/TabGroupingPanel";
import type { GroupingDragCancelReason } from "../../src/components/layout/groupingDrag";
import type { GroupingEditSession } from "../../src/components/layout/groupingEdit";
import { useGroupingDrag } from "../../src/hooks/useGroupingDrag";
import { useGroupingRuntimeStore } from "../../src/stores/groupingRuntimeStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useSessionAttentionStore } from "../../src/stores/sessionAttentionStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { __resetGroupingPrecomputeForTests } from "../../src/lib/groupingPrecompute";
import { mockGroupingAnalysis, mockWorkspaces } from "./fixtures/tabGroupingMockScenario";
import { hashCanonical } from "./helpers/groupingTestEntrypoint";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let nextFrameId = 1;
let frameQueue = new Map<number, FrameRequestCallback>();

function resetStores(): void {
  useGroupingRuntimeStore.setState({
    persistentSchema: { loadedSchemaVersion: 1, migrationComplete: true, schemaEpoch: 1 },
    transitionDepth: 0,
    transitionEpoch: 0,
    transitionSource: null,
    transitionFrames: [],
    operation: null,
    poisoned: false,
    diagnostic: null,
    undo: null,
    durability: { status: "idle" },
  });
  useWorkspaceListStore.setState({
    workspaces: structuredClone(mockWorkspaces),
    layoutRevision: 1,
    activeWorkspaceId: "wsA",
    lastActivePaneByWorkspace: {
      wsA: "session-t請求",
      wsB: "session-t統括",
      wsC: "session-t数学",
    },
  });
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {} });
  useSessionAttentionStore.setState({ attentionBySession: {}, seenAttentionByTab: new Map() });
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 })));
  await settle();
}

function pointer(
  type: string,
  pointerId: number,
  clientX: number,
  clientY: number,
  overrides: { button?: number; isPrimary?: boolean } = {},
): PointerEvent {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    button: { value: overrides.button ?? 0 },
    clientX: { value: clientX },
    clientY: { value: clientY },
    isPrimary: { value: overrides.isPrimary ?? true },
    pointerId: { value: pointerId },
    screenX: { value: clientX },
    screenY: { value: clientY },
  });
  return event as PointerEvent;
}

function stubElementFromPoint(element: Element | null): void {
  stubElementsFromPoint(element ? [element] : []);
}

function stubElementsFromPoint(elements: readonly Element[]): void {
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: vi.fn(() => elements[0] ?? null),
  });
  Object.defineProperty(document, "elementsFromPoint", {
    configurable: true,
    value: vi.fn(() => [...elements]),
  });
}

async function flushAnimationFrames(): Promise<void> {
  const callbacks = [...frameQueue.values()];
  frameQueue.clear();
  await act(async () => {
    callbacks.forEach((callback) => callback(performance.now()));
  });
  await settle();
}

function chip(tabId: string): HTMLButtonElement {
  const match = document.querySelector<HTMLButtonElement>(
    `.cmux-tab-grouping-editmap button.cmux-tab-grouping-chip[data-tab-id="${tabId}"]`,
  );
  if (!match) throw new Error(`chip not found: ${tabId}`);
  return match;
}

function dropTarget(dropId: string): HTMLElement {
  const match = [...document.querySelectorAll<HTMLElement>("[data-drop-id]")]
    .find((element) => element.dataset.dropId === dropId);
  if (!match) throw new Error(`drop target not found: ${dropId}`);
  return match;
}

async function startDrag(sourceTabId: string, dropId: string, pointerId = 7): Promise<void> {
  const source = chip(sourceTabId);
  const destination = dropTarget(dropId);
  stubElementFromPoint(destination);
  await act(async () => source.dispatchEvent(pointer("pointerdown", pointerId, 10, 10)));
  await act(async () => window.dispatchEvent(pointer("pointermove", pointerId, 20, 10)));
  await flushAnimationFrames();
}

async function drag(sourceTabId: string, dropId: string, pointerId = 7): Promise<void> {
  await startDrag(sourceTabId, dropId, pointerId);
  await act(async () => window.dispatchEvent(pointer("pointerup", pointerId, 20, 10)));
  await settle();
}

async function mountEdit(onClose = vi.fn()): Promise<ReturnType<typeof vi.fn>> {
  const container = document.createElement("div");
  document.body.replaceChildren(container);
  root = createRoot(container);
  await act(async () => root?.render(<TabGroupingPanel open visible intent={null} onClose={onClose} />));
  await settle();
  await click(button(tabGroupingStrings.editPlan));
  return onClose;
}

function HookCancelProbe({
  enabled,
  mode = "edit",
  onCancel,
}: {
  enabled: boolean;
  mode?: "compare" | "edit";
  onCancel: (reason: GroupingDragCancelReason) => void;
}) {
  const { onTabPointerDown } = useGroupingDrag({
    enabled,
    mode,
    plan: null,
    selectedTabIds: new Set(),
    validDropIds: new Set(),
    targetsByDropId: new Map(),
    dropNames: new Map(),
    tabLabels: new Map([["probe", "probe"]]),
    revisionToken: null,
    layoutRevision: "probe-layout",
    onToggleTab: vi.fn(),
    onMove: vi.fn(),
    onCancel,
  });
  return (
    <button type="button" data-hook-cancel-probe onPointerDown={(event) => onTabPointerDown(event, "probe")}>probe</button>
  );
}

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((item) => item.textContent?.trim() === label);
  if (!match) throw new Error(`button not found: ${label}`);
  return match;
}

beforeEach(() => {
  __resetGroupingPrecomputeForTests();
  localStorage.clear();
  analysisHarness.value = mockGroupingAnalysis;
  editHarness.commands = [];
  editHarness.sessions = [];
  boundaryHarness.previewCalls = 0;
  boundaryHarness.prepareCalls = 0;
  boundaryHarness.commitCalls = 0;
  boundaryHarness.previews = [];
  nextFrameId = 1;
  frameQueue = new Map();
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    const id = nextFrameId++;
    frameQueue.set(id, callback);
    return id;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => {
    frameQueue.delete(id);
  }));
  resetStores();
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
  __resetGroupingPrecomputeForTests();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetStores();
});

describe("TabGroupingPanel pointer drag", () => {
  it("renders drag affordances only in the editable after-map", async () => {
    const container = document.createElement("div");
    document.body.replaceChildren(container);
    root = createRoot(container);
    await act(async () => root?.render(<TabGroupingPanel open visible intent={null} onClose={vi.fn()} />));
    await settle();

    expect(document.querySelectorAll(".cmux-tab-grouping-grip")).toHaveLength(0);
    await click(button(tabGroupingStrings.editPlan));

    const editableChips = document.querySelectorAll<HTMLButtonElement>(
      ".cmux-tab-grouping-editmap button.cmux-tab-grouping-chip[data-tab-id]",
    );
    expect(editableChips.length).toBeGreaterThan(0);
    expect(document.querySelectorAll(".cmux-tab-grouping-grip")).toHaveLength(editableChips.length);
    expect(document.querySelector('[role="status"][aria-live="polite"]')).not.toBeNull();
    expect(document.querySelectorAll("[draggable]")).toHaveLength(0);
  });

  it("moves one tab once and removes the overlay-root ghost after drop", async () => {
    await mountEdit();
    const source = chip("t数学");
    const grip = source.querySelector<HTMLElement>(".cmux-tab-grouping-grip");
    if (!grip) throw new Error("drag grip not found");
    const destination = dropTarget("g2:0:0");
    stubElementFromPoint(destination);
    await act(async () => grip.dispatchEvent(pointer("pointerdown", 7, 10, 10)));
    await act(async () => window.dispatchEvent(pointer("pointermove", 7, 20, 10)));
    await flushAnimationFrames();

    const ghost = document.querySelector<HTMLElement>("[data-grouping-ghost]");
    const overlayRoot = document.querySelector<HTMLElement>("[data-cmux-overlay-root]");
    expect(ghost).not.toBeNull();
    expect(ghost?.parentElement).toBe(overlayRoot);
    expect(document.querySelector(".cmux-overlay-panel")?.contains(ghost)).toBe(false);
    expect(ghost?.getAttribute("aria-hidden")).toBe("true");
    expect(source.classList.contains("is-dragging")).toBe(true);

    await act(async () => window.dispatchEvent(pointer("pointerup", 7, 20, 10)));
    await settle();
    expect(editHarness.commands).toEqual([{
      kind: "reassign_tabs",
      tabIds: ["t数学"],
      target: { kind: "pane", groupId: "g2", columnIndex: 0, paneIndex: 0 },
    }]);
    expect(document.querySelectorAll("[data-grouping-ghost]")).toHaveLength(0);
    expect(source.classList.contains("is-dragging")).toBe(false);
    expect(dropTarget("g2:0:0").querySelector('[data-tab-id="t数学"]')).not.toBeNull();
  });

  it("treats an exact-threshold move and pointerup before rAF as one drop", async () => {
    await mountEdit();
    const source = chip("t数学");
    const destination = dropTarget("g2:0:0");
    stubElementFromPoint(destination);
    await act(async () => source.dispatchEvent(pointer("pointerdown", 70, 10, 10)));
    await act(async () => window.dispatchEvent(pointer("pointermove", 70, 17, 10)));
    expect(frameQueue.size).toBe(1);
    await act(async () => window.dispatchEvent(pointer("pointerup", 70, 17, 10)));
    await settle();
    expect(editHarness.commands).toEqual([{
      kind: "reassign_tabs",
      tabIds: ["t数学"],
      target: { kind: "pane", groupId: "g2", columnIndex: 0, paneIndex: 0 },
    }]);
    expect(frameQueue.size).toBe(0);
    expect(chip("t数学").getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelectorAll("[data-grouping-ghost], .is-drop-active, .is-dragging")).toHaveLength(0);
  });

  it("finds the first valid drop surface below a sibling overlay", async () => {
    await mountEdit();
    const source = chip("t数学");
    const destination = dropTarget("g2:0:0");
    const cover = document.createElement("div");
    document.querySelector("[data-cmux-overlay-root]")?.append(cover);
    stubElementsFromPoint([cover, destination]);
    await act(async () => source.dispatchEvent(pointer("pointerdown", 71, 10, 10)));
    await act(async () => window.dispatchEvent(pointer("pointermove", 71, 20, 10)));
    await flushAnimationFrames();
    expect(destination.classList.contains("is-drop-active")).toBe(true);
    await act(async () => window.dispatchEvent(pointer("pointerup", 71, 20, 10)));
    await settle();
    expect(editHarness.commands).toEqual([{
      kind: "reassign_tabs",
      tabIds: ["t数学"],
      target: { kind: "pane", groupId: "g2", columnIndex: 0, paneIndex: 0 },
    }]);
  });

  it("keeps pointermove free of edit commands and turns a sub-threshold release into one selection click", async () => {
    await mountEdit();
    const source = chip("t数学");
    const destination = dropTarget("g2:0:0");
    const previewCalls = boundaryHarness.previewCalls;
    const workspaceSetState = vi.spyOn(useWorkspaceListStore, "setState");
    const runtimeSetState = vi.spyOn(useGroupingRuntimeStore, "setState");
    stubElementFromPoint(destination);
    await act(async () => source.dispatchEvent(pointer("pointerdown", 8, 10, 10)));
    for (let x = 18; x <= 22; x += 1) {
      await act(async () => window.dispatchEvent(pointer("pointermove", 8, x, 10)));
    }
    await flushAnimationFrames();
    expect(editHarness.commands).toHaveLength(0);
    expect(boundaryHarness.previewCalls).toBe(previewCalls);
    expect(boundaryHarness.prepareCalls).toBe(0);
    expect(boundaryHarness.commitCalls).toBe(0);
    expect(workspaceSetState).not.toHaveBeenCalled();
    expect(runtimeSetState).not.toHaveBeenCalled();
    workspaceSetState.mockRestore();
    runtimeSetState.mockRestore();
    await act(async () => window.dispatchEvent(pointer("pointercancel", 8, 22, 10)));
    await settle();

    const clickSource = chip("t数学");
    stubElementFromPoint(destination);
    await act(async () => clickSource.dispatchEvent(pointer("pointerdown", 9, 10, 10)));
    await act(async () => window.dispatchEvent(pointer("pointermove", 9, 13, 10)));
    await flushAnimationFrames();
    expect(destination.classList.contains("is-drop-active")).toBe(false);
    await act(async () => window.dispatchEvent(pointer("pointerup", 9, 13, 10)));
    await settle();
    expect(document.querySelectorAll("[data-grouping-ghost]")).toHaveLength(0);
    expect(editHarness.commands).toHaveLength(0);
    expect(chip("t数学").getAttribute("aria-pressed")).toBe("true");
  });

  it("moves the selected set together and leaves an unselected source as a one-tab drag", async () => {
    await mountEdit();
    await click(chip("t請求"));
    await click(chip("tkessan"));
    const source = chip("t請求");
    const destination = dropTarget("g1:0:0");
    stubElementFromPoint(destination);
    await act(async () => source.dispatchEvent(pointer("pointerdown", 10, 10, 10)));
    await act(async () => window.dispatchEvent(pointer("pointermove", 10, 20, 10)));
    await flushAnimationFrames();
    expect(document.querySelector(".cmux-tab-grouping-ghost-count")?.textContent).toBe(
      tabGroupingStrings.dragGhostCount(2),
    );
    await act(async () => window.dispatchEvent(pointer("pointerup", 10, 20, 10)));
    await settle();
    expect(editHarness.commands).toEqual([{
      kind: "reassign_tabs",
      tabIds: ["t請求", "tkessan"],
      target: { kind: "pane", groupId: "g1", columnIndex: 0, paneIndex: 0 },
    }]);

    editHarness.commands = [];
    await click(chip("t請求"));
    await click(chip("tkessan"));
    await drag("t数学", "g1:0:0", 11);
    expect(editHarness.commands).toEqual([{
      kind: "reassign_tabs",
      tabIds: ["t数学"],
      target: { kind: "pane", groupId: "g1", columnIndex: 0, paneIndex: 0 },
    }]);
    expect(chip("t請求")).not.toBeNull();
    expect(chip("tkessan")).not.toBeNull();
  });

  it("rejects no-op, stale, and targetless releases", async () => {
    await mountEdit();
    const map = document.querySelector<HTMLElement>(".cmux-tab-grouping-editmap");
    const before = map?.innerHTML;
    await drag("t数学", "g1:1:0", 111);
    expect(editHarness.commands).toHaveLength(0);
    expect(map?.innerHTML).toBe(before);
    expect(document.querySelectorAll('[role="status"][aria-live="polite"]')).toHaveLength(1);
    expect(document.querySelector('[role="status"][aria-live="polite"]')?.textContent)
      .toBe(tabGroupingStrings.dragNoopAnnounce);

    const stale = document.createElement("div");
    stale.dataset.dropId = "stale:9:9";
    document.querySelector("[data-cmux-overlay-root]")?.append(stale);
    const source = chip("t数学");
    stubElementFromPoint(stale);
    await act(async () => source.dispatchEvent(pointer("pointerdown", 112, 10, 10)));
    await act(async () => window.dispatchEvent(pointer("pointermove", 112, 20, 10)));
    await flushAnimationFrames();
    expect(stale.classList.contains("is-drop-active")).toBe(false);
    await act(async () => window.dispatchEvent(pointer("pointerup", 112, 20, 10)));
    await settle();
    expect(editHarness.commands).toHaveLength(0);

    stubElementFromPoint(null);
    await act(async () => source.dispatchEvent(pointer("pointerdown", 113, 10, 10)));
    await act(async () => window.dispatchEvent(pointer("pointermove", 113, 20, 10)));
    await flushAnimationFrames();
    await act(async () => window.dispatchEvent(pointer("pointerup", 113, 20, 10)));
    await settle();
    expect(editHarness.commands).toHaveLength(0);
    expect(document.querySelectorAll("[data-grouping-ghost], .is-drop-active")).toHaveLength(0);
  });

  it("cancels immediately when the real edited plan revision changes", async () => {
    await mountEdit();
    await drag("t請求", "g1:0:0", 220);
    editHarness.commands = [];
    await startDrag("t数学", "g2:0:0", 221);
    expect(document.querySelectorAll(".cmux-tab-grouping-ghost")).toHaveLength(1);
    await click(button(tabGroupingStrings.undoEdit));
    expect(document.querySelectorAll(".cmux-tab-grouping-ghost, .is-dragging, .is-drop-active, .is-drag-active")).toHaveLength(0);
    expect(document.querySelector('[role="status"][aria-live="polite"]')?.textContent)
      .toBe(tabGroupingStrings.dragCancelAnnounce);
    expect(editHarness.commands).toHaveLength(0);
  });

  it("cancels immediately when the real workspace structure revision changes", async () => {
    await mountEdit();
    const ticketRevision = useWorkspaceListStore.getState().layoutRevision;
    await startDrag("t数学", "g2:0:0", 222);
    await act(async () => useWorkspaceListStore.setState({
      workspaces: structuredClone(useWorkspaceListStore.getState().workspaces).reverse(),
    }));
    await settle();
    expect(useWorkspaceListStore.getState().layoutRevision).toBe(ticketRevision);
    expect(document.querySelectorAll(".cmux-tab-grouping-ghost, .is-dragging, .is-drop-active, .is-drag-active")).toHaveLength(0);
    expect(document.querySelector('[role="status"][aria-live="polite"]')?.textContent)
      .toBe(tabGroupingStrings.dragCancelAnnounce);
    expect(editHarness.commands).toHaveLength(0);
  });

  it("keeps dragging when only the numeric commit ticket revision changes", async () => {
    await mountEdit();
    const workspaces = useWorkspaceListStore.getState().workspaces;
    const ticketRevision = useWorkspaceListStore.getState().layoutRevision;
    await startDrag("t数学", "g2:0:0", 223);
    await act(async () => useWorkspaceListStore.setState({ layoutRevision: ticketRevision + 1 }));
    await settle();
    expect(useWorkspaceListStore.getState().workspaces).toBe(workspaces);
    expect(document.querySelectorAll(".cmux-tab-grouping-ghost")).toHaveLength(1);
    expect(document.querySelectorAll(".is-dragging, .is-drop-active, .is-drag-active").length).toBeGreaterThan(0);
    expect(document.querySelector('[role="status"][aria-live="polite"]')?.textContent)
      .not.toBe(tabGroupingStrings.dragCancelAnnounce);
    expect(editHarness.commands).toHaveLength(0);
    await act(async () => window.dispatchEvent(pointer("pointercancel", 223, 20, 10)));
    await settle();
  });

  it("keeps boundary and store mutation seams unchanged during auto-scroll and cancel", async () => {
    await mountEdit();
    const editmap = document.querySelector<HTMLElement>(".cmux-tab-grouping-editmap");
    if (!editmap) throw new Error("editmap not found");
    Object.defineProperties(editmap, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 400 },
      scrollTop: { configurable: true, writable: true, value: 0 },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100, x: 0, y: 0, toJSON: () => ({}) }),
      },
    });
    const workspaceSetState = vi.spyOn(useWorkspaceListStore, "setState");
    const runtimeSetState = vi.spyOn(useGroupingRuntimeStore, "setState");
    const boundaryBaseline = {
      preview: boundaryHarness.previewCalls,
      prepare: boundaryHarness.prepareCalls,
      commit: boundaryHarness.commitCalls,
    };
    await startDrag("t数学", "g2:0:0", 224);
    await act(async () => window.dispatchEvent(pointer("pointermove", 224, 20, 95)));
    await flushAnimationFrames();
    await flushAnimationFrames();
    expect(editmap.scrollTop).toBeGreaterThan(0);
    expect(boundaryHarness.previewCalls).toBe(boundaryBaseline.preview);
    expect(boundaryHarness.prepareCalls).toBe(boundaryBaseline.prepare);
    expect(boundaryHarness.commitCalls).toBe(boundaryBaseline.commit);
    expect(workspaceSetState).not.toHaveBeenCalled();
    expect(runtimeSetState).not.toHaveBeenCalled();
    expect(editHarness.commands).toHaveLength(0);
    const stoppedTop = editmap.scrollTop;
    await act(async () => window.dispatchEvent(pointer("pointercancel", 224, 20, 95)));
    expect(frameQueue.size).toBe(0);
    await flushAnimationFrames();
    expect(editmap.scrollTop).toBe(stoppedTop);
  });

  it("drops a selected tab into keep-current and announces the result", async () => {
    await mountEdit();
    await click(chip("t数学"));
    await drag("t数学", "keep-current", 114);
    expect(editHarness.commands).toEqual([{
      kind: "keep_current",
      tabIds: ["t数学"],
    }]);
    expect(document.querySelector('[data-tab-id="t数学"] .cmux-tab-grouping-state')?.getAttribute("data-state"))
      .toBe("unassigned");
    expect(document.querySelectorAll('[role="status"][aria-live="polite"]')).toHaveLength(1);
    expect(document.querySelector('[role="status"][aria-live="polite"]')?.textContent)
      .toBe(tabGroupingStrings.keepAnnounce(1));
  });

  it("restores a stashed empty group through its shared group drop id", async () => {
    await mountEdit();
    await drag("t請求", "g1:0:0", 12);
    await drag("tkessan", "g1:0:0", 13);

    const placeholder = dropTarget("group:g2");
    expect(placeholder.classList.contains("cmux-tab-grouping-empty-group-drop")).toBe(true);
    expect(placeholder.textContent).toContain(tabGroupingStrings.emptyGroupDropHint);
    expect(placeholder.getAttribute("role")).toBe("button");
    expect(placeholder.tabIndex).toBe(-1);
    const emptiedSession = editHarness.sessions.at(-1) as GroupingEditSession;
    expect(emptiedSession.stashedLayouts.g2).toBeDefined();

    editHarness.commands = [];
    await drag("tkessan", "group:g2", 14);
    expect(editHarness.commands).toEqual([{
      kind: "reassign_tabs",
      tabIds: ["tkessan"],
      target: { kind: "group", groupId: "g2" },
    }]);
    const restoredSession = editHarness.sessions.at(-1) as GroupingEditSession;
    expect(restoredSession.stashedLayouts.g2).toBeUndefined();
    expect(restoredSession.plan.groups.find((group) => group.groupId === "g2")?.layout).not.toBeNull();
    expect(document.querySelectorAll('[data-drop-id="group:g2"]')).toHaveLength(0);
    expect(dropTarget("g2:0:0").querySelector('[data-tab-id="tkessan"] .cmux-tab-grouping-state')?.getAttribute("data-state"))
      .toBe("moved");

    await drag("tkessan", "g1:0:0", 115);
    await click(chip("t請求"));
    editHarness.commands = [];
    await click(dropTarget("group:g2"));
    expect(editHarness.commands).toEqual([{
      kind: "reassign_tabs",
      tabIds: ["t請求"],
      target: { kind: "group", groupId: "g2" },
    }]);
  });

  it("cancels pointercancel and Escape without applying or closing, and ignores secondary pointers", async () => {
    const onClose = await mountEdit();
    for (const [pointerId, cancel] of [[15, "pointercancel"], [16, "Escape"]] as const) {
      const source = chip("t数学");
      const destination = dropTarget("g2:0:0");
      stubElementFromPoint(destination);
      await act(async () => source.dispatchEvent(pointer("pointerdown", pointerId, 10, 10)));
      await act(async () => window.dispatchEvent(pointer("pointermove", pointerId, 20, 10)));
      await flushAnimationFrames();
      if (cancel === "pointercancel") {
        await act(async () => window.dispatchEvent(pointer("pointercancel", pointerId, 20, 10)));
      } else {
        await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
      }
      await settle();
      expect(document.querySelectorAll("[data-grouping-ghost], .is-drop-active")).toHaveLength(0);
    }
    const source = chip("t数学");
    await act(async () => source.dispatchEvent(pointer("pointerdown", 17, 10, 10, { button: 2 })));
    await act(async () => source.dispatchEvent(pointer("pointerdown", 18, 10, 10, { isPrimary: false })));
    await act(async () => window.dispatchEvent(pointer("pointermove", 18, 30, 10)));
    await flushAnimationFrames();
    expect(editHarness.commands).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelectorAll("[data-grouping-ghost]")).toHaveLength(0);
    expect(document.querySelectorAll("[draggable]")).toHaveLength(0);
  });

  it("refuses backdrop and explicit close requests until the active drag is cancelled", async () => {
    const onClose = await mountEdit();
    await startDrag("t数学", "g2:0:0", 225);
    const backdrop = document.querySelector<HTMLElement>(".cmux-overlay-backdrop");
    if (!backdrop) throw new Error("overlay backdrop not found");
    await act(async () => backdrop.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      button: 0,
    })));
    await click(button(tabGroupingStrings.close));
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelectorAll(".cmux-tab-grouping-ghost")).toHaveLength(1);
    expect(editHarness.commands).toHaveLength(0);

    await act(async () => window.dispatchEvent(pointer("pointercancel", 225, 20, 10)));
    await settle();
    await click(button(tabGroupingStrings.close));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps drag-only DOM out of compare and every confirmation view", async () => {
    const container = document.createElement("div");
    document.body.replaceChildren(container);
    root = createRoot(container);
    await act(async () => root?.render(<TabGroupingPanel open visible intent={null} onClose={vi.fn()} />));
    await settle();
    const expectNoDragDom = () => {
      expect(document.querySelectorAll(
        ".cmux-tab-grouping-grip, .cmux-tab-grouping-ghost, .is-dragging, .is-drop-active, .is-drag-active, .cmux-tab-grouping-empty-group-drop, [aria-describedby=\"cmux-tab-grouping-drop-picker-hint\"], [data-grouping-drop-state]",
      )).toHaveLength(0);
    };
    expectNoDragDom();
    await click(button(tabGroupingStrings.confirmPlan));
    for (const label of [
      tabGroupingStrings.confirmSideBySide,
      tabGroupingStrings.confirmCurrent,
      tabGroupingStrings.confirmAfter,
      tabGroupingStrings.confirmDiff,
    ]) {
      await click(button(label));
      expectNoDragDom();
    }
  });

  it("keeps the same two-tab move canonically equal across a pane/group id collision", async () => {
    const collisionAnalysis = structuredClone(mockGroupingAnalysis);
    const projectPlan = collisionAnalysis.parsed.plans.find((plan) => plan.planId === "p1");
    if (!projectPlan) throw new Error("project plan not found");
    projectPlan.groups[0].groupId = "group:a";
    projectPlan.groups[1].groupId = "a:0:0";
    analysisHarness.value = collisionAnalysis;
    await mountEdit();
    await drag("t請求", "group:a:0:0", 190);
    await drag("tkessan", "group:a:0:0", 191);
    const paneSurface = dropTarget("group:a:0:0");
    const groupSurface = dropTarget("group:a%3A0%3A0");
    expect(paneSurface).not.toBe(groupSurface);
    expect(paneSurface.classList.contains("cmux-tab-grouping-pane")).toBe(true);
    expect(groupSurface.classList.contains("cmux-tab-grouping-empty-group-drop")).toBe(true);

    const expectedCommand = {
      kind: "reassign_tabs",
      tabIds: ["t模試", "t数学"],
      target: { kind: "pane", groupId: "group:a", columnIndex: 0, paneIndex: 0 },
    };
    const captureFreshPathResult = (
      previewIndex: number,
      commandIndex: number,
      sessionIndex: number,
      previousResult: unknown,
    ) => {
      expect(boundaryHarness.previews).toHaveLength(previewIndex + 1);
      expect(editHarness.commands).toHaveLength(commandIndex + 1);
      expect(editHarness.sessions).toHaveLength(sessionIndex + 1);
      const preview = boundaryHarness.previews[previewIndex];
      const session = editHarness.sessions[sessionIndex] as GroupingEditSession;
      expect(preview.result).not.toBe(previousResult);
      expect(preview.plan).toEqual(session.plan);
      expect(editHarness.commands[commandIndex]).toEqual(expectedCommand);
      const result = preview.result as { ok: true; transaction: { workspaces: unknown } };
      expect(result.ok).toBe(true);
      return {
        command: structuredClone(editHarness.commands[commandIndex]),
        hash: hashCanonical(result.transaction.workspaces),
      };
    };

    await click(chip("t模試"));
    await click(chip("t数学"));
    const dragIndexes = {
      preview: boundaryHarness.previews.length,
      command: editHarness.commands.length,
      session: editHarness.sessions.length,
      previous: boundaryHarness.previews.at(-1)?.result,
    };
    await drag("t数学", "group:a:0:0", 192);
    const dragPath = captureFreshPathResult(
      dragIndexes.preview,
      dragIndexes.command,
      dragIndexes.session,
      dragIndexes.previous,
    );
    const expectedAnnouncement = "2件をモモスタ制作 の 母艦へ移動しました";
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe(expectedAnnouncement);

    await click(button(tabGroupingStrings.undoEdit));
    await click(chip("t模試"));
    await click(chip("t数学"));
    const clickIndexes = {
      preview: boundaryHarness.previews.length,
      command: editHarness.commands.length,
      session: editHarness.sessions.length,
      previous: boundaryHarness.previews.at(-1)?.result,
    };
    await click(dropTarget("group:a:0:0"));
    const clickPath = captureFreshPathResult(
      clickIndexes.preview,
      clickIndexes.command,
      clickIndexes.session,
      clickIndexes.previous,
    );
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe(expectedAnnouncement);

    await click(button(tabGroupingStrings.undoEdit));
    await click(chip("t模試"));
    await click(chip("t数学"));
    await click(button(tabGroupingStrings.moveSelected));
    const menuItem = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((item) => item.textContent?.trim() === "モモスタ制作 / 母艦");
    if (!menuItem) throw new Error("popover target not found");
    const popoverIndexes = {
      preview: boundaryHarness.previews.length,
      command: editHarness.commands.length,
      session: editHarness.sessions.length,
      previous: boundaryHarness.previews.at(-1)?.result,
    };
    await click(menuItem);
    const popoverPath = captureFreshPathResult(
      popoverIndexes.preview,
      popoverIndexes.command,
      popoverIndexes.session,
      popoverIndexes.previous,
    );

    expect([dragPath.command, clickPath.command, popoverPath.command]).toEqual([
      expectedCommand,
      expectedCommand,
      expectedCommand,
    ]);
    expect([dragPath.hash, clickPath.hash, popoverPath.hash]).toEqual([
      dragPath.hash,
      dragPath.hash,
      dragPath.hash,
    ]);
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe(expectedAnnouncement);
    expect(document.querySelectorAll('[role="status"][aria-live="polite"]')).toHaveLength(1);
  });

  it("reports mode-changed through the hook cancellation contract", async () => {
    const reasons: GroupingDragCancelReason[] = [];
    const container = document.createElement("div");
    document.body.replaceChildren(container);
    root = createRoot(container);
    await act(async () => root?.render(<HookCancelProbe enabled onCancel={(reason) => reasons.push(reason)} />));
    const source = document.querySelector<HTMLButtonElement>("[data-hook-cancel-probe]");
    if (!source) throw new Error("hook probe not found");
    await act(async () => source.dispatchEvent(pointer("pointerdown", 193, 10, 10)));
    await act(async () => root?.render(<HookCancelProbe enabled={false} mode="compare" onCancel={(reason) => reasons.push(reason)} />));
    await settle();
    expect(reasons).toEqual(["mode-changed"]);
    expect(document.querySelectorAll("[data-grouping-ghost], .is-drop-active, .is-dragging")).toHaveLength(0);
  });

  it("cancels an active drag when the real Panel enters closing state", async () => {
    const onClose = await mountEdit();
    const element = chip("t数学");
    stubElementFromPoint(dropTarget("g2:0:0"));
    await act(async () => element.dispatchEvent(pointer("pointerdown", 197, 10, 10)));
    await act(async () => window.dispatchEvent(pointer("pointermove", 197, 20, 10)));
    await flushAnimationFrames();
    expect(document.querySelectorAll(".cmux-tab-grouping-ghost")).toHaveLength(1);
    await act(async () => root?.render(
      <TabGroupingPanel open visible closing intent={null} onClose={onClose} />,
    ));
    await settle();
    expect(document.querySelectorAll(".cmux-tab-grouping-ghost, .is-dragging, .is-drop-active, .is-drag-active")).toHaveLength(0);
    expect(document.querySelector('[role="status"][aria-live="polite"]')?.textContent)
      .toBe(tabGroupingStrings.dragCancelAnnounce);
    expect(editHarness.commands).toHaveLength(0);
  });

  it("keeps exactly one edit-map drop zone tabbable and moves it without wrapping", async () => {
    await mountEdit();
    const zones = [...document.querySelectorAll<HTMLElement>(".cmux-tab-grouping-editmap [data-drop-id]")];
    expect(zones.length).toBeGreaterThan(2);
    expect(zones.filter((zone) => zone.tabIndex === 0)).toHaveLength(1);
    const first = zones[0];
    first.focus();
    await act(async () => first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(first);
    const down = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    await act(async () => first.dispatchEvent(down));
    expect(down.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(zones[1]);
    expect(first.tabIndex).toBe(-1);
    expect(zones[1].tabIndex).toBe(0);
    await act(async () => zones[1].dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(zones.at(-1));
    expect(zones.filter((zone) => zone.tabIndex === 0)).toHaveLength(1);
  });

  it("uses the existing EditCommand for roving Enter and lets Escape exit without closing", async () => {
    const onClose = await mountEdit();
    await click(chip("t数学"));
    let zones = [...document.querySelectorAll<HTMLElement>(".cmux-tab-grouping-editmap [data-drop-id]")];
    zones[0].focus();
    await act(async () => zones[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
    await act(async () => zones[1].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
    const chosen = zones[2];
    const dropId = chosen.dataset.dropId;
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => chosen.dispatchEvent(escape));
    await settle();
    expect(onClose).not.toHaveBeenCalled();
    expect(chip("t数学").getAttribute("aria-pressed")).toBe("true");
    chosen.focus();
    editHarness.commands = [];
    await act(async () => chosen.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    await settle();
    const keyboardCommand = structuredClone(editHarness.commands[0]);
    expect(keyboardCommand).toBeDefined();

    if (root) await act(async () => root?.unmount());
    root = null;
    resetStores();
    __resetGroupingPrecomputeForTests();
    localStorage.clear();
    editHarness.commands = [];
    await mountEdit();
    if (!dropId) throw new Error("roving drop id missing");
    await drag("t数学", dropId, 194);
    expect(editHarness.commands).toEqual([keyboardCommand]);
  });

  it("restores focus inside the panel after a successful drop", async () => {
    await mountEdit();
    const element = chip("t数学");
    element.focus();
    await drag("t数学", "g2:0:0", 195);
    const focused = document.activeElement as HTMLElement | null;
    expect(focused?.dataset.tabId).toBe("t数学");
    expect(document.querySelector(".cmux-tab-grouping")?.contains(focused)).toBe(true);
  });

  it("restores source focus after Escape and leaves Tab to OverlayShell", async () => {
    await mountEdit();
    const element = chip("t数学");
    element.focus();
    stubElementFromPoint(dropTarget("g2:0:0"));
    await act(async () => element.dispatchEvent(pointer("pointerdown", 196, 10, 10)));
    await act(async () => window.dispatchEvent(pointer("pointermove", 196, 20, 10)));
    await flushAnimationFrames();
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    await settle();
    expect(document.activeElement).toBe(chip("t数学"));
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    await act(async () => document.activeElement?.dispatchEvent(tab));
    expect(tab.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(chip("t数学"));
    const expectedNext = chip("t請求");
    const dialog = document.querySelector<HTMLElement>('.cmux-overlay-panel[role="dialog"]');
    if (!dialog) throw new Error("dialog not found");
    const focusable = [...dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter((candidate) => !candidate.closest("[inert], [hidden]"));
    expect(focusable[focusable.indexOf(chip("t数学")) + 1]).toBe(expectedNext);
    expectedNext.focus();
    expect(document.activeElement).toBe(expectedNext);
    expect(document.activeElement).not.toBe(button(tabGroupingStrings.close));
    expect(document.querySelector(".cmux-tab-grouping")?.contains(document.activeElement)).toBe(true);
  });

  it("prevents contextmenu only inside the open panel", async () => {
    await mountEdit();
    const panel = document.querySelector<HTMLElement>(".cmux-tab-grouping");
    if (!panel) throw new Error("panel not found");
    const inside = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    await act(async () => panel.dispatchEvent(inside));
    expect(inside.defaultPrevented).toBe(true);
    const outside = document.createElement("div");
    document.body.append(outside);
    const outsideEvent = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    outside.dispatchEvent(outsideEvent);
    expect(outsideEvent.defaultPrevented).toBe(false);
  });
});
