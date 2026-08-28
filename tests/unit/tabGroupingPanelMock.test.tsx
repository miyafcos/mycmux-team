// @vitest-environment jsdom

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const analysisHarness = vi.hoisted(() => ({ value: null as unknown }));
const boundaryHarness = vi.hoisted(() => ({ prepared: null as unknown, committed: null as unknown }));
const liveRenderHarness = vi.hoisted(() => ({ counts: new Map<string, number>() }));
const parentRenderHarness = vi.hoisted(() => ({ panel: 0, sideBySide: 0 }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => true),
}));

vi.mock("../../src/components/layout/tabGrouping", async (importActual) => {
  const actual = await importActual<typeof import("../../src/components/layout/tabGrouping")>();
  return {
    ...actual,
    runGroupingAnalysis: vi.fn(async () => analysisHarness.value),
  };
});

vi.mock("../../src/components/layout/groupingBoundary", async (importActual) => {
  const actual = await importActual<typeof import("../../src/components/layout/groupingBoundary")>();
  return {
    ...actual,
    groupingBoundary: {
      ...actual.groupingBoundary,
      prepare: (...args: Parameters<typeof actual.groupingBoundary.prepare>) => {
        const result = actual.groupingBoundary.prepare(...args);
        boundaryHarness.prepared = result;
        return result;
      },
      commit: (...args: Parameters<typeof actual.groupingBoundary.commit>) => {
        const result = actual.groupingBoundary.commit(...args);
        boundaryHarness.committed = result;
        return result;
      },
    },
  };
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

import { TabGroupingPanel } from "../../src/components/layout/TabGroupingPanel";
import { groupingMoveDiffs, groupingMoveLines } from "../../src/components/layout/groupingMoveLines";
import { groupingLineageNodes } from "../../src/components/layout/groupingLineage";
import { groupingBoundary } from "../../src/components/layout/groupingBoundary";
import { contrastRatio, isHexColor, mixHex } from "../../src/components/theme/colorContrast";
import { getTheme } from "../../src/components/theme/themeDefinitions";
import { applyActiveTabFields } from "../../src/lib/paneTabState";
import { DEFAULT_THEME_BACKGROUND } from "../../src/lib/themeBackgrounds";
import { persistentLayoutSignature } from "../../src/lib/persistentLayoutProjection";
import { resolveTheme, resolvedThemeToCssVars, type ResolvedTheme } from "../../src/lib/theme/resolveTheme";
import { useGroupingRuntimeStore } from "../../src/stores/groupingRuntimeStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useSessionAttentionStore } from "../../src/stores/sessionAttentionStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { tabGroupingStrings } from "../../src/components/dashboard/dashboardStrings";
import { mockGroupingAnalysis, mockWorkspaces } from "./fixtures/tabGroupingMockScenario";
import { structuralUndoSignature } from "./helpers/groupingTestEntrypoint";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
analysisHarness.value = mockGroupingAnalysis;

const globalCss = readFileSync("src/global.css", "utf8");
const panelCss = readFileSync("src/components/layout/TabGroupingPanel.css", "utf8");
const outputDirectory = process.env.MYCMUX_GROUPING_MOCK_OUT;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function cloneWorkspaces() {
  return structuredClone(mockWorkspaces);
}

function fiveMoveAnalysis() {
  const analysis = structuredClone(mockGroupingAnalysis);
  const plan = analysis.parsed.plans.find((candidate) => candidate.planId === "p1");
  if (!plan) throw new Error("project fixture plan is missing");
  const first = plan.groups.find((group) => group.groupId === "g1");
  const second = plan.groups.find((group) => group.groupId === "g2");
  if (!first || !second) throw new Error("project fixture groups are missing");
  first.destination = { kind: "existing_workspace", workspaceId: "wsA" };
  second.destination = { kind: "existing_workspace", workspaceId: "wsB" };
  analysis.parsed.plans = [plan];
  return analysis;
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

function cubicSamples(path: string, segments = 32): Array<{ x: number; y: number }> {
  const match = path.match(/^M\s+(-?[\d.]+)\s+(-?[\d.]+)\s+C\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)$/);
  if (!match) throw new Error(`unexpected cubic path: ${path}`);
  const [x0, y0, x1, y1, x2, y2, x3, y3] = match.slice(1).map(Number);
  return Array.from({ length: segments + 1 }, (_, index) => {
    const t = index / segments;
    const inverse = 1 - t;
    return {
      x: inverse ** 3 * x0 + 3 * inverse ** 2 * t * x1 + 3 * inverse * t ** 2 * x2 + t ** 3 * x3,
      y: inverse ** 3 * y0 + 3 * inverse ** 2 * t * y1 + 3 * inverse * t ** 2 * y2 + t ** 3 * y3,
    };
  });
}

function installMeasurementHarness() {
  const observed = new Set<Element>();
  const unobserved = new Set<Element>();
  const frames: FrameRequestCallback[] = [];
  let resizeCallback: ResizeObserverCallback | null = null;
  let disconnected = 0;
  class MeasurementResizeObserver implements ResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      resizeCallback = callback;
    }

    observe(target: Element) {
      observed.add(target);
    }

    unobserve(target: Element) {
      unobserved.add(target);
    }

    disconnect() {
      disconnected += 1;
    }

    takeRecords(): ResizeObserverEntry[] {
      return [];
    }
  }
  vi.stubGlobal("ResizeObserver", MeasurementResizeObserver);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  const cancelFrame = vi.fn();
  vi.stubGlobal("cancelAnimationFrame", cancelFrame);
  const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
    const element = this as HTMLElement;
    if (element.classList.contains("cmux-tab-grouping-sidebyside")) return domRect(0, 0, 1000, 800);
    const tabId = element.dataset.tabId;
    if (tabId) {
      const index = [...tabId].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 20;
      return domRect(element.dataset.groupingSide === "after" ? 620 : 60, 50 + index * 28, 120, 22);
    }
    if (element.dataset.workspaceId) return domRect(element.closest(".is-after") ? 560 : 20, 20, 400, 700);
    return domRect(0, 0, 0, 0);
  });
  return {
    observed,
    unobserved,
    frames,
    cancelFrame,
    rectSpy,
    get resizeCallback() { return resizeCallback; },
    get disconnected() { return disconnected; },
  };
}

function setRuntimeUndo(
  status: "available" | "expired" = "available",
  options: {
    movedTabCount?: number;
    appliedLayoutSignature?: ReturnType<typeof persistentLayoutSignature>;
    emptyWorkspaceIds?: string[];
    snapshotWorkspaces?: ReturnType<typeof cloneWorkspaces>;
  } = {},
) {
  const currentWorkspaces = useWorkspaceListStore.getState().workspaces;
  const snapshotWorkspaces = options.snapshotWorkspaces ?? cloneWorkspaces();
  useGroupingRuntimeStore.setState({
    undo: {
      recordId: `mock-undo-${status}`,
      schemaVersion: 1,
      snapshot: {
        schemaVersion: 1,
        workspaces: snapshotWorkspaces,
        selection: {
          activeWorkspaceId: "wsA",
          activeSessionId: "session-t請求",
          lastActivePaneByWorkspace: { wsA: "session-t請求" },
        },
      },
      report: {
        movedTabCount: options.movedTabCount ?? 3,
        affectedWorkspaceIds: ["wsA", "wsB"],
        emptyWorkspaceIds: options.emptyWorkspaceIds ?? [],
        appliedAt: 1,
      },
      appliedLayoutSignature: options.appliedLayoutSignature ?? persistentLayoutSignature(currentWorkspaces),
      expectedStructuralSignature: structuralUndoSignature(currentWorkspaces),
      committedLayoutRevision: 1,
      createdAt: 1,
      status,
      expireReason: status === "expired" ? tabGroupingStrings.undoExpired : null,
    },
  });
}

function resetStores() {
  const now = Date.now();
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
    workspaces: cloneWorkspaces(),
    layoutRevision: 1,
    activeWorkspaceId: "wsA",
    lastActivePaneByWorkspace: { wsA: "session-t請求", wsB: "session-t統括", wsC: "session-t数学" },
  });
  usePaneMetadataStore.setState({
    metadata: {
      "session-t請求": { processIsShell: false, agentStatus: "working", agentKind: "codex" },
      "session-tkessan": { agentStatus: "waiting", agentKind: "codex" },
      "session-t統括": { agentStatus: "done", agentKind: "claude" },
      "session-t数学": { agentStatus: "idle", agentKind: "codex" },
      "session-t模試": { agentStatus: "idle", agentKind: "claude" },
    },
    volatileMetadata: {
      "session-t請求": { outputActive: true, backendLastOutputAt: now - 12 * 60_000 },
      "session-tkessan": { backendLastOutputAt: now - 35 * 60_000 },
      "session-t統括": { backendLastOutputAt: now - 2 * 60 * 60_000 },
      "session-t数学": { backendLastOutputAt: now - 4 * 60 * 60_000 },
      "session-t模試": { backendLastOutputAt: now - 8 * 60_000 },
    },
  });
  useSessionAttentionStore.setState({
    attentionBySession: {
      "session-t模試": {
        sessionId: "session-t模試",
        sessionEpoch: null,
        attentionId: "mock-error",
        kind: "error",
        detail: "mock error",
        sessionRevision: 1,
        uiState: "waiting",
        stateSince: now,
        occurrenceOrder: 1,
      },
    },
    seenAttentionByTab: new Map(),
  });
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mountPanel(onClose: () => void = () => {}, intent?: "review") {
  container = document.createElement("div");
  document.body.replaceChildren(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<TabGroupingPanel open visible intent={intent} onClose={onClose} />);
  });
  await settle();
}

function button(label: string): HTMLButtonElement {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("button")];
  const match = buttons.find((item) => item.textContent?.trim() === label)
    ?? buttons.find((item) => item.textContent?.includes(label));
  if (!match) throw new Error(`button not found: ${label}`);
  return match;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

async function openEditWithSelection() {
  await click(button(tabGroupingStrings.editPlan));
  const rows = [...document.querySelectorAll<HTMLButtonElement>(".cmux-tab-grouping-editmap button.cmux-tab-grouping-chip")];
  expect(rows.length).toBeGreaterThanOrEqual(2);
  await click(rows[0]);
  await click(rows[1]);
}

async function openConfirm() {
  await click(button(tabGroupingStrings.confirmPlan));
  await settle();
}

function preparedTransaction() {
  const prepared = boundaryHarness.prepared as ReturnType<typeof groupingBoundary.prepare> | null;
  expect(prepared?.ok).toBe(true);
  if (!prepared?.ok) throw new Error("expected the grouping prepare harness to capture a ticket");
  return prepared.ticket.transaction;
}

async function dispatchMouse(element: Element, type: "mouseover" | "mouseout") {
  await act(async () => {
    element.dispatchEvent(new MouseEvent(type, { bubbles: true }));
  });
  await settle();
}

function themeSnapshotCss(themeId: "mayonaka" | "paper") {
  const theme = getTheme(themeId);
  const { resolved } = resolveTheme({
    theme,
    background: { ...DEFAULT_THEME_BACKGROUND, mode: "solid", solidSurfaces: true },
    mediaActive: false,
  });
  const vars = resolvedThemeToCssVars(resolved);
  const declarations = Object.entries(vars).map(([name, value]) => `${name}:${value};`).join("");
  return { resolved, css: `:root{${declarations}color-scheme:${resolved.colorScheme};}` };
}

function verifyReadableLightSnapshot(resolved: ResolvedTheme) {
  const hosts = [resolved.bg, resolved.surface, resolved.surfaceRaised, resolved.popover];
  const foregrounds = [resolved.text, resolved.textSecondary, resolved.textTertiary];
  const failures: string[] = [];
  for (const value of [...hosts, ...foregrounds, resolved.accent, resolved.onAccent]) {
    if (!isHexColor(value)) failures.push(`not an opaque colour: ${value}`);
  }
  for (const foreground of foregrounds) {
    for (const background of hosts) {
      const ratio = contrastRatio(foreground, background);
      if (ratio < 4.5) failures.push(`${foreground} / ${background} = ${ratio.toFixed(2)}:1`);
    }
  }
  const statePairs = [
    [resolved.text, mixHex(resolved.yellow, resolved.popover, 0.78)],
    [resolved.text, mixHex(resolved.accent, resolved.surface, 0.88)],
    [resolved.text, mixHex(resolved.accent, resolved.popover, 0.78)],
    [resolved.onAccent, resolved.accent],
  ] as const;
  for (const [foreground, background] of statePairs) {
    const ratio = contrastRatio(foreground, background);
    if (ratio < 4.5) failures.push(`${foreground} / ${background} = ${ratio.toFixed(2)}:1`);
  }
  expect(failures).toEqual([]);
}

function standaloneHtml(body: string, themeId: "mayonaka" | "paper") {
  const theme = themeSnapshotCss(themeId);
  if (themeId === "paper") verifyReadableLightSnapshot(theme.resolved);
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>${globalCss}\n${theme.css}\n${panelCss}</style></head><body>${body}</body></html>`;
}

function escapeAttribute(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function writeMockFiles(states: Array<{ baseName: string; caption: string; body: string }>) {
  if (!outputDirectory) return;
  mkdirSync(outputDirectory, { recursive: true });
  const cards: string[] = [];
  for (const state of states) {
    for (const theme of ["mayonaka", "paper"] as const) {
      const suffix = theme === "paper" ? "_ライト" : "";
      const fileName = `${state.baseName}${suffix}.html`;
      const html = standaloneHtml(state.body, theme);
      expect(html.startsWith("<!doctype html>")).toBe(true);
      expect(html).toContain("cmux-tab-grouping");
      expect(html).not.toMatch(/https?:\/\//);
      writeFileSync(join(outputDirectory, fileName), html, "utf8");
      cards.push(`<figure><figcaption>${state.caption} / ${theme === "paper" ? "ライト" : "ダーク"}</figcaption><iframe title="${state.caption} / ${theme}" srcdoc="${escapeAttribute(html)}"></iframe></figure>`);
    }
  }
  const index = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>body{margin:0;padding:16px;font-family:system-ui,sans-serif;background:#202124;color:#fff}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}figure{margin:0}figcaption{margin-bottom:6px;font-weight:700}iframe{width:100%;height:720px;border:1px solid #777;border-radius:6px;background:#fff}</style></head><body><main class="grid">${cards.join("")}</main></body></html>`;
  expect(index).toContain("cmux-tab-grouping");
  expect(index).not.toMatch(/https?:\/\//);
  writeFileSync(join(outputDirectory, "index.html"), index, "utf8");
}

beforeEach(() => {
  analysisHarness.value = mockGroupingAnalysis;
  boundaryHarness.prepared = null;
  boundaryHarness.committed = null;
  liveRenderHarness.counts.clear();
  parentRenderHarness.panel = 0;
  parentRenderHarness.sideBySide = 0;
  resetStores();
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
  }
  root = null;
  container = null;
  document.body.replaceChildren();
  resetStores();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("TabGroupingPanel mounted interaction", () => {
  it("selects the project strategy first", async () => {
    await mountPanel();
    const cards = [...document.querySelectorAll<HTMLElement>('[role="radio"]')];
    expect(cards[0]?.getAttribute("aria-checked")).toBe("true");
    expect(cards[0]?.dataset.strategy).toBe("project");
  });

  it("moves focus through the destination menu and returns it on Escape", async () => {
    const onClose = vi.fn();
    await mountPanel(onClose);
    await openEditWithSelection();
    const trigger = button(tabGroupingStrings.moveSelected);
    await click(trigger);
    const items = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(document.activeElement).toBe(items[0]);
    items[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(items[1]);
    items[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("opens confirmation in a side-by-side view with one line per cross-workspace move", async () => {
    await mountPanel();
    await openConfirm();

    expect(document.querySelectorAll(".cmux-tab-grouping-sidebyside")).toHaveLength(1);
    expect(document.querySelectorAll(".cmux-tab-grouping-sidebyside-pane.is-before")).toHaveLength(1);
    expect(document.querySelectorAll(".cmux-tab-grouping-sidebyside-pane.is-after")).toHaveLength(1);
    expect(document.querySelector(".cmux-tab-grouping-sidebyside")?.classList.contains("is-stacked")).toBe(false);

    const transaction = preparedTransaction();
    const expected = groupingMoveLines(cloneWorkspaces(), transaction.workspaces);
    expect(expected.map((line) => line.tabId)).toEqual(["t模試", "tb2", "t数学", "t請求", "tkessan"]);
    const paths = [...document.querySelectorAll<SVGPathElement>("path.cmux-tab-grouping-line")];
    expect(paths).toHaveLength(5);
    expect(paths).toHaveLength(expected.length);
    expect(paths).toHaveLength(transaction.expected.movedTabIds.length);
    const svg = document.querySelector<SVGSVGElement>("svg.cmux-tab-grouping-lines");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("focusable")).toBe("false");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 0 0");
    expect(svg?.getAttribute("preserveAspectRatio")).toBe("none");
    expect(document.body.textContent).toContain(tabGroupingStrings.sideBySideLegend);
    expect(document.querySelectorAll(".is-after .cmux-tab-grouping-workspace.is-new")).toHaveLength(2);
    const destinationWorkspaces = [...document.querySelectorAll<HTMLElement>(".is-after [data-workspace-id]")];
    const workspaceColorChips = [...document.querySelectorAll<HTMLElement>(".is-after .cmux-tab-grouping-workspace-color")];
    expect(workspaceColorChips).toHaveLength(transaction.workspaces.length);
    expect(workspaceColorChips.every((colorChip) => colorChip.getAttribute("aria-hidden") === "true")).toBe(true);
    expect(destinationWorkspaces.filter((workspace) => workspace.classList.contains("is-new"))
      .every((workspace) => workspace.querySelector(".cmux-tab-grouping-workspace-color") !== null)).toBe(true);
    expect(destinationWorkspaces.filter((workspace) => !workspace.classList.contains("is-new"))
      .every((workspace) => workspace.querySelector(".cmux-tab-grouping-workspace-color") !== null)).toBe(true);
    const workspaceHeadings = [...document.querySelectorAll<HTMLElement>(".cmux-tab-grouping-sidebyside .cmux-tab-grouping-workspace-head")];
    expect(workspaceHeadings).toHaveLength(cloneWorkspaces().length + transaction.workspaces.length);
    expect(workspaceHeadings.every((heading) => ["0", "-1"].includes(heading.getAttribute("tabindex") ?? ""))).toBe(true);
    expect(workspaceHeadings.every((heading) => heading.getAttribute("role") === "button")).toBe(true);
    expect(workspaceHeadings.every((heading) => heading.getAttribute("aria-pressed") === "false")).toBe(true);
    expect(workspaceHeadings.every((heading) => heading.getAttribute("aria-level") === null)).toBe(true);
    const sidePanes = [...document.querySelectorAll<HTMLElement>(".cmux-tab-grouping-sidebyside-pane")];
    expect(sidePanes).toHaveLength(2);
    expect(sidePanes.every((pane) => pane.getAttribute("role") === "group")).toBe(true);
    expect(sidePanes.every((pane) => pane.getAttribute("aria-label")?.includes("矢印キー") ?? false)).toBe(true);
    const movedChips = [...document.querySelectorAll<HTMLElement>('.cmux-tab-grouping-chip.is-moved[data-grouping-side]')];
    expect(movedChips.length).toBeGreaterThan(0);
    expect(movedChips.every((chip) => ["0", "-1"].includes(chip.getAttribute("tabindex") ?? ""))).toBe(true);
    expect(document.querySelectorAll('.cmux-tab-grouping-chip:not(.is-moved)[data-grouping-side][tabindex]')).toHaveLength(0);
    expect(document.querySelectorAll('.cmux-tab-grouping-sidebyside [tabindex="0"]')).toHaveLength(2);
    const rovingTargets = [...workspaceHeadings, ...movedChips];
    expect(rovingTargets.filter((target) => target.getAttribute("tabindex") === "-1"))
      .toHaveLength(rovingTargets.length - 2);

    const lineage = groupingLineageNodes(cloneWorkspaces());
    const beforeLineageItems = [...document.querySelectorAll<HTMLElement>('.is-before .cmux-tab-grouping-lineage-item')];
    expect(document.querySelectorAll("ul.cmux-tab-grouping-lineage").length).toBeGreaterThan(0);
    expect(beforeLineageItems).toHaveLength(mockWorkspaces.flatMap((workspace) => workspace.panes.flatMap((pane) => pane.tabs)).length);
    for (const item of beforeLineageItems) {
      const chip = item.querySelector<HTMLElement>(":scope > .cmux-tab-grouping-chip");
      if (!chip?.dataset.tabId) throw new Error("lineage item is missing its direct chip");
      expect(item.dataset.lineageDepth).toBe(String(lineage.get(chip.dataset.tabId)?.depth));
    }
    const parentLi = document.querySelector<HTMLElement>('.is-before .cmux-tab-grouping-chip[data-tab-id="t統括"]')?.closest("li");
    const childChip = document.querySelector<HTMLElement>('.is-before .cmux-tab-grouping-chip[data-tab-id="t配置図"]');
    expect(parentLi?.contains(childChip ?? null)).toBe(true);
    const sameWorkspaceRef = document.querySelector<HTMLElement>(
      '.is-before .cmux-tab-grouping-lineage-item[data-lineage-parent-ref="t請求"][data-lineage-parent-scope="pane"] > [data-tab-id="tosaka"]',
    );
    expect(sameWorkspaceRef).not.toBeNull();
    expect(sameWorkspaceRef?.textContent).toContain(tabGroupingStrings.liveParentRef("請求 期間確認", null));
    expect(parentLi?.contains(sameWorkspaceRef ?? null)).toBe(false);
    const orphan = document.querySelector<HTMLElement>(
      '.is-before .cmux-tab-grouping-lineage-item[data-lineage-orphan="true"] > [data-tab-id="tshinso"]',
    );
    expect(orphan).not.toBeNull();
    expect(orphan?.closest("li")?.hasAttribute("data-lineage-parent-ref")).toBe(false);

    expect(document.body.textContent).toContain(tabGroupingStrings.liveLegendWithParentRef);
    const expectedStatuses = {
      "t請求": "working",
      tkessan: "waiting",
      "t統括": "done",
      "t数学": "idle",
      "t模試": "error",
    } as const;
    const expectedMarks = { working: "●", waiting: "◐", done: "✓", idle: "", error: "✗" } as const;
    for (const [tabId, status] of Object.entries(expectedStatuses)) {
      const badges = [...document.querySelectorAll<HTMLElement>(`.cmux-tab-grouping-chip[data-tab-id="${tabId}"] .cmux-tab-grouping-live`)];
      expect(badges).toHaveLength(2);
      expect(badges.every((badge) => badge.dataset.status === status)).toBe(true);
      expect(badges.every((badge) => badge.getAttribute("role") === "img")).toBe(true);
      expect(badges.every((badge) => badge.getAttribute("aria-label")?.length !== 0)).toBe(true);
      expect(badges.every((badge) => badge.querySelector(".cmux-tab-grouping-live-mark")?.textContent === expectedMarks[status])).toBe(true);
      expect(badges.every((badge) => (badge.querySelector(".cmux-tab-grouping-live-age")?.textContent?.length ?? 0) > 0)).toBe(true);
    }
    const workingMovedTabIds = new Set(
      [...document.querySelectorAll<HTMLElement>('.is-after .cmux-tab-grouping-chip.is-moved .cmux-tab-grouping-live[data-status="working"]')]
        .map((badge) => badge.closest<HTMLElement>("[data-tab-id]")?.dataset.tabId)
        .filter((tabId): tabId is string => Boolean(tabId)),
    );
    expect(workingMovedTabIds.size).toBeGreaterThan(0);
    expect(paths.filter((path) => path.classList.contains("is-live")).map((path) => path.dataset.tabId).sort())
      .toEqual([...workingMovedTabIds].sort());
    expect(paths.filter((path) => !workingMovedTabIds.has(path.dataset.tabId ?? ""))
      .every((path) => !path.classList.contains("is-live"))).toBe(true);
    expect(document.querySelectorAll("path.cmux-tab-grouping-leadin")).toHaveLength(0);
    for (const line of expected) {
      const path = paths.find((item) => item.dataset.tabId === line.tabId);
      expect(path?.dataset.fromWs).toBe(line.fromWorkspaceId);
      expect(path?.dataset.toWs).toBe(line.toWorkspaceId);
      expect(path?.getAttribute("d")).toMatch(/^M .* C /);
      const lineColor = path?.closest<SVGGElement>("g")?.style.getPropertyValue("--grouping-line-color");
      expect(lineColor).not.toBe("");
      const destinationColorChip = destinationWorkspaces
        .find((workspace) => workspace.dataset.workspaceId === line.toWorkspaceId)
        ?.querySelector<HTMLElement>(".cmux-tab-grouping-workspace-color");
      expect(destinationColorChip?.style.backgroundColor).not.toBe("");

      const fromName = cloneWorkspaces().find((workspace) => workspace.id === line.fromWorkspaceId)?.name;
      const toName = transaction.workspaces.find((workspace) => workspace.id === line.toWorkspaceId)?.name;
      if (!fromName || !toName) throw new Error(`workspace name missing for ${line.tabId}`);
      const description = tabGroupingStrings.sideBySideMoveAriaDescription(fromName, toName);
      const endpointChips = [...document.querySelectorAll<HTMLElement>(`.cmux-tab-grouping-chip.is-moved[data-tab-id="${line.tabId}"]`)]
        .filter((endpoint) => endpoint.hasAttribute("data-grouping-side"));
      expect(endpointChips).toHaveLength(2);
      for (const endpoint of endpointChips) {
        const live = endpoint.querySelector<HTMLElement>(".cmux-tab-grouping-live");
        const status = live?.dataset.status;
        const labels = {
          working: tabGroupingStrings.liveStatusWorking,
          waiting: tabGroupingStrings.liveStatusWaiting,
          done: tabGroupingStrings.liveStatusDone,
          error: tabGroupingStrings.liveStatusError,
          idle: tabGroupingStrings.liveStatusIdle,
        } as const;
        if (!status || !(status in labels)) throw new Error(`live status missing for ${line.tabId}`);
        const age = live.querySelector(".cmux-tab-grouping-live-age")?.textContent ?? null;
        expect(endpoint.getAttribute("aria-description")).toBe(description);
        expect(live?.getAttribute("aria-label")).toBe(
          tabGroupingStrings.liveChipAriaDescription(labels[status as keyof typeof labels], age),
        );
      }
    }
    const nonMovedDescriptions = [...document.querySelectorAll<HTMLElement>(
      '.cmux-tab-grouping-chip:not(.is-moved)[aria-description]',
    )];
    expect(nonMovedDescriptions).toHaveLength(0);
  });

  it("renders three cross-workspace lines, two within-workspace badges, and one matching count", async () => {
    analysisHarness.value = fiveMoveAnalysis();
    await mountPanel();
    await openConfirm();

    const transaction = preparedTransaction();
    const diffs = groupingMoveDiffs(cloneWorkspaces(), transaction.workspaces);
    expect(diffs).toHaveLength(5);
    expect(diffs.filter((diff) => diff.kind === "cross-workspace")).toHaveLength(3);
    expect(diffs.filter((diff) => diff.kind === "within-workspace")).toHaveLength(2);
    expect(document.querySelectorAll("path.cmux-tab-grouping-line")).toHaveLength(3);
    const badges = [...document.querySelectorAll<HTMLElement>(".is-after .cmux-tab-grouping-movebadge")];
    expect(badges).toHaveLength(2);
    expect(badges.map((badge) => badge.textContent)).toEqual([
      tabGroupingStrings.moveBadgeColumns(1, 2),
      tabGroupingStrings.moveBadgeColumns(1, 2),
    ]);
    expect(document.body.textContent).toContain(tabGroupingStrings.sideBySideDiffCount(3, 2));
  });

  it("observes the container, move sources, every chip/pane obstacle, and after workspaces", async () => {
    const harness = installMeasurementHarness();
    await mountPanel();
    await openConfirm();

    const lineIds = new Set(groupingMoveLines(cloneWorkspaces(), preparedTransaction().workspaces).map((line) => line.tabId));
    const sideBySide = document.querySelector(".cmux-tab-grouping-sidebyside");
    expect(sideBySide).not.toBeNull();
    expect(harness.observed.has(sideBySide!)).toBe(true);
    for (const tabId of lineIds) {
      for (const side of ["before", "after"] as const) {
        const endpoint = document.querySelector(`[data-grouping-side="${side}"][data-tab-id="${tabId}"]`);
        expect(endpoint, `${side}:${tabId}`).not.toBeNull();
        expect(harness.observed.has(endpoint!)).toBe(true);
      }
    }
    const afterChips = [...document.querySelectorAll<HTMLElement>('[data-grouping-side="after"][data-tab-id]')];
    expect(afterChips.length).toBeGreaterThan(lineIds.size);
    expect(afterChips.every((chip) => harness.observed.has(chip))).toBe(true);
    const afterPanes = [...document.querySelectorAll<HTMLElement>('.is-after .cmux-tab-grouping-pane[data-grouping-pane]')];
    expect(afterPanes.length).toBeGreaterThan(0);
    expect(afterPanes.every((pane) => harness.observed.has(pane))).toBe(true);
    const beforePanes = [...document.querySelectorAll<HTMLElement>('.is-before .cmux-tab-grouping-pane[data-grouping-pane]')];
    expect(beforePanes.length).toBeGreaterThan(0);
    expect(beforePanes.every((pane) => harness.observed.has(pane))).toBe(true);
    const afterWorkspaces = [...document.querySelectorAll<HTMLElement>('.is-after [data-workspace-id]')];
    expect(afterWorkspaces.length).toBeGreaterThan(0);
    expect(afterWorkspaces.every((workspace) => harness.observed.has(workspace))).toBe(true);

    harness.rectSpy.mockClear();
    harness.resizeCallback?.([], {} as ResizeObserver);
    harness.resizeCallback?.([], {} as ResizeObserver);
    expect(harness.frames).toHaveLength(1);
    expect(harness.rectSpy).not.toHaveBeenCalled();
    await act(async () => harness.frames.shift()?.(performance.now()));
    expect(harness.rectSpy).toHaveBeenCalled();
    harness.resizeCallback?.([], {} as ResizeObserver);
    expect(harness.frames).toHaveLength(1);
    const disconnectedBeforeViewChange = harness.disconnected;
    await click(button(tabGroupingStrings.confirmAfter));
    expect(harness.cancelFrame).toHaveBeenCalledTimes(1);
    expect(harness.unobserved).toEqual(harness.observed);
    expect(harness.disconnected).toBe(disconnectedBeforeViewChange + 1);
  });

  it("cleans a pending measurement when the Panel closes", async () => {
    const harness = installMeasurementHarness();
    await mountPanel();
    await openConfirm();
    harness.resizeCallback?.([], {} as ResizeObserver);
    expect(harness.frames).toHaveLength(1);
    const scrollContainer = document.querySelector<HTMLElement>(".cmux-tab-grouping-sidebyside")
      ?.closest<HTMLElement>(".cmux-tab-grouping-col");
    if (!scrollContainer) throw new Error("side-by-side scroll container is missing");
    const removeListener = vi.spyOn(scrollContainer, "removeEventListener");
    const disconnectedBeforeClose = harness.disconnected;
    await act(async () => root?.render(<TabGroupingPanel open={false} visible={false} onClose={() => {}} />));
    await settle();
    expect(harness.cancelFrame).toHaveBeenCalledTimes(1);
    expect(harness.unobserved).toEqual(harness.observed);
    expect(harness.disconnected).toBe(disconnectedBeforeClose + 1);
    expect(removeListener).toHaveBeenCalledTimes(1);
    harness.frames.length = 0;
    harness.rectSpy.mockClear();
    harness.resizeCallback?.([], {} as ResizeObserver);
    expect(harness.frames).toHaveLength(0);
    expect(harness.rectSpy).not.toHaveBeenCalled();
  });

  it("remeasures only a changed source anchor from a ResizeObserver entry", async () => {
    const harness = installMeasurementHarness();
    await mountPanel();
    await openConfirm();
    const anchor = document.querySelector<HTMLElement>(
      '.is-before .cmux-tab-grouping-chip.is-moved[data-grouping-side="before"]',
    );
    if (!anchor) throw new Error("changed move anchor is missing");
    const pathData = [...document.querySelectorAll<SVGPathElement>("path.cmux-tab-grouping-line")]
      .map((path) => path.getAttribute("d"));
    harness.rectSpy.mockClear();
    harness.resizeCallback?.([{ target: anchor } as ResizeObserverEntry], {} as ResizeObserver);
    expect(harness.frames).toHaveLength(1);
    await act(async () => harness.frames.shift()?.(performance.now()));
    expect(harness.rectSpy).toHaveBeenCalledTimes(1);
    expect(harness.rectSpy.mock.instances[0]).toBe(anchor);
    expect([...document.querySelectorAll<SVGPathElement>("path.cmux-tab-grouping-line")]
      .map((path) => path.getAttribute("d"))).toEqual(pathData);
  });

  it("refreshes the complete geometry snapshot when an obstacle or workspace changes", async () => {
    const harness = installMeasurementHarness();
    await mountPanel();
    await openConfirm();
    const obstacles = [
      document.querySelector<HTMLElement>(
        '.is-after .cmux-tab-grouping-chip:not(.is-moved)[data-grouping-side="after"]',
      ),
      document.querySelector<HTMLElement>('.is-after .cmux-tab-grouping-pane[data-grouping-pane^="after:"]'),
      document.querySelector<HTMLElement>('.is-after [data-workspace-id]'),
    ];
    expect(obstacles.every(Boolean)).toBe(true);
    for (const obstacle of obstacles) {
      if (!obstacle) continue;
      harness.rectSpy.mockClear();
      harness.resizeCallback?.([{ target: obstacle } as ResizeObserverEntry], {} as ResizeObserver);
      expect(harness.frames).toHaveLength(1);
      await act(async () => harness.frames.shift()?.(performance.now()));
      expect(harness.rectSpy.mock.calls.length).toBeGreaterThan(1);
      expect(document.querySelectorAll("path.cmux-tab-grouping-line").length).toBeGreaterThan(0);
    }
  });

  it("places the pinned arrow on the destination chip edge", async () => {
    installMeasurementHarness();
    await mountPanel();
    await openConfirm();
    const chip = document.querySelector<HTMLElement>('.is-after .cmux-tab-grouping-chip.is-moved[data-grouping-side="after"]');
    expect(chip).not.toBeNull();
    if (!chip) return;
    await click(chip);
    expect(document.querySelector(`path.cmux-tab-grouping-leadin[data-tab-id="${chip.dataset.tabId}"]`)).not.toBeNull();
    const arrow = document.querySelector<SVGPathElement>(".cmux-tab-grouping-line-arrow");
    const match = arrow?.getAttribute("d")?.match(/^M\s+(-?[\d.]+)\s+(-?[\d.]+)/);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBe(620);
    expect(Number(match?.[2])).toBe(chip.getBoundingClientRect().top + 11);
  });

  it("coalesces ten scroll events into one animation-frame measurement", async () => {
    const harness = installMeasurementHarness();
    await mountPanel();
    await openConfirm();
    const scrollContainer = document.querySelector<HTMLElement>(".cmux-tab-grouping-sidebyside")?.closest<HTMLElement>(".cmux-tab-grouping-col");
    expect(scrollContainer).not.toBeNull();
    harness.rectSpy.mockClear();
    await act(async () => {
      for (let index = 0; index < 10; index += 1) scrollContainer?.dispatchEvent(new Event("scroll"));
    });
    expect(harness.frames).toHaveLength(1);
    expect(harness.rectSpy).not.toHaveBeenCalled();
    await act(async () => harness.frames.shift()?.(performance.now()));
    expect(harness.rectSpy).toHaveBeenCalled();
  });

  it("keeps every sampled cross-workspace curve out of after-side chips including a second-column target", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
      const element = this as HTMLElement;
      if (element.classList.contains("cmux-tab-grouping-sidebyside")) return domRect(0, 0, 1100, 900);
      if (element.dataset.workspaceId) return domRect(element.closest(".is-after") ? 560 : 20, 20, 500, 820);
      if (element.dataset.tabId) {
        const pane = element.closest(".cmux-tab-grouping-pane");
        const column = pane?.parentElement;
        const columns = column?.parentElement;
        const columnIndex = column && columns ? [...columns.children].indexOf(column) : 0;
        const allIds = cloneWorkspaces().flatMap((workspace) => workspace.panes.flatMap((itemPane) => itemPane.tabs.map((tab) => tab.id)));
        const row = Math.max(0, allIds.indexOf(element.dataset.tabId));
        const left = element.dataset.groupingSide === "after" ? 620 + columnIndex * 180 : 80;
        return domRect(left, 60 + row * 34, 130, 24);
      }
      return domRect(0, 0, 0, 0);
    });
    await mountPanel();
    await openConfirm();
    const afterChips = [...document.querySelectorAll<HTMLElement>('.is-after [data-grouping-side="after"][data-tab-id]')];
    const rects = afterChips.map((chip) => ({ tabId: chip.dataset.tabId, rect: chip.getBoundingClientRect() }));
    expect(rects.some(({ rect }) => rect.left >= 800)).toBe(true);
    for (const path of document.querySelectorAll<SVGPathElement>("path.cmux-tab-grouping-line")) {
      const crossings = cubicSamples(path.getAttribute("d") ?? "").flatMap((point) => (
        rects.filter(({ rect }) => point.x > rect.left && point.x < rect.right && point.y > rect.top && point.y < rect.bottom)
      ));
      expect(crossings, `line=${path.dataset.tabId}`).toEqual([]);
    }
  });

  it("renders only the two badges for a changed session", async () => {
    await mountPanel();
    await openConfirm();
    liveRenderHarness.counts.clear();
    parentRenderHarness.panel = 0;
    parentRenderHarness.sideBySide = 0;

    await act(async () => {
      const previous = usePaneMetadataStore.getState().volatileMetadata["session-t請求"]?.backendLastOutputAt ?? 0;
      usePaneMetadataStore.getState().setVolatileMetadata("session-t請求", { backendLastOutputAt: previous + 1 });
    });
    await settle();

    expect(liveRenderHarness.counts.get("session-t請求")).toBe(2);
    expect([...liveRenderHarness.counts.entries()].filter(([sessionId]) => sessionId !== "session-t請求"))
      .toEqual([]);
    expect(parentRenderHarness).toEqual({ panel: 0, sideBySide: 0 });
  });

  it("shows a workspace-qualified parent reference across workspaces", async () => {
    const crossWorkspace = cloneWorkspaces();
    const crossTab = crossWorkspace
      .flatMap((workspace) => workspace.panes)
      .flatMap((pane) => pane.tabs)
      .find((tab) => tab.id === "tudr2");
    if (!crossTab) throw new Error("cross-workspace fixture tab is missing");
    crossTab.origin = { kind: "agent", parentTabId: "t請求" };
    useWorkspaceListStore.setState({ workspaces: crossWorkspace });

    await mountPanel();
    await openConfirm();

    const crossRef = document.querySelector<HTMLElement>(
      '.is-before .cmux-tab-grouping-lineage-item[data-lineage-parent-ref="t請求"][data-lineage-parent-scope="workspace"] > [data-tab-id="tudr2"]',
    );
    expect(crossRef).not.toBeNull();
    expect(crossRef?.textContent).toContain(
      tabGroupingStrings.liveParentRef("請求 期間確認", "なるゼミ・モモスタ"),
    );
  });

  it("omits the move-line SVG and shows a badge for a within-workspace-only move", async () => {
    const sameWorkspacePlan = structuredClone(mockGroupingAnalysis.parsed.plans.find((plan) => plan.planId === "p3"));
    if (!sameWorkspacePlan) throw new Error("same-workspace fixture plan is missing");
    sameWorkspacePlan.groups[0].destination = { kind: "existing_workspace", workspaceId: "wsA" };
    analysisHarness.value = {
      ...mockGroupingAnalysis,
      parsed: { ...mockGroupingAnalysis.parsed, plans: [sameWorkspacePlan] },
    };
    await mountPanel();
    await openConfirm();
    expect(document.querySelector("svg.cmux-tab-grouping-lines")).toBeNull();
    expect(document.querySelectorAll(".is-after .cmux-tab-grouping-movebadge")).toHaveLength(1);
    expect(document.body.textContent).not.toContain(tabGroupingStrings.sideBySideNoMoves);
  });

  it("renders the exact zero-move empty state without an SVG or badge", async () => {
    setRuntimeUndo("available", { movedTabCount: 0 });
    await mountPanel(() => {}, "review");
    expect(document.body.textContent).toContain(tabGroupingStrings.sideBySideNoMoves);
    expect(document.querySelector("svg.cmux-tab-grouping-lines")).toBeNull();
    expect(document.querySelectorAll(".cmux-tab-grouping-movebadge")).toHaveLength(0);
  });

  it("labels a same-column pane move with both pane names and no line", async () => {
    const before = cloneWorkspaces();
    const beforeWorkspace = before.find((workspace) => workspace.id === "wsA");
    if (!beforeWorkspace) throw new Error("same-column source workspace is missing");
    beforeWorkspace.splitColumns = [["pane-a1", "pane-a2"]];
    beforeWorkspace.panes[0].label = "母艦";
    beforeWorkspace.panes[1].label = "作業";
    const after = structuredClone(before);
    const afterWorkspace = after.find((workspace) => workspace.id === "wsA")!;
    const sourcePane = afterWorkspace.panes.find((pane) => pane.id === "pane-a1")!;
    const destinationPane = afterWorkspace.panes.find((pane) => pane.id === "pane-a2")!;
    const moved = sourcePane.tabs.find((tab) => tab.id === "t模試");
    if (!moved) throw new Error("same-column moved tab is missing");
    sourcePane.tabs = sourcePane.tabs.filter((tab) => tab.id !== moved.id);
    destinationPane.tabs.push(moved);
    useWorkspaceListStore.setState({ workspaces: after });
    setRuntimeUndo("available", {
      movedTabCount: 1,
      snapshotWorkspaces: before,
      appliedLayoutSignature: persistentLayoutSignature(after),
    });

    await mountPanel(() => {}, "review");
    const badges = [...document.querySelectorAll<HTMLElement>(".is-after .cmux-tab-grouping-movebadge")];
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toBe(tabGroupingStrings.moveBadgePanes("母艦", "作業"));
    expect(document.querySelector("svg.cmux-tab-grouping-lines")).toBeNull();
  });

  it("remeasures move-line paths after leaving and returning to the side-by-side view", async () => {
    let afterShift = 0;
    const tabOrder = new Map(
      cloneWorkspaces().flatMap((workspace) => workspace.panes.flatMap((pane) => pane.tabs))
        .map((tab, index) => [tab.id, index] as const),
    );
    const rect = (left: number, top: number, width: number, height: number) => ({
      x: left,
      y: top,
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
      toJSON: () => ({}),
    }) as DOMRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
      const element = this as HTMLElement;
      if (element.classList.contains("cmux-tab-grouping-sidebyside")) return rect(0, 0, 1000, 800);
      const tabId = element.dataset.tabId;
      if (tabId) {
        const index = tabOrder.get(tabId) ?? 0;
        const left = element.dataset.groupingSide === "after" ? 620 + afterShift : 60;
        return rect(left, 50 + index * 28, 120, 22);
      }
      if (element.dataset.workspaceId) {
        const left = element.closest(".is-after") ? 560 + afterShift : 20;
        return rect(left, 20, 400, 700);
      }
      return rect(0, 0, 0, 0);
    });

    await mountPanel();
    await openConfirm();
    const firstPath = document.querySelector<SVGPathElement>("path.cmux-tab-grouping-line")?.getAttribute("d");
    expect(firstPath).toMatch(/^M /);

    afterShift = 120;
    await click(button(tabGroupingStrings.confirmDiff));
    await click(button(tabGroupingStrings.confirmSideBySide));
    await settle();
    const secondPath = document.querySelector<SVGPathElement>("path.cmux-tab-grouping-line")?.getAttribute("d");
    expect(secondPath).toMatch(/^M /);
    expect(secondPath).not.toBe(firstPath);
  });

  it("focuses one move line from a chip and every related line from a workspace heading", async () => {
    const onClose = vi.fn();
    await mountPanel(onClose);
    await openConfirm();

    const paths = [...document.querySelectorAll<SVGPathElement>("path.cmux-tab-grouping-line")];
    expect(paths.length).toBeGreaterThan(1);
    const chip = document.querySelector<HTMLElement>('.is-after .cmux-tab-grouping-chip.is-moved[data-grouping-side="after"]');
    expect(chip).not.toBeNull();
    if (!chip) return;
    const tabId = chip.dataset.tabId;
    const line = groupingMoveLines(cloneWorkspaces(), preparedTransaction().workspaces)
      .find((candidate) => candidate.tabId === tabId);
    const fromName = cloneWorkspaces().find((workspace) => workspace.id === line?.fromWorkspaceId)?.name;
    if (!fromName) throw new Error(`source workspace name missing for ${tabId}`);
    expect(chip.querySelector(".cmux-tab-grouping-movectx")?.textContent)
      .toBe(`${fromName} → ${line?.toWorkspaceId ? preparedTransaction().workspaces.find((workspace) => workspace.id === line.toWorkspaceId)?.name : ""}`);
    await dispatchMouse(chip, "mouseover");
    expect(paths.filter((path) => path.classList.contains("is-focused")).map((path) => path.dataset.tabId)).toEqual([tabId]);
    expect(paths.filter((path) => path.classList.contains("is-dimmed"))).toHaveLength(paths.length - 1);
    expect([...document.querySelectorAll<HTMLElement>(".cmux-tab-grouping-chip.is-line-focused")]
      .filter((item) => item.dataset.tabId === tabId)).toHaveLength(2);
    expect(chip.querySelector(".cmux-tab-grouping-movectx")).not.toBeNull();

    await dispatchMouse(chip, "mouseout");
    expect(document.querySelectorAll("path.is-focused, path.is-dimmed")).toHaveLength(0);
    expect(chip.querySelector(".cmux-tab-grouping-movectx")).not.toBeNull();

    await act(async () => chip.focus());
    await settle();
    expect(paths.filter((path) => path.classList.contains("is-focused")).map((path) => path.dataset.tabId)).toEqual([tabId]);
    expect(paths.filter((path) => path.classList.contains("is-dimmed"))).toHaveLength(paths.length - 1);
    expect([...document.querySelectorAll<HTMLElement>(".cmux-tab-grouping-chip.is-line-focused")]
      .filter((item) => item.dataset.tabId === tabId)).toHaveLength(2);
    expect(chip.querySelector(".cmux-tab-grouping-movectx")).not.toBeNull();
    await act(async () => chip.blur());
    await settle();
    expect(document.querySelectorAll("path.is-focused, path.is-dimmed")).toHaveLength(0);
    expect(chip.querySelector(".cmux-tab-grouping-movectx")).not.toBeNull();

    const destinationId = paths[0].dataset.toWs;
    const destination = [...document.querySelectorAll<HTMLElement>(".is-after [data-workspace-id]")]
      .find((item) => item.dataset.workspaceId === destinationId);
    const heading = destination?.querySelector(".cmux-tab-grouping-workspace-head");
    expect(heading).not.toBeNull();
    if (!heading) return;
    await dispatchMouse(heading, "mouseover");
    const related = paths.filter((path) => path.dataset.fromWs === destinationId || path.dataset.toWs === destinationId);
    expect(related.length).toBeGreaterThan(0);
    expect(related.every((path) => path.classList.contains("is-focused"))).toBe(true);
    expect(paths.filter((path) => !related.includes(path)).every((path) => path.classList.contains("is-dimmed"))).toBe(true);
    expect(document.querySelectorAll(".cmux-tab-grouping-chip.is-line-focused")).toHaveLength(related.length * 2);
    await dispatchMouse(heading, "mouseout");
    expect(document.querySelectorAll("path.is-focused, path.is-dimmed")).toHaveLength(0);

    expect(heading.getAttribute("tabindex")).toBe("-1");
    expect(heading.getAttribute("role")).toBe("button");
    await act(async () => heading.focus());
    await settle();
    expect(related.every((path) => path.classList.contains("is-focused"))).toBe(true);
    await dispatchMouse(heading, "mouseover");
    await dispatchMouse(heading, "mouseout");
    expect(related.every((path) => path.classList.contains("is-focused"))).toBe(true);
    await act(async () => {
      heading.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle();
    expect(document.querySelectorAll("path.is-focused, path.is-dimmed")).toHaveLength(0);
    expect(document.querySelector(".cmux-tab-grouping")).not.toBeNull();
    expect(document.activeElement).not.toBe(heading);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("pins all four representations without changing line geometry and supports every clear path", async () => {
    const onClose = vi.fn();
    await mountPanel(onClose);
    await openConfirm();
    const chips = [...document.querySelectorAll<HTMLElement>('.is-after .cmux-tab-grouping-chip.is-moved[data-grouping-side="after"]')];
    expect(chips.length).toBeGreaterThan(1);
    const chip = chips[0];
    const other = chips[1];
    const tabId = chip.dataset.tabId;
    const viewBox = document.querySelector("svg.cmux-tab-grouping-lines")?.getAttribute("viewBox");
    const geometry = () => [...document.querySelectorAll<SVGPathElement>("path.cmux-tab-grouping-line, path.cmux-tab-grouping-leadin")]
      .map((path) => path.getAttribute("d"));
    const initialGeometry = geometry();
    expect(chip.querySelector(".cmux-tab-grouping-movectx")).not.toBeNull();
    expect(chip.getAttribute("role")).toBe("button");
    expect(chip.getAttribute("aria-pressed")).toBe("false");

    await dispatchMouse(chip, "mouseover");
    expect(geometry()).toEqual(initialGeometry);
    await dispatchMouse(chip, "mouseout");
    await click(chip);
    expect(document.querySelectorAll("path.cmux-tab-grouping-line.is-pinned")).toHaveLength(1);
    expect(document.querySelector("path.cmux-tab-grouping-line.is-pinned")?.getAttribute("data-tab-id")).toBe(tabId);
    expect([...document.querySelectorAll<HTMLElement>(".cmux-tab-grouping-chip.is-line-pinned")]
      .filter((endpoint) => endpoint.dataset.tabId === tabId)).toHaveLength(2);
    expect(chip.querySelector(".cmux-tab-grouping-movectx")).not.toBeNull();
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelectorAll(".cmux-tab-grouping-line-start, .cmux-tab-grouping-line-arrow")).toHaveLength(2);
    expect(document.querySelectorAll("path.cmux-tab-grouping-line.is-dimmed")).toHaveLength(
      document.querySelectorAll("path.cmux-tab-grouping-line").length - 1,
    );
    expect(document.querySelector("svg.cmux-tab-grouping-lines")?.getAttribute("viewBox")).toBe(viewBox);
    expect(geometry()).toEqual(initialGeometry);

    await dispatchMouse(other, "mouseover");
    expect(document.querySelector("path.cmux-tab-grouping-line.is-pinned")?.getAttribute("data-tab-id")).toBe(tabId);
    await click(chip);
    expect(document.querySelectorAll("path.cmux-tab-grouping-line.is-pinned")).toHaveLength(0);
    await act(async () => chip.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await settle();
    expect(document.querySelectorAll("path.cmux-tab-grouping-line.is-pinned")).toHaveLength(1);
    await act(async () => chip.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })));
    await settle();
    expect(document.querySelectorAll("path.cmux-tab-grouping-line.is-pinned")).toHaveLength(0);
    await dispatchMouse(other, "mouseover");
    expect(document.querySelector("path.cmux-tab-grouping-line.is-focused")?.getAttribute("data-tab-id")).toBe(other.dataset.tabId);
    await dispatchMouse(other, "mouseout");

    await click(chip);
    await act(async () => chip.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await settle();
    expect(document.querySelectorAll("path.cmux-tab-grouping-line.is-pinned")).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();
    await click(chip);
    await click(button(tabGroupingStrings.confirmAfter));
    await click(button(tabGroupingStrings.confirmSideBySide));
    expect(document.querySelectorAll("path.cmux-tab-grouping-line.is-pinned")).toHaveLength(0);
  });

  it("isolates three real elapsed-clock ticks from the Panel and unchanged badges", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T12:00:00+09:00"));
    resetStores();
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    await mountPanel();
    await openConfirm();
    const pathData = [...document.querySelectorAll<SVGPathElement>("path.cmux-tab-grouping-line")].map((path) => path.getAttribute("d"));
    const workingAge = () => document.querySelector<HTMLElement>(
      '.cmux-tab-grouping-chip[data-tab-id="t請求"] .cmux-tab-grouping-live-age',
    )?.textContent;
    expect(workingAge()).toBe("12分");
    parentRenderHarness.panel = 0;
    parentRenderHarness.sideBySide = 0;
    rectSpy.mockClear();
    liveRenderHarness.counts.clear();
    for (let tick = 0; tick < 3; tick += 1) {
      await act(async () => vi.advanceTimersByTime(30_000));
    }
    expect(parentRenderHarness).toEqual({ panel: 0, sideBySide: 0 });
    expect(rectSpy).not.toHaveBeenCalled();
    expect([...document.querySelectorAll<SVGPathElement>("path.cmux-tab-grouping-line")].map((path) => path.getAttribute("d")))
      .toEqual(pathData);
    expect(liveRenderHarness.counts.get("session-t請求")).toBe(2);
    expect(liveRenderHarness.counts.get("session-tkessan")).toBe(2);
    expect(liveRenderHarness.counts.get("session-t模試")).toBe(2);
    expect(liveRenderHarness.counts.get("session-t統括") ?? 0).toBe(0);
    expect(liveRenderHarness.counts.get("session-t数学") ?? 0).toBe(0);
    expect(workingAge()).toBe("13分");
    await act(async () => root?.unmount());
    root = null;
    liveRenderHarness.counts.clear();
    rectSpy.mockClear();
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(liveRenderHarness.counts.size).toBe(0);
    expect(rectSpy).not.toHaveBeenCalled();
  });

  it("moves the single roving tab stop with arrows, wraparound, Home, and End", async () => {
    await mountPanel();
    await openConfirm();
    const pane = document.querySelector<HTMLElement>(".cmux-tab-grouping-sidebyside-pane.is-before");
    const targets = [...(pane?.querySelectorAll<HTMLElement>('.cmux-tab-grouping-workspace-head, .cmux-tab-grouping-chip.is-moved[data-grouping-side="before"]') ?? [])];
    expect(targets.length).toBeGreaterThan(1);
    expect(targets.filter((target) => target.tabIndex === 0)).toHaveLength(1);
    const first = targets.find((target) => target.tabIndex === 0);
    if (!first) throw new Error("before-side roving target is missing");

    await act(async () => first.focus());
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await settle();
    expect(document.activeElement).toBe(targets[1]);
    expect(targets[1].tabIndex).toBe(0);
    expect(first.tabIndex).toBe(-1);

    targets[1].dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    await settle();
    expect(document.activeElement).toBe(targets.at(-1));
    targets.at(-1)?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await settle();
    expect(document.activeElement).toBe(targets[0]);
    targets[0].dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    await settle();
    targets.at(-1)?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    await settle();
    expect(document.activeElement).toBe(targets[0]);
  });

  it("renders cycle members as finite sibling roots", async () => {
    const cyclic = cloneWorkspaces();
    const tabs = cyclic.flatMap((workspace) => workspace.panes.flatMap((pane) => pane.tabs));
    const rootTab = tabs.find((tab) => tab.id === "t統括");
    const childTab = tabs.find((tab) => tab.id === "t配置図");
    if (!rootTab || !childTab) throw new Error("cycle fixture tabs are missing");
    rootTab.origin = { kind: "agent", parentTabId: childTab.id };
    childTab.origin = { kind: "agent", parentTabId: rootTab.id };
    useWorkspaceListStore.setState({ workspaces: cyclic });

    await mountPanel();
    await openConfirm();
    const cycleItems = [...document.querySelectorAll<HTMLElement>('.is-before [data-lineage-cycle="true"]')];
    expect(cycleItems).toHaveLength(2);
    expect(cycleItems.every((item) => item.parentElement?.classList.contains("cmux-tab-grouping-lineage") ?? false)).toBe(true);
    expect(cycleItems.every((item) => item.querySelector('[data-lineage-cycle="true"]') === null)).toBe(true);
  });

  it("keeps declared tabs idle and omits their elapsed output", async () => {
    const declared = cloneWorkspaces();
    const declaredTab = declared.flatMap((workspace) => workspace.panes.flatMap((pane) => pane.tabs))
      .find((tab) => tab.id === "tosaka");
    if (!declaredTab) throw new Error("declared fixture tab is missing");
    declaredTab.lifecycle = "declared";
    useWorkspaceListStore.setState({ workspaces: declared });
    usePaneMetadataStore.setState((state) => ({
      metadata: {
        ...state.metadata,
        [declaredTab.sessionId]: {
          agentStatus: "working",
          backendLastOutputAt: Date.now() - 60_000,
          agentKind: "codex",
        },
      },
    }));

    await mountPanel();
    await openConfirm();
    const badges = [...document.querySelectorAll<HTMLElement>('[data-tab-id="tosaka"] .cmux-tab-grouping-live')];
    expect(badges).toHaveLength(2);
    expect(badges.every((badge) => badge.dataset.status === "idle")).toBe(true);
    expect(badges.every((badge) => badge.querySelector(".cmux-tab-grouping-live-age") === null)).toBe(true);
  });

  it("keeps live metadata and origin out of the structural Undo signature", async () => {
    const withOrigin = cloneWorkspaces();
    const withoutOrigin = structuredClone(withOrigin);
    for (const workspace of withoutOrigin) {
      for (const pane of workspace.panes) {
        for (const tab of pane.tabs) delete tab.origin;
      }
    }
    expect(structuralUndoSignature(withOrigin)).toBe(structuralUndoSignature(withoutOrigin));

    setRuntimeUndo("available");
    await mountPanel();
    const signatureBefore = structuralUndoSignature(useWorkspaceListStore.getState().workspaces);
    const reviewDisabledBefore = button(tabGroupingStrings.undoReview).disabled;
    await act(async () => {
      usePaneMetadataStore.setState((state) => ({
        metadata: {
          ...state.metadata,
          "session-t請求": { agentStatus: "done", backendLastOutputAt: Date.now() },
        },
      }));
    });
    await settle();
    expect(structuralUndoSignature(useWorkspaceListStore.getState().workspaces)).toBe(signatureBefore);
    expect(button(tabGroupingStrings.undoReview).disabled).toBe(reviewDisabledBefore);
  });

  it("keeps the current, after, and diff confirmation views", async () => {
    await mountPanel();
    await openConfirm();
    const transaction = preparedTransaction();
    for (const [label, workspaces] of [
      [tabGroupingStrings.confirmDiff, transaction.workspaces],
      [tabGroupingStrings.confirmCurrent, cloneWorkspaces()],
      [tabGroupingStrings.confirmAfter, transaction.workspaces],
    ] as const) {
      await click(button(label));
      expect(document.querySelector(".cmux-tab-grouping-sidebyside")).toBeNull();
      expect(button(label).getAttribute("aria-pressed")).toBe("true");
      const sections = [...document.querySelectorAll<HTMLElement>(".cmux-tab-grouping-col > div > section[data-workspace-id]")];
      expect(new Set(sections.map((section) => section.parentElement))).toHaveLength(1);
      expect(sections.map((section) => section.dataset.workspaceId)).toEqual(workspaces.map((workspace) => workspace.id));
    }
  });

  it("does not add side markers or explicit tab indexes in the edit step", async () => {
    await mountPanel();
    expect(document.querySelectorAll(".cmux-tab-grouping-line-halo, .cmux-tab-grouping-movectx, .cmux-tab-grouping-movebadge, .is-line-pinned")).toHaveLength(0);
    await click(button(tabGroupingStrings.editPlan));
    expect(document.querySelectorAll(".cmux-tab-grouping-chip[data-grouping-side]")).toHaveLength(0);
    expect(document.querySelectorAll(".cmux-tab-grouping-chip[tabindex]")).toHaveLength(0);
    expect(document.querySelectorAll(".cmux-tab-grouping-line-halo, .cmux-tab-grouping-movectx, .cmux-tab-grouping-movebadge, .is-line-pinned")).toHaveLength(0);
  });

  it("keeps the same move-line set immediately after apply and after reopening with review intent", async () => {
    const onClose = vi.fn();
    await mountPanel(onClose);
    await openConfirm();
    const lineSet = () => [...document.querySelectorAll<SVGPathElement>("path.cmux-tab-grouping-line")]
      .map((path) => `${path.dataset.tabId}|${path.dataset.fromWs}|${path.dataset.toWs}`).sort();
    const beforeApply = lineSet();
    expect(beforeApply.length).toBeGreaterThan(0);
    await click(button(tabGroupingStrings.apply));
    await settle();
    expect(document.querySelector("svg.cmux-tab-grouping-lines")).not.toBeNull();
    expect(lineSet()).toEqual(beforeApply);
    expect(document.querySelectorAll('.cmux-tab-grouping-chip.is-moved[data-grouping-side="after"][role="button"]')).toHaveLength(beforeApply.length);
    expect(document.body.textContent).not.toContain(tabGroupingStrings.sideBySideNoMoves);
    expect(document.body.textContent).toContain(tabGroupingStrings.undo);

    await act(async () => root?.render(<TabGroupingPanel open={false} visible={false} onClose={onClose} />));
    await settle();
    await act(async () => root?.render(<TabGroupingPanel open visible intent="review" onClose={onClose} />));
    await settle();
    expect(lineSet()).toEqual(beforeApply);
    expect(document.querySelectorAll('.cmux-tab-grouping-chip.is-moved[data-grouping-side="after"][role="button"]')).toHaveLength(beforeApply.length);
  });

  it("restores a decoration-free zero-move map after Undo", async () => {
    const zeroMoveDomSnapshot = (scope: ParentNode) => ({
      chipClassSets: [...scope.querySelectorAll<HTMLElement>(".cmux-tab-grouping-chip")].map((element) => ({
        tabId: element.dataset.tabId,
        classes: [...element.classList].sort(),
        role: element.getAttribute("role"),
        tabIndex: element.getAttribute("tabindex"),
      })).sort((left, right) => (left.tabId ?? "").localeCompare(right.tabId ?? "")),
      lines: document.querySelectorAll("path.cmux-tab-grouping-line").length,
      halos: document.querySelectorAll("path.cmux-tab-grouping-line-halo").length,
      markers: document.querySelectorAll(".cmux-tab-grouping-line-start, .cmux-tab-grouping-line-arrow").length,
      badges: scope.querySelectorAll(".cmux-tab-grouping-movebadge").length,
      contexts: scope.querySelectorAll(".cmux-tab-grouping-movectx").length,
    });
    const originalSignature = structuralUndoSignature(useWorkspaceListStore.getState().workspaces);
    await mountPanel();
    await openConfirm();
    await click(button(tabGroupingStrings.confirmCurrent));
    const currentMap = document.querySelector<HTMLElement>(".cmux-tab-grouping-col section[data-workspace-id]")?.parentElement;
    if (!currentMap) throw new Error("pre-apply current map is missing");
    const preApplyCurrentSnapshot = zeroMoveDomSnapshot(currentMap);
    expect(preApplyCurrentSnapshot.lines).toBe(0);
    expect(preApplyCurrentSnapshot.badges).toBe(0);
    await click(button(tabGroupingStrings.confirmSideBySide));
    await click(button(tabGroupingStrings.apply));
    const committed = boundaryHarness.committed as ReturnType<typeof groupingBoundary.commit> | null;
    expect(committed?.commit.ok).toBe(true);
    if (!committed) return;
    await act(async () => committed.durability);
    await settle();
    expect(document.querySelectorAll("path.cmux-tab-grouping-line").length).toBeGreaterThan(0);
    await click(button(tabGroupingStrings.undo));
    await settle();
    expect(structuralUndoSignature(useWorkspaceListStore.getState().workspaces)).toBe(originalSignature);
    expect(document.querySelectorAll("path.cmux-tab-grouping-line, path.cmux-tab-grouping-line-halo, .cmux-tab-grouping-movebadge, .cmux-tab-grouping-line-start, .cmux-tab-grouping-line-arrow")).toHaveLength(0);
    expect(document.querySelectorAll('.is-after .cmux-tab-grouping-chip.is-moved, .is-after .cmux-tab-grouping-chip[role="button"], .is-after .cmux-tab-grouping-chip[tabindex]')).toHaveLength(0);
    expect(document.body.textContent).toContain(tabGroupingStrings.sideBySideNoMoves);
    const restoredAfterMap = document.querySelector<HTMLElement>(".cmux-tab-grouping-sidebyside-pane.is-after");
    if (!restoredAfterMap) throw new Error("restored after map is missing");
    expect(zeroMoveDomSnapshot(restoredAfterMap)).toEqual(preApplyCurrentSnapshot);
  });

  it("reviews the applied layout side by side from the runtime Undo bar", async () => {
    await mountPanel();
    await openConfirm();
    const appliedTransaction = preparedTransaction();
    await click(button(tabGroupingStrings.apply));
    const committed = boundaryHarness.committed as ReturnType<typeof groupingBoundary.commit> | null;
    expect(committed?.commit.ok).toBe(true);
    if (!committed) return;
    await act(async () => committed.durability);
    await settle();
    expect(useGroupingRuntimeStore.getState().undo?.status).toBe("available");
    await click(button(tabGroupingStrings.undoReview));
    expect(document.querySelector(".cmux-tab-grouping-sidebyside")).not.toBeNull();
    const undo = useGroupingRuntimeStore.getState().undo;
    expect(undo?.status).toBe("available");
    if (!undo) return;
    const expected = groupingMoveLines(undo.snapshot.workspaces, appliedTransaction.workspaces);
    const paths = [...document.querySelectorAll<SVGPathElement>("path.cmux-tab-grouping-line")];
    expect(paths).toHaveLength(expected.length);
    for (const line of expected) {
      const path = paths.find((item) => item.dataset.tabId === line.tabId);
      expect(path?.dataset.fromWs).toBe(line.fromWorkspaceId);
      expect(path?.dataset.toWs).toBe(line.toWorkspaceId);
    }
  });

  it("shows only actionable pending and failed durability states in the undo bar", async () => {
    setRuntimeUndo("available");
    await mountPanel();
    const durabilityBase = {
      requestId: "durability-1",
      layoutRevision: 1,
      signature: "signature",
      snapshotDigest: "digest",
      leaderGeneration: 1,
    };

    await act(async () => useGroupingRuntimeStore.setState({
      durability: { status: "pending", ...durabilityBase } as never,
    }));
    await settle();
    expect(document.querySelector('[data-durability="pending"]')?.textContent)
      .toBe(tabGroupingStrings.durabilityPending);

    await act(async () => useGroupingRuntimeStore.setState({
      durability: {
        status: "failed",
        ...durabilityBase,
        errorCode: "persistence_failed",
        retryScheduled: false,
        failureGeneration: 1,
      } as never,
    }));
    await settle();
    expect(document.querySelector('[data-durability="failed"]')?.textContent)
      .toBe(tabGroupingStrings.statusDurabilityWarning);

    await act(async () => useGroupingRuntimeStore.setState({
      durability: { status: "saved", ...durabilityBase } as never,
    }));
    await settle();
    expect(document.querySelector("[data-durability]")).toBeNull();
    await act(async () => useGroupingRuntimeStore.setState({ durability: { status: "idle" } }));
    await settle();
    expect(document.querySelector("[data-durability]")).toBeNull();
  });

  it("replaces the success summary with an edit conflict after apply", async () => {
    await mountPanel();
    await openConfirm();
    await click(button(tabGroupingStrings.apply));
    expect(document.querySelector(".cmux-tab-grouping-summary")).toBeNull();

    const projectPlan = mockGroupingAnalysis.parsed.plans.find((plan) => plan.strategy === "project");
    const conflictName = projectPlan?.groups.find((group) => (
      group.adopted && group.destination.kind === "new_workspace"
    ))?.destination;
    if (!conflictName || conflictName.kind !== "new_workspace") {
      throw new Error("new-workspace conflict fixture is missing");
    }
    const conflicted = structuredClone(useWorkspaceListStore.getState().workspaces);
    if (!conflicted[0]) throw new Error("conflict workspace fixture is missing");
    conflicted[0].name = conflictName.proposedName;
    await act(async () => useWorkspaceListStore.setState({ workspaces: conflicted, layoutRevision: 3 }));
    await settle();

    expect(document.querySelector(".cmux-tab-grouping-summary")).toBeNull();
    const error = document.querySelector<HTMLElement>(".cmux-tab-grouping-error");
    expect(error).not.toBeNull();
    if (!error) throw new Error("applied conflict message is missing");
    expect(error.textContent?.trim())
      .toBe(`新ワークスペース名が既存名と衝突しています: ${conflictName.proposedName}`);
  });

  it("returns both confirm and edit tickets to confirm when the layout revision changes", async () => {
    await mountPanel();
    await click(button(tabGroupingStrings.editPlan));
    await click(button(tabGroupingStrings.goConfirm));
    await settle();
    useWorkspaceListStore.setState({ layoutRevision: 2 });
    await settle();
    expect(document.querySelector('[aria-current="step"]')?.textContent).toContain(tabGroupingStrings.stepConfirm);
    expect(document.querySelector('[role="status"]')?.textContent).toBe(tabGroupingStrings.ticketInvalidated);

    await click(button(tabGroupingStrings.backToEdit));
    await settle();
    useWorkspaceListStore.setState({ layoutRevision: 3 });
    await settle();
    expect(document.querySelector('[aria-current="step"]')?.textContent).toContain(tabGroupingStrings.stepConfirm);
    expect(document.querySelector('[role="status"]')?.textContent).toBe(tabGroupingStrings.ticketInvalidated);
  });

  it("keeps the runtime Undo bar when a fresh comparison starts", async () => {
    setRuntimeUndo("available");
    await mountPanel();
    expect(document.querySelector(".cmux-tab-grouping-undo")).not.toBeNull();
    await click(button(tabGroupingStrings.analyzeAgain));
    expect(document.querySelector(".cmux-tab-grouping-undo")).not.toBeNull();
    expect(document.body.textContent).toContain(tabGroupingStrings.undoApplied(3));
  });

  it("keeps the runtime report after an unmount and remount", async () => {
    const emptyWorkspaceMessage = `${tabGroupingStrings.emptyWorkspaces(2)} ${tabGroupingStrings.notDeleted}`;
    setRuntimeUndo("available", { movedTabCount: 4, emptyWorkspaceIds: ["wsA", "wsB"] });
    await mountPanel();
    expect(document.body.textContent).toContain(tabGroupingStrings.undoApplied(4));
    expect(document.body.textContent).toContain(emptyWorkspaceMessage);

    await act(async () => root?.unmount());
    root = null;
    await mountPanel();

    expect(document.body.textContent).toContain(tabGroupingStrings.undoApplied(4));
    expect(document.body.textContent).toContain(emptyWorkspaceMessage);
  });

  it("does not render the empty-workspace line when the runtime report has no empty workspaces", async () => {
    setRuntimeUndo("available", { emptyWorkspaceIds: [] });
    await mountPanel();

    expect(document.body.textContent).not.toContain(tabGroupingStrings.emptyWorkspaces(0));
  });

  it("keeps review enabled after an active-tab click while runtime Undo stays available", async () => {
    setRuntimeUndo("available");
    await mountPanel();
    expect(button(tabGroupingStrings.undoReview).disabled).toBe(false);

    const clicked = cloneWorkspaces();
    const clickedPane = clicked[0].panes[0];
    const clickedTab = clickedPane.tabs[1];
    if (!clickedTab) throw new Error("active-tab fixture requires a second tab");
    clicked[0].panes[0] = applyActiveTabFields(clickedPane, clickedTab);
    await act(async () => {
      useWorkspaceListStore.setState({ workspaces: clicked, layoutRevision: 2 });
    });
    await settle();

    expect(useGroupingRuntimeStore.getState().undo?.status).toBe("available");
    expect(button(tabGroupingStrings.undoReview).disabled).toBe(false);
    expect(button(tabGroupingStrings.undo).disabled).toBe(false);
    expect(document.querySelector(".cmux-tab-grouping-undo")?.classList.contains("is-expired")).toBe(false);
  });

  it("disables review after Undo expires", async () => {
    setRuntimeUndo("expired");
    await mountPanel();
    expect(button(tabGroupingStrings.undoReview).disabled).toBe(true);
    expect(document.querySelector(".cmux-tab-grouping-undo")?.classList.contains("is-expired")).toBe(true);
  });

  it("writes four dark and four light snapshots plus a comparison index", async () => {
    await mountPanel();
    const states = [{ baseName: "01_案を比較", caption: "1 案を比較", body: document.body.innerHTML }];

    await openEditWithSelection();
    await click(button(tabGroupingStrings.moveSelected));
    states.push({ baseName: "02_内容を編集", caption: "2 内容を編集", body: document.body.innerHTML });

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle();
    await click(button(tabGroupingStrings.goConfirm));
    await settle();
    expect(document.querySelector("ul.cmux-tab-grouping-lineage")).not.toBeNull();
    expect(document.querySelector('span.cmux-tab-grouping-live[data-status="working"]')).not.toBeNull();
    states.push({ baseName: "03_適用前確認", caption: "3 適用前確認", body: document.body.innerHTML });

    await act(async () => root?.unmount());
    root = null;
    setRuntimeUndo("available");
    await mountPanel();
    states.push({ baseName: "04_元に戻すバー", caption: "元に戻すバー", body: document.body.innerHTML });

    writeMockFiles(states);
    expect(states).toHaveLength(4);
  });
});
