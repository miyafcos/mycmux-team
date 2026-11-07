import { useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { DashboardStatusMark } from "./DashboardUi";
import type { DashboardDisplayState } from "./dashboardModel";
import { stateLabels } from "./stateLabels";
import { dashboardStrings } from "./dashboardStrings";
import type { MinimapChip } from "./minimapModel";
import { formatLastOutputAge, formatLastOutputAgeCompact } from "../layout/tabSweep";
import { usePaneDragSource } from "../../hooks/usePaneDragSource";
import { usePaneDragStore } from "../../stores/paneDragStore";
import { dormantAgentDescription } from "../../lib/agentDormancy";
import { useThemeStore } from "../../stores/themeStore";

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
  const dormantDescription = chip.declared ? undefined : dormantAgentDescription(chip.mark);
  const agentColor = chip.mark?.color.fg;
  const label = chip.label;
  // Glyph metrics follow these settings without resizing the label box, so ResizeObserver alone can miss them.
  const fontFamily = useThemeStore((state) => state.fontFamily);
  const fontScale = useThemeStore((state) => state.uiFontScale);
  const density = useThemeStore((state) => state.uiDensity);
  const labelRef = useRef<HTMLSpanElement>(null);
  const [labelTruncated, setLabelTruncated] = useState(false);
  useLayoutEffect(() => {
    const node = labelRef.current;
    if (!node || collapsed) return;
    const measure = () => setLabelTruncated(node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node);
    let active = true;
    const fonts = typeof document === "undefined" ? undefined : document.fonts;
    void fonts?.ready.then(() => { if (active) measure(); });
    const onFontsLoaded = () => { if (active) measure(); };
    fonts?.addEventListener?.("loadingdone", onFontsLoaded);
    return () => { active = false; observer?.disconnect(); fonts?.removeEventListener?.("loadingdone", onFontsLoaded); };
  }, [label, collapsed, fontFamily, fontScale, density]);
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
  const agentSegment = chip.declared ? DECLARED_META_LABEL : chip.mark?.label;
  const metaRef = useRef<HTMLSpanElement>(null);
  const agentRef = useRef<HTMLSpanElement>(null);
  const contextRef = useRef<HTMLSpanElement>(null);
  const [agentNameFits, setAgentNameFits] = useState(true);
  const [contextFits, setContextFits] = useState(true);
  const [metaGap, setMetaGap] = useState<number>();
  useLayoutEffect(() => {
    const meta = metaRef.current;
    const agent = agentRef.current;
    if (!meta) return;
    const measure = () => {
      const context = contextRef.current;
      const widths = [...meta.children]
        .filter((child) => child !== agent && child !== context && !child.classList.contains("cmux-dashboard-sr-only"))
        .map((child) => child.getBoundingClientRect().width).filter((width) => width > 0);
      const gap = parseFloat(getComputedStyle(meta).getPropertyValue("--minimap-meta-gap")) || 5;
      const fixedWidth = widths.reduce((sum, width) => sum + width, 0);
      const fitsContext = !context || fixedWidth + context.scrollWidth + gap * widths.length <= meta.clientWidth + 0.5;
      // Keep elapsed text intact before spending space on CTX or the full name.
      // Tighten only the remaining gaps when the narrowest cards need it.
      const remaining = fitsContext && context ? [...widths, context.scrollWidth] : widths;
      const remainingWidth = remaining.reduce((sum, width) => sum + width, 0);
      const fittedGap = remaining.length > 1 ? Math.max(0, Math.min(gap, (meta.clientWidth - remainingWidth) / (remaining.length - 1))) : gap;
      setContextFits(fitsContext);
      setMetaGap(fittedGap);
      setAgentNameFits(!agent || agent.scrollWidth + remainingWidth + fittedGap * remaining.length <= meta.clientWidth + 0.5);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(meta);
    for (const child of meta.children) observer?.observe(child);
    let active = true;
    void document.fonts?.ready.then(() => { if (active) measure(); });
    return () => { active = false; observer?.disconnect(); };
  }, [agentSegment, age, collapsed, displayState, chip.contextPct, dormantDescription]);
  const jumpHint = "ダブルクリックで元の画面に戻る";
  const groupHint = "Alt+クリックでグループ選択";
  const beginChipDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const dragItem = isBundleSelected && selectedTabIds.size > 1
      ? { kind: "tab-bundle" as const, surface: "minimap" as const, workspaceId, paneId, tabIds: [...selectedTabIds], anchorTabId: chip.tabId, label }
      : { kind: "tab" as const, surface: "minimap" as const, workspaceId, paneId, tabId: chip.tabId, label };
    beginPointerDrag(event, dragItem);
  };
  const declarationOnly = chip.declared && labels.attention === null;
  const statusMark = <DashboardStatusMark state={declarationOnly ? "notStarted" : displayState} label={declarationOnly ? DECLARED_META_LABEL : labels.attention === "needsReview" ? dashboardStrings.stateNeedsReview : labels.primary} hasElapsed={Boolean(age)} />;
  return <button
    type="button"
    className={`cmux-minimap-chip${selected ? " is-selected" : ""}${open && !selected ? " is-open" : ""}${isBundleSelected ? " is-bundle-selected" : ""}${isGroupPulse ? " is-group-pulse" : ""}${chip.declared ? " is-declared" : ""}${needsAnswer ? " is-waiting" : ""}${collapsed ? " is-collapsed" : " is-expanded"}${!collapsed && labelTruncated ? " is-label-truncated" : ""}${isDragSource ? " is-drag-source" : ""}`}
    data-minimap-tab={chip.tabId}
    data-mark-kind={chip.mark?.kind ?? ""}
    data-mark-source={chip.mark?.source}
    data-dashboard-open={open || undefined}
    data-dashboard-active={selected || undefined}
    data-declared={chip.declared || undefined}
    title={[label, agentSegment, chip.declared ? DECLARED_META_LABEL : null, labels.tooltip, dormantDescription, chip.contextPct == null ? null : `CTX ${Math.round(chip.contextPct)}%`, ageSentence].filter(Boolean).join("\n")}
    aria-label={`${label} — ${agentSegment ? `${agentSegment}・` : ""}${labels.tooltip}${dormantDescription ? `・${dormantDescription}` : ""}${chip.contextPct == null ? "" : `・CTX ${Math.round(chip.contextPct)}%`}${ageSentence ? `・${ageSentence}` : ""}。${jumpHint}。${groupHint}`}
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
    {collapsed ? null : <span ref={metaRef} className="cmux-minimap-meta" style={{ columnGap: metaGap }} aria-hidden="true">
      {chip.declared ? null : agentColor ? <span className="cmux-minimap-agent-dot" style={{ background: agentColor, opacity: chip.mark?.dormant ? 0.45 : 1 }} /> : null}
      {agentSegment && !chip.declared ? <span ref={agentRef} className={`cmux-minimap-agent${agentNameFits ? "" : " is-name-hidden"}`} style={{ opacity: chip.mark?.dormant ? 0.45 : 1 }}>{agentSegment}</span> : null}
      {chip.contextPct == null ? null : <span ref={contextRef} className={`cmux-minimap-ctx${contextFits ? "" : " is-ctx-hidden"}`} data-minimap-ctx={chip.tabId}>{Math.round(chip.contextPct)}%</span>}
      {age ? <span className={`cmux-minimap-age${displayState === "noUpdate" ? " is-stalled" : ""}`}>{age}</span> : null}
    </span>}
    {collapsed ? null : <span className="cmux-minimap-status-line" title={labels.tooltip}>
      {dormantDescription ? <DashboardStatusMark state="dormant" label={dormantDescription} /> : null}
      {statusMark}
      {chip.declared && !declarationOnly ? <DashboardStatusMark state="notStarted" label={DECLARED_META_LABEL} /> : null}
    </span>}
    <span ref={labelRef} className="cmux-minimap-label">{label}</span>
    {collapsed && chip.contextPct != null ? <span className="cmux-minimap-ctx" data-minimap-ctx={chip.tabId}>{Math.round(chip.contextPct)}%</span> : null}
    {collapsed ? displayState === "noUpdate" && age ? <span className="cmux-minimap-age is-stalled">{age}</span> : statusMark : null}
  </button>;
}
