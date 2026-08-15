import { useMemo } from "react";
import type { MouseEvent } from "react";

import { targetKey, type LiveSessionBrief, type SemanticEventEnvelope } from "../../lib/livebrief";
import { dashboardStrings } from "./dashboardStrings";
import {
  chooseOption,
  interventionResultText,
  isInterventionConflict,
  questionModel,
  useInterventionFeedbackStore,
} from "./interventionRouting";

/** 番号キー (1/2/3) で撃てる上限。これを超えたらヒントを出さない。 */
const NUMBER_KEY_LIMIT = 3;

/**
 * 「エージェントが今なにを聞いているか」と、その場で答えるボタン。
 * 一覧行 (compact) と詳細フッタ (フル) の両方で同じものを出す。
 * 送信そのものは interventionRouting へ寄せてあり、キーボード経路と同一。
 */
export function QuestionCard({ brief, events, targetLabel, onFocusComposer, compact = false }: {
  brief: LiveSessionBrief | undefined;
  events: readonly SemanticEventEnvelope[] | undefined;
  targetLabel: string;
  onFocusComposer: (brief: LiveSessionBrief | undefined) => void;
  compact?: boolean;
}) {
  const model = useMemo(() => questionModel(brief, events), [brief, events]);
  const key = brief ? targetKey(brief) : null;
  const inFlight = useInterventionFeedbackStore((state) => (key ? state.inFlightByTarget[key] ?? false : false));
  const result = useInterventionFeedbackStore((state) => (key ? state.resultByTarget[key] : undefined));

  if (!model) return null;
  const disabled = inFlight || !model.canSend;
  const resultText = result ? interventionResultText(result) : null;
  // 一覧行の行クリック (選択) は通してよいが、ボタンの連打が dblclick になって
  // ペインへ飛ぶのは事故なので、ボタン側でバブリングを止める。
  const stop = (event: MouseEvent) => event.stopPropagation();

  return <section
    id={!compact && brief ? `dashboard-question-${brief.ptySessionId}` : undefined}
    data-dashboard-question={!compact ? brief?.ptySessionId : undefined}
    data-livebrief-interactive="true"
    className={`cmux-dashboard-qcard${compact ? " is-compact" : ""}`}
    onDoubleClick={stop}
  >
    {compact ? null : <div className="cmux-dashboard-qcard-head">
      <strong>{dashboardStrings.liveBriefQuestionLabel}</strong>
      <span>{targetLabel}</span>
    </div>}
    <div className="cmux-dashboard-qcard-prompt">{model.prompt}</div>
    {model.options.length ? <div className="cmux-dashboard-qcard-options">
      {model.options.map((option, index) => <button
        key={option.id}
        type="button"
        disabled={disabled}
        className="cmux-dashboard-qcard-option"
        style={{ opacity: disabled ? 0.55 : 1 }}
        // blur しておかないとフォーカスがボタンに残り、DashboardView の
        // キーボード操作 (1/2/3・j/k) が「入力中」と見なされて効かなくなる。
        onClick={(event) => { stop(event); event.currentTarget.blur(); void chooseOption(brief, option.id); }}
      >
        <span className="cmux-dashboard-qcard-badge">{index + 1}</span>
        <span>{option.label}</span>
      </button>)}
    </div> : null}
    {compact ? null : <div className="cmux-dashboard-qcard-footer">
      <button
        type="button"
        disabled={inFlight}
        className="cmux-dashboard-qcard-other"
        style={{ opacity: inFlight ? 0.55 : 1 }}
        onClick={(event) => { stop(event); onFocusComposer(brief); }}
      >{dashboardStrings.otherFreeText}</button>
      {model.options.length && model.options.length <= NUMBER_KEY_LIMIT
        ? <span className="cmux-dashboard-qcard-hint">{dashboardStrings.numberKeyHint}</span>
        : null}
    </div>}
    {resultText
      ? <div className={`cmux-dashboard-qcard-result${isInterventionConflict(result) ? " is-error" : ""}`}>{resultText}</div>
      : null}
  </section>;
}
