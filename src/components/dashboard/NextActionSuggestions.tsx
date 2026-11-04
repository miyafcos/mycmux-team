import { useEffect, useState } from "react";
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

  if (!sessionId || questionActive) return null;
  const request = () => {
    setRequestedKey(expectedKey);
    setReadAttempt(attempt => attempt + 1);
    setElapsed(0);
    if (!aiSuggestion || aiSuggestion.status === "failed") retryActiveSession();
  };
  if (!aiEnabled || !suggestionsEnabled) return <section className="cmux-dashboard-next-actions is-unavailable" data-next-action-status="unavailable" role="note">
    <span>{!aiEnabled ? "AIの提案は無効です" : "返信案の準備は無効です"}</span>
  </section>;
  if (!requested) return <section className="cmux-dashboard-next-actions" data-next-action-status="not-requested">
    <span>{!aiEnabled || !suggestionsEnabled ? "AIの提案は無効です" : !eligible ? "会話の処理が落ち着くと提案を読めます" : "提案はまだ読み込んでいません"}</span>
    <button type="button" disabled={!canRead || sending} onClick={request}>提案を読む</button>
  </section>;
  if (!aiSuggestion) return <section className="cmux-dashboard-next-actions" role="status">
    <span>{elapsed < 30 ? `提案を読み取っています（${elapsed}秒）` : "提案の読み取りに時間がかかっています。再試行できます"}</span>
    <button type="button" disabled={!canRead || sending} onClick={() => { setElapsed(0); setReadAttempt(attempt => attempt + 1); retryActiveSession(); }}>再試行</button>
  </section>;

  const retryButton = <DashboardIconButton icon={RotateCcw} label={dashboardStrings.nextActionRetry}
    className="cmux-dashboard-next-actions-retry"
    title={dashboardStrings.nextActionRetry}
    aria-label={dashboardStrings.nextActionRetry}
    disabled={!canRead || sending}
    onClick={() => { setElapsed(0); setReadAttempt(attempt => attempt + 1); retryActiveSession(); }}
  />;

  if (aiSuggestion.status === "loading") {
    return <section
      className="cmux-dashboard-next-actions is-loading"
      data-next-action-suggestions="true"
      data-next-action-status="loading"
      aria-label={dashboardStrings.nextActionAriaLabel}
    >
      <div className="cmux-dashboard-next-actions-loading"><DashboardStatusMark state="running" label={`${dashboardStrings.nextActionLoading}（${elapsed}秒）`} />{elapsed >= 30 ? <span>時間がかかっています</span> : null}{retryButton}</div>
    </section>;
  }

  if (aiSuggestion.status === "failed") {
    return <section
      className="cmux-dashboard-next-actions"
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

  return <section
    className="cmux-dashboard-next-actions"
    data-next-action-suggestions="true"
    data-next-action-status="ready"
    aria-label={dashboardStrings.nextActionAriaLabel}
  >
    <div className="cmux-dashboard-next-actions-row">
      <div className="cmux-dashboard-next-actions-summary" title={`${aiSuggestion.oneLine}\n${aiSuggestion.completionAssessment}`}>
        {aiSuggestion.oneLine}
      </div>
      {retryButton}
    </div>
    <div className="cmux-dashboard-next-actions-list">
      {aiSuggestion.nextActions.slice(0, 3).map((action, index) => <button
        key={`${action.label}:${action.prompt}`}
        type="button"
        className={`cmux-dashboard-next-action${index === 0 ? " is-recommended" : ""}`}
        data-next-action-recommended={index === 0 ? "true" : undefined}
        title={action.prompt}
        disabled={sending}
        onClick={() => setPending(action)}
      >
        {index === 0 ? <span className="cmux-dashboard-next-action-star" aria-label={dashboardStrings.nextActionRecommended}>{"\u2605"}</span> : null}
        <span>{action.label}</span>
      </button>)}
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
