import { useEffect, useMemo, useState } from "react";

import { useBackgroundAiSuggestion } from "../../lib/backgroundAiScheduler";
import type { DashboardDisplayState } from "./dashboardModel";
import { dashboardStrings } from "./dashboardStrings";
import { stateLabels } from "./stateLabels";

export type NextActionSource = "machine" | "ai";

export interface NextAction {
  label: string;
  prompt: string;
  source: NextActionSource;
}

/**
 * This is intentionally a presentation of the existing display vocabulary,
 * not a second state classifier. QuestionCard owns the needs-answer case.
 */
export function machineNextActions(
  displayState: DashboardDisplayState,
  questionActive: boolean,
): NextAction[] {
  if (questionActive) return [];
  const activity = stateLabels(displayState).activity;
  if (activity === "done") {
    return [
      { label: "続きをお願い", prompt: "続きをお願い", source: "machine" },
      { label: "詳しく報告", prompt: "詳しく報告", source: "machine" },
    ];
  }
  if (activity === "stalled") {
    return [
      { label: "再開して", prompt: "再開して", source: "machine" },
      { label: "状況を教えて", prompt: "状況を教えて", source: "machine" },
    ];
  }
  if (activity === "waiting") {
    return [
      { label: "続けて", prompt: "続けて", source: "machine" },
      { label: "ゴールと残りは？", prompt: "ゴールと残りは？", source: "machine" },
    ];
  }
  return [];
}

export function NextActionSuggestions({
  sessionId,
  displayState,
  questionActive,
  sending,
  onConfirm,
}: {
  sessionId: string | null;
  displayState: DashboardDisplayState;
  questionActive: boolean;
  sending: boolean;
  onConfirm: (action: NextAction) => Promise<void>;
}) {
  const aiSuggestion = useBackgroundAiSuggestion(sessionId);
  const [pending, setPending] = useState<NextAction | null>(null);
  const machineActions = useMemo(
    () => machineNextActions(displayState, questionActive),
    [displayState, questionActive],
  );
  const aiActions = useMemo<NextAction[]>(() => {
    if (questionActive || aiSuggestion?.status !== "ready") return [];
    return aiSuggestion.nextActions.map((action) => ({ ...action, source: "ai" }));
  }, [aiSuggestion, questionActive]);

  useEffect(() => setPending(null), [sessionId, questionActive]);

  const aiFailed = aiSuggestion?.status === "failed";
  if (questionActive || (!machineActions.length && !aiActions.length && aiSuggestion?.status !== "loading" && !aiFailed)) {
    return null;
  }

  return <section className="cmux-dashboard-next-actions" data-next-action-suggestions="true" aria-label="次の一手">
    <div className="cmux-dashboard-next-actions-head">
      <strong>次の一手</strong>
      {aiSuggestion?.status === "loading" ? <span className="cmux-dashboard-next-actions-loading">具体案を準備中</span> : null}
      {aiSuggestion?.status === "ready" ? <span className="cmux-dashboard-next-actions-ai-tag">AI案</span> : null}
    </div>
    {aiSuggestion?.status === "ready" && aiSuggestion.oneLine ? <div className="cmux-dashboard-next-actions-summary">{aiSuggestion.oneLine}</div> : null}
    {aiSuggestion?.status === "ready" && aiSuggestion.completionAssessment ? <div className="cmux-dashboard-next-actions-summary">{aiSuggestion.completionAssessment}</div> : null}
    <div className="cmux-dashboard-next-actions-list">
      {[...machineActions, ...aiActions].map((action) => <button
        key={`${action.source}:${action.label}:${action.prompt}`}
        type="button"
        disabled={sending}
        className={`cmux-dashboard-next-action is-${action.source}`}
        onClick={() => setPending(action)}
      >
        {action.source === "ai" ? <span className="cmux-dashboard-next-actions-ai-tag">AI案</span> : null}
        <span>{action.label}</span>
      </button>)}
    </div>
    {aiFailed ? <div
      data-next-action-ai-failed="true"
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 6,
        color: "var(--cmux-usage-warn)",
        fontSize: "var(--cmux-font-size-xs)",
      }}
    >
      <span
        className="cmux-dashboard-next-actions-machine-tag"
        style={{
          background: "color-mix(in srgb, var(--cmux-usage-warn) 22%, var(--cmux-surface))",
          color: "var(--cmux-usage-warn)",
        }}
      >
        {dashboardStrings.aiSuggestionFailed}
      </span>
      <span>{dashboardStrings.aiSuggestionFailureReason(aiSuggestion.failureCode ?? "internal")}</span>
    </div> : null}
    {pending ? <div className="cmux-dashboard-next-action-confirm" data-next-action-confirm="true">
      <div>送る全文</div>
      <pre>{pending.prompt}</pre>
      <div>
        <button type="button" disabled={sending} onClick={() => { void onConfirm(pending).then(() => setPending(null)); }}>この内容を送る</button>
        <button type="button" disabled={sending} onClick={() => setPending(null)}>戻る</button>
      </div>
    </div> : null}
  </section>;
}
