import { agentKindColor } from "../../lib/agentKindColors";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { displayStateColor } from "./DashboardCardRow";
import type { DashboardDisplayState } from "./dashboardModel";
import { stateLabels } from "./stateLabels";
import type { MinimapChip } from "./minimapModel";
import { formatLastOutputAge, formatLastOutputAgeCompact } from "../layout/tabSweep";
import { usePaneDragSource } from "../../hooks/usePaneDragSource";
import { usePaneDragStore } from "../../stores/paneDragStore";

const DECLARED_META_LABEL = "宣言のみ";

export function MinimapTabChip({ chip, workspaceId, paneId, selected, open, columnColor, selectedTabIds, groupPulseTabIds, displayState, collapsed, now, onSelect, onSelectGroup, onJump }: {
  chip: MinimapChip;
  workspaceId: string;
  paneId: string;
  selected: boolean;
  open: boolean;
  columnColor?: string;
  selectedTabIds: ReadonlySet<string>;
  groupPulseTabIds: ReadonlySet<string>;
  displayState: DashboardDisplayState;
  collapsed: boolean;
  /** Panel clock, so the elapsed value re-evaluates without a PTY subscription. */
  now: number;
  onSelect: (tabId: string, event: ReactMouseEvent<HTMLButtonElement>) => void;
  onSelectGroup: (tabId: string) => void;
  onJump?: (workspaceId: string, paneId: string, tabId: string) => void;
}) {
  const { beginPointerDrag, shouldSuppressClick } = usePaneDragSource();
  const dragItem = usePaneDragStore((state) => state.item);
  const labels = stateLabels(displayState);
  const agentColor = agentKindColor(chip.agentKind)?.fg;
  const label = chip.label;
  const needsAnswer = displayState === "needsHuman";
  const isBundleSelected = selectedTabIds.has(chip.tabId);
  const isGroupPulse = groupPulseTabIds.has(chip.tabId);
  const isDragSource = dragItem?.surface === "minimap" && (dragItem.kind === "tab"
    ? dragItem.tabId === chip.tabId
    : dragItem.kind === "tab-bundle" && dragItem.tabIds.includes(chip.tabId));
  // A declared tab has never produced output, so it carries no elapsed value.
  const timestamp = chip.declared ? null : chip.lastOutputAt ?? null;
  const ageSentence = timestamp === null ? null : formatLastOutputAge(timestamp, now);
  const age = formatLastOutputAgeCompact(timestamp, now);
  const agentSegment = chip.declared ? DECLARED_META_LABEL : chip.agentKind;
  const jumpHint = "ダブルクリックで元の画面に戻る";
  const groupHint = "Alt+クリックでグループ選択";
  const beginChipDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const dragItem = isBundleSelected && selectedTabIds.size > 1
      ? { kind: "tab-bundle" as const, surface: "minimap" as const, workspaceId, paneId, tabIds: [...selectedTabIds], anchorTabId: chip.tabId, label }
      : { kind: "tab" as const, surface: "minimap" as const, workspaceId, paneId, tabId: chip.tabId, label };
    beginPointerDrag(event, dragItem);
  };
  const statusDot = <span className={`cmux-minimap-status${labels.activity === "working" ? " is-working" : ""}`} aria-hidden="true" style={{ background: displayStateColor(displayState) }} />;
  return <button
    type="button"
    className={`cmux-minimap-chip${selected ? " is-selected" : ""}${open && !selected ? " is-open" : ""}${isBundleSelected ? " is-bundle-selected" : ""}${isGroupPulse ? " is-group-pulse" : ""}${chip.declared ? " is-declared" : ""}${needsAnswer ? " is-waiting" : ""}${collapsed ? " is-collapsed" : " is-expanded"}${isDragSource ? " is-drag-source" : ""}`}
    data-minimap-tab={chip.tabId}
    data-dashboard-open={open || undefined}
    data-dashboard-active={selected || undefined}
    data-declared={chip.declared || undefined}
    title={ageSentence ? `${label}\n${ageSentence}` : label}
    aria-label={`${label} — ${agentSegment ? `${agentSegment}・` : ""}${labels.tooltip}${ageSentence ? `・${ageSentence}` : ""}。${jumpHint}。${groupHint}`}
    aria-pressed={isBundleSelected}
    onPointerDown={beginChipDrag}
    onClick={(event) => {
      if (shouldSuppressClick()) return;
      if (event.altKey) {
        onSelectGroup(chip.tabId);
        return;
      }
      onSelect(chip.tabId, event);
    }}
    onDoubleClick={() => { if (!shouldSuppressClick()) onJump?.(workspaceId, paneId, chip.tabId); }}
    style={open && !selected && columnColor ? { outlineColor: columnColor } : undefined}
  >
    {collapsed ? null : <span className="cmux-minimap-meta" aria-hidden="true">
      {chip.declared ? null : agentColor ? <span className="cmux-minimap-agent-dot" style={{ background: agentColor }} /> : null}
      {agentSegment ? <span className="cmux-minimap-agent">{agentSegment}</span> : null}
      {chip.declared ? null : statusDot}
      {needsAnswer ? <span className="cmux-minimap-question">返答待ち</span> : null}
      {age ? <span className="cmux-minimap-age">{age}</span> : null}
    </span>}
    <span className="cmux-minimap-label">{label}</span>
    {collapsed && !chip.declared ? statusDot : null}
  </button>;
}
