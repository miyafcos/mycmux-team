import type { DashboardDisplayState } from "./dashboardModel";
import type { MinimapCell } from "./minimapModel";
import { MinimapTabChip } from "./MinimapTabChip";
import { usePaneDragStore } from "../../stores/paneDragStore";

export function MinimapPaneCell({ cell, workspaceId, selectedTabId, displayStateByTabId, presentation, paneLabel, onSelect }: {
  cell: MinimapCell;
  workspaceId: string;
  selectedTabId: string | null;
  displayStateByTabId: ReadonlyMap<string, DashboardDisplayState>;
  presentation: "map" | "list";
  paneLabel?: string;
  onSelect: (tabId: string) => void;
}) {
  const target = usePaneDragStore((state) => state.target);
  const isDropTarget = target?.kind === "pane"
    && target.surface === "minimap"
    && target.workspaceId === workspaceId
    && target.paneId === cell.paneId;
  const dropZone = isDropTarget ? target.zone : null;
  const cellLabel = cell.chips.map((chip) => chip.label).join("\n");
  return <div
    className={`cmux-minimap-cell${presentation === "list" ? " is-list-row" : ""}${cell.isActivePane ? " is-active-pane" : ""}${isDropTarget ? ` is-minimap-drop-target is-minimap-drop-${dropZone}` : ""}`}
    data-minimap-pane={cell.paneId}
    data-minimap-dnd-workspace-id={workspaceId}
    data-minimap-dnd-pane-id={cell.paneId}
    data-minimap-drop-zone={dropZone ?? undefined}
    title={cellLabel || undefined}
    style={presentation === "map" ? { flexGrow: cell.heightShare } : undefined}
  >
    {presentation === "list" ? <>
      <span className="cmux-minimap-pane-list-label" aria-hidden="true">{paneLabel} ─</span>
      <div className="cmux-minimap-pane-list-tabs">
        {cell.chips.map((chip) => <MinimapTabChip key={chip.tabId} chip={chip} workspaceId={workspaceId} paneId={cell.paneId} selected={chip.tabId === selectedTabId} displayState={displayStateByTabId.get(chip.tabId) ?? "idle"} collapsed={false} onSelect={onSelect} />)}
      </div>
    </> : cell.chips.map((chip) => <MinimapTabChip key={chip.tabId} chip={chip} workspaceId={workspaceId} paneId={cell.paneId} selected={chip.tabId === selectedTabId} displayState={displayStateByTabId.get(chip.tabId) ?? "idle"} collapsed onSelect={onSelect} />)}
  </div>;
}
