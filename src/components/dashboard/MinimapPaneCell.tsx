import type { MouseEvent as ReactMouseEvent } from "react";
import type { DashboardDisplayState } from "./dashboardModel";
import type { MinimapCell } from "./minimapModel";
import { MinimapTabChip } from "./MinimapTabChip";
import { usePaneDragStore } from "../../stores/paneDragStore";

export function MinimapPaneCell({ cell, workspaceId, selectedTabId, selectedTabIds, groupPulseTabIds, displayStateByTabId, expanded, onSelect, onSelectGroup }: {
  cell: MinimapCell;
  workspaceId: string;
  selectedTabId: string | null;
  selectedTabIds: ReadonlySet<string>;
  groupPulseTabIds: ReadonlySet<string>;
  displayStateByTabId: ReadonlyMap<string, DashboardDisplayState>;
  expanded: boolean;
  onSelect: (tabId: string, event: ReactMouseEvent<HTMLButtonElement>) => void;
  onSelectGroup: (tabId: string) => void;
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
    style={{ flexGrow: cell.heightShare }}
  >
    {cell.chips.map((chip) => <MinimapTabChip key={chip.tabId} chip={chip} workspaceId={workspaceId} paneId={cell.paneId} selected={!isDragSource && chip.tabId === selectedTabId} selectedTabIds={selectedTabIds} groupPulseTabIds={groupPulseTabIds} displayState={displayStateByTabId.get(chip.tabId) ?? "idle"} collapsed={!expanded} onSelect={onSelect} onSelectGroup={onSelectGroup} />)}
  </div>;
}
