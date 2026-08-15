import { agentKindColor } from "../../lib/agentKindColors";
import { displayStateColor } from "./DashboardCardRow";
import type { DashboardDisplayState } from "./dashboardModel";
import { stateLabels } from "./stateLabels";
import type { MinimapChip } from "./minimapModel";
import { usePaneDragSource } from "../../hooks/usePaneDragSource";
import { usePaneDragStore } from "../../stores/paneDragStore";

export function MinimapTabChip({ chip, workspaceId, paneId, selected, displayState, collapsed, onSelect }: {
  chip: MinimapChip;
  workspaceId: string;
  paneId: string;
  selected: boolean;
  displayState: DashboardDisplayState;
  collapsed: boolean;
  onSelect: (tabId: string) => void;
}) {
  const { beginPointerDrag, shouldSuppressClick } = usePaneDragSource();
  const dragItem = usePaneDragStore((state) => state.item);
  const labels = stateLabels(displayState);
  const agentColor = agentKindColor(chip.agentKind)?.fg;
  const label = chip.declared ? `＋ ${chip.label}（まだ）` : chip.label;
  const needsAnswer = displayState === "needsHuman";
  const isDragSource = dragItem?.kind === "tab" && dragItem.surface === "minimap" && dragItem.tabId === chip.tabId;
  return <button
    type="button"
    className={`cmux-minimap-chip${selected ? " is-selected" : ""}${chip.declared ? " is-declared" : ""}${collapsed ? " is-collapsed" : " is-expanded"}${isDragSource ? " is-drag-source" : ""}`}
    data-minimap-tab={chip.tabId}
    data-declared={chip.declared || undefined}
    title={label}
    aria-label={`${label} — ${labels.tooltip}`}
    onPointerDown={(event) => beginPointerDrag(event, { kind: "tab", surface: "minimap", workspaceId, paneId, tabId: chip.tabId, label })}
    onClick={() => { if (!shouldSuppressClick()) onSelect(chip.tabId); }}
    style={{ borderLeftColor: agentColor }}
  >
    <span className="cmux-minimap-glyph" aria-hidden="true">{chip.typeGlyph}</span>
    {needsAnswer ? <span className="cmux-minimap-question" aria-hidden="true">❓</span> : null}
    {!collapsed ? <span className="cmux-minimap-label">{label}</span> : null}
    <span className={`cmux-minimap-status${labels.activity === "working" ? " is-working" : ""}`} aria-hidden="true" style={{ background: displayStateColor(displayState) }} />
  </button>;
}
