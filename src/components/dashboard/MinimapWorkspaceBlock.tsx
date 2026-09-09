import { useMemo, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import type { DashboardDisplayState } from "./dashboardModel";
import { buildMinimapModel, minimapWorkspaceStrip } from "./minimapModel";
import { MinimapPaneCell } from "./MinimapPaneCell";
import type { Workspace } from "../../types";
import { usePaneMetadataStore } from "../../stores/paneMetadataStore";
import { useLiveBriefStore } from "../../stores/liveBriefStore";
import { resolveWorkspaceColor } from "../../lib/workspaceColors";

// The strip stays one line: past this many ticks the overflow is written as a
// "+N" tail so no tab is silently dropped from the summary.
const MINIMAP_STRIP_MAX_TICKS = 12;

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
  // A tab-less pane still needs one row of budget: it renders the "空きペイン"
  // line, and without it the cell collapses to ~19px where the five drop zones
  // overlap and the centre (merge) target disappears.
  const rows = Math.max(1, chips);
  const chipStack = rows * chip + (rows - 1) * gap;
  const gripBlock = MINIMAP_PANE_GRIP_HEIGHT + gap;
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

export function MinimapWorkspaceBlock({ workspace, selectedTabId, selectedTabIds, openColumnByTabId, groupPulseTabIds, displayStateByTabId, expanded, activePaneId, now, onToggle, onSelect, onSelectGroup, onJump }: {
  workspace: Workspace;
  selectedTabId: string | null;
  selectedTabIds: ReadonlySet<string>;
  /** tabId -> chat column index, built once by the panel. */
  openColumnByTabId: ReadonlyMap<string, number>;
  groupPulseTabIds: ReadonlySet<string>;
  displayStateByTabId: ReadonlyMap<string, DashboardDisplayState>;
  expanded: boolean;
  activePaneId: string | null;
  /** Panel clock, so elapsed values re-evaluate without a PTY subscription. */
  now: number;
  onToggle: () => void;
  onSelect: (tabId: string, event: ReactMouseEvent<HTMLButtonElement>) => void;
  onSelectGroup: (tabId: string) => void;
  onJump?: (workspaceId: string, paneId: string, tabId: string) => void;
}) {
  // Read (not subscribe): backendLastOutputAt ticks with every PTY write, and a
  // subscription here would re-render the whole minimap on that cadence. The
  // panel clock re-renders us instead, and the snapshot reference is a memo
  // dependency so a genuinely new snapshot still rebuilds the model.
  const volatileMetadata = usePaneMetadataStore.getState().volatileMetadata;
  // CTX% is snapshotted on the panel clock (same 30s tick as elapsed age) so
  // livebrief updates do not re-render the whole minimap every second.
  const model = useMemo(
    () => {
      const briefs = useLiveBriefStore.getState().briefsBySession;
      const contextPctBySession: Record<string, number | undefined> = {};
      for (const [sessionId, brief] of Object.entries(briefs)) {
        const pct = brief?.telemetry?.context?.pct;
        if (pct != null) contextPctBySession[sessionId] = pct;
      }
      return buildMinimapModel(workspace, { activePaneId, metadataBySession: volatileMetadata, contextPctBySession });
    },
    [activePaneId, volatileMetadata, workspace, now],
  );
  const strip = useMemo(() => minimapWorkspaceStrip(model, displayStateByTabId), [displayStateByTabId, model]);
  const hiddenTicks = strip.tabCount - MINIMAP_STRIP_MAX_TICKS;
  const { rowCount, mapStyle } = useMemo(() => {
    const columnChipCounts = model.columns.map((column) => column.cells.map((cell) => cell.chips.length));
    return {
      rowCount: Math.max(1, ...model.columns.map((column) => column.cells.length)),
      mapStyle: { "--minimap-map-height": `${minimapMapHeightPx(columnChipCounts, expanded)}px` } as CSSProperties,
    };
  }, [expanded, model]);
  // 実画面のタブバーと同じ解決 (TabItem 参照): 未設定の WS には色を発明しない。
  const workspaceColor = resolveWorkspaceColor(workspace.color)?.value;
  return <section className={`cmux-minimap-workspace${expanded ? " is-expanded" : ""}`} data-minimap-workspace={workspace.id} style={workspaceColor ? { "--minimap-ws": workspaceColor } as CSSProperties : undefined}>
    <button type="button" className="cmux-minimap-workspace-header" aria-expanded={expanded} onClick={onToggle} title={workspace.name} aria-label={`${workspace.name} — ${strip.tabCount}本${strip.waitingCount > 0 ? `、返答待ち${strip.waitingCount}本` : ""}`}>
      <span className="cmux-minimap-workspace-swatch" aria-hidden="true" />
      <span className="cmux-minimap-workspace-name" title={workspace.name}>{workspace.name}</span>
      <span className="cmux-minimap-workspace-summary" aria-hidden="true">
        <span className="cmux-minimap-workspace-strip">
          {strip.ticks.slice(0, MINIMAP_STRIP_MAX_TICKS).map((entry) => {
            const tickColor = entry.mark?.color.fg;
            return <i
              key={entry.tabId}
              className={`cmux-minimap-strip-tick is-${entry.activity}`}
              style={tickColor ? { "--minimap-agent": tickColor } as CSSProperties : undefined}
            />;
          })}
          {hiddenTicks > 0 ? <em className="cmux-minimap-strip-overflow">{`+${hiddenTicks}`}</em> : null}
        </span>
        <span className="cmux-minimap-workspace-count">{strip.tabCount}</span>
      </span>
    </button>
    <div className={`cmux-minimap-map${expanded ? " is-expanded" : ""}`} data-minimap-expanded={expanded || undefined} data-minimap-row-count={rowCount} style={mapStyle}>
      {model.columns.map((column) => <div key={column.index} className="cmux-minimap-column" style={{ flexGrow: column.widthShare }}>
        {column.cells.map((cell) => <MinimapPaneCell key={cell.paneId} cell={cell} workspaceId={workspace.id} selectedTabId={selectedTabId} selectedTabIds={selectedTabIds} openColumnByTabId={openColumnByTabId} groupPulseTabIds={groupPulseTabIds} displayStateByTabId={displayStateByTabId} expanded={expanded} now={now} minHeight={minimapCellHeightPx(cell.chips.length, expanded)} onSelect={onSelect} onSelectGroup={onSelectGroup} onJump={onJump} />)}
      </div>)}
    </div>
  </section>;
}
