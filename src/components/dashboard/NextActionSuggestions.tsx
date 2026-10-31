import { useEffect, useState } from "react";
import { ArrowLeft, Info, RotateCcw } from "lucide-react";
import { DashboardGlyph, DashboardIconButton, DashboardStatusMark } from "./DashboardUi";

import { retryActiveSession, useBackgroundAiSuggestion } from "../../lib/backgroundAiScheduler";
import type { DashboardDisplayState } from "./dashboardModel";
import { dashboardStrings } from "./dashboardStrings";

export interface NextAction {
  label: string;
  prompt: string;
}

interface NextActionSuggestionsProps {
  sessionId: string | null;
  displayState: DashboardDisplayState;
  questionActive: boolean;
  sending: boolean;
  onConfirm: (action: NextAction) => Promise<void>;
}

export function NextActionSuggestions(props: NextActionSuggestionsProps) {
  const { sessionId, questionActive, sending, onConfirm } = props;
  const aiSuggestion = useBackgroundAiSuggestion(sessionId);
  const [pending, setPending] = useState<NextAction | null>(null);

  useEffect(() => setPending(null), [sessionId, questionActive, aiSuggestion?.requestKey]);

  if (!aiSuggestion || questionActive) return null;

  const retryButton = <DashboardIconButton icon={RotateCcw} label={dashboardStrings.nextActionRetry}
    className="cmux-dashboard-next-actions-retry"
    title={dashboardStrings.nextActionRetry}
    aria-label={dashboardStrings.nextActionRetry}
    disabled={sending}
    onClick={() => retryActiveSession()}
  />;

  if (aiSuggestion.status === "loading") {
    return <section
      className="cmux-dashboard-next-actions is-loading"
      data-next-action-suggestions="true"
      data-next-action-status="loading"
      aria-label={dashboardStrings.nextActionAriaLabel}
    >
      <div className="cmux-dashboard-next-actions-loading"><DashboardStatusMark state="running" label={dashboardStrings.nextActionLoading} /></div>
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
