// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { tabGroupingStrings } from "../../src/components/dashboard/dashboardStrings";
import {
  groupingDropIdForTarget,
  type GroupingDragCancelReason,
} from "../../src/components/layout/groupingDrag";
import { paneRefKey, type GroupingEditTarget } from "../../src/components/layout/groupingEdit";
import type { GroupingPlan } from "../../src/components/layout/tabGrouping";
import { useGroupingDrag } from "../../src/hooks/useGroupingDrag";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const sameTarget = { kind: "pane", groupId: "g1", columnIndex: 0, paneIndex: 0 } as const;
const otherTarget = { kind: "pane", groupId: "g2", columnIndex: 0, paneIndex: 0 } as const;
const sameDropId = paneRefKey(sameTarget);
const otherDropId = paneRefKey(otherTarget);

function makePlan(): GroupingPlan {
  return {
    planId: "plan",
    title: "plan",
    rationale: "test",
    strategy: "project",
    groups: [
      {
        groupId: "g1",
        title: "one",
        disposition: "reorganize",
        destination: { kind: "new_workspace", proposedName: "one" },
        layout: { columns: [{ panes: [{ title: "one", role: "mother", tabIds: ["a"] }] }] },
        tabIds: ["a"],
        adopted: true,
      },
      {
        groupId: "g2",
        title: "two",
        disposition: "reorganize",
        destination: { kind: "new_workspace", proposedName: "two" },
        layout: { columns: [{ panes: [{ title: "two", role: "worker", tabIds: ["b"] }] }] },
        tabIds: ["b"],
        adopted: true,
      },
    ],
    unassignedTabIds: [],
    warnings: [],
  };
}

interface HarnessConfig {
  readonly enabled: boolean;
  readonly mode: "compare" | "edit";
  readonly plan: GroupingPlan;
  readonly revisionToken: object;
  readonly layoutRevision: string;
  readonly validDropIds: ReadonlySet<string>;
  readonly targetsByDropId: ReadonlyMap<string, GroupingEditTarget>;
  readonly throwOnCancel?: boolean;
}

const effects = {
  applyEditCommand: vi.fn(),
  toggle: vi.fn(),
  reasons: [] as GroupingDragCancelReason[],
};

function cancelMessage(reason: GroupingDragCancelReason): string {
  if (reason === "noop") return tabGroupingStrings.dragNoopAnnounce;
  if (reason === "target-gone" || reason === "stale-selection") {
    return tabGroupingStrings.dragTargetGoneAnnounce;
  }
  return tabGroupingStrings.dragCancelAnnounce;
}

function Harness({ config }: { readonly config: HarnessConfig }) {
  const [announcement, setAnnouncement] = useState("");
  const { onTabPointerDown, ghost } = useGroupingDrag({
    enabled: config.enabled,
    mode: config.mode,
    plan: config.plan,
    selectedTabIds: new Set(["a"]),
    validDropIds: config.validDropIds,
    targetsByDropId: config.targetsByDropId,
    dropNames: new Map([[sameDropId, "one"], [otherDropId, "two"]]),
    tabLabels: new Map([["a", "A"]]),
    revisionToken: config.revisionToken,
    layoutRevision: config.layoutRevision,
    onToggleTab: effects.toggle,
    onMove: (tabIds, target, announce) => effects.applyEditCommand(tabIds, target, announce),
    onCancel: (reason, announce) => {
      effects.reasons.push(reason);
      if (config.throwOnCancel) throw new Error("cancel callback failed");
      if (announce) setAnnouncement(cancelMessage(reason));
    },
  });
  return (
    <div className="cmux-tab-grouping" data-cmux-overlay-root>
      <div className="cmux-tab-grouping-body">
        <div className="outer-scroll-probe">
          <div className="cmux-tab-grouping-editmap">
            <button
              type="button"
              className="cmux-tab-grouping-chip"
              data-tab-id="a"
              onPointerDown={(event) => onTabPointerDown(event, "a")}
            >A</button>
            {[...config.validDropIds].map((dropId) => (
              <button type="button" key={dropId} data-drop-id={dropId}>{dropId}</button>
            ))}
            {ghost}
          </div>
        </div>
      </div>
      <div role="status" aria-live="polite">{announcement}</div>
    </div>
  );
}

let root: Root | null = null;
let config: HarnessConfig;
let frameId = 1;
let frameQueue = new Map<number, FrameRequestCallback>();
let hitElements: Element[] = [];
let capture = false;
let releasePointerCapture: ReturnType<typeof vi.fn>;
let sourceClassName = "";
let nodeCount = 0;
let timerCountAtDragStart = 0;
let windowListenerStart = 0;
let documentListenerStart = 0;
let windowTimerStart = 0;
let bodyCursorAtDragStart = "";
let windowAddListenerSpy: ReturnType<typeof vi.spyOn>;
let windowRemoveListenerSpy: ReturnType<typeof vi.spyOn>;
let documentAddListenerSpy: ReturnType<typeof vi.spyOn>;
let documentRemoveListenerSpy: ReturnType<typeof vi.spyOn>;
let windowSetTimeoutSpy: ReturnType<typeof vi.spyOn>;
let windowClearTimeoutSpy: ReturnType<typeof vi.spyOn>;
let sourceAddListenerSpy: ReturnType<typeof vi.spyOn> | null = null;
let sourceRemoveListenerSpy: ReturnType<typeof vi.spyOn> | null = null;

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

function source(): HTMLButtonElement {
  const element = document.querySelector<HTMLButtonElement>('[data-tab-id="a"]');
  if (!element) throw new Error("drag source not found");
  return element;
}

function drop(dropId: string): HTMLElement {
  const element = [...document.querySelectorAll<HTMLElement>("[data-drop-id]")]
    .find((candidate) => candidate.dataset.dropId === dropId);
  if (!element) throw new Error(`drop target not found: ${dropId}`);
  return element;
}

function stubElementFromPoint(...elements: Element[]): void {
  hitElements = elements;
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function flushFrame(): Promise<void> {
  const callbacks = [...frameQueue.values()];
  frameQueue.clear();
  await act(async () => callbacks.forEach((callback) => callback(performance.now())));
  await settle();
}

async function render(next: HarnessConfig = config): Promise<void> {
  config = next;
  await act(async () => root?.render(<Harness config={config} />));
  await settle();
}

function installCaptureSpies(element: HTMLElement): void {
  sourceAddListenerSpy?.mockRestore();
  sourceRemoveListenerSpy?.mockRestore();
  sourceAddListenerSpy = vi.spyOn(element, "addEventListener");
  sourceRemoveListenerSpy = vi.spyOn(element, "removeEventListener");
  capture = false;
  releasePointerCapture = vi.fn(() => { capture = false; });
  Object.defineProperties(element, {
    setPointerCapture: { configurable: true, value: vi.fn(() => { capture = true; }) },
    releasePointerCapture: { configurable: true, value: releasePointerCapture },
    hasPointerCapture: { configurable: true, value: vi.fn(() => capture) },
  });
}

async function beginDrag(dropId = otherDropId, pointerId = 7): Promise<HTMLElement> {
  const element = source();
  installCaptureSpies(element);
  sourceClassName = element.className;
  nodeCount = document.querySelector(".cmux-tab-grouping")?.querySelectorAll("*").length ?? 0;
  timerCountAtDragStart = vi.getTimerCount();
  windowListenerStart = windowAddListenerSpy.mock.calls.length;
  documentListenerStart = documentAddListenerSpy.mock.calls.length;
  windowTimerStart = windowSetTimeoutSpy.mock.calls.length;
  bodyCursorAtDragStart = document.body.style.cursor;
  const destination = drop(dropId);
  stubElementFromPoint(destination);
  await act(async () => element.dispatchEvent(pointer("pointerdown", pointerId, 10, 10)));
  await act(async () => window.dispatchEvent(pointer("pointermove", pointerId, 17, 10)));
  await flushFrame();
  expect(document.querySelectorAll(".cmux-tab-grouping-ghost")).toHaveLength(1);
  expect(document.documentElement.dataset.cmuxGroupingDrag).toBe("1");
  return destination;
}

async function release(dropId = otherDropId, pointerId = 7): Promise<void> {
  stubElementFromPoint(drop(dropId));
  await act(async () => window.dispatchEvent(pointer("pointerup", pointerId, 17, 10)));
  await settle();
  expect(document.documentElement.dataset.cmuxGroupingDrag).toBeUndefined();
}

function captureOption(options: unknown): boolean {
  return options === true
    || (typeof options === "object" && options !== null && "capture" in options
      && (options as { capture?: boolean }).capture === true);
}

function expectListenerCleanup(): void {
  const trackedTypes = new Set([
    "pointermove", "pointerup", "pointercancel", "keydown", "blur", "resize", "scroll", "pointerdown", "contextmenu", "wheel",
  ]);
  const added = windowAddListenerSpy.mock.calls.slice(windowListenerStart)
    .filter(([type]) => trackedTypes.has(String(type)));
  expect(added).toHaveLength(10);
  for (const [type, listener, options] of added) {
    expect(windowRemoveListenerSpy.mock.calls.some(([removedType, removedListener, removedOptions]) => (
      removedType === type && removedListener === listener && captureOption(removedOptions) === captureOption(options)
    ))).toBe(true);
  }
  const visibilityListeners = documentAddListenerSpy.mock.calls.slice(documentListenerStart)
    .filter(([type]) => type === "visibilitychange");
  expect(visibilityListeners).toHaveLength(1);
  const visibilityListener = visibilityListeners[0]?.[1];
  expect(documentRemoveListenerSpy.mock.calls.some(([type, listener, options]) => (
    type === "visibilitychange" && listener === visibilityListener && captureOption(options) === false
  ))).toBe(true);
  const lostListener = sourceAddListenerSpy?.mock.calls
    .find(([type]) => type === "lostpointercapture")?.[1];
  expect(lostListener).toBeDefined();
  expect(sourceRemoveListenerSpy?.mock.calls.some(([type, listener]) => (
    type === "lostpointercapture" && listener === lostListener
  ))).toBe(true);
}

async function expectDragFullyReset(
  expectedReason: GroupingDragCancelReason,
  expectedMessage: string,
  pointerId = 7,
): Promise<void> {
  const element = source();
  expect(effects.reasons).toEqual([expectedReason]);
  expect(document.querySelectorAll('[data-cmux-overlay-root] .cmux-tab-grouping-ghost')).toHaveLength(0);
  expect(element.className).toBe(sourceClassName);
  expect([
    element.style.height,
    element.style.width,
    element.style.display,
    element.style.margin,
    element.style.padding,
  ]).toEqual(["", "", "", "", ""]);
  expect(document.querySelectorAll(".is-dragging")).toHaveLength(0);
  expect(releasePointerCapture.mock.calls.length > 0 || capture === false).toBe(true);
  expect(document.querySelectorAll(".is-drop-active")).toHaveLength(0);
  expect(document.querySelectorAll(".cmux-tab-grouping.is-drag-active")).toHaveLength(0);
  expect(document.documentElement.dataset.cmuxGroupingDrag).toBeUndefined();
  expect(document.body.style.cursor).toBe(bodyCursorAtDragStart);
  expect(effects.applyEditCommand).not.toHaveBeenCalled();
  expect(document.querySelector('[role="status"][aria-live="polite"]')?.textContent).toBe(expectedMessage);
  expectListenerCleanup();
  expect(frameQueue.size).toBe(0);
  const timeoutCalls = windowSetTimeoutSpy.mock.calls.slice(windowTimerStart);
  const jsdomFocusTimers = timeoutCalls.filter(([callback]) => String(callback).includes('fireAnEvent("selectionchange"'));
  const dragTimers = timeoutCalls.filter(([callback]) => !String(callback).includes('fireAnEvent("selectionchange"'));
  expect(jsdomFocusTimers).toHaveLength(1);
  expect(dragTimers.length).toBeLessThanOrEqual(1);
  expect(dragTimers.every(([callback, delay]) => delay === 0 && String(callback).includes("lost-capture"))).toBe(true);
  expect(vi.getTimerCount()).toBe(timerCountAtDragStart + 1);
  await act(async () => window.dispatchEvent(pointer("pointerup", pointerId, 17, 10)));
  expect(effects.applyEditCommand).not.toHaveBeenCalled();
  expect(effects.reasons).toEqual([expectedReason]);
}

beforeEach(async () => {
  vi.useFakeTimers();
  effects.applyEditCommand.mockReset();
  effects.toggle.mockReset();
  effects.reasons = [];
  frameId = 1;
  frameQueue = new Map();
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    const id = frameId++;
    frameQueue.set(id, callback);
    return id;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => frameQueue.delete(id)));
  Object.defineProperty(document, "elementsFromPoint", {
    configurable: true,
    value: vi.fn(() => [...hitElements]),
  });
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: vi.fn(() => hitElements[0] ?? null),
  });
  const revisionToken = {};
  config = {
    enabled: true,
    mode: "edit",
    plan: makePlan(),
    revisionToken,
    layoutRevision: "layout-1",
    validDropIds: new Set([sameDropId, otherDropId]),
    targetsByDropId: new Map([[sameDropId, sameTarget], [otherDropId, otherTarget]]),
  };
  const container = document.createElement("div");
  document.body.replaceChildren(container);
  windowAddListenerSpy = vi.spyOn(window, "addEventListener");
  windowRemoveListenerSpy = vi.spyOn(window, "removeEventListener");
  documentAddListenerSpy = vi.spyOn(document, "addEventListener");
  documentRemoveListenerSpy = vi.spyOn(document, "removeEventListener");
  windowSetTimeoutSpy = vi.spyOn(window, "setTimeout");
  windowClearTimeoutSpy = vi.spyOn(window, "clearTimeout");
  root = createRoot(container);
  await render();
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
  delete document.documentElement.dataset.cmuxGroupingDrag;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useGroupingDrag cancellation paths", () => {
  it("resets all invariants after release over an invalid area", async () => {
    await beginDrag();
    stubElementFromPoint(document.body);
    await act(async () => window.dispatchEvent(pointer("pointerup", 7, 17, 10)));
    await expectDragFullyReset("target-gone", tabGroupingStrings.dragTargetGoneAnnounce);
  });

  it("resets all invariants after pointercancel", async () => {
    await beginDrag();
    await act(async () => window.dispatchEvent(pointer("pointercancel", 7, 17, 10)));
    await expectDragFullyReset("pointercancel", tabGroupingStrings.dragCancelAnnounce);
  });

  it("resets all invariants after delayed lostpointercapture", async () => {
    await beginDrag();
    await act(async () => source().dispatchEvent(new Event("lostpointercapture")));
    await act(async () => vi.advanceTimersByTime(0));
    await expectDragFullyReset("lost-capture", tabGroupingStrings.dragCancelAnnounce);
  });

  it("resets all invariants after Escape without closing the panel", async () => {
    const onClose = vi.fn();
    await beginDrag();
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => window.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    await expectDragFullyReset("escape", tabGroupingStrings.dragCancelAnnounce);
  });

  it("resets all invariants after window blur", async () => {
    await beginDrag();
    await act(async () => window.dispatchEvent(new Event("blur")));
    await expectDragFullyReset("blur", tabGroupingStrings.dragCancelAnnounce);
  });

  it("ignores visible visibilitychange and resets all invariants when the document becomes hidden", async () => {
    let visibilityState: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibilityState);
    await beginDrag();
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(document.querySelectorAll(".cmux-tab-grouping-ghost")).toHaveLength(1);
    expect(effects.reasons).toEqual([]);
    visibilityState = "hidden";
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await expectDragFullyReset("blur", tabGroupingStrings.dragCancelAnnounce);
  });

  it("resets all invariants after resize", async () => {
    await beginDrag();
    await act(async () => window.dispatchEvent(new Event("resize")));
    await expectDragFullyReset("resize", tabGroupingStrings.dragCancelAnnounce);
  });

  it("resets all invariants when the drop target disappears", async () => {
    const destination = await beginDrag();
    destination.remove();
    stubElementFromPoint(destination);
    await act(async () => window.dispatchEvent(pointer("pointerup", 7, 17, 10)));
    await expectDragFullyReset("target-gone", tabGroupingStrings.dragTargetGoneAnnounce);
  });

  it("resets all invariants when the panel closes", async () => {
    await beginDrag();
    await render({ ...config, enabled: false });
    await expectDragFullyReset("unmount", tabGroupingStrings.dragCancelAnnounce);
  });

  it("cleans every drag artifact on unmount even when onCancel throws", async () => {
    await render({ ...config, throwOnCancel: true });
    await beginDrag();
    const element = source();
    let thrown: unknown;
    try {
      await act(async () => root?.unmount());
    } catch (error) {
      thrown = error;
    } finally {
      root = null;
    }
    expect(String(thrown)).toContain("cancel callback failed");
    expect(element.classList.contains("is-dragging")).toBe(false);
    expect(document.body.style.cursor).toBe(bodyCursorAtDragStart);
    expect(releasePointerCapture.mock.calls.length > 0 || capture === false).toBe(true);
    expect(frameQueue.size).toBe(0);
    expect(document.documentElement.dataset.cmuxGroupingDrag).toBeUndefined();
    expectListenerCleanup();
  });

  it("resets all invariants when the mode changes", async () => {
    await beginDrag();
    await render({ ...config, enabled: false, mode: "compare" });
    expect(effects.reasons).toEqual(["mode-changed"]);
    await expectDragFullyReset("mode-changed", tabGroupingStrings.dragCancelAnnounce);
  });

  it("resets all invariants after a secondary pointerdown", async () => {
    await beginDrag();
    const event = pointer("pointerdown", 9, 17, 10, { button: 2 });
    await act(async () => window.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    await expectDragFullyReset("secondary-button", tabGroupingStrings.dragCancelAnnounce);
  });

  it("resets all invariants after contextmenu", async () => {
    await beginDrag();
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    await act(async () => window.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    await expectDragFullyReset("secondary-button", tabGroupingStrings.dragCancelAnnounce);
  });

  it("resets all invariants and announces a same-destination no-op", async () => {
    await beginDrag(sameDropId);
    await release(sameDropId);
    expect(effects.reasons).toEqual(["noop"]);
    await expectDragFullyReset("noop", tabGroupingStrings.dragNoopAnnounce);
  });

  it("resets all invariants when the moving selection is stale", async () => {
    await beginDrag();
    config.plan.groups[0].layout?.columns[0]?.panes[0]?.tabIds.splice(0);
    await render({ ...config });
    await release(otherDropId);
    expect(effects.reasons).toEqual(["stale-selection"]);
    await expectDragFullyReset("stale-selection", tabGroupingStrings.dragTargetGoneAnnounce);
  });

  it("resets all invariants when a present element is not a valid target", async () => {
    await beginDrag();
    const invalid = document.createElement("button");
    invalid.dataset.dropId = "invalid";
    document.querySelector(".cmux-tab-grouping-editmap")?.append(invalid);
    stubElementFromPoint(invalid);
    await act(async () => window.dispatchEvent(pointer("pointerup", 7, 17, 10)));
    invalid.remove();
    await expectDragFullyReset("target-gone", tabGroupingStrings.dragTargetGoneAnnounce);
  });
});

describe("useGroupingDrag ordering and WebView2 contracts", () => {
  it("keeps the six-pixel gesture a click and starts a drop at seven CSS pixels", async () => {
    const element = source();
    installCaptureSpies(element);
    stubElementFromPoint(drop(otherDropId));
    await act(async () => element.dispatchEvent(pointer("pointerdown", 20, 10, 10)));
    await act(async () => window.dispatchEvent(pointer("pointermove", 20, 16, 10)));
    await flushFrame();
    await act(async () => window.dispatchEvent(pointer("pointerup", 20, 16, 10)));
    expect(effects.toggle).toHaveBeenCalledWith("a");
    expect(effects.applyEditCommand).not.toHaveBeenCalled();
    expect(document.querySelector('[role="status"]')?.textContent).toBe("");

    effects.toggle.mockReset();
    await beginDrag(otherDropId, 21);
    await release(otherDropId, 21);
    expect(effects.applyEditCommand).toHaveBeenCalledTimes(1);
    expect(effects.toggle).not.toHaveBeenCalled();
  });

  it("rehit-tests on scroll without cancelling and then drops", async () => {
    const first = await beginDrag(sameDropId);
    const second = drop(otherDropId);
    expect(first.classList.contains("is-drop-active")).toBe(true);
    stubElementFromPoint(second);
    await act(async () => document.querySelector(".cmux-tab-grouping-editmap")?.dispatchEvent(new Event("scroll")));
    await flushFrame();
    expect(document.querySelectorAll(".cmux-tab-grouping-ghost")).toHaveLength(1);
    expect(first.classList.contains("is-drop-active")).toBe(false);
    expect(second.classList.contains("is-drop-active")).toBe(true);
    expect(document.querySelector('[role="status"]')?.textContent).toBe("");
    await release(otherDropId);
    expect(effects.applyEditCommand).toHaveBeenCalledTimes(1);
  });

  it("lets pointerup win when lostpointercapture arrives first in the same task", async () => {
    await beginDrag();
    const clearCount = windowClearTimeoutSpy.mock.calls.length;
    await act(async () => {
      source().dispatchEvent(new Event("lostpointercapture"));
      window.dispatchEvent(pointer("pointerup", 7, 17, 10));
    });
    expect(windowClearTimeoutSpy.mock.calls.length).toBe(clearCount + 1);
    await act(async () => vi.advanceTimersByTime(0));
    expect(effects.applyEditCommand).toHaveBeenCalledTimes(1);
    expect(effects.reasons).toEqual([]);
  });

  it("does not double-issue when lostpointercapture follows pointerup", async () => {
    await beginDrag();
    await act(async () => {
      window.dispatchEvent(pointer("pointerup", 7, 17, 10));
      source().dispatchEvent(new Event("lostpointercapture"));
    });
    await act(async () => vi.advanceTimersByTime(0));
    expect(effects.applyEditCommand).toHaveBeenCalledTimes(1);
    expect(effects.reasons).toEqual([]);
  });

  it("passes CSS client coordinates to hit testing at every devicePixelRatio", async () => {
    const original = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
    Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: undefined });
    const elementFromPoint = vi.fn(() => drop(otherDropId));
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: elementFromPoint });
    for (const ratio of [1, 1.25, 1.5]) {
      Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: ratio });
      await beginDrag(otherDropId, 30 + ratio * 4);
      expect(elementFromPoint).toHaveBeenLastCalledWith(17, 10);
      await release(otherDropId, 30 + ratio * 4);
    }
    if (original) Object.defineProperty(window, "devicePixelRatio", original);
  });

  it("does not depend on pointerleave, pointerout, or mouseleave", async () => {
    await beginDrag();
    await act(async () => {
      source().dispatchEvent(new Event("pointerleave", { bubbles: true }));
      source().dispatchEvent(new Event("pointerout", { bubbles: true }));
      source().dispatchEvent(new Event("mouseleave", { bubbles: true }));
    });
    expect(document.querySelectorAll(".cmux-tab-grouping-ghost")).toHaveLength(1);
    await release();
    expect(effects.applyEditCommand).toHaveBeenCalledTimes(1);
  });

  it("cancels immediately when revisionToken changes", async () => {
    await beginDrag();
    await render({ ...config, revisionToken: {} });
    await expectDragFullyReset("revision-changed", tabGroupingStrings.dragCancelAnnounce);
  });

  it("cancels immediately when layoutRevision changes", async () => {
    await beginDrag();
    await render({ ...config, layoutRevision: "layout-2" });
    await expectDragFullyReset("layout-changed", tabGroupingStrings.dragCancelAnnounce);
  });

  it("uses the same DOM-presence result without CSS.escape", async () => {
    const groupId = 'odd"[]\nname';
    const target = { kind: "group", groupId } as const;
    const dropId = groupingDropIdForTarget(target);
    config.plan.groups.push({
      groupId,
      title: "odd",
      disposition: "reorganize",
      destination: { kind: "new_workspace", proposedName: "odd" },
      layout: { columns: [{ panes: [{ title: "odd", role: "worker", tabIds: ["z"] }] }] },
      tabIds: ["z"],
      adopted: true,
    });
    await render({
      ...config,
      validDropIds: new Set([...config.validDropIds, dropId]),
      targetsByDropId: new Map([...config.targetsByDropId, [dropId, target]]),
    });
    const css = globalThis.CSS ?? ({} as typeof CSS);
    const escape = (value: string): string => value
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"')
      .replaceAll("\n", "\\a ");
    vi.stubGlobal("CSS", { ...css, escape });
    await beginDrag(dropId, 80);
    await release(dropId, 80);
    expect(effects.applyEditCommand).toHaveBeenCalledTimes(1);
    vi.stubGlobal("CSS", { ...css, escape: undefined });
    await beginDrag(dropId, 81);
    await release(dropId, 81);
    expect(effects.applyEditCommand).toHaveBeenCalledTimes(2);
  });

  it("cancels on Tab without preventing the focus trap event", async () => {
    await beginDrag();
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    await act(async () => window.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(effects.reasons).toEqual(["focus-moved"]);
    await expectDragFullyReset("focus-moved", tabGroupingStrings.dragCancelAnnounce);
  });

  it("blocks background shortcuts while dragging without cancelling the drag", async () => {
    const downstream = vi.fn();
    window.addEventListener("keydown", downstream);
    try {
      await beginDrag();
      const event = new KeyboardEvent("keydown", {
        key: "G",
        code: "KeyG",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      await act(async () => window.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(true);
      expect(downstream).not.toHaveBeenCalled();
      expect(document.querySelectorAll(".cmux-tab-grouping-ghost")).toHaveLength(1);
      expect(effects.reasons).toEqual([]);
      await act(async () => window.dispatchEvent(pointer("pointercancel", 7, 17, 10)));
      await expectDragFullyReset("pointercancel", tabGroupingStrings.dragCancelAnnounce);
    } finally {
      window.removeEventListener("keydown", downstream);
    }
  });

  it("blocks Ctrl+wheel while dragging and lets ordinary wheel continue", async () => {
    const downstream = vi.fn();
    window.addEventListener("wheel", downstream);
    try {
      await beginDrag();
      const ctrlWheel = new WheelEvent("wheel", {
        ctrlKey: true,
        deltaY: 100,
        bubbles: true,
        cancelable: true,
      });
      await act(async () => window.dispatchEvent(ctrlWheel));
      expect(ctrlWheel.defaultPrevented).toBe(true);
      expect(downstream).not.toHaveBeenCalled();

      const ordinaryWheel = new WheelEvent("wheel", {
        deltaY: 100,
        bubbles: true,
        cancelable: true,
      });
      await act(async () => window.dispatchEvent(ordinaryWheel));
      expect(ordinaryWheel.defaultPrevented).toBe(false);
      expect(downstream).toHaveBeenCalledTimes(1);
      expect(document.querySelectorAll(".cmux-tab-grouping-ghost")).toHaveLength(1);
      await act(async () => window.dispatchEvent(pointer("pointercancel", 7, 17, 10)));
      await expectDragFullyReset("pointercancel", tabGroupingStrings.dragCancelAnnounce);
    } finally {
      window.removeEventListener("wheel", downstream);
    }
  });

  it("restores focus and toggles the drag-active class without leaking nodes", async () => {
    source().focus();
    await beginDrag();
    expect(document.querySelectorAll(".cmux-tab-grouping.is-drag-active")).toHaveLength(1);
    await release();
    expect(document.activeElement).toBe(source());
    expect(document.querySelectorAll(".cmux-tab-grouping.is-drag-active")).toHaveLength(0);
    expect(document.querySelector(".cmux-tab-grouping")?.querySelectorAll("*").length).toBe(nodeCount);
  });

  it("auto-scrolls only the edit map and stops its shared frame on cancel", async () => {
    const editmap = document.querySelector<HTMLElement>(".cmux-tab-grouping-editmap");
    const outer = document.querySelector<HTMLElement>(".outer-scroll-probe");
    if (!editmap) throw new Error("editmap not found");
    if (!outer) throw new Error("outer scroll probe not found");
    Object.defineProperties(editmap, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 400 },
      scrollLeft: { configurable: true, writable: true, value: 19 },
      scrollTop: { configurable: true, writable: true, value: 0 },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100, x: 0, y: 0, toJSON: () => ({}) }),
      },
    });
    Object.defineProperties(outer, {
      clientHeight: { configurable: true, value: 80 },
      scrollHeight: { configurable: true, value: 500 },
      scrollLeft: { configurable: true, writable: true, value: 29 },
      scrollTop: { configurable: true, writable: true, value: 31 },
    });
    const matchMedia = vi.fn(() => ({ matches: false }));
    vi.stubGlobal("matchMedia", matchMedia);
    await beginDrag(otherDropId, 70);
    expect(matchMedia).toHaveBeenCalledTimes(1);
    expect(matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
    await act(async () => window.dispatchEvent(pointer("pointermove", 70, 20, 95)));
    await flushFrame();
    const firstScrollTop = editmap.scrollTop;
    await flushFrame();
    expect(firstScrollTop).toBeGreaterThan(0);
    expect(editmap.scrollTop).toBeGreaterThan(firstScrollTop);
    expect(editmap.scrollLeft).toBe(19);
    expect(outer.scrollTop).toBe(31);
    expect(outer.scrollLeft).toBe(29);
    expect(frameQueue.size).toBe(1);
    const stoppedTop = editmap.scrollTop;
    await act(async () => window.dispatchEvent(pointer("pointercancel", 70, 20, 95)));
    expect(frameQueue.size).toBe(0);
    await flushFrame();
    expect(editmap.scrollTop).toBe(stoppedTop);
    await act(async () => window.dispatchEvent(new Event("scroll")));
    await flushFrame();
    expect(editmap.scrollTop).toBe(stoppedTop);
    await expectDragFullyReset("pointercancel", tabGroupingStrings.dragCancelAnnounce, 70);
  });

  it("queries reduced motion once per drag and disables auto-scroll", async () => {
    const editmap = document.querySelector<HTMLElement>(".cmux-tab-grouping-editmap");
    const outer = document.querySelector<HTMLElement>(".outer-scroll-probe");
    if (!editmap) throw new Error("editmap not found");
    if (!outer) throw new Error("outer scroll probe not found");
    Object.defineProperties(editmap, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 400 },
      scrollLeft: { configurable: true, writable: true, value: 19 },
      scrollTop: { configurable: true, writable: true, value: 0 },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100, x: 0, y: 0, toJSON: () => ({}) }),
      },
    });
    Object.defineProperties(outer, {
      scrollLeft: { configurable: true, writable: true, value: 29 },
      scrollTop: { configurable: true, writable: true, value: 31 },
    });
    const matchMedia = vi.fn(() => ({ matches: true }));
    vi.stubGlobal("matchMedia", matchMedia);
    await beginDrag(otherDropId, 71);
    expect(matchMedia).toHaveBeenCalledTimes(1);
    expect(matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
    await act(async () => window.dispatchEvent(pointer("pointermove", 71, 20, 95)));
    await flushFrame();
    await flushFrame();
    expect(editmap.scrollTop).toBe(0);
    expect(editmap.scrollLeft).toBe(19);
    expect(outer.scrollTop).toBe(31);
    expect(outer.scrollLeft).toBe(29);
    await act(async () => window.dispatchEvent(pointer("pointercancel", 71, 20, 95)));
    await expectDragFullyReset("pointercancel", tabGroupingStrings.dragCancelAnnounce, 71);
  });
});
