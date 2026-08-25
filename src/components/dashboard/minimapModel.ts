import { reconcileSplitColumnsForPanes } from "../../lib/layoutColumns";
import { fitLayoutSizes } from "../../lib/layoutMetrics";
import { getTabDisplayLabel } from "../../lib/tabDisplayLabel";
import { isDeclaredTab } from "../../lib/tabLifecycle";
import type { Pane, PaneTab, Workspace } from "../../types";
import type { PaneMetadata } from "../../stores/paneMetadataStore";

export interface MinimapChip {
  tabId: string;
  sessionId: string;
  index: number;
  label: string;
  typeGlyph: string;
  agentKind?: PaneTab["agentKind"];
  displayState?: string;
  isActiveTab: boolean;
  isPinned: boolean;
  declared: boolean;
  declaredPrompt?: string;
  originParentTabId?: string;
  /**
   * Backend PTY output timestamp, read the same way ChatColumn reads it
   * (`volatileMetadata.backendLastOutputAt`). Undefined when the session has
   * never reported output, which the chip renders as "no elapsed time".
   */
  lastOutputAt?: number;
  /** CTX occupancy percent from livebrief telemetry. Chip shows this number only. */
  contextPct?: number;
}

export interface MinimapCell {
  paneId: string;
  rowIndex: number;
  heightShare: number;
  isActivePane: boolean;
  chips: MinimapChip[];
}

export interface MinimapColumn {
  index: number;
  widthShare: number;
  cells: MinimapCell[];
}

export interface MinimapModel {
  workspaceId: string;
  columns: MinimapColumn[];
}

export type MinimapDropZone = "center" | "left" | "right" | "up" | "down";

interface MinimapDropRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

const MINIMAP_EDGE_HYSTERESIS_PX = 4;

function minimapEdge(size: number): number {
  return Math.min(15, Math.max(10, size * 0.22));
}

function isWithinZoneEdge(
  zone: Exclude<MinimapDropZone, "center">,
  rect: MinimapDropRect,
  x: number,
  y: number,
  extra = 0,
): boolean {
  if (zone === "left") return x - rect.left <= minimapEdge(rect.width) + extra;
  if (zone === "right") return rect.right - x <= minimapEdge(rect.width) + extra;
  if (zone === "up") return y - rect.top <= minimapEdge(rect.height) + extra;
  return rect.bottom - y <= minimapEdge(rect.height) + extra;
}

/**
 * Five-zone hit test used only by the minimap. Existing workspace panes retain
 * their broader handoff targets. An edge remains selected for four pixels
 * after the pointer crosses back into the center to avoid preview flicker.
 */
export function resolveMinimapDropZone(
  rect: MinimapDropRect,
  x: number,
  y: number,
  previousZone: MinimapDropZone = "center",
): MinimapDropZone {
  let next: MinimapDropZone = "center";
  if (isWithinZoneEdge("left", rect, x, y)) next = "left";
  else if (isWithinZoneEdge("right", rect, x, y)) next = "right";
  else if (isWithinZoneEdge("up", rect, x, y)) next = "up";
  else if (isWithinZoneEdge("down", rect, x, y)) next = "down";
  if (next !== "center" || previousZone === "center") return next;
  return isWithinZoneEdge(previousZone, rect, x, y, MINIMAP_EDGE_HYSTERESIS_PX)
    ? previousZone
    : "center";
}

export interface MinimapModelContext {
  displayStateByTabId?: Record<string, string>;
  metadataBySession?: Record<string, unknown>;
  activePaneId?: string | null;
  contextPctBySession?: Record<string, number | undefined>;
}

function shareValues(sizes: number[] | undefined, count: number): number[] {
  // Quantize before division so valid shares always sum to exactly one.
  const fitted = fitLayoutSizes(sizes, 10_000, count);
  if (!fitted) return [];
  const total = fitted.reduce((sum, size) => sum + size, 0);
  return total > 0 ? fitted.map((size) => size / total) : Array.from({ length: count }, () => 1 / count);
}

function typeGlyph(type: PaneTab["type"]): string {
  if (type === "browser") return "◉";
  if (type === "online") return "☁";
  return "⌘";
}

/** Activity axis of the workspace header strip. Folded from the existing
 * displayState vocabulary only — the strip never invents a new state word. */
export type MinimapStripActivity = "working" | "waiting" | "idle";

export interface MinimapStripEntry {
  tabId: string;
  agentKind?: PaneTab["agentKind"];
  activity: MinimapStripActivity;
}

export interface MinimapStripSummary {
  /** One tick per tab, in visual order. */
  ticks: MinimapStripEntry[];
  tabCount: number;
  waitingCount: number;
}

function stripActivity(state: string | undefined): MinimapStripActivity {
  // `needsHuman` is the dashboard's 返答待ち state (stateLabels maps it to the
  // needsAnswer/waiting pair); `running` is the working state.
  if (state === "needsHuman") return "waiting";
  if (state === "running") return "working";
  return "idle";
}

/**
 * Flatten a workspace model into the header strip in a single pass: the tick
 * list, the tab count, and the 返答待ち count all come from one walk so the
 * header never re-traverses the model per summary field.
 */
export function minimapWorkspaceStrip(
  model: MinimapModel,
  displayStateByTabId?: ReadonlyMap<string, string>,
): MinimapStripSummary {
  const ticks: MinimapStripEntry[] = [];
  let waitingCount = 0;
  for (const column of model.columns) {
    for (const cell of column.cells) {
      for (const chip of cell.chips) {
        const activity = stripActivity(displayStateByTabId?.get(chip.tabId) ?? chip.displayState);
        if (activity === "waiting") waitingCount += 1;
        ticks.push({ tabId: chip.tabId, agentKind: chip.agentKind, activity });
      }
    }
  }
  return { ticks, tabCount: ticks.length, waitingCount };
}

function chip(tab: PaneTab, pane: Pane, index: number, ctx: MinimapModelContext): MinimapChip {
  const metadata = ((ctx.metadataBySession ?? {}) as Record<string, PaneMetadata | undefined>)[tab.sessionId];
  return {
    tabId: tab.id,
    sessionId: tab.sessionId,
    index,
    label: getTabDisplayLabel(
      tab,
      tab.id === pane.activeTabId,
      (ctx.metadataBySession ?? {}) as Record<string, PaneMetadata | undefined>,
    ),
    lastOutputAt: metadata?.backendLastOutputAt,
    contextPct: ctx.contextPctBySession?.[tab.sessionId],
    typeGlyph: typeGlyph(tab.type),
    agentKind: tab.agentKind,
    displayState: ctx.displayStateByTabId?.[tab.id],
    isActiveTab: tab.id === pane.activeTabId,
    isPinned: tab.id === pane.pinnedTabId,
    declared: isDeclaredTab(tab),
    declaredPrompt: tab.declaredPrompt,
    originParentTabId: tab.origin?.parentTabId,
  };
}

export function buildMinimapModel(workspace: Workspace, ctx: MinimapModelContext = {}): MinimapModel {
  const paneById = new Map(workspace.panes.map((pane) => [pane.id, pane]));
  const columns = reconcileSplitColumnsForPanes(workspace.splitColumns, workspace.panes.map((pane) => pane.id));
  const widthShares = shareValues(workspace.columnWidths, columns.length);
  return {
    workspaceId: workspace.id,
    columns: columns.map((paneIds, index) => {
      const rowShares = shareValues(workspace.rowHeightsPerCol?.[index], paneIds.length);
      return {
        index,
        widthShare: widthShares[index] ?? 0,
        cells: paneIds.map((paneId, rowIndex) => {
          const pane = paneById.get(paneId)!;
          return {
            paneId,
            rowIndex,
            heightShare: rowShares[rowIndex] ?? 0,
            isActivePane: ctx.activePaneId === paneId,
            chips: pane.tabs.map((tab, tabIndex) => chip(tab, pane, tabIndex, ctx)),
          };
        }),
      };
    }),
  };
}
