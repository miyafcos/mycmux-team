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
const MINIMAP_CHIP_GAP_COLLAPSED = 4;
const MINIMAP_CHIP_GAP_EXPANDED = 5;
// .cmux-minimap-pane-grip is a 7px band at the top of each cell.
const MINIMAP_PANE_GRIP_HEIGHT = 7;
// .cmux-minimap-cell has a 1px hairline border and box-sizing: border-box.
const MINIMAP_CELL_BORDER_Y = 2;

function chipGapPx(expanded: boolean): number {
  return expanded ? MINIMAP_CHIP_GAP_EXPANDED : MINIMAP_CHIP_GAP_COLLAPSED;
}

// Heights stay discrete px values (not `auto`) so the 180ms height transition
// still animates. The stack already scrolls, so this is not clamped.
export function minimapCellHeightPx(chipCount: number, expanded: boolean): number {
  const chips = Math.max(0, chipCount);
  const chip = expanded ? MINIMAP_ROW_EXPANDED : MINIMAP_ROW_COLLAPSED;
  const cellPad = expanded ? MINIMAP_CELL_PADDING_EXPANDED : MINIMAP_CELL_PADDING_COLLAPSED;
  const gap = chipGapPx(expanded);
  const chipStack = chips === 0 ? 0 : chips * chip + (chips - 1) * gap;
  const gripBlock = MINIMAP_PANE_GRIP_HEIGHT + (chips > 0 ? gap : 0);
  return cellPad * 2 + MINIMAP_CELL_BORDER_Y + gripBlock + chipStack;
}

export function minimapMapHeightPx(columnChipCounts: readonly (readonly number[])[], expanded: boolean): number {
  const columns = columnChipCounts.length > 0 ? columnChipCounts : [[0]];
  let maxColumn = 0;
  for (const cells of columns) {
    const rows = cells.length > 0 ? cells : [0];
    let columnHeight = 0;
    for (let index = 0; index < rows.length; index += 1) {
      if (index > 0) columnHeight += MINIMAP_COLUMN_GAP;
      columnHeight += minimapCellHeightPx(rows[index] ?? 0, expanded);
    }
    maxColumn = Math.max(maxColumn, columnHeight);
  }
  return MINIMAP_MAP_PADDING_Y * 2 + maxColumn;
}

export function MinimapWorkspaceBlock({ workspace, selectedTabId, selectedTabIds, openTabIds, groupPulseTabIds, displayStateByTabId, expanded, activePaneId, onToggle, onSelect, onSelectGroup, onJump }: {
  workspace: Workspace;
  selectedTabId: string | null;
  selectedTabIds: ReadonlySet<string>;
  openTabIds: readonly string[];
  groupPulseTabIds: ReadonlySet<string>;
  displayStateByTabId: ReadonlyMap<string, DashboardDisplayState>;
  expanded: boolean;
  activePaneId: string | null;
  onToggle: () => void;
  onSelect: (tabId: string, event: ReactMouseEvent<HTMLButtonElement>) => void;
  onSelectGroup: (tabId: string) => void;
  onJump?: (workspaceId: string, paneId: string, tabId: string) => void;
}) {
  const model = buildMinimapModel(workspace, { activePaneId });
  const needsAnswer = model.columns.flatMap((column) => column.cells).flatMap((cell) => cell.chips)
    .filter((chip) => displayStateByTabId.get(chip.tabId) === "needsHuman").length;
  const tabCount = workspace.panes.reduce((total, pane) => total + pane.tabs.length, 0);
  const rowCount = Math.max(1, ...model.columns.map((column) => column.cells.length));
  const columnChipCounts = model.columns.map((column) => column.cells.map((cell) => cell.chips.length));
  const mapHeight = minimapMapHeightPx(columnChipCounts, expanded);
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
        {column.cells.map((cell) => <MinimapPaneCell key={cell.paneId} cell={cell} workspaceId={workspace.id} selectedTabId={selectedTabId} selectedTabIds={selectedTabIds} openTabIds={openTabIds} groupPulseTabIds={groupPulseTabIds} displayStateByTabId={displayStateByTabId} expanded={expanded} minHeight={minimapCellHeightPx(cell.chips.length, expanded)} onSelect={onSelect} onSelectGroup={onSelectGroup} onJump={onJump} />)}
      </div>)}
    </div>
  </section>;
}
