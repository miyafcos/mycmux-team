import { Fragment, memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useElementWidth } from "../../hooks/useElementWidth";
import { type SeriesReport } from "../../lib/ailog";
import { useThemeStore } from "../../stores/themeStore";
import { grassScale } from "./grassScale";
import { buildUsageGrass, grassLayout, type GrassBreakdown, type GrassDay, type UsageGrassModel } from "./usageGrassModel";
import { costCoverageLabel, groupByLabel, usageMetricInfo, type UsageMetric } from "./usageModel";
import { VScrollBox, noteStyle, paintSwatchBackground, subtleButtonStyle } from "./ui";

type PreviewSource = "pointer" | "focus";
type Preview = { day: GrassDay; anchor: DOMRect; element: HTMLElement; source: PreviewSource } | null;
type PreviewDay = (day: GrassDay | null, element?: HTMLElement, source?: PreviewSource) => void;

const GrassCell = memo(function GrassCell({ day, color, cell, selected, tabStop, onPreview, onPin }: {
  day: GrassDay; color: string; cell: number; selected: boolean; tabStop: boolean;
  onPreview: PreviewDay; onPin: (day: number | null) => void;
}) {
  return <button type="button" data-usage-day={day.day} aria-label={day.tooltip} aria-pressed={selected} tabIndex={tabStop ? 0 : -1}
    onMouseEnter={event => onPreview(day, event.currentTarget, "pointer")} onFocus={event => onPreview(day, event.currentTarget, "focus")}
    onClick={() => onPin(day.day)}
    style={{ gridColumn: day.column + 1, gridRow: day.row + 1, width: cell, height: cell, padding: 0, border: 0, borderRadius: 2,
      background: color, cursor: "pointer", boxShadow: selected ? "inset 0 0 0 2px var(--cmux-text)" : undefined }} />;
});

/** Hover updates the sibling breakdown/tooltip; this memo receives no hover state. */
const GrassGrid = memo(function GrassGrid({ model, colors, width, pinned, onPreview, onPin, onEscape, onScroll }: {
  model: UsageGrassModel; colors: readonly string[]; width: number; pinned: number | null;
  onPreview: PreviewDay; onPin: (day: number | null) => void; onEscape: () => boolean; onScroll: () => void;
}) {
  const [focusDay, setFocusDay] = useState<number | null>(model.days[model.days.length - 1]?.day ?? null);
  const scroll = useRef<HTMLDivElement>(null);
  const layout = grassLayout(width, model.weeks.length);
  const matrixWidth = Math.max(layout.width - 28, model.months.length ? 24 : 0);
  useEffect(() => {
    setFocusDay(previous => model.days.some(day => day.day === previous) ? previous : model.days[model.days.length - 1]?.day ?? null);
  }, [model]);
  useEffect(() => {
    const node = scroll.current;
    if (node) node.scrollLeft = node.scrollWidth - node.clientWidth;
  }, [model, width]);
  const tabDay = model.days.some(day => day.day === focusDay) ? focusDay : model.days[model.days.length - 1]?.day;
  return <div data-grass-calendar style={{ display: "flex", gap: 4, width: matrixWidth + 28, maxWidth: "100%", minWidth: 0 }}
    onMouseLeave={() => onPreview(null)}
    onFocusCapture={event => {
      const value = (event.target as HTMLElement).dataset.usageDay;
      if (value !== undefined) setFocusDay(Number(value));
    }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onPreview(null); }}
    onKeyDown={event => {
      if (event.key === "Escape") {
        if (onEscape()) { event.preventDefault(); event.stopPropagation(); }
        return;
      }
      const target = event.target as HTMLElement;
      const current = model.days.findIndex(day => day.day === Number(target.dataset.usageDay));
      if (current < 0) return;
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onPin(model.days[current].day); return; }
      const offsets: Record<string, number> = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 };
      const next = event.key === "Home" ? 0 : event.key === "End" ? model.days.length - 1 : event.key in offsets ? Math.max(0, Math.min(model.days.length - 1, current + offsets[event.key])) : null;
      if (next === null) return;
      event.preventDefault();
      const day = model.days[next];
      setFocusDay(day.day);
      const button = event.currentTarget.querySelector<HTMLButtonElement>('[data-usage-day="' + day.day + '"]');
      button?.focus({ preventScroll: true });
      button?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      if (button) onPreview(day, button, "focus");
    }}>
    <div data-grass-weekdays aria-hidden="true" style={{ width: 24, flex: "0 0 24px", paddingTop: 30, display: "grid", gridTemplateRows: "repeat(7, " + layout.cell + "px)", rowGap: layout.gap, alignContent: "start" }}>
      {[0, 2, 4].map((row, i) => <span key={row} style={{ ...noteStyle, gridRow: row + 1, lineHeight: layout.cell + "px" }}>{["月", "水", "金"][i]}</span>)}
    </div>
    <div ref={scroll} data-grass-scroll style={{ overflowX: "auto", minWidth: 0, padding: "4px 0 6px" }} onScroll={onScroll}>
      <div style={{ width: matrixWidth, position: "relative", paddingTop: 26 }}>
        {model.months.map(month => <span key={month.column} data-grass-month style={{ ...noteStyle, position: "absolute", top: 0,
          ...(month.column >= model.weeks.length - 2 ? { right: 0 } : { left: month.column * (layout.cell + layout.gap) }), whiteSpace: "nowrap" }}>{month.label}</span>)}
        <div data-grass-grid role="group" aria-label="日ごとの使用量"
          style={{ display: "grid", gridTemplateColumns: "repeat(" + model.weeks.length + ", " + layout.cell + "px)", gridTemplateRows: "repeat(7, " + layout.cell + "px)", gap: layout.gap, justifyContent: "end" }}>
          {model.days.map(day => <GrassCell key={day.day} day={day} color={colors[day.level]} cell={layout.cell}
            selected={pinned === day.day} tabStop={tabDay === day.day} onPreview={onPreview} onPin={onPin} />)}
        </div>
      </div>
    </div>
  </div>;
});

function GrassTooltip({ preview }: { preview: NonNullable<Preview> }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const { width, height } = node.getBoundingClientRect();
    const { anchor } = preview;
    const left = Math.max(8, Math.min(anchor.left + anchor.width / 2 - width / 2, window.innerWidth - width - 8));
    const above = anchor.top - height - 10;
    const preferred = preview.day.row <= 1 || above < 8 ? anchor.bottom + 10 : above;
    const top = Math.max(8, Math.min(preferred, window.innerHeight - height - 8));
    setPosition({ left, top });
  }, [preview]);
  return <div ref={ref} role="tooltip" style={{ position: "fixed", ...position, zIndex: 20, pointerEvents: "none", maxWidth: "calc(100vw - 16px)", boxSizing: "border-box",
    padding: "7px 10px", borderRadius: 5, background: "var(--cmux-popover)", border: "1px solid var(--cmux-border)", boxShadow: "var(--cmux-shadow-popover, 0 3px 12px #0003)", color: "var(--cmux-text)", fontSize: "var(--cmux-font-size-xs)", lineHeight: 1.5 }}>
    <div>{preview.day.label} · {preview.day.tooltipValueLabel}</div>
    {preview.day.topLabel !== "—" ? <div style={{ color: "var(--cmux-text-secondary)", overflowWrap: "anywhere" }}>{preview.day.topLabel}</div> : null}
  </div>;
}

const textWidth = (value: string) => [...value].reduce((sum, char) => sum + (char.charCodeAt(0) > 255 ? 2 : 1), 0);
const longestText = (values: string[]) => values.reduce((longest, value) => textWidth(value) > textWidth(longest) ? value : longest, "");
type BreakdownSize = { name: string; value: string; share: string; rows: number; foldedCount: number };

function Breakdown({ data, scope, pinned, metric, report, size, periodMessage, onPickDay, onClear }: {
  data: GrassBreakdown; scope: GrassDay | null; pinned: number | null; metric: UsageMetric; report: SeriesReport;
  size: BreakdownSize; periodMessage: string | null; onPickDay: (day: number) => void; onClear: () => void;
}) {
  const headingId = useId();
  const grouping = groupByLabel(report.groupBy);
  const hideActions = pinned === null || (scope !== null && scope.day !== pinned);
  const message = scope ? !data.recorded ? "この日の記録はありません。" : null : periodMessage;
  return <div role="group" aria-labelledby={headingId} data-grass-breakdown style={{ minWidth: 0, containerType: "inline-size" }}>
    <div className="usage-grass-header" data-grass-heading>
      <h3 id={headingId} style={{ gridArea: "heading", margin: 0, fontSize: "var(--cmux-font-size-sm)", fontWeight: 600, color: "var(--cmux-text)", whiteSpace: "nowrap" }}>{scope ? scope.label + "の内訳" : "期間全体の内訳"}</h3>
      <div data-grass-actions aria-hidden={hideActions ? true : undefined} style={{ gridArea: "actions", display: "flex", flexWrap: "wrap", gap: 8, minHeight: 26, visibility: hideActions ? "hidden" : "visible" }}>
        <button type="button" style={subtleButtonStyle} onClick={() => { if (pinned !== null) onPickDay(pinned); }}>この日に絞り込む</button>
        <button type="button" style={subtleButtonStyle} onClick={onClear}>期間全体に戻す</button>
      </div>
      <strong title={data.fullTotalLabel} style={{ gridArea: "total", justifySelf: "end", whiteSpace: "nowrap", fontSize: "var(--cmux-font-size-md)", fontWeight: 700, fontVariantNumeric: "proportional-nums" }}>{data.totalLabel}</strong>
    </div>
    <div data-grass-breakdown-rows style={{ minHeight: size.rows * 28 }}>
      {message ? <div style={noteStyle}>{message}</div> : null}
      <div data-grass-breakdown-grid style={{ display: "grid", gridTemplateColumns: "8px minmax(0, min(40%, " + Math.min(18, textWidth(size.name)) + "ch)) minmax(80px, 1fr) max-content" + (metric === "sessions" ? "" : " max-content"), columnGap: 10, alignItems: "center", fontSize: "var(--cmux-font-size-xs)" }}>
        <div data-grass-measure aria-hidden="true" style={{ display: "contents", visibility: "hidden" }}>
          <span style={measureCell} /><span data-grass-measure-name style={measureCell}>{size.name}</span><span style={measureCell} />
          <span data-grass-measure-value style={measureCell}>{size.value}</span>
          {metric !== "sessions" ? <span data-grass-measure-share style={measureCell}>{size.share}</span> : null}
        </div>
        {!message ? data.rows.map(row => <div key={row.group} data-grass-breakdown-row style={{ display: "contents" }}>
          <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 1, background: paintSwatchBackground(row.paint) }} />
          <span data-grass-name title={row.members.length ? row.members.join("、") : row.label} style={{ height: 28, lineHeight: "28px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--cmux-text)" }}>{row.label}</span>
          <span data-grass-bar aria-hidden="true" style={{ width: Math.max(0, row.ratio) * 100 + "%", height: 8, borderRadius: "0 4px 4px 0", background: paintSwatchBackground(row.paint) }} />
          <span title={row.fullValueLabel} style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", color: "var(--cmux-text)" }}>{row.valueLabel}</span>
          {row.shareLabel !== null ? <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--cmux-text-secondary)" }}>{row.shareLabel}</span> : null}
        </div>) : null}
      </div>
    </div>
    <div style={{ ...noteStyle, marginTop: 12 }}>
      {size.foldedCount ? <div style={{ visibility: data.foldedCount ? "visible" : "hidden" }}>{"下位 " + (data.foldedCount || size.foldedCount) + " 件は「下位まとめ」にまとめています。"}</div> : null}
      {metric === "costUsd" ? <div>{costCoverageLabel(report.priceCoverage)}</div> : null}
      {metric === "sessions" ? <div>{"セッション数は、1 本で複数の" + grouping + "を使うとそれぞれに数えるため、割合は出していません。"}</div> : null}
    </div>
  </div>;
}

export function UsageGrass({ report, metric, onPickDay }: {
  report: SeriesReport; metric: UsageMetric; onPickDay: (day: number) => void;
}) {
  const { ref, width } = useElementWidth();
  const scheme = useThemeStore(state => state?.theme?.colorScheme ?? "dark");
  const colors = useMemo(() => grassScale(scheme), [scheme]);
  const model = useMemo(() => buildUsageGrass(report, metric, report.groupBy), [report, metric]);
  const size = useMemo<BreakdownSize>(() => {
    const overall = model.breakdown("all");
    const rows = [...overall.rows, ...model.days.flatMap(day => model.breakdown(day.day).rows)];
    return { name: longestText(rows.map(row => row.label)), value: longestText(rows.map(row => row.valueLabel)),
      share: longestText(rows.map(row => row.shareLabel ?? "")), rows: overall.rows.length, foldedCount: overall.foldedCount };
  }, [model]);
  const [pinned, setPinned] = useState<number | null>(null);
  const [preview, setPreview] = useState<Preview>(null);
  const pinnedRef = useRef(pinned);
  const previewRef = useRef(preview);
  pinnedRef.current = pinned;
  previewRef.current = preview;
  useEffect(() => {
    if (!model.days.some(day => day.day === pinnedRef.current)) {
      pinnedRef.current = null;
      setPinned(null);
    }
    previewRef.current = null;
    setPreview(null);
  }, [model]);
  const showPreview = useCallback<PreviewDay>((day, element, source = "pointer") => {
    const next = day && element ? { day, anchor: element.getBoundingClientRect(), element, source } : null;
    previewRef.current = next;
    setPreview(next);
  }, []);
  const pin = useCallback((day: number | null) => {
    const next = day === null || pinnedRef.current === day ? null : day;
    pinnedRef.current = next;
    setPinned(next);
    previewRef.current = null;
    setPreview(null);
  }, []);
  const clear = useCallback(() => {
    const hadSelection = pinnedRef.current !== null || previewRef.current !== null;
    pinnedRef.current = null;
    previewRef.current = null;
    setPinned(null);
    setPreview(null);
    return hadSelection;
  }, []);
  const scrollPreview = useCallback(() => {
    const current = previewRef.current;
    if (current?.source === "focus" && document.activeElement === current.element) showPreview(current.day, current.element, "focus");
    else showPreview(null);
  }, [showPreview]);
  const scope = preview?.day ?? model.days.find(day => day.day === pinned) ?? null;
  const data = model.breakdown(scope?.day ?? "all");
  const wide = width >= 760;
  const gridWidth = wide ? width - 24 - 320 : width;
  const layout = grassLayout(gridWidth, model.weeks.length);
  return <div ref={ref} data-usage-grass style={{ minWidth: 0 }} onKeyDown={event => {
    if (event.key === "Escape" && clear()) { event.preventDefault(); event.stopPropagation(); }
  }}>
    <style>{[
      "[data-usage-day] { outline: none; }",
      "[data-usage-day]:focus-visible { outline: 2px solid var(--cmux-accent); outline-offset: 1px; }",
      ".usage-grass-header { display: grid; grid-template-columns: minmax(0, 1fr) max-content; grid-template-areas: 'heading total' 'actions actions'; column-gap: 12px; row-gap: 8px; min-height: 60px; align-items: center; align-content: center; margin-bottom: 12px; }",
      "@container (min-width: 560px) { .usage-grass-header { grid-template-columns: max-content minmax(0, 1fr) max-content; grid-template-areas: 'heading actions total'; min-height: 32px; } }",
    ].join("\n")}</style>
    <div data-grass-columns style={{ display: "grid", gridTemplateColumns: wide ? "max-content minmax(320px, 720px)" : "minmax(0, 1fr)", gap: 24, alignItems: "start" }}>
      <div data-grass-left style={{ minWidth: 0, width: wide ? "max-content" : "100%", maxWidth: wide ? gridWidth : "100%", display: "flex", flexDirection: "column", alignItems: wide ? "flex-end" : "flex-start" }}>
        <div data-grass-chart style={{ width: Math.min(layout.width, gridWidth || layout.width), maxWidth: "100%", minWidth: Math.min(100, gridWidth || 100) }}>
          <GrassGrid model={model} colors={colors} width={gridWidth} pinned={pinned} onPreview={showPreview} onPin={pin} onEscape={clear} onScroll={scrollPreview} />
          <div data-grass-legend-row role="img" aria-label={"少から多の凡例: " + model.legend.map(entry => entry.label).join("、")} style={{ ...noteStyle, display: "flex", alignItems: "center", justifyContent: layout.width < 100 ? "flex-start" : "flex-end", gap: 4, whiteSpace: "nowrap", marginTop: 12 }}>
            <span>少</span>{model.legend.map(entry => <span key={entry.level} title={entry.label} data-grass-legend={entry.level} style={{ width: 10, height: 10, borderRadius: 2, background: colors[entry.level] }} />)}<span>多</span>
          </div>
        </div>
        <dl data-grass-statistics style={{ ...noteStyle, display: "grid", gridTemplateColumns: "max-content max-content", columnGap: 12, rowGap: 4, margin: "12px 0 0", width: "max-content", maxWidth: "100%", alignSelf: "flex-start" }}>
          {model.summaryItems.map(item => <Fragment key={item.label}><dt>{item.label}</dt><dd style={{ margin: 0, whiteSpace: "nowrap", color: "var(--cmux-text)" }}>{item.value}</dd></Fragment>)}
        </dl>
        <details style={{ marginTop: 16, width: "100%", contain: "inline-size" }}>
          <summary style={{ ...noteStyle, cursor: "pointer", color: "var(--cmux-text-secondary)" }}>日ごとの数値を表で見る</summary>
          <VScrollBox maxHeight={320} label="日ごとの数値を表で見る">
            <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 8, fontSize: "var(--cmux-font-size-xs)" }}>
              <thead><tr><th scope="col" style={leftCell}>日付</th><th scope="col" style={{ ...leftCell, textAlign: "right" }}>{usageMetricInfo(metric).label}</th><th scope="col" style={leftCell}>{"いちばん多い" + groupByLabel(report.groupBy)}</th></tr></thead>
              <tbody>{model.recordedDays.map(day => <tr key={day.day}><th scope="row" style={{ ...leftCell, fontWeight: 400, whiteSpace: "nowrap" }}>{day.label}</th><td style={{ padding: "5px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{day.fullValueLabel}</td><td style={{ ...leftCell, overflowWrap: "anywhere" }}>{day.topLabel}</td></tr>)}</tbody>
            </table>
          </VScrollBox>
        </details>
      </div>
      <Breakdown data={data} scope={scope} pinned={pinned} metric={metric} report={report} size={size} periodMessage={model.periodMessage} onPickDay={onPickDay} onClear={clear} />
    </div>
    {preview ? <GrassTooltip preview={preview} /> : null}
  </div>;
}

const measureCell: CSSProperties = { height: 0, minWidth: 0, overflow: "hidden", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" };
const leftCell: CSSProperties = { padding: "5px 8px", textAlign: "left", color: "var(--cmux-text-secondary)" };
