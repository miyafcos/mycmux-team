import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import type { DashboardDisplayState } from "./dashboardModel";
import { buildMinimapModel } from "./minimapModel";
import { MinimapPaneCell } from "./MinimapPaneCell";
import type { Workspace } from "../../types";
import { resolveWorkspaceColor } from "../../lib/workspaceColors";

const MINIMAP_MAP_PADDING_Y = 8;
const MINIMAP_CELL_PADDING_COLLAPSED = 4;
const MINIMAP_CELL_PADDING_EXPANDED = 5;
const MINIMAP_ROW_COLLAPSED = 26;
const MINIMAP_ROW_EXPANDED = 53;
const MINIMAP_COLUMN_GAP = 4;
// .cmux-minimap-cell has a 1px hairline border and box-sizing: border-box.
const MINIMAP_CELL_BORDER_Y = 2;
const MINIMAP_MAP_EXPANDED_MAX = 248;
// Collapsed rows stay a glance-level strip: cap at three rows so a 10-pane
// workspace cannot push the other workspaces out of the panel.
const MINIMAP_MAP_COLLAPSED_MAX = 132;

// The map used to be a fixed box, so a single-pane workspace kept the dead space
// of a four-row one. Heights stay discrete values (not `auto`) so the 180ms
// height transition still animates.
export function minimapMapHeightPx(rowCount: number, expanded: boolean): number {
  const rows = Math.max(1, rowCount);
  const chip = expanded ? MINIMAP_ROW_EXPANDED : MINIMAP_ROW_COLLAPSED;
  const cellPad = expanded ? MINIMAP_CELL_PADDING_EXPANDED : MINIMAP_CELL_PADDING_COLLAPSED;
  const cellMin = cellPad * 2 + MINIMAP_CELL_BORDER_Y + chip;
  const computed = MINIMAP_MAP_PADDING_Y * 2 + rows * cellMin + (rows - 1) * MINIMAP_COLUMN_GAP;
  // Past the cap the cells go back to sharing the box (they shrink via flex).
  return Math.min(expanded ? MINIMAP_MAP_EXPANDED_MAX : MINIMAP_MAP_COLLAPSED_MAX, computed);
}

export function MinimapWorkspaceBlock({ workspace, selectedTabId, selectedTabIds, groupPulseTabIds, displayStateByTabId, expanded, activePaneId, onToggle, onSelect, onSelectGroup }: {
  workspace: Workspace;
  selectedTabId: string | null;
  selectedTabIds: ReadonlySet<string>;
  groupPulseTabIds: ReadonlySet<string>;
  displayStateByTabId: ReadonlyMap<string, DashboardDisplayState>;
  expanded: boolean;
  activePaneId: string | null;
  onToggle: () => void;
  onSelect: (tabId: string, event: ReactMouseEvent<HTMLButtonElement>) => void;
  onSelectGroup: (tabId: string) => void;
}) {
  const model = buildMinimapModel(workspace, { activePaneId });
  const needsAnswer = model.columns.flatMap((column) => column.cells).flatMap((cell) => cell.chips)
    .filter((chip) => displayStateByTabId.get(chip.tabId) === "needsHuman").length;
  const tabCount = workspace.panes.reduce((total, pane) => total + pane.tabs.length, 0);
  const rowCount = Math.max(1, ...model.columns.map((column) => column.cells.length));
  const mapHeight = minimapMapHeightPx(rowCount, expanded);
  const mapStyle = { "--minimap-map-height": `${mapHeight}px` } as CSSProperties;
  // 実画面のタブバーと同じ解決 (TabItem 参照): 未設定の WS には色を発明しない。
  const workspaceColor = resolveWorkspaceColor(workspace.color)?.value;
  return <section className={`cmux-minimap-workspace${expanded ? " is-expanded" : ""}`} data-minimap-workspace={workspace.id} style={workspaceColor ? { borderLeftColor: workspaceColor } : undefined}>
    <button type="button" className="cmux-minimap-workspace-header" aria-expanded={expanded} onClick={onToggle} title={workspace.name}>
      <span className="cmux-minimap-workspace-name" title={workspace.name}>{workspace.name}</span>
      <span className="cmux-minimap-workspace-summary">{needsAnswer ? <span className="cmux-minimap-workspace-question">{`❓${needsAnswer}`}</span> : null}<span>{`● ${tabCount}本`}</span></span>
    </button>
    <div className={`cmux-minimap-map${expanded ? " is-expanded" : ""}`} data-minimap-expanded={expanded || undefined} data-minimap-row-count={rowCount} style={mapStyle}>
      {model.columns.map((column) => <div key={column.index} className="cmux-minimap-column" style={{ flexGrow: column.widthShare }}>
        {column.cells.map((cell) => <MinimapPaneCell key={cell.paneId} cell={cell} workspaceId={workspace.id} selectedTabId={selectedTabId} selectedTabIds={selectedTabIds} groupPulseTabIds={groupPulseTabIds} displayStateByTabId={displayStateByTabId} expanded={expanded} onSelect={onSelect} onSelectGroup={onSelectGroup} />)}
      </div>)}
    </div>
  </section>;
}
