import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Info, RotateCcw } from "lucide-react";
import { DashboardGlyph, DashboardIconButton, DashboardStatusMark } from "./DashboardUi";

import { nextActionRequestKey, retryActiveSession, useBackgroundAiSuggestion } from "../../lib/backgroundAiScheduler";
import type { DashboardDisplayState } from "./dashboardModel";
import { useAiSettingsStore } from "../../stores/aiSettingsStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { dashboardStrings } from "./dashboardStrings";

export interface NextAction {
  label: string;
  prompt: string;
}

interface NextActionSuggestionsProps {
  sessionId: string | null;
  displayState: DashboardDisplayState;
  eventSeq?: number;
  questionActive: boolean;
  sending: boolean;
  onConfirm: (action: NextAction) => Promise<void>;
}

interface PanelBox { left: number; bottom: number; width: number; minWidth: number; maxHeight: number }
const PANEL_MAX_WIDTH = 420;
const PANEL_MIN_WIDTH = 300;
const PANEL_GAP = 4;
const PANEL_EDGE = 8;

// Placement of the panel in viewport coordinates: left edge on the row, width capped by the row
// (the conversation column), opening upwards with a height that never reaches past the top edge.
export function measurePanelBox(row: { left: number; width: number; top: number }, viewportHeight: number, dashboardRoot: { top: number } = { top: 0 }): PanelBox {
  const width = Math.max(0, Math.min(PANEL_MAX_WIDTH, row.width));
  return {
    left: row.left,
    bottom: Math.max(0, viewportHeight - row.top + PANEL_GAP),
    width,
    minWidth: Math.min(PANEL_MIN_WIDTH, width),
    maxHeight: Math.max(0, Math.min(viewportHeight * 0.6, row.top - dashboardRoot.top - PANEL_GAP - PANEL_EDGE)),
  };
}

export function NextActionSuggestions(props: NextActionSuggestionsProps) {
  const { sessionId, questionActive, sending, onConfirm } = props;
  const storedSuggestion = useBackgroundAiSuggestion(sessionId);
  // Subscribe to model/provider changes as well as enablement; the key includes them.
  const aiSettings = useAiSettingsStore(state => state);
  const expectedKey = sessionId ? nextActionRequestKey({ sessionId, eventSeq: props.eventSeq ?? 0, displayState: props.displayState }) : null;
  const aiSuggestion = storedSuggestion?.requestKey === expectedKey ? storedSuggestion : undefined;
  const [pending, setPending] = useState<NextAction | null>(null);
  const [requestedKey, setRequestedKey] = useState<string | null>(null);
  const requested = expectedKey !== null && requestedKey === expectedKey;
  const [elapsed, setElapsed] = useState(0);
  const [readAttempt, setReadAttempt] = useState(0);
  const aiEnabled = aiSettings.aiEnabled;
  const suggestionsEnabled = useSettingsStore(state => state.replyDraftSuggestionsEnabled);
  const eligible = ["done", "acknowledged", "idle", "noUpdate", "error"].includes(props.displayState);
  const canRead = aiEnabled && suggestionsEnabled && eligible;
  useEffect(() => { setRequestedKey(null); setElapsed(0); }, [expectedKey]);
  useEffect(() => {
    if (!requested || (aiSuggestion && aiSuggestion.status !== "loading")) return;
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [requested, aiSuggestion?.status, readAttempt]);

  useEffect(() => setPending(null), [expectedKey, questionActive, aiSuggestion?.requestKey]);

  // The "more" panel opens upwards from the one-line row. It closes on Esc (focus goes back to
  // the button that opened it), on a press outside it, when focus leaves it, and when the
  // suggestion it belongs to changes.
  // The panel is drawn into the dashboard root (a portal) and placed with position: fixed from the
  // row's rectangle: the conversation column and its pane are CSS containers (layout containment),
  // which would otherwise clip it or turn "fixed" into "relative to the column". The root also
  // carries the theme variables. Because the panel is then outside the section in the DOM, Tab is
  // handled by hand (see onMoreKeyDown / onPanelKeyDown).
  const [moreOpen, setMoreOpen] = useState(false);
  const rowRef = useRef<HTMLElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const morePanelId = useId();
  const [panelBox, setPanelBox] = useState<PanelBox | null>(null);
  const retryFocusPending = useRef(false);
  const retryFollowLoading = useRef(false);
  // Drop only retry focus intent when switching conversations, before focus effects run.
  useLayoutEffect(() => {
    retryFocusPending.current = false;
    retryFollowLoading.current = false;
  }, [sessionId]);
  const isInsideMore = (node: Node) => Boolean(moreRef.current?.contains(node) || panelRef.current?.contains(node));
  useEffect(() => setMoreOpen(false), [expectedKey, questionActive, aiSuggestion?.requestKey, aiSuggestion?.status, aiEnabled, suggestionsEnabled]);
  useEffect(() => {
    if (!moreOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const focused = document.activeElement;
      const dashboardRoot = rowRef.current?.closest(".cmux-dashboard-view");
      if (focused !== document.body && focused !== dashboardRoot && !(focused && isInsideMore(focused))) return;
      // Never take the Escape that cancels an IME composition.
      if (event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      event.stopPropagation();
      setMoreOpen(false);
      moreButtonRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && isInsideMore(event.target)) return;
      setMoreOpen(false);
    };
    // window capture runs before the dashboard root's own document-level Escape handler, so that
    // stopPropagation keeps the Escape from closing the whole dashboard.
    window.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [moreOpen]);
  // Measure the row while the panel is open; re-measure on resize and on any scroll.
  useLayoutEffect(() => {
    if (!moreOpen) { setPanelBox(null); return; }
    const measure = () => {
      const row = rowRef.current;
      if (!row) return;
      const dashboardRoot = row.closest(".cmux-dashboard-view");
      setPanelBox(measurePanelBox(row.getBoundingClientRect(), window.innerHeight, dashboardRoot?.getBoundingClientRect()));
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    const observer = typeof ResizeObserver === "function" && rowRef.current ? new ResizeObserver(measure) : null;
    if (observer && rowRef.current) {
      observer.observe(rowRef.current);
      if (rowRef.current.parentElement) observer.observe(rowRef.current.parentElement);
    }
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      observer?.disconnect();
    };
  }, [moreOpen]);

  // A retry removes the panel's focused button; move to the replacement row after commit.
  useLayoutEffect(() => {
    if (retryFollowLoading.current && aiSuggestion?.status !== "loading") {
      // The loading row we moved to was replaced: follow it unless focus now sits somewhere else.
      retryFollowLoading.current = false;
      const focused = document.activeElement;
      if (!focused || focused === document.body) (rowRef.current?.querySelector<HTMLButtonElement>(".cmux-dashboard-next-actions-retry") ?? moreButtonRef.current)?.focus();
      return;
    }
    if (!retryFocusPending.current) return;
    // Focus already moved elsewhere (e.g. into a reply field): drop the flag instead of stealing it later.
    const focused = document.activeElement;
    if (focused && focused !== document.body) { retryFocusPending.current = false; return; }
    const target = rowRef.current?.querySelector<HTMLButtonElement>(".cmux-dashboard-next-actions-retry") ?? moreButtonRef.current;
    if (!target) return;
    retryFocusPending.current = false;
    target.focus();
    retryFollowLoading.current = aiSuggestion?.status === "loading";
  }, [moreOpen, aiSuggestion?.status]);

  if (!sessionId || questionActive) return null;
  const request = () => {
    setRequestedKey(expectedKey);
    setReadAttempt(attempt => attempt + 1);
    setElapsed(0);
    if (!aiSuggestion || aiSuggestion.status === "failed") retryActiveSession();
  };
  if (!aiEnabled || !suggestionsEnabled) return <section className="cmux-dashboard-next-actions is-balanced is-unavailable" data-next-action-status="unavailable" role="note">
    <span>{!aiEnabled ? "AIの提案は無効です" : "返信案の準備は無効です"}</span>
  </section>;
  if (!requested) return <section className="cmux-dashboard-next-actions is-balanced" data-next-action-status="not-requested">
    <span>{!aiEnabled || !suggestionsEnabled ? "AIの提案は無効です" : !eligible ? dashboardStrings.nextActionWaitSettle : dashboardStrings.nextActionNotRequested}</span>
    <button type="button" disabled={!canRead || sending} onClick={request}>提案を読む</button>
  </section>;
  if (!aiSuggestion) return <section className="cmux-dashboard-next-actions is-balanced" role="status">
    <span>{elapsed < 30 ? `提案を読み取っています（${elapsed}秒）` : "提案の読み取りに時間がかかっています。再試行できます"}</span>
    <button type="button" disabled={!canRead || sending} onClick={() => { setElapsed(0); setReadAttempt(attempt => attempt + 1); retryActiveSession(); }}>再試行</button>
  </section>;

  const retryButton = <DashboardIconButton icon={RotateCcw} label={dashboardStrings.nextActionRetry}
    className="cmux-dashboard-next-actions-retry"
    title={dashboardStrings.nextActionRetry}
    aria-label={dashboardStrings.nextActionRetry}
    disabled={!canRead || sending}
    onClick={() => {
      if (moreOpen) { retryFocusPending.current = true; setMoreOpen(false); }
      setElapsed(0); setReadAttempt(attempt => attempt + 1); retryActiveSession();
    }}
  />;

  if (aiSuggestion.status === "loading") {
    return <section
      ref={rowRef}
      className="cmux-dashboard-next-actions is-balanced is-loading"
      data-next-action-suggestions="true"
      data-next-action-status="loading"
      aria-label={dashboardStrings.nextActionAriaLabel}
    >
      <div className="cmux-dashboard-next-actions-loading"><DashboardStatusMark state="running" label={`${dashboardStrings.nextActionLoading}（${elapsed}秒）`} />{elapsed >= 30 ? <span>時間がかかっています</span> : null}{retryButton}</div>
    </section>;
  }

  if (aiSuggestion.status === "failed") {
    return <section
      ref={rowRef}
      className="cmux-dashboard-next-actions is-balanced"
      data-next-action-suggestions="true"
      data-next-action-status="failed"
      aria-label={dashboardStrings.nextActionAriaLabel}
    >
      <div className="cmux-dashboard-next-actions-row">
        <div className="cmux-dashboard-next-actions-failed" data-next-action-ai-failed="true">
          <DashboardStatusMark state="error" label={dashboardStrings.nextActionFailed(dashboardStrings.aiSuggestionFailureReason(aiSuggestion.failureCode ?? "internal"))} />
        </div>
        {retryButton}
      </div>
    </section>;
  }

  const visibleActions = aiSuggestion.nextActions.slice(0, 3);
  const [firstAction, ...restActions] = visibleActions;
  const chooseAction = (action: NextAction) => {
    setPending(action);
    if (moreOpen) {
      setMoreOpen(false);
      moreButtonRef.current?.focus();
    }
  };
  const actionButton = (action: NextAction, recommended: boolean) => <button
    key={`${action.label}:${action.prompt}`}
    type="button"
    className={`cmux-dashboard-next-action${recommended ? " is-recommended" : ""}`}
    data-next-action-recommended={recommended ? "true" : undefined}
    title={action.prompt}
    disabled={sending}
    onClick={() => chooseAction(action)}
  >
    {recommended ? <span className="cmux-dashboard-next-action-star" aria-label={dashboardStrings.nextActionRecommended}>{"★"}</span> : null}
    <span>{action.label}</span>
  </button>;

  const panelHost = moreOpen ? moreRef.current?.closest<HTMLElement>(".cmux-dashboard-view") ?? null : null;
  const focusablesInPanel = () => [...(panelRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? [])];
  const onMoreKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!moreOpen || !panelHost || event.key !== "Tab" || event.shiftKey || event.nativeEvent.isComposing) return;
    const first = focusablesInPanel()[0];
    if (!first) return;
    event.preventDefault();
    first.focus();
  };
  const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || event.nativeEvent.isComposing) return;
    const items = focusablesInPanel();
    const index = items.indexOf(event.target as HTMLElement);
    const leaving = event.shiftKey ? index <= 0 : index === items.length - 1 || index < 0;
    if (!leaving) return;
    event.preventDefault();
    if (event.shiftKey) { moreButtonRef.current?.focus(); return; }
    // The portal is last in the root's DOM; resume just after its trigger, excluding the panel.
    const host = panelHost ?? rowRef.current?.parentElement;
    const candidates = [...(host?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), textarea:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
    ) ?? [])].filter(item => item.tabIndex >= 0 && !item.matches(":disabled") && !panelRef.current?.contains(item));
    // Some selector engines group results by selector; enforce DOM order explicitly.
    candidates.sort((a, b) => a === b ? 0 : (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);
    const trigger = moreButtonRef.current;
    const triggerIndex = trigger ? candidates.indexOf(trigger) : -1;
    const next = triggerIndex >= 0 ? candidates[triggerIndex + 1] : undefined;
    setMoreOpen(false);
    (next ?? host)?.focus();
  };
  const panel = moreOpen ? <div
    ref={panelRef}
    id={morePanelId}
    role="group"
    tabIndex={-1}
    data-livebrief-interactive="true"
    className="cmux-dashboard-next-actions-more-panel"
    aria-label={dashboardStrings.nextActionMorePanelLabel}
    style={panelHost && panelBox ? { position: "fixed", left: panelBox.left, bottom: panelBox.bottom, width: panelBox.width, minWidth: panelBox.minWidth, maxHeight: panelBox.maxHeight } : undefined}
    onKeyDown={onPanelKeyDown}
  >
    <div className="cmux-dashboard-next-actions-summary" title={`${aiSuggestion.oneLine}
${aiSuggestion.completionAssessment}`}>
      {aiSuggestion.oneLine}
    </div>
    {restActions.map(action => actionButton(action, false))}
    {retryButton}
  </div> : null;

  return <section
    ref={rowRef}
    className="cmux-dashboard-next-actions is-balanced"
    data-next-action-suggestions="true"
    data-next-action-status="ready"
    aria-label={dashboardStrings.nextActionAriaLabel}
  >
    <div className="cmux-dashboard-next-actions-list">
      {firstAction ? actionButton(firstAction, true) : null}
      <div
        className="cmux-dashboard-next-actions-more"
        ref={moreRef}
        onBlur={(event) => {
          const next = event.relatedTarget;
          if (moreOpen && next instanceof Node && !isInsideMore(next)) setMoreOpen(false);
        }}
      >
        <button
          ref={moreButtonRef}
          type="button"
          className="cmux-dashboard-next-actions-more-button"
          aria-expanded={moreOpen}
          aria-controls={moreOpen ? morePanelId : undefined}
          onKeyDown={onMoreKeyDown}
          onClick={() => setMoreOpen(open => !open)}
        >{restActions.length ? dashboardStrings.nextActionMoreCount(restActions.length) : dashboardStrings.nextActionMoreDetail}</button>
        {panel ? (panelHost ? createPortal(panel, panelHost) : panel) : null}
      </div>
    </div>
    {pending ? <div className="cmux-dashboard-next-action-confirm" data-next-action-confirm="true">
      <DashboardGlyph icon={Info} label={dashboardStrings.nextActionSendPreviewTitle} />
      <pre>{pending.prompt}</pre>
      <div>
        <button type="button" disabled={sending} onClick={() => { void onConfirm(pending).then(() => setPending(null)); }}>{dashboardStrings.nextActionSendConfirm}</button>
        <DashboardIconButton icon={ArrowLeft} label={dashboardStrings.nextActionSendCancel} disabled={sending} onClick={() => setPending(null)} />
      </div>
    </div> : null}
  </section>;
}
