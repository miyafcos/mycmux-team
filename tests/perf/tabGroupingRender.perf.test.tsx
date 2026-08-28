// @vitest-environment jsdom
// These are jsdom render measurements; Gate 5-R must remeasure p95 on the real WebView2 runtime.
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const analysisHarness = vi.hoisted(() => ({ value: null as unknown }));
const liveRenderHarness = vi.hoisted(() => ({ counts: new Map<string, number>() }));
const parentRenderHarness = vi.hoisted(() => ({ panel: 0, sideBySide: 0 }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => true) }));

vi.mock("../../src/components/layout/tabGrouping", async (importActual) => {
  const actual = await importActual<typeof import("../../src/components/layout/tabGrouping")>();
  return { ...actual, runGroupingAnalysis: vi.fn(async () => analysisHarness.value) };
});

vi.mock("../../src/components/common/OverlayShell", async (importActual) => {
  const actual = await importActual<typeof import("../../src/components/common/OverlayShell")>();
  return {
    ...actual,
    OverlayShell: (props: ComponentProps<typeof actual.OverlayShell>) => {
      parentRenderHarness.panel += 1;
      return <actual.OverlayShell {...props} />;
    },
  };
});

vi.mock("../../src/components/layout/groupingMoveLines", async (importActual) => {
  const actual = await importActual<typeof import("../../src/components/layout/groupingMoveLines")>();
  return {
    ...actual,
    groupingSideBySideOrientation: (...args: Parameters<typeof actual.groupingSideBySideOrientation>) => {
      parentRenderHarness.sideBySide += 1;
      return actual.groupingSideBySideOrientation(...args);
    },
  };
});

vi.mock("../../src/components/layout/GroupingLiveChip", async (importActual) => {
  const actual = await importActual<typeof import("../../src/components/layout/GroupingLiveChip")>();
  const React = await import("react");
  const MeasuredBadge = React.memo((props: ComponentProps<typeof actual.GroupingLiveChipBadge>) => (
    <React.Profiler
      id={props.sessionId}
      onRender={(id, phase) => {
        if (phase === "mount") return;
        liveRenderHarness.counts.set(id, (liveRenderHarness.counts.get(id) ?? 0) + 1);
      }}
    >
      <actual.GroupingLiveChipBadge {...props} />
    </React.Profiler>
  ));
  return { ...actual, GroupingLiveChipBadge: MeasuredBadge };
});

import { tabGroupingStrings } from "../../src/components/dashboard/dashboardStrings";
import {
  groupingChangedWorkspaceIds,
  TabGroupingPanel,
} from "../../src/components/layout/TabGroupingPanel";
import { groupingBoundary } from "../../src/components/layout/groupingBoundary";
import { defaultLayoutForTabs, type GroupingPlan } from "../../src/components/layout/tabGrouping";
import {
  __resetPersistenceCoordinatorForTests,
  markPersistentSchemaSupported,
} from "../../src/lib/workspacePersistenceCoordinator";
import {
  __resetGroupingRuntimeForTests,
  recordPersistentSchemaState,
} from "../../src/stores/groupingRuntimeStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useSessionAttentionStore } from "../../src/stores/sessionAttentionStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import type { Pane, PaneTab, Workspace } from "../../src/types/workspace";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const FIXED_NOW = 1_800_000_000_000;
const D2_TARGET_SESSION = "session-D2-tab-0";

let root: Root | null = null;
let frameQueue = new Map<number, FrameRequestCallback>();
let nextFrameId = 1;

interface PerfStat {
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly samples: number;
}

function tab(id: string, ordinal: number, firstTabId: string, secondTabId: string): PaneTab {
  const origin: PaneTab["origin"] = ordinal === 0
    ? { kind: "human" }
    : ordinal === 1
      ? { kind: "agent", parentTabId: firstTabId }
      : ordinal === 2
        ? { kind: "agent", parentTabId: secondTabId }
        : { kind: "human" };
  return {
    id,
    sessionId: `session-${id}`,
    agentId: "shell-starter",
    agentKind: "codex",
    type: "terminal",
    label: `tab-${id}`,
    labelSource: "user",
    cwd: `C:\\work\\${id}`,
    origin,
  };
}

function pane(id: string, tabs: PaneTab[]): Pane {
  return {
    id,
    agentId: "shell-starter",
    sessionId: tabs[0]?.sessionId ?? `session-${id}`,
    activeTabId: tabs[0]?.id ?? "",
    tabs,
    label: `pane-${id}`,
    cwd: tabs[0]?.cwd ?? "C:\\work",
  };
}

function workspace(id: string, tabs: PaneTab[], createdAt: number): Workspace {
  const paneId = `${id}-pane`;
  return {
    id,
    name: id,
    gridTemplateId: "1x1",
    panes: [pane(paneId, tabs)],
    splitColumns: [[paneId]],
    columnWidths: [100],
    rowHeightsPerCol: [[100]],
    status: "running",
    createdAt,
  };
}

function workspaces(distribution: "D1" | "D2"): Workspace[] {
  const ids = Array.from({ length: 100 }, (_, index) => `${distribution}-tab-${index}`);
  const tabs = ids.map((id, index) => tab(id, index, ids[0], ids[1]));
  if (distribution === "D2") return [workspace("D2-ws-0", tabs, FIXED_NOW)];
  return Array.from({ length: 10 }, (_, index) => workspace(
    `D1-ws-${index}`,
    tabs.slice(index * 10, (index + 1) * 10),
    FIXED_NOW + index,
  ));
}

function allTabIds(items: readonly Workspace[]): string[] {
  return items.flatMap((item) => item.panes.flatMap((itemPane) => itemPane.tabs.map((itemTab) => itemTab.id)));
}

function d2Plan(items: readonly Workspace[]): GroupingPlan {
  const ids = allTabIds(items);
  const moved = ids.slice(0, 50);
  return {
    planId: "D2-plan",
    title: "D2性能案",
    rationale: "100タブの描画分離を測る",
    strategy: "project",
    groups: [{
      groupId: "D2-group",
      title: "移動対象",
      disposition: "reorganize",
      destination: { kind: "new_workspace", proposedName: "D2移動先" },
      layout: defaultLayoutForTabs(moved, "D2母艦"),
      tabIds: moved,
      adopted: true,
    }],
    unassignedTabIds: ids.slice(50),
    warnings: [],
  };
}

function d1Plan(items: readonly Workspace[]): GroupingPlan {
  const ids = allTabIds(items);
  const moved = [ids[0], ids[20]];
  return {
    planId: "D1-plan",
    title: "D1性能案",
    rationale: "変更ワークスペースを3件に限定する",
    strategy: "project",
    groups: [{
      groupId: "D1-group",
      title: "三点変更",
      disposition: "reorganize",
      destination: { kind: "existing_workspace", workspaceId: "D1-ws-1" },
      layout: defaultLayoutForTabs(moved, "D1母艦"),
      tabIds: moved,
      adopted: true,
    }],
    unassignedTabIds: ids.filter((id) => !moved.includes(id)),
    warnings: [],
  };
}

function analysisFor(items: Workspace[], plan: GroupingPlan) {
  const baseline = items.flatMap((item) => item.panes.flatMap((itemPane) => itemPane.tabs.map((itemTab) => ({
    tabId: itemTab.id,
    workspaceId: item.id,
    paneId: itemPane.id,
    sessionId: itemTab.sessionId,
  }))));
  return {
    scan: {
      scannedAt: FIXED_NOW,
      tabs: items.flatMap((item) => item.panes.flatMap((itemPane) => itemPane.tabs.map((itemTab) => ({
        id: itemTab.id,
        sessionId: itemTab.sessionId,
        label: itemTab.label ?? itemTab.id,
        labelSource: itemTab.labelSource,
        cwd: itemTab.cwd ?? "",
        agentKind: itemTab.agentKind ?? "codex",
        origin: itemTab.origin,
        workspaceId: item.id,
        workspaceName: item.name,
        paneId: itemPane.id,
        column: 1,
        lastOutputAt: null,
        tail: [],
      })))),
      lineageClusters: [],
      baseline,
      workspaceIds: items.map((item) => item.id),
      workspaces: structuredClone(items),
    },
    parsed: {
      status: "ok" as const,
      plans: [structuredClone(plan)],
      droppedPlans: [],
      comparisonInsufficient: false,
      raw: "fixture",
    },
    retried: false,
    raw: "fixture",
  };
}

function resetStores(items: Workspace[] = []): void {
  __resetGroupingRuntimeForTests();
  __resetPersistenceCoordinatorForTests();
  markPersistentSchemaSupported(1);
  recordPersistentSchemaState({ loadedSchemaVersion: 1, migrationComplete: true });
  useWorkspaceListStore.setState({
    workspaces: structuredClone(items),
    layoutRevision: 1,
    activeWorkspaceId: items[0]?.id ?? null,
    lastActivePaneByWorkspace: Object.fromEntries(items.flatMap((item) => {
      const sessionId = item.panes[0]?.tabs[0]?.sessionId;
      return sessionId ? [[item.id, sessionId]] : [];
    })),
  });
  const active = items[0]?.panes[0]?.tabs[0]?.sessionId ?? null;
  useUiStore.setState({ activePaneId: active, lastActivePaneId: active, focusRevision: 0 });
  usePaneMetadataStore.setState({
    metadata: active ? { [active]: { agentStatus: "working", agentKind: "codex" } } : {},
    volatileMetadata: active ? { [active]: { backendLastOutputAt: FIXED_NOW - 60_000 } } : {},
    lastLog: {},
    lastLogAt: {},
  });
  useSessionAttentionStore.setState({
    attentionBySession: {},
    statusSignalsBySession: {},
    seenAttentionByTab: new Map(),
    doneMarkByTab: new Map(),
    nextOccurrenceOrder: 1,
    serverEpoch: null,
    lastSeq: 0,
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mountPanel(): Promise<void> {
  const container = document.createElement("div");
  document.body.replaceChildren(container);
  root = createRoot(container);
  await act(async () => root?.render(<TabGroupingPanel open visible intent={null} onClose={() => {}} />));
  await settle();
}

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((item) => item.textContent?.trim() === label);
  if (!match) throw new Error(`button not found: ${label}`);
  return match;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 })));
  await settle();
}

function pointer(type: string, pointerId: number, clientX: number, clientY: number): PointerEvent {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    button: { value: 0 },
    clientX: { value: clientX },
    clientY: { value: clientY },
    isPrimary: { value: true },
    pointerId: { value: pointerId },
    screenX: { value: clientX },
    screenY: { value: clientY },
  });
  return event as PointerEvent;
}

function installFrameHarness(): void {
  nextFrameId = 1;
  frameQueue = new Map();
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    const id = nextFrameId;
    nextFrameId += 1;
    frameQueue.set(id, callback);
    return id;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => frameQueue.delete(id)));
}

async function flushSingleFrame(): Promise<void> {
  const callbacks = [...frameQueue.values()];
  frameQueue.clear();
  if (callbacks.length !== 1) throw new Error(`expected one rAF callback, got ${callbacks.length}`);
  await act(async () => callbacks[0](performance.now()));
  await settle();
}

async function measureAsync(run: () => Promise<void>): Promise<PerfStat> {
  await run();
  await run();
  const measured: number[] = [];
  for (let index = 0; index < 21; index += 1) {
    const started = performance.now();
    await run();
    measured.push(performance.now() - started);
  }
  measured.sort((left, right) => left - right);
  return {
    medianMs: measured[Math.floor(measured.length / 2)],
    p95Ms: measured[Math.min(measured.length - 1, Math.ceil(0.95 * measured.length) - 1)],
    samples: measured.length,
  };
}

function logStat(itemId: "(e)", stat: PerfStat, thresholdMs: number): void {
  console.log(
    `perf/G5-P ${itemId} D2 median=${stat.medianMs.toFixed(3)}ms p95=${stat.p95Ms.toFixed(3)}ms n=${stat.samples}`,
  );
  if (stat.p95Ms > thresholdMs) console.log("WARN p95 over target");
}

beforeEach(() => {
  liveRenderHarness.counts.clear();
  parentRenderHarness.panel = 0;
  parentRenderHarness.sideBySide = 0;
  resetStores();
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetStores();
});

describe("G5-P 100-tab render isolation", () => {
  it("(d) updates only the two D2 badge copies and keeps the parent stable across 30 clock ticks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    const items = workspaces("D2");
    const plan = d2Plan(items);
    resetStores(items);
    analysisHarness.value = analysisFor(items, plan);
    await mountPanel();
    await click(button(tabGroupingStrings.confirmPlan));

    expect(document.querySelectorAll(".cmux-tab-grouping-live")).toHaveLength(200);
    liveRenderHarness.counts.clear();
    parentRenderHarness.panel = 0;
    parentRenderHarness.sideBySide = 0;

    await act(async () => {
      usePaneMetadataStore.getState().setVolatileMetadata(D2_TARGET_SESSION, {
        backendLastOutputAt: FIXED_NOW - 30_000,
      });
    });
    await settle();
    expect(liveRenderHarness.counts.get(D2_TARGET_SESSION)).toBe(2);
    expect([...liveRenderHarness.counts.entries()].filter(([id]) => id !== D2_TARGET_SESSION)).toEqual([]);
    expect(parentRenderHarness).toEqual({ panel: 0, sideBySide: 0 });

    liveRenderHarness.counts.clear();
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    await act(async () => vi.advanceTimersByTime(30 * 30_000));
    await settle();
    expect(parentRenderHarness).toEqual({ panel: 0, sideBySide: 0 });
    expect(rectSpy).not.toHaveBeenCalled();
    expect([...liveRenderHarness.counts.keys()].filter((id) => id !== D2_TARGET_SESSION)).toEqual([]);
    expect(liveRenderHarness.counts.get(D2_TARGET_SESSION)).toBeGreaterThan(0);

    parentRenderHarness.panel = 0;
    await act(async () => root?.render(<TabGroupingPanel open visible intent={null} onClose={vi.fn()} />));
    await settle();
    expect(parentRenderHarness.panel).toBeGreaterThan(0);
  });

  it("(e) keeps D2 drag pointer median under 4ms, the parent stable, and 100 moves coalesced", async () => {
    installFrameHarness();
    const items = workspaces("D2");
    const plan = d2Plan(items);
    resetStores(items);
    analysisHarness.value = analysisFor(items, plan);
    await mountPanel();
    await click(button(tabGroupingStrings.editPlan));

    const source = document.querySelector<HTMLButtonElement>(
      ".cmux-tab-grouping-editmap button.cmux-tab-grouping-chip[data-tab-id]",
    );
    const destination = document.querySelector<HTMLElement>(".cmux-tab-grouping-editmap [data-drop-id]");
    if (!source || !destination) throw new Error("D2 drag fixture is missing");
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => destination) });
    Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: vi.fn(() => [destination]) });

    frameQueue.clear();
    await act(async () => source.dispatchEvent(pointer("pointerdown", 71, 10, 10)));
    await act(async () => window.dispatchEvent(pointer("pointermove", 71, 20, 10)));
    await flushSingleFrame();
    expect(document.querySelectorAll(".cmux-tab-grouping-ghost")).toHaveLength(1);

    parentRenderHarness.panel = 0;
    parentRenderHarness.sideBySide = 0;
    let coordinate = 21;
    const stat = await measureAsync(async () => {
      coordinate += 1;
      await act(async () => window.dispatchEvent(pointer("pointermove", 71, coordinate, 10)));
      await flushSingleFrame();
    });
    logStat("(e)", stat, 4);
    expect(stat.medianMs).toBeLessThanOrEqual(4);
    expect(parentRenderHarness).toEqual({ panel: 0, sideBySide: 0 });

    frameQueue.clear();
    const requestFrame = vi.mocked(requestAnimationFrame);
    const priorCalls = requestFrame.mock.calls.length;
    for (let index = 0; index < 100; index += 1) {
      window.dispatchEvent(pointer("pointermove", 71, 100 + index, 10));
    }
    expect(requestFrame.mock.calls.length - priorCalls).toBe(1);
    expect(frameQueue.size).toBe(1);
    await flushSingleFrame();
    expect(frameQueue.size).toBe(0);
    expect(parentRenderHarness).toEqual({ panel: 0, sideBySide: 0 });

    parentRenderHarness.panel = 0;
    await act(async () => root?.render(<TabGroupingPanel open visible intent={null} onClose={vi.fn()} />));
    await settle();
    expect(parentRenderHarness.panel).toBeGreaterThan(0);
    await act(async () => window.dispatchEvent(pointer("pointercancel", 71, 200, 10)));
  });

  it("(f) shows exactly three D1 workspaces with changed-only on and restores all ten", async () => {
    const items = workspaces("D1");
    const plan = d1Plan(items);
    resetStores(items);
    analysisHarness.value = analysisFor(items, plan);
    const preview = groupingBoundary.preview(plan, {
      baseline: analysisFor(items, plan).scan.baseline,
      activeWorkspaceId: "D1-ws-0",
      activeSessionId: "session-D1-tab-0",
      allocationSeed: "g5p-D1",
      createdAt: FIXED_NOW,
      newWorkspaceDefaults: { status: "running", pet: "clawd" },
    });
    if (!preview.ok) throw new Error(preview.errors.join(" / "));
    const expected = groupingChangedWorkspaceIds(items, preview.transaction.workspaces);
    expect([...expected].sort()).toEqual(["D1-ws-0", "D1-ws-1", "D1-ws-2"]);

    await mountPanel();
    await click(button(tabGroupingStrings.editPlan));
    const map = document.querySelector<HTMLElement>(".cmux-tab-grouping-editmap");
    if (!map) throw new Error("D1 edit map is missing");
    const ids = () => [...map.querySelectorAll<HTMLElement>("[data-workspace-id]")]
      .map((item) => item.dataset.workspaceId ?? "");
    const full = ids();
    expect(full).toHaveLength(10);

    await click(button(tabGroupingStrings.changedOnly));
    expect(new Set(ids())).toEqual(expected);
    expect(ids()).toHaveLength(3);
    await click(button(tabGroupingStrings.changedOnly));
    expect(ids()).toEqual(full);
  });
});
