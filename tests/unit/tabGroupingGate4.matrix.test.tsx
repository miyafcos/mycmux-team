// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const analysisHarness = vi.hoisted(() => ({ value: null as unknown }));
const boundaryHarness = vi.hoisted(() => ({
  previews: [] as unknown[],
  prepared: [] as unknown[],
  committed: [] as unknown[],
  undone: [] as unknown[],
}));
const editHarness = vi.hoisted(() => ({ commands: [] as unknown[], sessions: [] as unknown[] }));
const tauriHarness = vi.hoisted(() => ({
  invoke: vi.fn(async () => true),
  getVersion: vi.fn(async () => "0.0.0-test"),
  relaunch: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriHarness.invoke }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: tauriHarness.getVersion }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: tauriHarness.relaunch }));

vi.mock("../../src/components/layout/tabGrouping", async (importActual) => {
  const actual = await importActual<typeof import("../../src/components/layout/tabGrouping")>();
  return {
    ...actual,
    runGroupingAnalysis: vi.fn(async () => analysisHarness.value),
  };
});

// Observation-only wrapper: every call and return value still comes from the real facade.
vi.mock("../../src/components/layout/groupingBoundary", async (importActual) => {
  const actual = await importActual<typeof import("../../src/components/layout/groupingBoundary")>();
  return {
    ...actual,
    groupingBoundary: {
      ...actual.groupingBoundary,
      preview: (...args: Parameters<typeof actual.groupingBoundary.preview>) => {
        const result = actual.groupingBoundary.preview(...args);
        boundaryHarness.previews.push({ args, result });
        return result;
      },
      prepare: (...args: Parameters<typeof actual.groupingBoundary.prepare>) => {
        const applyDisabled = [...document.querySelectorAll<HTMLButtonElement>("button")]
          .find((candidate) => candidate.textContent?.trim() === tabGroupingStrings.apply)?.disabled ?? null;
        const result = actual.groupingBoundary.prepare(...args);
        boundaryHarness.prepared.push({ applyDisabled, args, result });
        return result;
      },
      commit: (...args: Parameters<typeof actual.groupingBoundary.commit>) => {
        const result = actual.groupingBoundary.commit(...args);
        boundaryHarness.committed.push({ args, result });
        return result;
      },
      undo: (...args: Parameters<typeof actual.groupingBoundary.undo>) => {
        const result = actual.groupingBoundary.undo(...args);
        boundaryHarness.undone.push({ args, result });
        return result;
      },
    },
  };
});

// Observation-only wrapper: the production edit function computes every returned session.
vi.mock("../../src/components/layout/groupingEdit", async (importActual) => {
  const actual = await importActual<typeof import("../../src/components/layout/groupingEdit")>();
  return {
    ...actual,
    applyEditCommand: (...args: Parameters<typeof actual.applyEditCommand>) => {
      editHarness.commands.push(structuredClone(args[1]));
      const result = actual.applyEditCommand(...args);
      editHarness.sessions.push(result);
      return result;
    },
  };
});

import { OverlayShell } from "../../src/components/common/OverlayShell";
import { GroupingStatusBar } from "../../src/components/dashboard/GroupingStatusBar";
import { tabGroupingStrings } from "../../src/components/dashboard/dashboardStrings";
import { TabGroupingPanel } from "../../src/components/layout/TabGroupingPanel";
import { groupingBoundary } from "../../src/components/layout/groupingBoundary";
import {
  type GroupingDragCancelReason,
  groupingDropIdForTarget,
} from "../../src/components/layout/groupingDrag";
import { paneRefKey, type GroupingEditTarget } from "../../src/components/layout/groupingEdit";
import { groupingLineageNodes } from "../../src/components/layout/groupingLineage";
import {
  groupingLeadInPath,
  groupingMeasuredMoveLines,
  groupingMoveLinePath,
  groupingMoveLines,
  groupingSideBySideOrientation,
  type GroupingLinePoint,
  type GroupingLineRect,
  type MeasuredGroupingMoveLine,
} from "../../src/components/layout/groupingMoveLines";
import { buildGroups } from "../../src/lib/groupMembership";
import {
  attachGlobalFontZoom,
  resetFontZoomQueueForTests,
} from "../../src/components/terminal/terminalMouseInputFilter";
import {
  __resetPersistenceCoordinatorForTests,
  markPersistentSchemaSupported,
  registerPersistenceLeader,
  type PersistOutcome,
  type PersistRequest,
} from "../../src/lib/workspacePersistenceCoordinator";
import { persistentLayoutSignature } from "../../src/lib/persistentLayoutProjection";
import {
  __resetGroupingRuntimeForTests,
  endGroupingOperation,
  recordPersistentSchemaState,
  tryBeginGroupingOperation,
  useGroupingRuntimeStore,
} from "../../src/stores/groupingRuntimeStore";
import { useDashboardViewStore } from "../../src/stores/dashboardViewStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useSessionAttentionStore } from "../../src/stores/sessionAttentionStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { __resetGroupingPrecomputeForTests } from "../../src/lib/groupingPrecompute";
import { useThemeStore } from "../../src/stores/themeStore";
import { useGroupingDrag } from "../../src/hooks/useGroupingDrag";
import { runGroupingAnalysis, TAB_GROUPING_OPEN_EVENT } from "../../src/components/layout/tabGrouping";
import { mockGroupingAnalysis, mockGroupingPlans, mockWorkspaces } from "./fixtures/tabGroupingMockScenario";
import { hashCanonical, structuralUndoSignature } from "./helpers/groupingTestEntrypoint";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type PersistBehaviour = "saved" | "failed" | "hang" | "none";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let unregisterPersistence: (() => void) | null = null;
let persistBehaviour: PersistBehaviour = "saved";
let persistCalls: PersistRequest[] = [];
let frameId = 1;
let frameQueue = new Map<number, FrameRequestCallback>();
let resizeCallbacks: ResizeObserverCallback[] = [];
let hitElement: Element | null = null;
let pointerCaptured = false;
let measuredWidth = 1_000;
let detourGeometry = false;
let savedElementFromPoint: PropertyDescriptor | undefined;
let savedElementsFromPoint: PropertyDescriptor | undefined;
let savedPointerDescriptors: Record<string, PropertyDescriptor | undefined> = {};

function cloneWorkspaces() {
  return structuredClone(mockWorkspaces);
}

function domRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

function paneFrames(rect: GroupingLineRect): GroupingLineRect[] {
  return [
    { left: rect.left, top: rect.top, width: rect.width, height: 2 },
    { left: rect.left + rect.width - 2, top: rect.top, width: 2, height: rect.height },
    { left: rect.left, top: rect.top + rect.height - 2, width: rect.width, height: 2 },
    { left: rect.left, top: rect.top, width: 2, height: rect.height },
  ];
}

function rectsIntersect(left: GroupingLineRect, right: GroupingLineRect): boolean {
  return left.left < right.left + right.width
    && right.left < left.left + left.width
    && left.top < right.top + right.height
    && right.top < left.top + left.height;
}

function routeSegments(line: MeasuredGroupingMoveLine, orientation: "horizontal" | "vertical"):
Array<readonly [GroupingLinePoint, GroupingLinePoint]> {
  const points = line.routePoints;
  if (points && points.length >= 2) {
    return points.slice(1).map((point, index) => [points[index], point] as const);
  }
  const path = groupingMoveLinePath(line.fromRect!, line.toRect!, orientation);
  const values = path.match(/-?[\d.]+/g)?.map(Number) ?? [];
  if (values.length !== 8) throw new Error(`unexpected cubic path: ${path}`);
  const [x0, y0, x1, y1, x2, y2, x3, y3] = values;
  const samples = Array.from({ length: 65 }, (_, index) => {
    const t = index / 64;
    const inverse = 1 - t;
    return {
      x: inverse ** 3 * x0 + 3 * inverse ** 2 * t * x1 + 3 * inverse * t ** 2 * x2 + t ** 3 * x3,
      y: inverse ** 3 * y0 + 3 * inverse ** 2 * t * y1 + 3 * inverse * t ** 2 * y2 + t ** 3 * y3,
    };
  });
  return samples.slice(1).map((point, index) => [samples[index], point] as const);
}

function routeCrosses(line: MeasuredGroupingMoveLine, obstacles: readonly GroupingLineRect[], orientation: "horizontal" | "vertical"): boolean {
  const segments = routeSegments(line, orientation);
  if (line.leadIn) {
    const leadPath = groupingLeadInPath(line.leadIn, orientation);
    const values = leadPath.match(/-?[\d.]+/g)?.map(Number) ?? [];
    if (values.length === 4) segments.push([{ x: values[0], y: values[1] }, { x: values[2], y: values[3] }]);
  }
  return obstacles.some((obstacle) => segments.some(([from, to]) => rectsIntersect({
    left: Math.min(from.x, to.x) - 2,
    top: Math.min(from.y, to.y) - 2,
    width: Math.abs(to.x - from.x) + 4,
    height: Math.abs(to.y - from.y) + 4,
  }, obstacle)));
}

function orientedRect(
  primary: number,
  cross: number,
  primarySize: number,
  crossSize: number,
  orientation: "horizontal" | "vertical",
): GroupingLineRect {
  return orientation === "horizontal"
    ? { left: primary, top: cross, width: primarySize, height: crossSize }
    : { left: cross, top: primary, width: crossSize, height: primarySize };
}

function seededRandom(seed: number): () => number {
  let state = (0x71ab5eed ^ seed) >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function routeEndpoint(
  line: MeasuredGroupingMoveLine,
  orientation: "horizontal" | "vertical",
): GroupingLinePoint {
  const segments = routeSegments(line, orientation);
  if (line.leadIn) {
    const path = groupingLeadInPath(line.leadIn, orientation);
    const values = path.match(/-?[\d.]+/g)?.map(Number) ?? [];
    if (values.length !== 4) throw new Error(`unexpected lead-in path: ${path}`);
    segments.push([{ x: values[0], y: values[1] }, { x: values[2], y: values[3] }]);
  }
  const endpoint = segments.at(-1)?.[1];
  if (!endpoint) throw new Error("measured route has no endpoint");
  return endpoint;
}

function expectRouteReachesDestination(
  line: MeasuredGroupingMoveLine,
  target: GroupingLineRect,
  orientation: "horizontal" | "vertical",
): void {
  const endpoint = routeEndpoint(line, orientation);
  if (orientation === "horizontal") {
    expect(endpoint.y).toBeCloseTo(target.top + target.height / 2, 6);
    expect([target.left, target.left + target.width]).toContain(endpoint.x);
  } else {
    expect(endpoint.x).toBeCloseTo(target.left + target.width / 2, 6);
    expect([target.top, target.top + target.height]).toContain(endpoint.y);
  }
}

function resetStores(): void {
  __resetGroupingRuntimeForTests();
  __resetPersistenceCoordinatorForTests();
  markPersistentSchemaSupported(1);
  recordPersistentSchemaState({ loadedSchemaVersion: 1, migrationComplete: true });
  useWorkspaceListStore.setState({
    workspaces: cloneWorkspaces(),
    layoutRevision: 1,
    activeWorkspaceId: "wsA",
    lastActivePaneByWorkspace: { wsA: "session-t請求", wsB: "session-t統括", wsC: "session-t数学" },
  });
  useUiStore.setState({ activePaneId: "session-t請求", lastActivePaneId: "session-t請求", focusRevision: 0 });
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {} });
  useSessionAttentionStore.setState({ attentionBySession: {}, seenAttentionByTab: new Map() });
}

function savedOutcome(request: PersistRequest): PersistOutcome {
  return {
    status: "saved",
    requestId: request.requestId,
    savedRevision: request.revision,
    savedSignature: request.signature,
    savedDigest: request.snapshotDigest,
    leaderGeneration: request.leaderGeneration,
  };
}

function installPersistence(): void {
  if (persistBehaviour === "none") return;
  unregisterPersistence = registerPersistenceLeader({
    windowId: "main",
    persist: async (request) => {
      persistCalls.push(request);
      if (persistBehaviour === "hang") return new Promise<PersistOutcome>(() => {});
      if (persistBehaviour === "failed") {
        return {
          status: "failed",
          requestId: request.requestId,
          error: "gate4 persistence failure",
          retryScheduled: false,
          failureGeneration: 1,
        };
      }
      return savedOutcome(request);
    },
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function flushFrames(): Promise<void> {
  const callbacks = [...frameQueue.values()];
  frameQueue.clear();
  await act(async () => callbacks.forEach((callback) => callback(performance.now())));
  await settle();
}

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === label)
    ?? [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => candidate.textContent?.includes(label));
  if (!match) throw new Error(`button not found: ${label}`);
  return match;
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

async function mountPanel(onClose = vi.fn(), intent: "review" | null = null): Promise<ReturnType<typeof vi.fn>> {
  container = document.createElement("div");
  document.body.replaceChildren(container);
  root = createRoot(container);
  await act(async () => root?.render(<TabGroupingPanel open visible intent={intent} onClose={onClose} />));
  await settle();
  return onClose;
}

function latestPrepared() {
  const entry = boundaryHarness.prepared.at(-1) as { result: ReturnType<typeof groupingBoundary.prepare> } | undefined;
  if (!entry?.result.ok) throw new Error("expected a prepared Gate4 ticket");
  return entry.result.ticket;
}

function latestCommit() {
  const entry = boundaryHarness.committed.at(-1) as { result: ReturnType<typeof groupingBoundary.commit> } | undefined;
  if (!entry) throw new Error("expected a Gate4 commit result");
  return entry.result;
}

function panel(): HTMLElement {
  const match = document.querySelector<HTMLElement>("#tab-grouping-panel");
  if (!match) throw new Error("Gate4 panel is not mounted");
  return match;
}

function panelLiveText(): string {
  return panel().querySelector<HTMLElement>('[role="status"][aria-live="polite"]')?.textContent?.trim() ?? "";
}

function planCard(strategy: "project" | "role"): HTMLButtonElement {
  const match = panel().querySelector<HTMLButtonElement>(
    `button.cmux-tab-grouping-card[role="radio"][data-strategy="${strategy}"]`,
  );
  if (!match) throw new Error(`plan card not found: ${strategy}`);
  return match;
}

function latestPreviewPlanHash(): string {
  const entry = boundaryHarness.previews.at(-1) as { args: [unknown, ...unknown[]] } | undefined;
  if (!entry) throw new Error("expected a Gate4 preview result");
  return hashCanonical(entry.args[0]);
}

function expectInvalidationFailure(reason: string, rawReason?: string): void {
  const error = panel().querySelector<HTMLElement>(
    ".cmux-tab-grouping-body.is-confirm .cmux-tab-grouping-error",
  );
  expect(error).not.toBeNull();
  const lines = [...(error?.children ?? [])].map((item) => item.textContent?.trim());
  expect(lines).toEqual([tabGroupingStrings.ticketInvalidated, reason]);
  const footer = panel().querySelector<HTMLElement>(".cmux-tab-grouping-footer")?.textContent ?? "";
  expect(footer).not.toContain(reason);
  if (rawReason) {
    expect(panel().textContent).not.toContain(rawReason);
    expect(footer).not.toContain(rawReason);
  }
}

async function enterEdit(): Promise<void> {
  await click(button(tabGroupingStrings.editPlan));
  expect(panel().querySelector(".cmux-tab-grouping-editmap")).not.toBeNull();
}

async function enterConfirm(): Promise<void> {
  await click(button(tabGroupingStrings.confirmPlan));
  await settle();
  expect(panel().querySelector(".cmux-tab-grouping-body.is-confirm")).not.toBeNull();
  expect(boundaryHarness.prepared.length).toBeGreaterThan(0);
}

async function applyCurrentPlan(clickCount = 1): Promise<void> {
  const apply = button(tabGroupingStrings.apply);
  expect(apply.disabled).toBe(false);
  await act(async () => {
    for (let index = 0; index < clickCount; index += 1) {
      apply.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    }
  });
  await settle();
}

function currentSignature(): string {
  return persistentLayoutSignature(useWorkspaceListStore.getState().workspaces);
}

async function mountAndApply(clickCount = 1): Promise<{ before: string; ticket: ReturnType<typeof latestPrepared> }> {
  const before = currentSignature();
  await mountPanel();
  await enterConfirm();
  const ticket = latestPrepared();
  await applyCurrentPlan(clickCount);
  return { before, ticket };
}

function chip(tabId: string): HTMLButtonElement {
  const match = panel().querySelector<HTMLButtonElement>(
    `.cmux-tab-grouping-editmap button.cmux-tab-grouping-chip[data-tab-id="${tabId}"]`,
  );
  if (!match) throw new Error(`chip not found: ${tabId}`);
  return match;
}

function dropTarget(dropId: string): HTMLElement {
  const match = [...panel().querySelectorAll<HTMLElement>("[data-drop-id]")]
    .find((candidate) => candidate.dataset.dropId === dropId);
  if (!match) throw new Error(`drop target not found: ${dropId}`);
  return match;
}

async function dragTab(tabId: string, dropId: string, pointerId = 41): Promise<void> {
  const source = chip(tabId);
  hitElement = dropTarget(dropId);
  await act(async () => source.dispatchEvent(pointer("pointerdown", pointerId, 10, 10)));
  await act(async () => window.dispatchEvent(pointer("pointermove", pointerId, 10, 10)));
  await act(async () => window.dispatchEvent(pointer("pointermove", pointerId, 60, 40)));
  await flushFrames();
  await act(async () => window.dispatchEvent(pointer("pointerup", pointerId, 60, 40)));
  await settle();
}

type ScenarioId = "S1" | "S2" | "S3" | "S4";

async function runScenario(id: ScenarioId) {
  await mountPanel();
  let live = "";
  let keepText = "";
  if (id === "S1") {
    await enterConfirm();
  } else {
    await enterEdit();
    if (id === "S2") {
      await dragTab("tosaka", "g1:0:0", 42);
    } else if (id === "S3") {
      await click(chip("t模試"));
      await click(chip("t数学"));
      await click(dropTarget("g2:0:0"));
    } else {
      await click(chip("t模試"));
      const tray = dropTarget("keep-current");
      keepText = tray.textContent ?? "";
      await click(tray);
    }
    live = panelLiveText();
    await click(button(tabGroupingStrings.goConfirm));
    await settle();
  }
  const ticket = latestPrepared();
  const before = currentSignature();
  await applyCurrentPlan();
  const committed = latestCommit();
  const undo = useGroupingRuntimeStore.getState().undo;
  return { before, committed, keepText, live, ticket, undo };
}

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

beforeEach(() => {
  __resetGroupingPrecomputeForTests();
  localStorage.clear();
  analysisHarness.value = structuredClone(mockGroupingAnalysis);
  boundaryHarness.previews = [];
  boundaryHarness.prepared = [];
  boundaryHarness.committed = [];
  boundaryHarness.undone = [];
  editHarness.commands = [];
  editHarness.sessions = [];
  tauriHarness.invoke.mockClear();
  tauriHarness.getVersion.mockClear();
  tauriHarness.relaunch.mockClear();
  persistBehaviour = "saved";
  persistCalls = [];
  frameId = 1;
  frameQueue = new Map();
  resizeCallbacks = [];
  hitElement = null;
  pointerCaptured = false;
  measuredWidth = 1_000;
  detourGeometry = false;
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    const id = frameId++;
    frameQueue.set(id, callback);
    return id;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => frameQueue.delete(id)));
  class Gate4ResizeObserver implements ResizeObserver {
    constructor(callback: ResizeObserverCallback) { resizeCallbacks.push(callback); }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): ResizeObserverEntry[] { return []; }
  }
  vi.stubGlobal("ResizeObserver", Gate4ResizeObserver);
  savedElementFromPoint = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
  savedElementsFromPoint = Object.getOwnPropertyDescriptor(document, "elementsFromPoint");
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => hitElement) });
  Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: vi.fn(() => hitElement ? [hitElement] : []) });
  savedPointerDescriptors = Object.fromEntries(
    ["setPointerCapture", "releasePointerCapture", "hasPointerCapture", "scrollIntoView", "clientWidth"]
      .map((name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)]),
  );
  Object.defineProperties(HTMLElement.prototype, {
    setPointerCapture: { configurable: true, value: vi.fn(() => { pointerCaptured = true; }) },
    releasePointerCapture: { configurable: true, value: vi.fn(() => { pointerCaptured = false; }) },
    hasPointerCapture: { configurable: true, value: vi.fn(() => pointerCaptured) },
    scrollIntoView: { configurable: true, value: vi.fn() },
    clientWidth: {
      configurable: true,
      get() { return (this as HTMLElement).classList.contains("cmux-tab-grouping-sidebyside") ? measuredWidth : 0; },
    },
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
    const element = this as HTMLElement;
    if (element.classList.contains("cmux-tab-grouping-sidebyside")) return domRect(0, 0, 1_000, 800);
    const side = element.dataset.groupingSide
      ?? element.closest<HTMLElement>('[data-grouping-side]')?.dataset.groupingSide;
    const tabId = element.dataset.tabId;
    if (tabId) {
      if (!element.classList.contains("is-moved")) return domRect(0, 0, 0, 0);
      const order = ["t模試", "tb2", "t数学", "t請求", "tkessan", "t統括", "t配置図", "tudr2", "tosaka", "tshinso"];
      const index = Math.max(0, order.indexOf(tabId));
      if (measuredWidth < 960) return domRect(40 + index * 90, side === "after" ? 620 : 80, 70, 22);
      return domRect(side === "after" ? 820 : 60, 40 + index * 70, 100, 22);
    }
    if (element.classList.contains("cmux-tab-grouping-pane")) {
      if (detourGeometry) {
        const peers = [...document.querySelectorAll<HTMLElement>(".cmux-tab-grouping-pane")];
        if (peers.indexOf(element) === 4) return domRect(150, 300, 260, 90);
      }
      return domRect(0, 0, 0, 0);
    }
    if (element.dataset.workspaceId) {
      return domRect(0, 0, 0, 0);
    }
    if (element.dataset.dropId) return domRect(500, 40, 180, 120);
    return domRect(0, 0, 0, 0);
  });
  resetStores();
  useSettingsStore.setState({ groupingApplyAnimationEnabled: false });
  installPersistence();
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  container = null;
  __resetGroupingPrecomputeForTests();
  localStorage.clear();
  unregisterPersistence?.();
  unregisterPersistence = null;
  __resetPersistenceCoordinatorForTests();
  __resetGroupingRuntimeForTests();
  resetFontZoomQueueForTests();
  document.body.replaceChildren();
  for (const [name, descriptor] of Object.entries(savedPointerDescriptors)) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
  }
  if (savedElementFromPoint) Object.defineProperty(document, "elementFromPoint", savedElementFromPoint);
  else delete (document as unknown as Record<string, unknown>).elementFromPoint;
  if (savedElementsFromPoint) Object.defineProperty(document, "elementsFromPoint", savedElementsFromPoint);
  else delete (document as unknown as Record<string, unknown>).elementsFromPoint;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("A. 4 scenarios end-to-end", () => {
  it("[G4-01] completes S1 compare, confirm, apply, and exposes undo", { timeout: 10_000 }, async () => {
    await runScenario("S1");
    expect(latestCommit().commit.ok).toBe(true);
    expect(useGroupingRuntimeStore.getState().undo?.status).toBe("available");
  });

  it("[G4-02] completes S2 last-tab pointer move and apply", { timeout: 10_000 }, async () => {
    const result = await runScenario("S2");
    expect(result.committed.commit.ok).toBe(true);
    expect(result.live).toContain("移動しました");
  });

  it("[G4-03] completes S3 two-tab click move and apply", { timeout: 10_000 }, async () => {
    const result = await runScenario("S3");
    expect(result.committed.commit.ok).toBe(true);
    expect(result.live).toContain("2件");
  });

  it("[G4-04] completes S4 visible keep-current tray and apply", { timeout: 10_000 }, async () => {
    const result = await runScenario("S4");
    expect(result.committed.commit.ok).toBe(true);
    expect(result.keepText).toContain(tabGroupingStrings.keepTrayHint);
  });

  for (const [id, scenario] of [["G4-05", "S1"], ["G4-06", "S2"], ["G4-07", "S3"], ["G4-08", "S4"]] as const) {
    it(`[${id}] keeps prepared and committed transactions canonically identical`, { timeout: 10_000 }, async () => {
      const result = await runScenario(scenario);
      expect(result.committed.commit.ok).toBe(true);
      if (!result.committed.commit.ok) return;
      expect(hashCanonical(result.committed.commit.transaction)).toBe(hashCanonical(result.ticket.transaction));
    });
  }

  for (const [id, scenario] of [["G4-09", "S1"], ["G4-10", "S2"], ["G4-11", "S3"], ["G4-12", "S4"]] as const) {
    it(`[${id}] commits the exact prepared persistent layout`, { timeout: 10_000 }, async () => {
      const result = await runScenario(scenario);
      expect(currentSignature()).toBe(persistentLayoutSignature(result.ticket.transaction.workspaces));
      const moved = result.ticket.transaction.expected.movedTabIds;
      for (const tabId of moved) {
        expect(useWorkspaceListStore.getState().workspaces.some((workspace) =>
          workspace.panes.some((paneItem) => paneItem.tabs.some((tab) => tab.id === tabId)))).toBe(true);
      }
    });
  }

  for (const [id, scenario] of [["G4-13", "S1"], ["G4-14", "S2"], ["G4-15", "S3"], ["G4-16", "S4"]] as const) {
    it(`[${id}] publishes one undo record and the scenario live announcement`, { timeout: 10_000 }, async () => {
      const result = await runScenario(scenario);
      expect(result.undo?.status).toBe("available");
      if (result.undo?.status !== "available") return;
      expect(result.undo.report.movedTabCount).toBe(result.ticket.transaction.expected.movedTabIds.length);
      if (scenario === "S1") expect(result.live).toBe("");
      else expect(result.live.length).toBeGreaterThan(0);
    });
  }

  it("[G4-17] restores S1 structuralUndoSignature through the real undo facade", { timeout: 10_000 }, async () => {
    const result = await runScenario("S1");
    if (result.undo?.status !== "available") throw new Error("undo record is not available");
    const appliedWorkspaces = useWorkspaceListStore.getState().workspaces;
    expect(result.undo.appliedLayoutSignature).toBe(persistentLayoutSignature(appliedWorkspaces));
    expect(result.undo.expectedStructuralSignature).toBe(structuralUndoSignature(appliedWorkspaces));
    const snapshotSignature = structuralUndoSignature(result.undo.snapshot.workspaces);
    let undone!: ReturnType<typeof groupingBoundary.undo>;
    await act(async () => { undone = groupingBoundary.undo(); });
    await settle();
    expect(undone.ok).toBe(true);
    expect(structuralUndoSignature(useWorkspaceListStore.getState().workspaces)).toBe(snapshotSignature);
  });
});

async function captureMovePath(kind: "dnd" | "click" | "popover") {
  await mountPanel();
  await enterEdit();
  await click(chip("t模試"));
  await click(chip("t数学"));
  editHarness.commands = [];
  editHarness.sessions = [];
  if (kind === "dnd") {
    await dragTab("t数学", "g2:0:0", 52);
  } else if (kind === "click") {
    await click(dropTarget("g2:0:0"));
  } else {
    await click(button(tabGroupingStrings.moveSelected));
    const menuItem = [...panel().querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((item) => item.textContent?.trim() === "請求と決算 / 母艦");
    if (!menuItem) throw new Error("popover pane destination is missing");
    await click(menuItem);
  }
  const session = editHarness.sessions.at(-1) as { plan: unknown } | undefined;
  if (!session) throw new Error(`no edit session for ${kind}`);
  return {
    command: structuredClone(editHarness.commands.at(-1)),
    commandCount: editHarness.commands.length,
    hash: hashCanonical(session.plan),
    live: panelLiveText(),
  };
}

async function unmountKeepingStores(): Promise<void> {
  if (root) await act(async () => root?.unmount());
  root = null;
  container = null;
  document.body.replaceChildren();
}

describe("B. 3 mode round trips", () => {
  it("[G4-18] preserves the edited session across compare-edit-confirm round trips", { timeout: 10_000 }, async () => {
    await mountPanel();
    await enterEdit();
    await click(chip("t模試"));
    await click(dropTarget("g2:0:0"));
    const editedHash = hashCanonical((editHarness.sessions.at(-1) as { plan: unknown }).plan);
    await click(button(tabGroupingStrings.goConfirm));
    await click(button(tabGroupingStrings.backToEdit));
    await click(button(tabGroupingStrings.backToCompare));
    await click(button(tabGroupingStrings.editPlan));
    expect(hashCanonical((editHarness.sessions.at(-1) as { plan: unknown }).plan)).toBe(editedHash);
  });

  it("[G4-19] preserves plan-local edits across plan switches and resets only on explicit AI reset", { timeout: 10_000 }, async () => {
    const originalA = mockGroupingPlans.find((plan) => plan.planId === "p1");
    const originalB = mockGroupingPlans.find((plan) => plan.planId === "p2");
    if (!originalA || !originalB) throw new Error("Gate4 plan fixtures are missing");

    await mountPanel();
    await click(planCard("project"));
    expect(planCard("project").getAttribute("aria-checked")).toBe("true");
    expect(latestPreviewPlanHash()).toBe(hashCanonical(originalA));

    await enterEdit();
    await click(chip("t模試"));
    await click(dropTarget("g2:0:0"));
    expect(editHarness.commands).toEqual([{
      kind: "reassign_tabs",
      tabIds: ["t模試"],
      target: { kind: "pane", groupId: "g2", columnIndex: 0, paneIndex: 0 },
    }]);
    const editedAHash = latestPreviewPlanHash();
    expect(editedAHash).not.toBe(hashCanonical(originalA));

    await click(button(tabGroupingStrings.backToCompare));
    await click(planCard("role"));
    expect(planCard("role").getAttribute("aria-checked")).toBe("true");
    expect(latestPreviewPlanHash()).toBe(hashCanonical(originalB));
    expect(latestPreviewPlanHash()).not.toBe(editedAHash);
    expect(editHarness.commands).toHaveLength(1);

    await click(planCard("project"));
    expect(latestPreviewPlanHash()).toBe(editedAHash);
    await click(button(tabGroupingStrings.editPlan));
    expect(latestPreviewPlanHash()).toBe(editedAHash);
    expect(button(tabGroupingStrings.resetToAiPlan).disabled).toBe(false);

    await click(button(tabGroupingStrings.resetToAiPlan));
    expect(latestPreviewPlanHash()).toBe(hashCanonical(originalA));
    expect(editHarness.commands).toHaveLength(1);
    expect(button(tabGroupingStrings.resetToAiPlan).disabled).toBe(true);
  });

  it("[G4-20] enters confirm directly without mounting the edit map", { timeout: 10_000 }, async () => {
    await mountPanel();
    expect(button(tabGroupingStrings.confirmPlan).disabled).toBe(false);
    expect(button(tabGroupingStrings.editPlan).disabled).toBe(false);
    await enterConfirm();
    expect(panel().querySelector(".cmux-tab-grouping-editmap")).toBeNull();
  });

  it("[G4-21] returns from confirm to the preserved edit map", { timeout: 10_000 }, async () => {
    await mountPanel();
    await enterEdit();
    await click(chip("t模試"));
    await click(dropTarget("g2:0:0"));
    const editedHash = hashCanonical((editHarness.sessions.at(-1) as { plan: unknown }).plan);
    await click(button(tabGroupingStrings.goConfirm));
    await click(button(tabGroupingStrings.backToEdit));
    expect(panel().querySelector(".cmux-tab-grouping-editmap")).not.toBeNull();
    expect(hashCanonical((editHarness.sessions.at(-1) as { plan: unknown }).plan)).toBe(editedHash);
  });

  it("[G4-22] clears selected chips whenever edit mode is left", { timeout: 10_000 }, async () => {
    await mountPanel();
    await enterEdit();
    await click(chip("t模試"));
    await click(chip("t数学"));
    expect(panel().querySelectorAll("button.cmux-tab-grouping-chip.is-selected")).toHaveLength(2);
    await click(button(tabGroupingStrings.goConfirm));
    await click(button(tabGroupingStrings.backToEdit));
    expect(panel().querySelectorAll("button.cmux-tab-grouping-chip.is-selected")).toHaveLength(0);
  });
});

describe("C. DnD equals click equals popover", () => {
  for (const [id, kind] of [["G4-23", "dnd"], ["G4-24", "click"], ["G4-25", "popover"]] as const) {
    it(`[${id}] produces the canonical expected edited plan through ${kind}`, { timeout: 10_000 }, async () => {
      const result = await captureMovePath(kind);
      expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(result.commandCount).toBe(1);
    });
  }
  for (const [id, kind] of [["G4-26", "dnd"], ["G4-27", "click"], ["G4-28", "popover"]] as const) {
    it(`[${id}] emits one exact reassign_tabs command through ${kind}`, { timeout: 10_000 }, async () => {
      const result = await captureMovePath(kind);
      expect(result.command).toEqual({
        kind: "reassign_tabs",
        tabIds: ["t模試", "t数学"],
        target: { kind: "pane", groupId: "g2", columnIndex: 0, paneIndex: 0 },
      });
    });
  }
  for (const [id, kind] of [["G4-29", "dnd"], ["G4-30", "click"], ["G4-31", "popover"]] as const) {
    it(`[${id}] announces the same visible destination through ${kind}`, { timeout: 10_000 }, async () => {
      const result = await captureMovePath(kind);
      expect(result.live).toBe("2件を請求と決算 の 母艦へ移動しました");
    });
  }
  it("[G4-32] proves the three path hashes, commands, and live strings are mutually identical", { timeout: 10_000 }, async () => {
    const results = [];
    for (const kind of ["dnd", "click", "popover"] as const) {
      if (root) {
        await unmountKeepingStores();
        resetStores();
        __resetGroupingPrecomputeForTests();
        localStorage.clear();
      }
      results.push(await captureMovePath(kind));
    }
    expect(results.map((item) => item.hash)).toEqual([results[0].hash, results[0].hash, results[0].hash]);
    expect(results.map((item) => item.command)).toEqual([results[0].command, results[0].command, results[0].command]);
    expect(results.map((item) => item.live)).toEqual([results[0].live, results[0].live, results[0].live]);
  });
});

describe("D. 14 cancellation paths", () => {
  it("[G4-33] mechanically inventories the exact cancel-reason union and all UX-4 owners", { timeout: 10_000 }, () => {
    const production = source("../../src/components/layout/groupingDrag.ts");
    const owner = source("./tabGroupingDragCancel.test.tsx");
    const union = production.match(/export type GroupingDragCancelReason =([\s\S]*?);/)?.[1] ?? "";
    const reasons = [...union.matchAll(/"([a-z-]+)"/g)].map((match) => match[1]);
    expect(reasons).toHaveLength(14);
    for (const reason of reasons) expect(owner, `missing UX-4 owner for ${reason}`).toContain(reason);
  });

  it("[G4-35] treats a sub-threshold pointer gesture as a selection toggle", { timeout: 10_000 }, async () => {
    await mountPanel();
    await enterEdit();
    const sourceChip = chip("t模試");
    await act(async () => sourceChip.dispatchEvent(pointer("pointerdown", 61, 10, 10)));
    await act(async () => window.dispatchEvent(pointer("pointermove", 61, 15, 10)));
    await act(async () => window.dispatchEvent(pointer("pointerup", 61, 15, 10)));
    await settle();
    expect(sourceChip.getAttribute("aria-pressed")).toBe("true");
    expect(editHarness.commands).toHaveLength(0);
  });

  it("[G4-36] announces noop and issues no command for the same destination", { timeout: 10_000 }, async () => {
    await mountPanel();
    await enterEdit();
    editHarness.commands = [];
    await dragTab("t模試", "g1:0:0", 62);
    expect(editHarness.commands).toHaveLength(0);
    expect(panelLiveText()).toBe(tabGroupingStrings.dragNoopAnnounce);
  });

  it("[G4-37] consumes Escape during drag without closing the Panel", { timeout: 10_000 }, async () => {
    const onClose = await mountPanel();
    await enterEdit();
    const sourceChip = chip("t模試");
    hitElement = dropTarget("g2:0:0");
    await act(async () => sourceChip.dispatchEvent(pointer("pointerdown", 63, 10, 10)));
    await act(async () => window.dispatchEvent(pointer("pointermove", 63, 60, 40)));
    await flushFrames();
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    await settle();
    expect(onClose).toHaveBeenCalledTimes(0);
    expect(panel().querySelectorAll(".cmux-tab-grouping-ghost, .is-dragging, .is-drop-active")).toHaveLength(0);
  });

  it("[G4-38] accepts a click move immediately after pointer cancellation", { timeout: 10_000 }, async () => {
    await mountPanel();
    await enterEdit();
    const sourceChip = chip("t模試");
    await act(async () => sourceChip.dispatchEvent(pointer("pointerdown", 64, 10, 10)));
    await act(async () => window.dispatchEvent(pointer("pointermove", 64, 60, 40)));
    await flushFrames();
    await act(async () => window.dispatchEvent(pointer("pointercancel", 64, 60, 40)));
    await click(sourceChip);
    await click(dropTarget("g2:0:0"));
    expect(editHarness.commands.at(-1)).toMatchObject({ kind: "reassign_tabs", tabIds: ["t模試"] });
  });
});

type ExternalChange = "spawn" | "close" | "move";

async function mutateExternalLayout(kind: ExternalChange, bumpRevision = true): Promise<void> {
  const state = useWorkspaceListStore.getState();
  const workspaces = externalLayoutAfter(state.workspaces, kind);
  await act(async () => useWorkspaceListStore.setState({
    workspaces,
    ...(bumpRevision ? { layoutRevision: state.layoutRevision + 1 } : {}),
  }));
  await settle();
}

function externalLayoutAfter(
  currentWorkspaces: ReturnType<typeof cloneWorkspaces>,
  kind: ExternalChange,
): ReturnType<typeof cloneWorkspaces> {
  const workspaces = structuredClone(currentWorkspaces);
  if (kind === "spawn") {
    workspaces[0].panes[0].tabs.push({
      id: "gate4-spawn",
      sessionId: "session-gate4-spawn",
      agentId: "terminal",
      agentKind: "codex",
      label: "Gate4 spawn",
      cwd: "C:\\gate4",
    });
  } else if (kind === "close") {
    workspaces[0].panes[0].tabs = workspaces[0].panes[0].tabs.filter((tab) => tab.id !== "tb2");
  } else {
    const sourcePane = workspaces[0].panes[0];
    const destinationPane = workspaces[1].panes[0];
    const moved = sourcePane.tabs.find((tab) => tab.id === "tb2");
    sourcePane.tabs = sourcePane.tabs.filter((tab) => tab.id !== "tb2");
    if (moved) destinationPane.tabs.push(moved);
  }
  return workspaces;
}

async function openConfirmThenMutate(kind: ExternalChange, bumpRevision = true) {
  await mountPanel();
  await enterConfirm();
  const oldTicket = latestPrepared();
  const prepareCount = boundaryHarness.prepared.length;
  await mutateExternalLayout(kind, bumpRevision);
  return { oldTicket, prepareCount };
}

describe("E. stale tickets and re-prepare", () => {
  it("[G4-39] blocks a stale same-act Apply and automatically prepares exactly one new spawn ticket", { timeout: 10_000 }, async () => {
    await mountPanel();
    await enterConfirm();
    const oldTicket = latestPrepared();
    const prepareCount = boundaryHarness.prepared.length;
    const commitCount = boundaryHarness.committed.length;
    const staleApply = button(tabGroupingStrings.apply);
    const state = useWorkspaceListStore.getState();
    const workspaces = externalLayoutAfter(state.workspaces, "spawn");

    await act(async () => {
      useWorkspaceListStore.setState({
        workspaces,
        layoutRevision: state.layoutRevision + 1,
      });
      staleApply.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    });
    expect(boundaryHarness.committed).toHaveLength(commitCount);
    await settle();

    expect(boundaryHarness.prepared).toHaveLength(prepareCount + 1);
    const automatic = boundaryHarness.prepared.at(-1) as {
      applyDisabled: boolean | null;
      result: ReturnType<typeof groupingBoundary.prepare>;
    };
    expect(automatic.applyDisabled).toBe(true);
    expect(automatic.result.ok).toBe(true);
    expect(latestPrepared().issuanceId).not.toBe(oldTicket.issuanceId);
    expect(button(tabGroupingStrings.apply).disabled).toBe(false);
    expect([...document.querySelectorAll("button")].some((item) => item.textContent?.trim() === tabGroupingStrings.retryPrepare)).toBe(false);
  });

  for (const [id, kind, autoSucceeds, failureReason] of [
    ["G4-40", "close", false, "タブ tb2 が閉じられています"],
    ["G4-41", "move", false, "タブ tb2 が分析後に手動で移動されています"],
  ] as const) {
    it(`[${id}] invalidates a confirm ticket after external ${kind}`, { timeout: 10_000 }, async () => {
      const { oldTicket, prepareCount } = await openConfirmThenMutate(kind);
      expect(boundaryHarness.prepared).toHaveLength(prepareCount + 1);
      const automatic = boundaryHarness.prepared.at(-1) as {
        applyDisabled: boolean | null;
        result: ReturnType<typeof groupingBoundary.prepare>;
      };
      expect(panel().querySelector(".cmux-tab-grouping-body.is-confirm")).not.toBeNull();
      expect(document.body.textContent).toContain(tabGroupingStrings.ticketInvalidated);
      expect(automatic.applyDisabled).toBe(true);
      expect(automatic.result.ok).toBe(autoSucceeds);
      expect(autoSucceeds).toBe(false);
      expect(button(tabGroupingStrings.apply).disabled).toBe(true);
      expect(button(tabGroupingStrings.retryPrepare)).not.toBeNull();
      expectInvalidationFailure(failureReason);
    });
  }

  it("[G4-42] records that workspace mutation without a revision bump does not invalidate", { timeout: 10_000 }, async () => {
    const { prepareCount } = await openConfirmThenMutate("spawn", false);
    expect(button(tabGroupingStrings.apply).disabled).toBe(false);
    expect(document.body.textContent).not.toContain(tabGroupingStrings.ticketInvalidated);
    expect(boundaryHarness.prepared).toHaveLength(prepareCount);
  });

  it("[G4-43] adds exactly one manual prepare after the automatic spawn retry fails", { timeout: 10_000 }, async () => {
    await mountPanel();
    await enterConfirm();
    const oldTicket = latestPrepared();
    const prepareCount = boundaryHarness.prepared.length;
    const token = tryBeginGroupingOperation("commit");
    if (!token) throw new Error("failed to acquire Gate4 operation token");
    try {
      await mutateExternalLayout("spawn", true);
      expect(boundaryHarness.prepared).toHaveLength(prepareCount + 1);
      expect(button(tabGroupingStrings.retryPrepare)).not.toBeNull();
      expect(button(tabGroupingStrings.apply).disabled).toBe(true);
      expectInvalidationFailure(
        tabGroupingStrings.applyOperationInProgress,
        "grouping boundary operation is in progress",
      );
    } finally {
      endGroupingOperation(token);
    }
    await click(button(tabGroupingStrings.retryPrepare));
    expect(boundaryHarness.prepared).toHaveLength(prepareCount + 2);
    expect(latestPrepared().issuanceId).not.toBe(oldTicket.issuanceId);
    expect(button(tabGroupingStrings.apply).disabled).toBe(false);
    expect(panel().querySelector(".cmux-tab-grouping-body.is-confirm .cmux-tab-grouping-error")).toBeNull();
  });

  for (const [id, kind, failureReason] of [
    ["G4-44", "close", "タブ tb2 が閉じられています"],
    ["G4-45", "move", "タブ tb2 が分析後に手動で移動されています"],
  ] as const) {
    it(`[${id}] adds exactly one manual prepare after the automatic ${kind} retry fails`, { timeout: 10_000 }, async () => {
      const { oldTicket, prepareCount } = await openConfirmThenMutate(kind);
      expect(boundaryHarness.prepared).toHaveLength(prepareCount + 1);
      expect(button(tabGroupingStrings.apply).disabled).toBe(true);
      expectInvalidationFailure(failureReason);
      await act(async () => useWorkspaceListStore.setState({ workspaces: structuredClone(mockWorkspaces) }));
      await settle();
      await click(button(tabGroupingStrings.retryPrepare));
      expect(boundaryHarness.prepared).toHaveLength(prepareCount + 2);
      expect(latestPrepared().issuanceId).not.toBe(oldTicket.issuanceId);
      expect(button(tabGroupingStrings.apply).disabled).toBe(false);
      expect(panel().querySelector(".cmux-tab-grouping-body.is-confirm .cmux-tab-grouping-error")).toBeNull();
    });
  }

  it("[G4-46] rejects a drop when layoutRevision changes during drag", { timeout: 10_000 }, async () => {
    await mountPanel();
    await enterEdit();
    const sourceChip = chip("t模試");
    hitElement = dropTarget("g2:0:0");
    editHarness.commands = [];
    await act(async () => sourceChip.dispatchEvent(pointer("pointerdown", 71, 10, 10)));
    await act(async () => window.dispatchEvent(pointer("pointermove", 71, 60, 40)));
    await flushFrames();
    await mutateExternalLayout("spawn", true);
    await act(async () => window.dispatchEvent(pointer("pointerup", 71, 60, 40)));
    expect(editHarness.commands).toHaveLength(0);
    expect(panel().querySelectorAll(".cmux-tab-grouping-ghost, .is-dragging, .is-drop-active")).toHaveLength(0);
  });

  it("[G4-47] retries a real operation-in-progress prepare failure and succeeds", { timeout: 10_000 }, async () => {
    await mountPanel();
    const token = tryBeginGroupingOperation("commit");
    if (!token) throw new Error("failed to acquire Gate4 operation token");
    await click(button(tabGroupingStrings.confirmPlan));
    expect(boundaryHarness.prepared).toHaveLength(1);
    expect((boundaryHarness.prepared[0] as { result: { ok: boolean } }).result.ok).toBe(false);
    expect(button(tabGroupingStrings.retryPrepare)).not.toBeNull();
    endGroupingOperation(token);
    await click(button(tabGroupingStrings.retryPrepare));
    expect(boundaryHarness.prepared).toHaveLength(2);
    expect(latestPrepared()).toBeDefined();
    expect(button(tabGroupingStrings.apply).disabled).toBe(false);
  });
});

async function mountStatusBar(): Promise<void> {
  await unmountKeepingStores();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<GroupingStatusBar />));
  await settle();
}

describe("F. single apply, rollback, undo, and durability", () => {
  it("[G4-48] commits once for two clicks in one act", { timeout: 10_000 }, async () => {
    await mountAndApply(2);
    expect(boundaryHarness.committed).toHaveLength(1);
  });

  it("[G4-49] commits once for five clicks and releases operation ownership", { timeout: 10_000 }, async () => {
    await mountAndApply(5);
    expect(boundaryHarness.committed).toHaveLength(1);
    expect(useGroupingRuntimeStore.getState().operation).toBeNull();
  });

  it("[G4-50] rolls back a real commit_mismatch without publishing applied state", { timeout: 10_000 }, async () => {
    await mountPanel();
    await enterConfirm();
    const before = currentSignature();
    const originalRestore = useWorkspaceListStore.getState()._restoreGroupingLayout;
    let commitRestores = 0;
    useWorkspaceListStore.setState({
      _restoreGroupingLayout: (workspaces, selection, sourceName, capability) => {
        const next = structuredClone(workspaces);
        if (sourceName === "grouping-commit" && commitRestores++ === 0) next[0].name = "Gate4 forced mismatch";
        originalRestore(next, selection, sourceName, capability);
      },
    });
    await applyCurrentPlan();
    expect(latestCommit().commit).toMatchObject({ ok: false, kind: "commit_mismatch" });
    expect(currentSignature()).toBe(before);
    expect(useGroupingRuntimeStore.getState().undo).toBeNull();
    expect(panel().querySelector(".cmux-tab-grouping-body.is-edit")).not.toBeNull();
    expect(document.body.textContent).toContain("適用");
  });

  it("[G4-51] exposes one global undo generation and removes it after use", { timeout: 10_000 }, async () => {
    await mountAndApply();
    await mountStatusBar();
    expect(button(tabGroupingStrings.undo).disabled).toBe(false);
    await click(button(tabGroupingStrings.undo));
    expect(useGroupingRuntimeStore.getState().undo?.status).not.toBe("available");
    expect([...document.querySelectorAll("button")].some((item) => item.textContent?.trim() === tabGroupingStrings.undo)).toBe(false);
  });

  it("[G4-52] exposes pending durability while the real leader hangs", { timeout: 10_000 }, async () => {
    persistBehaviour = "hang";
    await mountAndApply();
    expect(useGroupingRuntimeStore.getState().durability.status).toBe("pending");
    const note = panel().querySelector<HTMLElement>('[data-durability="pending"]');
    expect(note?.textContent).toContain(tabGroupingStrings.durabilityPending);
  });

  it("[G4-53] removes durability warning after the real saved acknowledgement", { timeout: 10_000 }, async () => {
    persistBehaviour = "saved";
    await mountAndApply();
    await vi.waitFor(() => expect(useGroupingRuntimeStore.getState().durability.status).toBe("saved"));
    expect(panel().querySelector('[data-durability="pending"], [data-durability="failed"]')).toBeNull();
  });

  it("[G4-54] exposes failed durability after the real failed acknowledgement", { timeout: 10_000 }, async () => {
    persistBehaviour = "failed";
    await mountAndApply();
    await vi.waitFor(() => expect(useGroupingRuntimeStore.getState().durability.status).toBe("failed"));
    const note = panel().querySelector<HTMLElement>('[data-durability="failed"]');
    expect(note?.textContent).toContain(tabGroupingStrings.statusDurabilityWarning);
  });

  it("[G4-55] exposes failed durability when no persistence leader exists", { timeout: 10_000 }, async () => {
    unregisterPersistence?.();
    unregisterPersistence = null;
    persistBehaviour = "none";
    await mountAndApply();
    await vi.waitFor(() => expect(useGroupingRuntimeStore.getState().durability.status).toBe("deferred"));
    const note = panel().querySelector<HTMLElement>('[data-durability="deferred"]');
    expect(note?.textContent).toContain(tabGroupingStrings.statusDurabilityWarning);
  });
});

async function mountOverlay(onClose = vi.fn(), closing = false): Promise<ReturnType<typeof vi.fn>> {
  container = document.createElement("div");
  document.body.replaceChildren(container);
  root = createRoot(container);
  await act(async () => root?.render(
    <OverlayShell open closing={closing} ariaLabel="Gate4 overlay" onClose={onClose}>
      <button type="button" id="gate4-first">first</button>
      <input id="gate4-middle" />
      <button type="button" id="gate4-last">last</button>
    </OverlayShell>,
  ));
  await settle();
  return onClose;
}

async function pressKey(key: string, shiftKey = false): Promise<void> {
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", {
    key,
    shiftKey,
    bubbles: true,
    cancelable: true,
  })));
  await settle();
}

describe("G. real OverlayShell integration", () => {
  it("[G4-56] focuses the real dialog immediately after mount", { timeout: 10_000 }, async () => {
    await mountOverlay();
    expect(document.activeElement).toBe(document.querySelector('.cmux-overlay-panel[role="dialog"]'));
  });

  it("[G4-57] traps forward Tab from the last focusable at the first", { timeout: 10_000 }, async () => {
    await mountOverlay();
    document.querySelector<HTMLElement>("#gate4-last")?.focus();
    await pressKey("Tab");
    expect(document.activeElement).toBe(document.querySelector("#gate4-first"));
  });

  it("[G4-58] traps backward Tab from the first focusable at the last", { timeout: 10_000 }, async () => {
    await mountOverlay();
    document.querySelector<HTMLElement>("#gate4-first")?.focus();
    await pressKey("Tab", true);
    expect(document.activeElement).toBe(document.querySelector("#gate4-last"));
  });

  it("[G4-59] moves Tab from the dialog itself to its first focusable", { timeout: 10_000 }, async () => {
    await mountOverlay();
    document.querySelector<HTMLElement>('.cmux-overlay-panel[role="dialog"]')?.focus();
    await pressKey("Tab");
    expect(document.activeElement).toBe(document.querySelector("#gate4-first"));
  });

  it("[G4-60] unwinds drag, then selection, then the Panel, then the popover on Escape", { timeout: 10_000 }, async () => {
    const onClose = await mountPanel();
    await enterEdit();
    const sourceChip = chip("t模試");
    // Select first: without a live selection the "no selected chips" assertion
    // below passes whether or not Escape clears anything.
    await click(sourceChip);
    await click(chip("t数学"));
    expect(panel().querySelectorAll("button.cmux-tab-grouping-chip.is-selected")).toHaveLength(2);

    hitElement = dropTarget("g2:0:0");
    await act(async () => sourceChip.dispatchEvent(pointer("pointerdown", 91, 10, 10)));
    await act(async () => window.dispatchEvent(pointer("pointermove", 91, 60, 40)));
    await flushFrames();
    expect(document.querySelector(".cmux-tab-grouping-ghost")).not.toBeNull();

    // Escape unwinds one layer at a time. First the drag, and the selection
    // survives it — re-picking every chip after a mis-drag would be punishing.
    await pressKey("Escape");
    expect(onClose).toHaveBeenCalledTimes(0);
    expect(document.querySelectorAll(".cmux-tab-grouping-ghost, .is-dragging, .is-drop-active")).toHaveLength(0);
    expect(panel().querySelectorAll("button.cmux-tab-grouping-chip.is-selected")).toHaveLength(2);

    // Then the selection, with the Panel still open.
    await pressKey("Escape");
    expect(onClose).toHaveBeenCalledTimes(0);
    expect(panel().querySelectorAll("button.cmux-tab-grouping-chip.is-selected")).toHaveLength(0);

    // Only once nothing is left to undo does Escape close the Panel.
    await pressKey("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);

    const destinationTrigger = panel().querySelector<HTMLButtonElement>(
      '.cmux-tab-grouping-dest button[aria-haspopup="menu"]',
    );
    if (!destinationTrigger) throw new Error("destination popover trigger is missing");
    await click(destinationTrigger);
    expect(destinationTrigger.getAttribute("aria-expanded")).toBe("true");
    expect(panel().querySelector('.cmux-tab-grouping-dest [role="menu"]')).not.toBeNull();
    await pressKey("Escape");
    expect(panel().querySelector('.cmux-tab-grouping-dest [role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(destinationTrigger);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("[G4-61] restores focus to the opener after the real portal unmounts", { timeout: 10_000 }, async () => {
    const opener = document.createElement("button");
    opener.id = "gate4-opener";
    document.body.append(opener);
    opener.focus();
    const host = document.createElement("div");
    document.body.append(host);
    container = host;
    root = createRoot(host);
    await act(async () => root?.render(<OverlayShell open ariaLabel="restore" onClose={vi.fn()}><button>inside</button></OverlayShell>));
    await act(async () => root?.unmount());
    root = null;
    expect(document.activeElement).toBe(opener);
  });

  it("[G4-62] traps Tab and Shift+Tab inside only the topmost real overlay", { timeout: 10_000 }, async () => {
    const back = vi.fn();
    const front = vi.fn();
    const background = document.createElement("button");
    background.id = "gate4-background";
    container = document.createElement("div");
    document.body.replaceChildren(background, container);
    root = createRoot(container);
    await act(async () => root?.render(<>
      <OverlayShell open ariaLabel="back" onClose={back}>
        <button id="gate4-back-first">back first</button>
        <button id="gate4-back-last">back last</button>
      </OverlayShell>
      <OverlayShell open ariaLabel="front" layer="top" onClose={front}>
        <button id="gate4-front-first">front first</button>
        <button id="gate4-front-last">front last</button>
      </OverlayShell>
    </>));
    await settle();

    const backFirst = document.querySelector<HTMLElement>("#gate4-back-first")!;
    const backLast = document.querySelector<HTMLElement>("#gate4-back-last")!;
    const frontFirst = document.querySelector<HTMLElement>("#gate4-front-first")!;
    const frontLast = document.querySelector<HTMLElement>("#gate4-front-last")!;
    const backFirstFocus = vi.spyOn(backFirst, "focus");
    const backLastFocus = vi.spyOn(backLast, "focus");

    frontLast.focus();
    await pressKey("Tab");
    expect(document.activeElement).toBe(frontFirst);
    frontFirst.focus();
    await pressKey("Tab", true);
    expect(document.activeElement).toBe(frontLast);
    expect(backFirstFocus).not.toHaveBeenCalled();
    expect(backLastFocus).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(background);

    await pressKey("Escape");
    expect(front).toHaveBeenCalledTimes(1);
    expect(back).toHaveBeenCalledTimes(0);
  });

  it("[G4-63] closes only on a primary-button backdrop mousedown", { timeout: 10_000 }, async () => {
    const onClose = await mountOverlay();
    const backdrop = document.querySelector<HTMLElement>(".cmux-overlay-backdrop")!;
    await act(async () => backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })));
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => document.querySelector<HTMLElement>(".cmux-overlay-panel")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("[G4-64] ignores right-button backdrop mousedown", { timeout: 10_000 }, async () => {
    const onClose = await mountOverlay();
    const backdrop = document.querySelector<HTMLElement>(".cmux-overlay-backdrop")!;
    await act(async () => backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 2 })));
    expect(onClose).toHaveBeenCalledTimes(0);
  });

  it("[G4-65] keeps backdrop and background inert and disables Escape while closing", { timeout: 10_000 }, async () => {
    const onClose = await mountOverlay();
    const background = container!;
    await act(async () => root?.render(
      <OverlayShell open closing ariaLabel="Gate4 overlay" onClose={onClose}><button>inside</button></OverlayShell>,
    ));
    await settle();
    const backdrop = document.querySelector<HTMLElement>(".cmux-overlay-backdrop")!;
    expect(backdrop.hasAttribute("inert")).toBe(true);
    expect(backdrop.getAttribute("aria-hidden")).toBe("true");
    expect(background.hasAttribute("inert")).toBe(true);
    await pressKey("Escape");
    expect(onClose).toHaveBeenCalledTimes(0);
  });
});

async function setSideBySideWidth(width: number): Promise<HTMLElement> {
  measuredWidth = width;
  const sideBySide = panel().querySelector<HTMLElement>(".cmux-tab-grouping-sidebyside");
  if (!sideBySide) throw new Error("side-by-side measurement container is missing");
  for (const callback of resizeCallbacks) {
    await act(async () => callback([{ target: sideBySide } as ResizeObserverEntry], {} as ResizeObserver));
  }
  await flushFrames();
  return sideBySide;
}

describe("H. widths 959, 960, and 961", () => {
  for (const [id, width, stacked] of [["G4-66", 959, true], ["G4-67", 960, false], ["G4-68", 961, false]] as const) {
    it(`[${id}] renders ${width}px with stacked=${stacked}`, { timeout: 10_000 }, async () => {
      await mountPanel();
      await enterConfirm();
      const sideBySide = await setSideBySideWidth(width);
      expect(sideBySide.classList.contains("is-stacked")).toBe(stacked);
      expect(groupingSideBySideOrientation(width)).toBe(stacked ? "vertical" : "horizontal");
    });
  }

  it("[G4-69] returns to stacked after 959 to 961 to 959", { timeout: 10_000 }, async () => {
    await mountPanel();
    await enterConfirm();
    expect((await setSideBySideWidth(959)).classList.contains("is-stacked")).toBe(true);
    expect((await setSideBySideWidth(961)).classList.contains("is-stacked")).toBe(false);
    expect((await setSideBySideWidth(959)).classList.contains("is-stacked")).toBe(true);
  });
});

describe("I. external review reopen", () => {
  it("[G4-70] dispatches exactly one review intent from visible status action", { timeout: 10_000 }, async () => {
    await runScenario("S1");
    await mountStatusBar();
    const intents: unknown[] = [];
    const listener = (event: Event) => intents.push((event as CustomEvent).detail);
    window.addEventListener(TAB_GROUPING_OPEN_EVENT, listener);
    await click(button(tabGroupingStrings.undoReview));
    window.removeEventListener(TAB_GROUPING_OPEN_EVENT, listener);
    expect(intents).toEqual([{ intent: "review" }]);
  });

  it("[G4-71] opens review through direct props without a new analysis", { timeout: 10_000 }, async () => {
    await runScenario("S1");
    await unmountKeepingStores();
    vi.mocked(runGroupingAnalysis).mockClear();
    await mountPanel(vi.fn(), "review");
    expect(runGroupingAnalysis).not.toHaveBeenCalled();
    expect(panel().querySelector(".cmux-tab-grouping-body.is-confirm")).not.toBeNull();
    expect(document.body.textContent).toContain(tabGroupingStrings.undoAppliedUnknown);
  });

  it("[G4-72] preserves the rendered move-line tab set across an independent review mount", { timeout: 10_000 }, async () => {
    await runScenario("S1");
    await flushFrames();
    const afterApply = [...panel().querySelectorAll<HTMLElement>("path.cmux-tab-grouping-line[data-tab-id]")]
      .map((path) => path.dataset.tabId).sort();
    await unmountKeepingStores();
    await mountPanel(vi.fn(), "review");
    await flushFrames();
    const reopened = [...panel().querySelectorAll<HTMLElement>("path.cmux-tab-grouping-line[data-tab-id]")]
      .map((path) => path.dataset.tabId).sort();
    expect(reopened).toEqual(afterApply);
    expect(reopened.length).toBeGreaterThan(0);
  });
});

describe("J. Alt-click lineage grouping", () => {
  it("[G4-73] matches buildGroups roots including shared absent parents", { timeout: 10_000 }, () => {
    const groups = buildGroups(structuredClone(mockWorkspaces));
    const lineage = groupingLineageNodes(mockWorkspaces);
    const lineageGroups = new Map<string, string[]>();
    for (const [tabId, node] of lineage) {
      const key = `origin:${node.rootTabId}`;
      if (!groups.has(key)) continue;
      lineageGroups.set(key, [...(lineageGroups.get(key) ?? []), tabId]);
    }
    for (const [key, tabIds] of lineageGroups) expect(groups.get(key)).toEqual(tabIds);
    expect(lineage.get("tshinso")).toMatchObject({ rootTabId: "t存在しない", orphan: true });
  });
});

describe("K. carried Gate 4 closure findings", () => {
  it("[G4-UX5-M-01] keeps reverse horizontal and vertical routes clear of a middle pane frame", { timeout: 10_000 }, () => {
    const line = {
      tabId: "reverse",
      label: "reverse",
      fromWorkspaceId: "before",
      toWorkspaceId: "after",
      fromRect: null,
      toRect: null,
    };
    for (const orientation of ["horizontal", "vertical"] as const) {
      const source = orientation === "horizontal"
        ? { left: 320, top: 40, width: 30, height: 20 }
        : { left: 40, top: 320, width: 30, height: 20 };
      const target = orientation === "horizontal"
        ? { left: 20, top: 40, width: 30, height: 20 }
        : { left: 40, top: 20, width: 30, height: 20 };
      const sourcePane = orientation === "horizontal"
        ? { left: 300, top: 20, width: 100, height: 60 }
        : { left: 20, top: 300, width: 60, height: 100 };
      const destinationPane = orientation === "horizontal"
        ? { left: 0, top: 20, width: 100, height: 60 }
        : { left: 20, top: 0, width: 60, height: 100 };
      const middlePane = orientation === "horizontal"
        ? { left: 150, top: 20, width: 100, height: 60 }
        : { left: 20, top: 150, width: 60, height: 100 };
      const measured = groupingMeasuredMoveLines({
        lines: [line],
        fromRects: new Map([[line.tabId, source]]),
        toRects: new Map([[line.tabId, target]]),
        afterChipRects: new Map([[line.tabId, target]]),
        paneRects: new Map([
          ["source", sourcePane],
          ["destination", destinationPane],
          ["middle", middlePane],
        ]),
        sourcePaneIds: new Map([[line.tabId, "source"]]),
        destinationPaneIds: new Map([[line.tabId, "destination"]]),
        workspaceRects: new Map([[line.toWorkspaceId, destinationPane]]),
        orientation,
      })[0];
      expect(measured, `orientation=${orientation}`).toBeDefined();
      expect(routeCrosses(measured, paneFrames(middlePane), orientation), `orientation=${orientation} measured=${JSON.stringify(measured)}`).toBe(false);
    }
  });

  it("[G4-UX5-M-01-ORACLE] varies 200 seeded topologies and independently kills the reverse routeMinimum regression", { timeout: 10_000 }, () => {
    for (const orientation of ["horizontal", "vertical"] as const) {
      const source = orientedRect(620, 40, 30, 20, orientation);
      const target = orientedRect(220, 40, 30, 20, orientation);
      const sourcePane = orientedRect(600, 20, 100, 60, orientation);
      const destinationPane = orientedRect(200, 20, 100, 60, orientation);
      const destinationWorkspace = orientedRect(0, 10, 300, 80, orientation);
      const afterChip = orientedRect(80, 44, 18, 12, orientation);
      const line = {
        tabId: `route-minimum-${orientation}`,
        label: "route minimum",
        fromWorkspaceId: "source-ws",
        toWorkspaceId: "destination-ws",
        fromRect: null,
        toRect: null,
      };
      const measured = groupingMeasuredMoveLines({
        lines: [line],
        fromRects: new Map([[line.tabId, source]]),
        toRects: new Map([[line.tabId, target]]),
        afterChipRects: new Map([[line.tabId, target], ["after-chip", afterChip]]),
        paneRects: new Map([["source", sourcePane], ["destination", destinationPane]]),
        sourcePaneIds: new Map([[line.tabId, "source"]]),
        destinationPaneIds: new Map([[line.tabId, "destination"]]),
        workspaceRects: new Map([[line.toWorkspaceId, destinationWorkspace]]),
        orientation,
      })[0];
      expect(measured, `routeMinimum/${orientation}`).toBeDefined();
      expect(measured.routePoints, `routeMinimum/${orientation}`).not.toBeNull();
      expect(measured.destinationRect).toEqual(target);
      expect(routeCrosses(measured, [afterChip], orientation), `routeMinimum/${orientation}`).toBe(false);
      expectRouteReachesDestination(measured, target, orientation);
    }

    const topologySignatures = new Set<string>();
    const paneCounts = new Set<number>();
    const directionCounts = { forward: 0, reverse: 0 };
    for (let seed = 0; seed < 200; seed += 1) {
      for (const [orientationIndex, orientation] of (["horizontal", "vertical"] as const).entries()) {
        const random = seededRandom(seed * 2 + orientationIndex);
        const direction = (seed + orientationIndex) % 2 === 0 ? "forward" : "reverse";
        const lane = 30 + Math.floor(random() * 190);
        const sourcePrimary = direction === "reverse"
          ? 610 + Math.floor(random() * 90)
          : -390 - Math.floor(random() * 90);
        const targetPrimary = 190 + Math.floor(random() * 90);
        const chipPrimarySize = 24 + Math.floor(random() * 18);
        const chipCrossSize = 16 + Math.floor(random() * 12);
        const panePrimarySize = 80 + Math.floor(random() * 45);
        const paneCrossSize = 50 + Math.floor(random() * 35);
        const source = orientedRect(sourcePrimary, lane, chipPrimarySize, chipCrossSize, orientation);
        const target = orientedRect(targetPrimary, lane, chipPrimarySize, chipCrossSize, orientation);
        const sourcePane = orientedRect(sourcePrimary - 20, lane - 20, panePrimarySize, paneCrossSize, orientation);
        const destinationPane = orientedRect(targetPrimary - 20, lane - 20, panePrimarySize, paneCrossSize, orientation);
        const workspacePrefix = 130 + Math.floor(random() * 85);
        const destinationWorkspace = orientedRect(
          targetPrimary - workspacePrefix,
          lane - 30,
          workspacePrefix + panePrimarySize + 30,
          paneCrossSize + 20,
          orientation,
        );
        const afterChip = orientedRect(
          targetPrimary - workspacePrefix + 25 + Math.floor(random() * 45),
          lane + 3 + Math.floor(random() * 5),
          12 + Math.floor(random() * 12),
          8 + Math.floor(random() * 8),
          orientation,
        );
        const paneCount = 2 + ((seed + orientationIndex) % 4);
        const paneRects = new Map<string, GroupingLineRect>([
          ["source", sourcePane],
          ["destination", destinationPane],
        ]);
        const extraPanes: GroupingLineRect[] = [];
        for (let index = 0; index < paneCount - 2; index += 1) {
          const base = direction === "reverse" ? 360 : -150;
          const primary = base + index * (65 + Math.floor(random() * 25));
          const pane = orientedRect(
            primary,
            lane - 24 + Math.floor(random() * 10),
            70 + Math.floor(random() * 35),
            48 + Math.floor(random() * 28),
            orientation,
          );
          extraPanes.push(pane);
          paneRects.set(`middle-${index}`, pane);
        }
        const line = {
          tabId: `route-${seed}-${orientation}`,
          label: "route",
          fromWorkspaceId: "source-ws",
          toWorkspaceId: "destination-ws",
          fromRect: null,
          toRect: null,
        };
        const afterChipRects = seed % 2 === 0
          ? new Map([[line.tabId, target], ["after-chip", afterChip]])
          : new Map([["after-chip", afterChip], [line.tabId, target]]);
        const measured = groupingMeasuredMoveLines({
          lines: [line],
          fromRects: new Map([[line.tabId, source]]),
          toRects: new Map([[line.tabId, target]]),
          afterChipRects,
          paneRects,
          sourcePaneIds: new Map([[line.tabId, "source"]]),
          destinationPaneIds: new Map([[line.tabId, "destination"]]),
          workspaceRects: new Map([[line.toWorkspaceId, destinationWorkspace]]),
          orientation,
        })[0];
        expect(measured, `${seed}/${orientation}/${direction}`).toBeDefined();
        expect(measured.destinationRect).toEqual(target);
        expect(
          routeCrosses(measured, [afterChip, ...extraPanes.flatMap(paneFrames)], orientation),
          `${seed}/${orientation}/${direction}`,
        ).toBe(false);
        expectRouteReachesDestination(measured, target, orientation);
        topologySignatures.add(hashCanonical({
          orientation,
          direction,
          source,
          target,
          destinationWorkspace,
          afterChip,
          paneRects: [...paneRects.values()],
          afterChipOrder: [...afterChipRects.keys()],
        }));
        paneCounts.add(paneCount);
        directionCounts[direction] += 1;
      }
    }
    expect(topologySignatures.size).toBe(400);
    expect([...paneCounts].sort()).toEqual([2, 3, 4, 5]);
    expect(directionCounts).toEqual({ forward: 200, reverse: 200 });
  });

  it("[G4-UX4-M-05] prevents the earlier real font-zoom capture listener from queuing zoom during drag", { timeout: 10_000 }, async () => {
    const detachZoom = attachGlobalFontZoom(window);
    try {
      await mountPanel();
      await enterEdit();
      const sourceChip = chip("t模試");
      hitElement = dropTarget("g2:0:0");
      await act(async () => sourceChip.dispatchEvent(pointer("pointerdown", 81, 10, 10)));
      await act(async () => window.dispatchEvent(pointer("pointermove", 81, 60, 40)));
      await flushFrames();
      const queuedBefore = frameQueue.size;
      await act(async () => window.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        deltaY: 100,
      })));
      expect(frameQueue.size, "font zoom must queue zero animation frames during grouping drag").toBe(queuedBefore);
    } finally {
      detachZoom();
      resetFontZoomQueueForTests();
    }
  });

  it("[G4-UX4-L-AUD2-01] wires OverlayShell onClose through the active-drag close guard", { timeout: 10_000 }, async () => {
    const addSpy = vi.spyOn(document, "addEventListener");
    const onClose = await mountPanel();
    await enterEdit();
    const sourceChip = chip("t模試");
    hitElement = dropTarget("g2:0:0");
    await act(async () => sourceChip.dispatchEvent(pointer("pointerdown", 82, 10, 10)));
    await act(async () => window.dispatchEvent(pointer("pointermove", 82, 60, 40)));
    await flushFrames();
    const overlayKeydown = addSpy.mock.calls
      .filter(([type]) => type === "keydown").at(-1)?.[1] as EventListener | undefined;
    if (!overlayKeydown) throw new Error("OverlayShell keydown listener was not captured");
    await act(async () => overlayKeydown(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })));
    expect(onClose).toHaveBeenCalledTimes(0);
    expect(document.querySelector(".cmux-tab-grouping-ghost")).not.toBeNull();
    await act(async () => window.dispatchEvent(pointer("pointercancel", 82, 60, 40)));
    await settle();
    const postCancelKeydown = addSpy.mock.calls
      .filter(([type]) => type === "keydown").at(-1)?.[1] as EventListener | undefined;
    if (!postCancelKeydown) throw new Error("post-cancel OverlayShell keydown listener was not captured");
    await act(async () => postCancelKeydown(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("[G4-UX5-A2-L-01] ignores a saved measurement rAF callback executed after Panel close", { timeout: 10_000 }, async () => {
    await mountPanel();
    await enterConfirm();
    const sideBySide = panel().querySelector<HTMLElement>(".cmux-tab-grouping-sidebyside");
    if (!sideBySide) throw new Error("side-by-side container is missing");
    for (const callback of resizeCallbacks) callback([{ target: sideBySide } as ResizeObserverEntry], {} as ResizeObserver);
    const savedFrame = [...frameQueue.values()][0];
    if (!savedFrame) throw new Error("saved measurement frame is missing");
    await unmountKeepingStores();
    frameQueue.clear();
    const rectSpy = vi.mocked(HTMLElement.prototype.getBoundingClientRect);
    rectSpy.mockClear();
    await act(async () => savedFrame(performance.now()));
    expect(rectSpy).toHaveBeenCalledTimes(0);
    expect(frameQueue.size).toBe(0);
    expect(document.querySelector(".cmux-tab-grouping-lines")).toBeNull();
  });

  it("[G4-UX5-A2-L-02] renders vertical SVG marker endpoints in the route direction", { timeout: 10_000 }, async () => {
    measuredWidth = 959;
    detourGeometry = true;
    await mountPanel();
    await enterConfirm();
    await flushFrames();
    const candidate = [...panel().querySelectorAll<SVGPathElement>("path.cmux-tab-grouping-line[data-tab-id]")]
      .find((path) => path.getAttribute("d")?.includes("L"))
      ?? panel().querySelector<SVGPathElement>("path.cmux-tab-grouping-line[data-tab-id]");
    if (!candidate?.dataset.tabId) throw new Error("vertical move path is missing");
    const afterChip = panel().querySelector<HTMLElement>(`[data-grouping-side="after"][data-tab-id="${candidate.dataset.tabId}"]`);
    if (!afterChip) throw new Error("vertical destination chip is missing");
    await click(afterChip);
    const selectedPath = panel().querySelector<SVGPathElement>(`path.cmux-tab-grouping-line[data-tab-id="${candidate.dataset.tabId}"]`)!;
    const leadIn = panel().querySelector<SVGPathElement>(`path.cmux-tab-grouping-leadin[data-tab-id="${candidate.dataset.tabId}"]`);
    const start = panel().querySelector<SVGCircleElement>("circle.cmux-tab-grouping-line-start")!;
    const arrow = panel().querySelector<SVGPathElement>("path.cmux-tab-grouping-line-arrow")!;
    const mainValues = selectedPath.getAttribute("d")?.match(/-?[\d.]+/g)?.map(Number) ?? [];
    const endpointValues = leadIn?.getAttribute("d")?.match(/-?[\d.]+/g)?.map(Number) ?? mainValues;
    const arrowValues = arrow.getAttribute("d")?.match(/-?[\d.]+/g)?.map(Number) ?? [];
    expect(panel().querySelector(".cmux-tab-grouping-sidebyside")?.classList.contains("is-stacked")).toBe(true);
    expect(mainValues.length).toBeGreaterThanOrEqual(4);
    expect(Number(start.getAttribute("cx"))).toBeCloseTo(mainValues[0]);
    expect(Number(start.getAttribute("cy"))).toBeCloseTo(mainValues[1]);
    expect(arrowValues[0]).toBeCloseTo(endpointValues.at(-2)!);
    expect(arrowValues[1]).toBeCloseTo(endpointValues.at(-1)!);
  });
});

describe("H. phase-2 retirement", () => {
  it("[P2-01] retires the panel and the Dashboard together after a successful apply", { timeout: 10_000 }, async () => {
    useDashboardViewStore.setState({ open: true });
    const onClose = await mountPanel();
    await enterConfirm();
    await applyCurrentPlan();
    expect(latestCommit().commit.ok).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(useDashboardViewStore.getState().open).toBe(false);
  });
});
