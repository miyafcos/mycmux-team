import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { jumpToPaneTab } from "../../lib/jumpToPaneTab";
import { type LiveTailFact } from "../../lib/liveTail/facts";
import { isAutomaticNameTarget } from "../../lib/autoNameOwnership";
import { autoNameDescription } from "../../lib/autoNameStatus";
import { useAutoNameRuntimeStore } from "../../stores/autoNameRuntimeStore";
import { getTabDisplayLabel } from "../../lib/tabDisplayLabel";
import { acquireLiveTailConsumer, liveTailAttentionChanged, liveTailScreenRetained, liveTailTargetsForView, statusForLiveTailTarget, useLiveTailStore, type LiveTailEntry, type LiveTailTarget } from "../../stores/liveTailStore";
import { useSessionAttentionStore } from "../../stores/sessionAttentionStore";
import { connectLiveBriefStore, useLiveBriefStore } from "../../stores/liveBriefStore";
import { useThemeStore } from "../../stores/themeStore";
import type { PaneMetadata, PaneVolatileMetadata } from "../../stores/paneMetadataStore";
import type { PaneTab, Workspace } from "../../types";
import { AgentKindIcon } from "../icons/AgentIcons";
import { buildLiveTailThemeVars } from "./themeVars";
import { applyThemeTweaks } from "../../lib/themeTweaks";
import "./LiveTailList.css";

interface LiveTailListProps {
  workspace: Workspace;
  targets: readonly LiveTailTarget[];
  entries: Readonly<Record<string, LiveTailEntry>>;
  metadataBySession?: Record<string, PaneMetadata | undefined>;
  volatileMetadataBySession?: Record<string, PaneVolatileMetadata | undefined>;
}

type ConnectedListProps = Omit<LiveTailListProps, "targets" | "entries">;

const BADGES: Partial<Record<LiveTailFact["kind"], string>> = {
  frozen: "止まっている",
  unreadable: "読めない",
  error: "エラー",
  stale: "進んでいない",
};

/** Fit a verbatim prefix and suffix using the rendered font's pixel widths. */
export function fitLiveTailLine(text: string, availablePx: number, measure: (text: string) => number): string {
  if (availablePx <= 0) return "";
  if (measure(text) <= availablePx) return text;
  const ellipsis = "…";
  if (measure(ellipsis) > availablePx) return "";
  const preferred = /(\s\([^()\n]*\)|\s[·•]\s(?:\d+h\s*)?(?:\d+m\s*)?\d+s)\s*$/.exec(text)?.[0];
  const lastNumber = [...text.matchAll(/\d[\d.,]*(?:[km])?/g)].pop();
  let suffix = preferred ?? (lastNumber ? text.slice(lastNumber.index) : Array.from(text).slice(-6).join(""));
  const suffixChars = Array.from(suffix);
  while (suffixChars.length && measure(ellipsis + suffixChars.join("")) > availablePx) suffixChars.shift();
  suffix = suffixChars.join("");
  const body = Array.from(text.slice(0, text.length - suffix.length));
  let low = 0, high = body.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measure(body.slice(0, middle).join("") + ellipsis + suffix) <= availablePx) low = middle;
    else high = middle - 1;
  }
  // Kerning can make widths non-monotonic; the returned width still has to fit.
  while (low && measure(body.slice(0, low).join("") + ellipsis + suffix) > availablePx) low -= 1;
  return body.slice(0, low).join("") + ellipsis + suffix;
}

function useFittedLine(text: string, fontFamily: string, fontScale: number) {
  const ref = useRef<HTMLSpanElement>(null);
  const [fitted, setFitted] = useState(text);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    let active = true;
    let context: CanvasRenderingContext2D | null | undefined;
    const fit = () => {
      if (!active) return;
      const width = element.getBoundingClientRect().width;
      if (width <= 0) { setFitted(text); return; }
      context ??= document.createElement("canvas").getContext("2d");
      if (!context) return;
      const style = getComputedStyle(element);
      context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const spacing = Number.parseFloat(style.letterSpacing) || 0;
      const measure = (value: string) => context!.measureText(value).width + Math.max(0, Array.from(value).length - 1) * spacing;
      setFitted(fitLiveTailLine(text, Math.max(0, width - 0.5), measure));
    };
    fit();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(fit);
    observer?.observe(element);
    window.addEventListener("resize", fit);
    void document.fonts?.ready.then(fit);
    return () => {
      active = false;
      observer?.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, [text, fontFamily, fontScale]);
  return { ref, fitted };
}

export function liveTailFactText(fact: LiveTailFact, now: number, waitingForReply = false): string {
  const seconds = Math.max(0, Math.floor((now - fact.sinceMs) / 1_000));
  switch (fact.kind) {
    case "progress": return `進んだ ${seconds}秒前`;
    case "cmd": return `コマンド待ち ${Math.floor(seconds / 60)}分${seconds % 60}秒`;
    case "stale": return `${Math.floor(seconds / 60)}分 進んでいない`;
    case "frozen": return `画面が止まっている ${Math.floor(seconds / 60)}分`;
    case "unreadable": return "画面を読めない";
    case "error": return "エラー";
    case "idle": return waitingForReply ? "返事待ち" : "入力待ち";
    case "alive": return waitingForReply ? "返事待ち" : "作業中";
  }
}

const clockFormatter = new Intl.DateTimeFormat("ja-JP", {
  hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC",
});

function localClockFields(at: number | null | undefined): number | null {
  if (at === null || at === undefined || !Number.isFinite(at)) return null;
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  return date.getHours() * 3_600 + date.getMinutes() * 60 + date.getSeconds();
}

function clockText(at: number | null | undefined): string | null {
  // Read local civil fields on every call: caching the default timezone would
  // keep an old OS timezone. A safe UTC date also handles either Date limit.
  const seconds = localClockFields(at);
  return seconds === null ? null : clockFormatter.format(new Date(Date.UTC(2000, 0, 1, 0, 0, seconds)));
}

/** This component owns the sidebar's one demand lease, even when kept mounted. */
export function LiveTailSidebarConsumer({ open }: { open: boolean }) {
  useEffect(() => {
    let releaseTail: (() => void) | undefined;
    let releaseBrief: (() => void) | undefined;
    const release = () => {
      releaseTail?.(); releaseTail = undefined;
      releaseBrief?.(); releaseBrief = undefined;
    };
    const sync = () => {
      if (!open || document.visibilityState === "hidden") { release(); return; }
      if (!releaseTail) releaseTail = acquireLiveTailConsumer("sidebar");
      if (!releaseBrief) releaseBrief = connectLiveBriefStore();
    };
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => { document.removeEventListener("visibilitychange", sync); release(); };
  }, [open]);
  return null;
}

export function WorkspaceLiveTailList(props: ConnectedListProps) {
  const targets = useLiveTailStore(state => state.targets);
  const entries = useLiveTailStore(state => state.entries);
  return <LiveTailList {...props} targets={targets} entries={entries} />;
}

interface TailRowInput {
  workspaceId: string;
  paneId: string;
  tab: PaneTab;
  target: LiveTailTarget;
  entry?: LiveTailEntry;
  fact: LiveTailFact;
  name: string;
  child: boolean;
  lastOutputAt: number | null;
  compact?: boolean;
}

type TailRowVisual = Readonly<{
  workspaceId: string;
  paneId: string;
  tabId: string;
  sessionId: string;
  agentKind: LiveTailTarget["agentKind"];
  name: string;
  child: boolean;
  fact: Readonly<LiveTailFact>;
  summary: string;
  rows: readonly string[];
  progressAt: number | null;
  previousScreen: boolean;
  sampleAt: number | null;
  waitingForReply: boolean;
  aliveScreenText: string | null;
  lastOutputAt: number | null;
}>;

interface TailRowProps {
  readonly visual: TailRowVisual;
  readonly tab: PaneTab;
  readonly colors: CSSProperties;
}

/** Snapshot every row/popup/effect input; do not retain mutable entry history. */
function projectTailRow({ workspaceId, paneId, tab, target, entry, fact, name, child, lastOutputAt, compact = false }: TailRowInput): TailRowVisual {
  const previousScreen = liveTailAttentionChanged(target, entry);
  const retained = liveTailScreenRetained(target, entry);
  const crop = entry?.evidence.observation.crop;
  const readable = crop?.readable && fact.kind !== "unreadable";
  const summary = readable && !compact && (fact.kind !== "idle" || previousScreen)
    ? (crop.tool || crop.state === "error" ? crop.rows[0] : crop.marker ?? crop.rows[crop.rows.length - 1]) ?? ""
    : "";
  const status = statusForLiveTailTarget(target), waitingForReply = status === "waiting";
  return {
    workspaceId, paneId, tabId: tab.id, sessionId: target.sessionId, agentKind: target.agentKind, name, child,
    fact: { ...fact }, summary, rows: readable ? crop.rows.slice(-3) : [],
    progressAt: entry?.evidence.lastProgressAt ?? null, previousScreen,
    sampleAt: retained && entry ? entry.evidence.observation.observedAt : null,
    waitingForReply, lastOutputAt,
    aliveScreenText: fact.kind === "alive" && !waitingForReply
      && (crop?.state === "unknown" || (crop?.state !== "working" && status !== "working"))
      ? (readable ? "画面を読めた" : "画面を確認中") : null,
  };
}

function sameScalarFields<T extends object>(a: T, b: T): boolean {
  const keys = Object.keys(a) as Array<keyof T>;
  return keys.length === Object.keys(b).length && keys.every(key => Object.is(a[key], b[key]));
}

function sameRowPresentation(a: TailRowProps, b: TailRowProps): boolean {
  // Frozen popups can show civil clocks. Independent brief/timer renders can
  // change those clocks without updating parent props, so every parent render
  // must refresh them, as in stage C. Keep the same row instance and cadence.
  if (b.visual.fact.kind === "frozen") return false;
  // Jump closures and theme variables are explicit inputs. The comparator
  // reads only immutable snapshots, never the current external stores.
  if (a.tab !== b.tab || a.colors !== b.colors) return false;
  const previous = a.visual, next = b.visual;
  if (!sameScalarFields(previous.fact, next.fact) || previous.rows.length !== next.rows.length
    || !previous.rows.every((row, index) => row === next.rows[index])) return false;
  const keys = Object.keys(previous) as Array<keyof TailRowVisual>;
  return keys.length === Object.keys(next).length
    && keys.every(key => key === "fact" || key === "rows" || Object.is(previous[key], next[key]));
}

function TailRow({ visual, tab, colors }: TailRowProps) {
  const { workspaceId, paneId, tabId, sessionId, agentKind, fact, name, child, lastOutputAt,
    summary, rows, progressAt, previousScreen, sampleAt, waitingForReply, aliveScreenText } = visual;
  const meaning = useAutoNameRuntimeStore(state => state.meanings.get(tabId));
  const automatic = isAutomaticNameTarget(tab);
  const namingHint = automatic ? autoNameDescription(meaning) : undefined;
  useSessionAttentionStore(state => state.attentionBySession[sessionId]);
  const fontFamily = useThemeStore(state => state.fontFamily);
  const fontScale = useThemeStore(state => state.uiFontScale);
  const lastEventAt = useLiveBriefStore(state => state.briefsBySession[sessionId]?.lastEventAt ?? null);
  const { ref: lineRef, fitted } = useFittedLine(summary, fontFamily, fontScale);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const [now, setNow] = useState(Date.now);
  const [flashAt, setFlashAt] = useState<number | null>(null);
  const previousProgress = useRef(progressAt);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  const popupId = useId();
  const open = (hovered || focused) && !dismissed;

  useEffect(() => {
    setPortal(anchorRef.current?.closest<HTMLElement>("[data-cmux-themed-root]") ?? document.body);
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const changed = () => setReducedMotion(media?.matches ?? false);
    media?.addEventListener("change", changed);
    return () => { media?.removeEventListener("change", changed); clearTimeout(leaveTimer.current); };
  }, []);

  useEffect(() => {
    const previous = previousProgress.current;
    previousProgress.current = progressAt;
    if (reducedMotion) { setFlashAt(null); return; }
    if (progressAt === null || progressAt <= (previous ?? 0) || fact.kind !== "progress") return;
    setFlashAt(progressAt);
    const timer = setTimeout(() => setFlashAt(null), 1_400);
    return () => clearTimeout(timer);
  }, [progressAt, reducedMotion]);

  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !portal) return;
    const place = () => {
      const anchor = anchorRef.current, popup = popupRef.current;
      if (!anchor || !popup) return;
      const rect = anchor.getBoundingClientRect(), size = popup.getBoundingClientRect();
      const right = rect.right + 12;
      const left = right + size.width <= window.innerWidth - 8 ? right : Math.max(8, rect.left - size.width - 12);
      const top = Math.max(8, Math.min(rect.top - 8, window.innerHeight - size.height - 8));
      setPosition(previous => previous.left === left && previous.top === top ? previous : { left, top });
    };
    place();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(place);
    if (popupRef.current) observer?.observe(popupRef.current);
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    return () => { observer?.disconnect(); window.removeEventListener("resize", place); document.removeEventListener("scroll", place, true); };
  }, [open, portal]);

  const enter = () => { clearTimeout(leaveTimer.current); setDismissed(false); setHovered(true); };
  const leave = () => { leaveTimer.current = setTimeout(() => setHovered(false), 120); };
  const jump = () => jumpToPaneTab({ workspaceId, paneId, tab });
  const factText = previousScreen ? "前の画面" : aliveScreenText ?? liveTailFactText(fact, now, waitingForReply);
  const outputTime = clockText(lastOutputAt);
  const eventTime = clockText(lastEventAt);
  const badge = BADGES[fact.kind];

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={`live-tail-row${child ? " live-tail-row--child" : ""}`}
        data-live-tail-tab={tabId}
        data-fact={fact.kind}
        aria-label={name}
        aria-describedby={open ? popupId : undefined}
        onMouseEnter={enter}
        onMouseLeave={leave}
        onFocus={() => { setDismissed(false); setFocused(true); }}
        onBlur={() => { setFocused(false); setHovered(false); }}
        onKeyDown={event => {
          if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); jump(); }
          if (event.key === "Escape") { event.preventDefault(); setDismissed(true); }
        }}
        onClick={event => { event.stopPropagation(); jump(); }}
      >
        {flashAt !== null && !reducedMotion && <span key={flashAt} className="live-tail-flash" data-live-tail-flash aria-hidden="true" />}
        <span className="live-tail-heading">
          {child && <span className="live-tail-tree" aria-hidden="true">└</span>}
          <span className="live-tail-agent" aria-hidden="true"><AgentKindIcon kind={agentKind} size={12} chip={false} /></span>
          <span className="live-tail-name" title={namingHint}>{name}</span>
          {automatic && meaning?.staleSince !== undefined && <span className="live-tail-badge" title={namingHint}>前回</span>}
          {badge && <span className="live-tail-badge">{badge}</span>}
        </span>
        {summary.trim() && <span className="live-tail-summary">
          <span className="live-tail-dot" aria-hidden="true" />
          <span ref={lineRef} className="live-tail-line" style={{ fontFamily }}>{fitted}</span>
        </span>}
      </button>
      {open && portal && createPortal(
        <div
          ref={popupRef}
          id={popupId}
          role="tooltip"
          className="live-tail-popup"
          data-fact={fact.kind}
          style={{ ...colors, ...position }}
          onMouseEnter={enter}
          onMouseLeave={leave}
          onClick={jump}
        >
          <div className="live-tail-popup-heading"><AgentKindIcon kind={agentKind} size={12} chip={false} /><b>{name}</b></div>
          {rows.length > 0 && <div className="live-tail-popup-rows" style={{ fontFamily }}>{rows.map((row, index) => <div key={index}>{row}</div>)}</div>}
          <div className="live-tail-fact">{factText}</div>
          {fact.kind === "frozen" && <div className="live-tail-evidence">端末の最後の出力 {outputTime ?? "不明"} · {eventTime ? `会話記録の最後の書き込み ${eventTime}` : "会話記録 不明"}</div>}
          {sampleAt !== null && <div className="live-tail-evidence">画面の読み取り {Math.max(0, Math.floor((now - sampleAt) / 1_000))}秒前</div>}
        </div>, portal,
      )}
    </>
  );
}

const MemoTailRow = memo(TailRow, sameRowPresentation);

/** Workspace order and names come from the same layout as the pane tab bar. */
export function LiveTailList({ workspace, targets, entries, metadataBySession = {}, volatileMetadataBySession = {} }: LiveTailListProps) {
  useSessionAttentionStore(state => state.attentionBySession);
  const baseTheme = useThemeStore(state => state.theme);
  const tweaks = useThemeStore(state => state.themeTweaks);
  const colors = useMemo(() => buildLiveTailThemeVars(applyThemeTweaks(baseTheme, tweaks)), [baseTheme, tweaks]);
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<ReadonlySet<string>>(() => new Set());
  const idleId = useId();
  const expanded = expandedWorkspaces.has(workspace.id);
  const toggleIdle = () => setExpandedWorkspaces(previous => {
    const next = new Set(previous);
    if (next.has(workspace.id)) next.delete(workspace.id);
    else next.add(workspace.id);
    return next;
  });
  const byTab = new Map(liveTailTargetsForView(targets, entries).filter(({ target }) => target.workspaceId === workspace.id)
    .map(view => [view.target.tabId, view]));
  const idleRows: ReactNode[] = [];
  const rows = workspace.panes.flatMap(pane => pane.tabs.flatMap(tab => {
    const view = byTab.get(tab.id);
    if (!view || view.target.paneId !== pane.id || view.target.sessionId !== tab.sessionId) return [];
    const { target, entry, fact, inputIdle } = view;
    const times = [entry?.evidence.observation.lastOutputAt, volatileMetadataBySession[tab.sessionId]?.backendLastOutputAt, metadataBySession[tab.sessionId]?.backendLastOutputAt]
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    const row = <MemoTailRow key={tab.id} tab={tab} colors={colors} visual={projectTailRow({
      workspaceId: workspace.id, paneId: pane.id, tab, target, entry, fact, compact: inputIdle,
      name: getTabDisplayLabel(tab, tab.id === pane.activeTabId, metadataBySession, volatileMetadataBySession),
      child: tab.origin?.kind === "agent" && Boolean(tab.origin.parentTabId),
      lastOutputAt: times.length ? Math.max(...times) : null,
    })} />;
    if (inputIdle) { idleRows.push(row); return []; }
    return [row];
  }));
  if (!rows.length && !idleRows.length) return null;
  return <div className="live-tail-list" data-live-tail-workspace={workspace.id} style={colors}>
    {rows}
    {idleRows.length > 0 && <>
      <button type="button" className="live-tail-idle" aria-expanded={expanded} aria-controls={idleId}
        onClick={event => { event.stopPropagation(); toggleIdle(); }}
        onKeyDown={event => {
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); toggleIdle(); }
        }}>
        <span aria-hidden="true">{expanded ? "▾" : "▸"}</span> ほか 入力待ち {idleRows.length}
      </button>
      <div id={idleId} hidden={!expanded}>{expanded && idleRows}</div>
    </>}
  </div>;
}
