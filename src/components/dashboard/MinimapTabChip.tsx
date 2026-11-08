import { useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
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

// Coordinates are relative to the label; glyph rectangles come from DOM Ranges.
// The ellipsis occupies its own slot after the last complete second-line glyph.
export function minimapLabelEllipsis(glyphs: readonly { left: number; right: number; top: number }[], width: number, ellipsisWidth: number, lineHeight: number) {
  const firstTop = glyphs[0]?.top ?? 0;
  const secondTop = glyphs.find(glyph => glyph.top > firstTop + 1)?.top ?? lineHeight;
  const limit = Math.max(0, width - ellipsisWidth);
  let cut = 0;
  for (const glyph of glyphs) {
    if (Math.abs(glyph.top - secondTop) <= 1 && glyph.left >= 0 && glyph.right <= limit + 0.01) cut = Math.max(cut, glyph.right);
  }
  // Chromium may round neighbouring Range edges outwards by 1/64px.
  // Never expose even that sliver of the first omitted glyph.
  const omitted = glyphs.find(glyph => Math.abs(glyph.top - secondTop) <= 1 && glyph.right > limit + 0.01);
  if (omitted) cut = Math.min(cut, Math.max(0, omitted.left));
  return { cut, line2Top: secondTop, ellipsisLeft: cut, ellipsisTop: lineHeight };
}

// Overflow clips at the tile padding edge, or at the cell's inner border.
// Use the row's stable box rather than the position of a hidden child.
export function minimapVisibleRowWidth(contentWidth: number, row: { right: number }, tile: { right: number }, cell?: { right: number }, cellBorderRight = 0): number {
  const right = Math.min(tile.right, cell ? cell.right - cellBorderRight : tile.right);
  return Math.max(0, contentWidth + right - row.right);
}

// Retain the half-pixel layout allowance, but do not spend rounded clientWidth
// or that allowance on visibly clipped text. Range edges round out by 1/64px.
export function minimapLabelFits(width: number, available: number, preciseAvailable = available): boolean {
  return width <= available + 0.5 && width <= preciseAvailable + 0.05;
}

function visibleRowWidth(tile: HTMLElement, row: HTMLElement, contentWidth: number): number {
  const cell = tile.closest<HTMLElement>(".cmux-minimap-cell");
  return minimapVisibleRowWidth(contentWidth, row.getBoundingClientRect(), tile.getBoundingClientRect(),
    cell?.getBoundingClientRect(), cell ? parseFloat(getComputedStyle(cell).borderRightWidth) || 0 : 0);
}

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
  const chipRef = useRef<HTMLButtonElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const [labelMask, setLabelMask] = useState<CSSProperties>();
  const [labelTruncated, setLabelTruncated] = useState(false);
  useLayoutEffect(() => {
    const node = labelRef.current;
    if (!node || collapsed) return;
    const measure = () => {
      const truncated = node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1;
      setLabelTruncated(truncated);
      const tile = chipRef.current;
      const text = node.firstChild;
      const range = document.createRange();
      // jsdom has no range layout; keep the CSS fallback for that environment.
      if (!truncated || !tile || !text || typeof range.getClientRects !== "function") {
        setLabelMask(undefined);
        return;
      }
      const box = node.getBoundingClientRect();
      const tileBox = tile.getBoundingClientRect();
      const font = getComputedStyle(node);
      const glyphs: { left: number; right: number; top: number }[] = [];
      let offset = 0;
      for (const character of label) {
        range.setStart(text, offset);
        offset += character.length;
        range.setEnd(text, offset);
        for (const rect of range.getClientRects()) glyphs.push({ left: rect.left - box.left, right: rect.right - box.left, top: rect.top - box.top });
      }
      const mask = minimapLabelEllipsis(glyphs, box.width, parseFloat(getComputedStyle(tile).fontSize), parseFloat(font.lineHeight));
      const next = {
        "--minimap-label-cut": `${mask.cut}px`,
        "--minimap-label-line2-top": `${mask.line2Top}px`,
        "--minimap-label-ellipsis-left": `${box.left - tileBox.left + mask.ellipsisLeft}px`,
        "--minimap-label-ellipsis-top": `${box.top - tileBox.top + mask.ellipsisTop}px`,
      } as CSSProperties;
      setLabelMask(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node);
    if (metaRef.current) observer?.observe(metaRef.current);
    let active = true;
    const fonts = typeof document === "undefined" ? undefined : document.fonts;
    void fonts?.ready.then(() => { if (active) measure(); });
    const onFontsLoaded = () => { if (active) measure(); };
    fonts?.addEventListener?.("loadingdone", onFontsLoaded);
    return () => { active = false; observer?.disconnect(); fonts?.removeEventListener?.("loadingdone", onFontsLoaded); };
  }, [label, collapsed, fontFamily, fontScale, density, selected, displayState, selectedTabIds.has(chip.tabId)]);
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
  const ageRef = useRef<HTMLSpanElement>(null);
  const [ageFits, setAgeFits] = useState(true);
  const [statusTextFits, setStatusTextFits] = useState(true);
  const [statusIconShift, setStatusIconShift] = useState(0);
  const statusMeasureRef = useRef<() => void>(() => {});
  const [metaGap, setMetaGap] = useState<number>();
  useLayoutEffect(() => {
    const tile = chipRef.current;
    const meta = metaRef.current;
    const agent = agentRef.current;
    if (!tile || (!meta && !collapsed)) return;
    const measure = () => {
      statusMeasureRef.current();
      const context = contextRef.current;
      const elapsed = ageRef.current;
      const elapsedWidth = elapsed?.getBoundingClientRect().width ?? 0;
      if (collapsed) {
        const style = getComputedStyle(tile);
        const label = labelRef.current;
        const gap = label && getComputedStyle(label).display !== "none" ? parseFloat(style.columnGap) || 0 : 0;
        const available = visibleRowWidth(tile, tile, tile.getBoundingClientRect().width - parseFloat(style.paddingLeft) - gap);
        const fits = minimapLabelFits(elapsedWidth, available);
        setAgeFits(fits);
        // Elapsed (or its replacement icon) has priority over CTX.
        const statusWidth = elapsed && fits ? elapsedWidth : parseFloat(style.getPropertyValue("--cmux-dash-icon-md")) || 12;
        const contextWidth = context ? Math.max(context.scrollWidth, context.getBoundingClientRect().width) : 0;
        setContextFits(!context || minimapLabelFits(contextWidth + statusWidth + (parseFloat(style.columnGap) || 0), available));
        return;
      }
      if (!meta) return;
      const widths = [...meta.children]
        .filter(child => child !== agent && child !== context && child !== elapsed && !child.classList.contains("cmux-dashboard-sr-only"))
        .map(child => child.getBoundingClientRect().width).filter(width => width > 0);
      // Hidden spans remain measurable. Do not let their current position change
      // the decision, or ResizeObserver can alternate between hidden and visible.
      const available = meta.clientWidth;
      const rectWidth = meta.getBoundingClientRect().width;
      // Use fractional geometry only when it agrees with the integer client box.
      // Unlaid-out rectangles must retain the existing clientWidth contract.
      const preciseWidth = Math.abs(rectWidth - available) <= 0.5 ? rectWidth : available;
      const fitsAge = minimapLabelFits(widths.reduce((sum, width) => sum + width, 0) + elapsedWidth,
        visibleRowWidth(tile, meta, available), visibleRowWidth(tile, meta, preciseWidth));
      if (elapsed && fitsAge) widths.push(elapsedWidth);
      const gap = parseFloat(getComputedStyle(meta).getPropertyValue("--minimap-meta-gap")) || 5;
      const fixedWidth = widths.reduce((sum, width) => sum + width, 0);
      const fitsContext = fitsAge && (!context || fixedWidth + context.scrollWidth + gap * widths.length <= available + 0.5);
      const remaining = fitsContext && context ? [...widths, context.scrollWidth] : widths;
      const remainingWidth = remaining.reduce((sum, width) => sum + width, 0);
      const fittedGap = remaining.length > 1 ? Math.max(0, Math.min(gap, (available - remainingWidth) / (remaining.length - 1))) : gap;
      setAgeFits(fitsAge);
      setContextFits(fitsContext);
      setMetaGap(fittedGap);
      setAgentNameFits(fitsAge && (!agent || agent.scrollWidth + remainingWidth + fittedGap * remaining.length <= available + 0.5));
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(tile);
    if (meta) observer?.observe(meta);
    for (const child of (meta ?? tile).children) observer?.observe(child);
    for (const text of tile.querySelectorAll(".cmux-minimap-status-line, .cmux-dashboard-status-text")) observer?.observe(text);
    let active = true;
    const fonts = document.fonts;
    void fonts?.ready.then(() => { if (active) measure(); });
    return () => { active = false; observer?.disconnect(); };
  }, [agentSegment, age, collapsed, displayState, chip.contextPct, dormantDescription, fontFamily, fontScale, density]);
  useLayoutEffect(() => {
    const tile = chipRef.current;
    if (!tile) return;
    const line = collapsed ? tile : tile.querySelector<HTMLElement>(".cmux-minimap-status-line");
    if (!line) return;
    const measure = () => {
      const style = getComputedStyle(tile);
      let available = visibleRowWidth(tile, line, line.getBoundingClientRect().width);
      if (collapsed) {
        available -= parseFloat(style.paddingLeft);
        const label = labelRef.current;
        if (label && getComputedStyle(label).display !== "none") available -= parseFloat(style.columnGap) || 0;
        const context = contextRef.current;
        if (context && getComputedStyle(context).visibility !== "hidden") available -= context.getBoundingClientRect().width + (parseFloat(style.columnGap) || 0);
      }
      let width = 0;
      for (const mark of line.querySelectorAll<HTMLElement>(".cmux-dashboard-status-mark:not(.cmux-dashboard-sr-only)")) {
        const text = mark.querySelector<HTMLElement>(".cmux-dashboard-status-text");
        const icon = mark.querySelector("svg");
        const iconWidth = icon?.getBoundingClientRect().width ?? (mark.classList.contains("is-noUpdate") && age && !ageFits ? parseFloat(style.getPropertyValue("--cmux-dash-icon-md")) || 12 : 0);
        width += (text?.getBoundingClientRect().width ?? 0) + iconWidth + (text && iconWidth ? parseFloat(getComputedStyle(mark).columnGap) || 0 : 0);
      }
      // First try the unchanged text-only layout. A no-time fallback ring is
      // needed only if that fails; adding its width cannot make the text fit.
      // Recompute from that layout on every resize so widening removes the ring.
      const noTimeRing = !age && displayState === "noUpdate" && !minimapLabelFits(width, available);
      if (noTimeRing) {
        const mark = line.querySelector<HTMLElement>(".cmux-dashboard-status-mark.is-noUpdate:not(.cmux-dashboard-sr-only)");
        if (mark) width += (parseFloat(style.getPropertyValue("--cmux-dash-icon-md")) || 12)
          + (mark.querySelector(".cmux-dashboard-status-text") ? parseFloat(getComputedStyle(mark).columnGap) || 0 : 0);
      }
      setStatusTextFits(minimapLabelFits(width, available));
      // Older three/four-column cards can have less than one icon of content
      // width. Borrow their existing padding visually, keeping tile geometry.
      const marked = [...line.querySelectorAll<HTMLElement>(".cmux-dashboard-status-mark:not(.cmux-dashboard-sr-only)")]
        .find(mark => mark.querySelector("svg") || (mark.classList.contains("is-noUpdate") && ((age && !ageFits) || noTimeRing)));
      const box = tile.getBoundingClientRect();
      const iconWidth = parseFloat(style.getPropertyValue("--cmux-dash-icon-md")) || 12;
      if (marked && box.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) < iconWidth) {
        // The mark itself never moves: every icon borrows the same padding,
        // preserving their order without feeding the shift back into measurement.
        const mark = marked.getBoundingClientRect();
        const inset = Math.min(2, Math.max(0, (box.width - iconWidth) / 2));
        const left = Math.max(box.left + inset, Math.min(mark.left, box.right - inset - iconWidth));
        setStatusIconShift(left - mark.left);
      } else setStatusIconShift(0);
    };
    // Share the metadata observer, including its resize callback contract.
    statusMeasureRef.current = measure;
    measure();
    let active = true;
    const fonts = document.fonts;
    void fonts?.ready.then(() => { if (active) measure(); });
    return () => { active = false; statusMeasureRef.current = () => {}; };
  }, [collapsed, displayState, dormantDescription, chip.declared, age, ageFits, contextFits, fontFamily, fontScale, density]);
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
  const statusMark = <DashboardStatusMark state={declarationOnly ? "notStarted" : displayState} label={declarationOnly ? DECLARED_META_LABEL : labels.attention === "needsReview" ? dashboardStrings.stateNeedsReview : labels.primary} hasElapsed={Boolean(age) && ageFits} />;
  return <button
    ref={chipRef}
    type="button"
    className={`cmux-minimap-chip${selected ? " is-selected" : ""}${open && !selected ? " is-open" : ""}${isBundleSelected ? " is-bundle-selected" : ""}${isGroupPulse ? " is-group-pulse" : ""}${chip.declared ? " is-declared" : ""}${needsAnswer ? " is-waiting" : ""}${collapsed ? " is-collapsed" : " is-expanded"}${!collapsed && labelTruncated ? " is-label-truncated" : ""}${isDragSource ? " is-drag-source" : ""}${statusTextFits ? "" : " is-status-text-hidden"}`}
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
    style={{ ...labelMask, ...(statusIconShift ? { "--minimap-status-offset": `${statusIconShift}px` } as CSSProperties : {}), ...(open && !selected && columnColor ? { outlineColor: columnColor } : {}) }}
  >
    {collapsed ? null : <span ref={metaRef} className="cmux-minimap-meta" style={{ columnGap: metaGap }} aria-hidden="true">
      {chip.declared ? null : agentColor ? <span className="cmux-minimap-agent-dot" style={{ background: agentColor, opacity: chip.mark?.dormant ? 0.45 : 1 }} /> : null}
      {agentSegment && !chip.declared ? <span ref={agentRef} className={`cmux-minimap-agent${agentNameFits ? "" : " is-name-hidden"}`} style={{ opacity: chip.mark?.dormant ? 0.45 : 1 }}>{agentSegment}</span> : null}
      {chip.contextPct == null ? null : <span ref={contextRef} className={`cmux-minimap-ctx${contextFits ? "" : " is-ctx-hidden"}`} data-minimap-ctx={chip.tabId}>{Math.round(chip.contextPct)}%</span>}
      {age ? <span ref={ageRef} className={`cmux-minimap-age${displayState === "noUpdate" ? " is-stalled" : ""}${ageFits ? "" : " is-age-hidden"}`}>{age}</span> : null}
    </span>}
    {collapsed ? null : <span className="cmux-minimap-status-line" title={labels.tooltip}>
      {dormantDescription ? <DashboardStatusMark state="dormant" label={dormantDescription} /> : null}
      {statusMark}
      {chip.declared && !declarationOnly ? <DashboardStatusMark state="notStarted" label={DECLARED_META_LABEL} /> : null}
    </span>}
    <span ref={labelRef} className="cmux-minimap-label">{label}</span>
    {collapsed && chip.contextPct != null ? <span ref={contextRef} className={`cmux-minimap-ctx${contextFits ? "" : " is-ctx-hidden"}`} data-minimap-ctx={chip.tabId}>{Math.round(chip.contextPct)}%</span> : null}
    {collapsed && displayState === "noUpdate" && age ? <span ref={ageRef} className={`cmux-minimap-age is-stalled${ageFits ? "" : " is-age-hidden"}`}>{age}</span> : null}
    {collapsed && !(displayState === "noUpdate" && age && ageFits) ? statusMark : null}
  </button>;
}
