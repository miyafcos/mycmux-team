import type { MouseEvent as ReactMouseEvent } from "react";
import { chatColumnColor } from "../../lib/chatColumnColors";
import type { DashboardDisplayState } from "./dashboardModel";
import type { MinimapCell } from "./minimapModel";
import { MinimapTabChip } from "./MinimapTabChip";
import { usePaneDragStore } from "../../stores/paneDragStore";

export function MinimapPaneCell({ cell, workspaceId, selectedTabId, selectedTabIds, openColumnByTabId, groupPulseTabIds, displayStateByTabId, expanded, minHeight, now, onSelect, onSelectGroup, onJump }: {
  cell: MinimapCell;
  workspaceId: string;
  selectedTabId: string | null;
  selectedTabIds: ReadonlySet<string>;
  /** tabId -> chat column index. A map, so a crowded workspace stays O(T). */
  openColumnByTabId: ReadonlyMap<string, number>;
  groupPulseTabIds: ReadonlySet<string>;
  displayStateByTabId: ReadonlyMap<string, DashboardDisplayState>;
  expanded: boolean;
  minHeight: number;
  now: number;
  onSelect: (tabId: string, event: ReactMouseEvent<HTMLButtonElement>) => void;
  onSelectGroup: (tabId: string) => void;
  onJump?: (workspaceId: string, paneId: string, tabId: string) => void;
}) {
  const target = usePaneDragStore((state) => state.target);
  const dragItem = usePaneDragStore((state) => state.item);
  const isDropTarget = target?.kind === "pane"
    && target.surface === "minimap"
    && target.workspaceId === workspaceId
    && target.paneId === cell.paneId;
  const dropZone = isDropTarget ? target.zone : null;
  const isDragSource = dragItem?.kind === "pane"
    && dragItem.surface === "minimap"
    && dragItem.workspaceId === workspaceId
    && dragItem.paneId === cell.paneId;
  const cellLabel = cell.chips.map((chip) => chip.label).join("\n");
  return <div
    className={`cmux-minimap-cell${expanded ? " is-expanded" : ""}${cell.isActivePane && !isDragSource ? " is-active-pane" : ""}${isDragSource ? " is-drag-source" : ""}${isDropTarget ? ` is-minimap-drop-target is-minimap-drop-${dropZone}` : ""}`}
    data-minimap-pane={cell.paneId}
    data-minimap-dnd-workspace-id={workspaceId}
    data-minimap-dnd-pane-id={cell.paneId}
    data-minimap-drop-zone={dropZone ?? undefined}
    title={cellLabel || undefined}
    style={{ flexGrow: cell.heightShare, minHeight }}
  >
    <div
      className="cmux-minimap-pane-grip"
      data-minimap-pane-grip=""
      title="ペインを移動"
      aria-hidden="true"
    />
    {cell.chips.length === 0 ? <span className="cmux-minimap-pane-empty">空きペイン</span> : null}
    {cell.chips.map((chip) => {
      const openColumn = openColumnByTabId.get(chip.tabId);
      return <MinimapTabChip key={chip.tabId} chip={chip} workspaceId={workspaceId} paneId={cell.paneId} selected={!isDragSource && chip.tabId === selectedTabId} open={openColumn !== undefined} columnColor={openColumn === undefined ? undefined : chatColumnColor(openColumn)} selectedTabIds={selectedTabIds} groupPulseTabIds={groupPulseTabIds} displayState={displayStateByTabId.get(chip.tabId) ?? "idle"} collapsed={!expanded} now={now} onSelect={onSelect} onSelectGroup={onSelectGroup} onJump={onJump} />;
    })}
  </div>;
}
