import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { jumpToPaneTab } from "../../lib/jumpToPaneTab";
import { factForLiveTailEvidence, type LiveTailFact } from "../../lib/liveTail/facts";
import { getTabDisplayLabel } from "../../lib/tabDisplayLabel";
import { acquireLiveTailConsumer, useLiveTailStore, type LiveTailEntry, type LiveTailTarget } from "../../stores/liveTailStore";
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

function clockText(at: number | null | undefined): string | null {
  if (at === null || at === undefined || !Number.isFinite(at)) return null;
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString("ja-JP", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
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

interface TailRowProps {
  workspaceId: string;
  paneId: string;
  tab: PaneTab;
  target: LiveTailTarget;
  entry?: LiveTailEntry;
  name: string;
  child: boolean;
  lastOutputAt: number | null;
  colors: CSSProperties;
}

function TailRow({ workspaceId, paneId, tab, target, entry, name, child, lastOutputAt, colors }: TailRowProps) {
  const fontFamily = useThemeStore(state => state.fontFamily);
  const fontScale = useThemeStore(state => state.uiFontScale);
  const lastEventAt = useLiveBriefStore(state => state.briefsBySession[target.sessionId]?.lastEventAt ?? null);
  const fact = entry ? factForLiveTailEvidence(entry.evidence) : {
    kind: "unreadable" as const, sinceMs: Date.now(), elapsedSec: null, tokens: null, toolElapsedSec: null, error: null,
  };
  const crop = entry?.evidence.observation.crop;
  const readable = crop?.readable && fact.kind !== "unreadable";
  const rows = readable ? crop.rows.slice(-3) : [];
  const summary = readable
    ? (crop.tool || crop.state === "error" ? crop.rows[0] : crop.marker ?? crop.rows[crop.rows.length - 1]) ?? ""
    : "";
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
  const progressAt = entry?.evidence.lastProgressAt ?? null;
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
  const factText = liveTailFactText(fact, now, target.waitingForReply);
  const outputTime = clockText(lastOutputAt);
  const eventTime = clockText(lastEventAt);
  const badge = BADGES[fact.kind];

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={`live-tail-row${child ? " live-tail-row--child" : ""}`}
        data-live-tail-tab={tab.id}
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
          <span className="live-tail-agent" aria-hidden="true"><AgentKindIcon kind={target.agentKind} size={12} chip={false} /></span>
          <span className="live-tail-name">{name}</span>
          {badge && <span className="live-tail-badge">{badge}</span>}
        </span>
        <span className="live-tail-summary">
          <span className="live-tail-dot" aria-hidden="true" />
          <span ref={lineRef} className="live-tail-line" style={{ fontFamily }}>{fitted}</span>
        </span>
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
          <div className="live-tail-popup-heading"><AgentKindIcon kind={target.agentKind} size={12} chip={false} /><b>{name}</b></div>
          {rows.length > 0 && <div className="live-tail-popup-rows" style={{ fontFamily }}>{rows.map((row, index) => <div key={index}>{row}</div>)}</div>}
          <div className="live-tail-fact">{factText}</div>
          {fact.kind === "frozen" && <div className="live-tail-evidence">端末の最後の出力 {outputTime ?? "不明"} · {eventTime ? `会話記録の最後の書き込み ${eventTime}` : "会話記録 不明"}</div>}
          {fact.kind === "unreadable" && <div className="live-tail-evidence">開けば最新になります</div>}
          <div className="live-tail-go">押すとこのペインへ</div>
        </div>, portal,
      )}
    </>
  );
}

/** Workspace order and names come from the same layout as the pane tab bar. */
export function LiveTailList({ workspace, targets, entries, metadataBySession = {}, volatileMetadataBySession = {} }: LiveTailListProps) {
  const baseTheme = useThemeStore(state => state.theme);
  const tweaks = useThemeStore(state => state.themeTweaks);
  const colors = useMemo(() => buildLiveTailThemeVars(applyThemeTweaks(baseTheme, tweaks)), [baseTheme, tweaks]);
  const byTab = new Map(targets.filter(target => target.workspaceId === workspace.id).map(target => [target.tabId, target]));
  let idle = 0;
  const rows = workspace.panes.flatMap(pane => pane.tabs.flatMap(tab => {
    const target = byTab.get(tab.id);
    if (!target || target.paneId !== pane.id || target.sessionId !== tab.sessionId) return [];
    const entry = entries[target.sessionId];
    const kind = entry ? factForLiveTailEvidence(entry.evidence).kind : target.status === "idle" ? "idle" : "unreadable";
    if (kind === "idle" && !target.waitingForReply) { idle += 1; return []; }
    const times = [entry?.evidence.observation.lastOutputAt, volatileMetadataBySession[tab.sessionId]?.backendLastOutputAt, metadataBySession[tab.sessionId]?.backendLastOutputAt]
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    return [<TailRow key={tab.id} workspaceId={workspace.id} paneId={pane.id} tab={tab} target={target} entry={entry}
      name={getTabDisplayLabel(tab, tab.id === pane.activeTabId, metadataBySession, volatileMetadataBySession)}
      child={tab.origin?.kind === "agent" && Boolean(tab.origin.parentTabId)}
      lastOutputAt={times.length ? Math.max(...times) : null} colors={colors} />];
  }));
  if (!rows.length && !idle) return null;
  return <div className="live-tail-list" data-live-tail-workspace={workspace.id} style={colors}>
    {rows}
    {idle > 0 && <div className="live-tail-idle">ほか 入力待ち {idle}</div>}
  </div>;
}
