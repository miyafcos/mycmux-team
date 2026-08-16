import { agentKindColor } from "../../lib/agentKindColors";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { displayStateColor } from "./DashboardCardRow";
import type { DashboardDisplayState } from "./dashboardModel";
import { stateLabels } from "./stateLabels";
import type { MinimapChip } from "./minimapModel";
import { usePaneDragSource } from "../../hooks/usePaneDragSource";
import { usePaneDragStore } from "../../stores/paneDragStore";

export function MinimapTabChip({ chip, workspaceId, paneId, selected, selectedTabIds, groupPulseTabIds, displayState, collapsed, onSelect, onSelectGroup }: {
  chip: MinimapChip;
  workspaceId: string;
  paneId: string;
  selected: boolean;
  selectedTabIds: ReadonlySet<string>;
  groupPulseTabIds: ReadonlySet<string>;
  displayState: DashboardDisplayState;
  collapsed: boolean;
  onSelect: (tabId: string, event: ReactMouseEvent<HTMLButtonElement>) => void;
  onSelectGroup: (tabId: string) => void;
}) {
  const { beginPointerDrag, shouldSuppressClick } = usePaneDragSource();
  const dragItem = usePaneDragStore((state) => state.item);
  const labels = stateLabels(displayState);
  const agentColor = agentKindColor(chip.agentKind)?.fg;
  const label = chip.declared ? `＋ ${chip.label}（まだ）` : chip.label;
  const needsAnswer = displayState === "needsHuman";
  const isBundleSelected = selectedTabIds.has(chip.tabId);
  const isGroupPulse = groupPulseTabIds.has(chip.tabId);
  const isDragSource = dragItem?.surface === "minimap" && (dragItem.kind === "tab"
    ? dragItem.tabId === chip.tabId
    : dragItem.kind === "tab-bundle" && dragItem.tabIds.includes(chip.tabId));
  const beginChipDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey) return;
    const dragItem = isBundleSelected && selectedTabIds.size > 1
      ? { kind: "tab-bundle" as const, surface: "minimap" as const, workspaceId, paneId, tabIds: [...selectedTabIds], anchorTabId: chip.tabId, label }
      : { kind: "tab" as const, surface: "minimap" as const, workspaceId, paneId, tabId: chip.tabId, label };
    beginPointerDrag(event, dragItem);
  };
  return <button
    type="button"
    className={`cmux-minimap-chip${selected ? " is-selected" : ""}${isBundleSelected ? " is-bundle-selected" : ""}${isGroupPulse ? " is-group-pulse" : ""}${chip.declared ? " is-declared" : ""}${collapsed ? " is-collapsed" : " is-expanded"}${isDragSource ? " is-drag-source" : ""}`}
    data-minimap-tab={chip.tabId}
    data-declared={chip.declared || undefined}
    title={label}
    aria-label={`${label} — ${labels.tooltip}`}
    aria-pressed={isBundleSelected}
    onPointerDown={beginChipDrag}
    onClick={(event) => { if (!shouldSuppressClick()) onSelect(chip.tabId, event); }}
    onDoubleClick={() => { if (!shouldSuppressClick()) onSelectGroup(chip.tabId); }}
    style={{ borderLeftColor: agentColor }}
  >
    <span className="cmux-minimap-glyph" aria-hidden="true">{chip.typeGlyph}</span>
    {needsAnswer ? <span className="cmux-minimap-question" aria-hidden="true">❓</span> : null}
    {!collapsed ? <span className="cmux-minimap-label">{label}</span> : null}
    <span className={`cmux-minimap-status${labels.activity === "working" ? " is-working" : ""}`} aria-hidden="true" style={{ background: displayStateColor(displayState) }} />
  </button>;
}
