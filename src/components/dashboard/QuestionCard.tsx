import { useEffect, useMemo } from "react";
import type { MouseEvent } from "react";

import { targetKey, type LiveSessionBrief, type SemanticEventEnvelope } from "../../lib/livebrief";
import type { AskOption, AskScreen } from "../../lib/askQuestionScan";
import type { SessionAttention } from "../../stores/sessionAttentionStore";
import {
  checkedOptionIndexes,
  getAskQuestionSession,
  questionKey,
  useAskQuestionStore,
} from "../../stores/askQuestionStore";
import { dashboardStrings } from "./dashboardStrings";
import {
  chooseOption,
  interventionResultText,
  isInterventionConflict,
  questionModel,
  useInterventionFeedbackStore,
} from "./interventionRouting";
import {
  isAskQuestionBusy,
  submitAskQuestionChoice,
  submitAskQuestionMultiSelect,
  submitAskQuestionReview,
  toggleAskQuestionDraft,
} from "./askQuestionRouting";

/** 番号キー (1/2/3) で撃てる上限。これを超えたらヒントを出さない。 */
const NUMBER_KEY_LIMIT = 3;

function stop(event: MouseEvent) {
  event.stopPropagation();
}

function optionAriaName(option: AskOption): string {
  if (option.role === "submit") return "AskUserQuestion submit";
  return `AskUserQuestion option ${option.index}`;
}

function AskScreenCard({
  sessionId,
  screen,
  targetLabel,
  compact,
}: {
  sessionId: string;
  screen: AskScreen;
  targetLabel: string;
  compact: boolean;
}) {
  const session = useAskQuestionStore((state) => state.bySession[sessionId]);
  const inFlight = session?.inFlight ?? false;
  const stopReason = session?.stopReason ?? null;
  const key = questionKey(screen);
  const draftChecked = session?.draftChecked[key];
  const checked = new Set(draftChecked ?? checkedOptionIndexes(screen));
  const disabled = inFlight;
  const numberedOptions = screen.kind === "review"
    ? screen.options.filter((option) => option.index === 1 && option.role === "submit")
    : screen.options.filter((option) => option.index !== null && option.role === "option");
  const submitRow = screen.options.find((option) => option.role === "submit" && option.index === null);
  const reviewSubmit = screen.kind === "review"
    ? screen.options.find((option) => option.index === 1 && option.role === "submit")
    : undefined;

  const runChoice = (index: number) => {
    if (isAskQuestionBusy(sessionId)) return;
    if (screen.kind === "review") {
      if (index === 1 && reviewSubmit) void submitAskQuestionReview(sessionId);
      return;
    }
    if (screen.multiSelect) {
      toggleAskQuestionDraft(sessionId, index);
      return;
    }
    void submitAskQuestionChoice(sessionId, index);
  };

  return <section
    id={!compact ? `dashboard-question-${sessionId}` : undefined}
    data-dashboard-question={!compact ? sessionId : undefined}
    data-ask-question-session={sessionId}
    data-livebrief-interactive="true"
    tabIndex={0}
    role="group"
    aria-label={`${screen.question} の回答`}
    className={`cmux-dashboard-qcard${compact ? " is-compact" : ""}`}
    onDoubleClick={stop}
  >
    {compact ? null : <div className="cmux-dashboard-qcard-head">
      <strong>{dashboardStrings.liveBriefQuestionLabel}</strong>
      <span>{targetLabel}</span>
    </div>}
    {screen.header ? <div className="cmux-dashboard-qcard-header" data-ask-question-header>{screen.header}</div> : null}
    {screen.tabs.length ? <div className="cmux-dashboard-qcard-tabs" role="list" aria-label="AskUserQuestion tabs">
      {screen.tabs.map((tab) => <span
        key={tab.label}
        role="listitem"
        data-ask-question-tab={tab.label}
        data-answered={tab.answered ? "true" : "false"}
        data-active={tab.active ? "true" : "false"}
        className={`cmux-dashboard-qcard-tab${tab.active ? " is-active" : ""}${tab.answered ? " is-answered" : ""}`}
      >{tab.answered ? "☑" : "☐"} {tab.label}</span>)}
      <span className="cmux-dashboard-qcard-tab-progress" data-ask-question-tab-progress>
        {dashboardStrings.askQuestionTabProgress(
          screen.tabs.filter((tab) => tab.answered).length,
          screen.tabs.length,
        )}
      </span>
    </div> : null}
    <div className="cmux-dashboard-qcard-prompt">{screen.question}</div>
    {numberedOptions.length ? <div className="cmux-dashboard-qcard-options">
      {numberedOptions.map((option) => {
        const isChecked = option.index !== null && checked.has(option.index);
        return <button
          key={`${option.index}:${option.label}`}
          type="button"
          disabled={disabled}
          className={`cmux-dashboard-qcard-option${isChecked ? " is-checked" : ""}${option.current ? " is-current" : ""}`}
          style={{ opacity: disabled ? 0.55 : 1 }}
          aria-label={optionAriaName(option)}
          aria-pressed={screen.multiSelect ? isChecked : undefined}
          data-ask-question-option={option.index}
          onClick={(event) => {
            stop(event);
            event.currentTarget.blur();
            if (
              option.index !== null
              && (option.role === "option" || (screen.kind === "review" && option.index === 1 && option.role === "submit"))
            ) {
              runChoice(option.index);
            }
          }}
        >
          <span className="cmux-dashboard-qcard-badge">{option.index}</span>
          <span>{screen.multiSelect ? `${isChecked ? "[✔]" : "[ ]"} ${option.label}` : option.label}</span>
          {option.description ? <span className="cmux-dashboard-qcard-desc">{option.description}</span> : null}
        </button>;
      })}
    </div> : null}
    {compact ? null : <div className="cmux-dashboard-qcard-footer">
      {submitRow ? <button
        type="button"
        disabled={disabled}
        className="cmux-dashboard-qcard-option"
        style={{ opacity: disabled ? 0.55 : 1 }}
        aria-label="AskUserQuestion submit"
        data-ask-question-submit="true"
        onClick={(event) => {
          stop(event);
          event.currentTarget.blur();
          if (isAskQuestionBusy(sessionId)) return;
          void submitAskQuestionMultiSelect(sessionId);
        }}
      >{dashboardStrings.askQuestionSubmit}</button> : null}
      {screen.kind !== "review" && !screen.multiSelect && numberedOptions.length && numberedOptions.length <= NUMBER_KEY_LIMIT
        ? <span className="cmux-dashboard-qcard-hint">{dashboardStrings.numberKeyHint}</span>
        : null}
    </div>}
    {inFlight
      ? <div className="cmux-dashboard-qcard-result" role="status" aria-label="AskUserQuestion status" aria-live="polite">{dashboardStrings.askQuestionSending}</div>
      : null}
    {stopReason
      ? <div className="cmux-dashboard-qcard-result is-error" role="status" aria-label="AskUserQuestion stop reason">{dashboardStrings.askQuestionStopReason(stopReason)}</div>
      : null}
  </section>;
}

/**
 * 「エージェントが今なにを聞いているか」と、その場で答えるボタン。
 * 一覧行 (compact) と詳細フッタ (フル) の両方で同じものを出す。
 * Claude の画面由来質問があればそちらを優先し、無ければ livebrief に落とす。
 */
export function QuestionCard({
  brief,
  events,
  targetLabel,
  onFocusComposer,
  compact = false,
  sessionId,
  attention: _attention,
}: {
  brief: LiveSessionBrief | undefined;
  events: readonly SemanticEventEnvelope[] | undefined;
  targetLabel: string;
  onFocusComposer: (brief: LiveSessionBrief | undefined) => void;
  compact?: boolean;
  sessionId?: string;
  attention?: SessionAttention;
}) {
  const resolvedSessionId = sessionId ?? brief?.ptySessionId;
  const askSession = useAskQuestionStore((state) => (
    resolvedSessionId ? state.bySession[resolvedSessionId] : undefined
  ));
  const screen = askSession?.screen ?? null;
  const screenIsCanonical = Boolean(
    screen
    && (!_attention || _attention.kind === "input"),
  );
  const model = useMemo(() => questionModel(brief, events), [brief, events]);
  const key = brief ? targetKey(brief) : null;
  const inFlight = useInterventionFeedbackStore((state) => (key ? state.inFlightByTarget[key] ?? false : false));
  const result = useInterventionFeedbackStore((state) => (key ? state.resultByTarget[key] : undefined));

  useEffect(() => {
    if (resolvedSessionId && screenIsCanonical) useAskQuestionStore.getState().markRead(resolvedSessionId);
  }, [resolvedSessionId, screenIsCanonical]);

  if (resolvedSessionId && screen && screenIsCanonical) {
    return <AskScreenCard
      sessionId={resolvedSessionId}
      screen={screen}
      targetLabel={targetLabel}
      compact={compact}
    />;
  }

  if (resolvedSessionId && askSession?.stopReason) {
    return <section
      id={!compact ? `dashboard-question-${resolvedSessionId}` : undefined}
      data-dashboard-question={!compact ? resolvedSessionId : undefined}
      data-ask-question-session={resolvedSessionId}
      className={`cmux-dashboard-qcard${compact ? " is-compact" : ""}`}
    >
      <div className="cmux-dashboard-qcard-result is-error" role="status" aria-label="AskUserQuestion stop reason">
        {dashboardStrings.askQuestionStopReason(askSession.stopReason)}
      </div>
    </section>;
  }

  if (!model) return null;
  const disabled = inFlight || !model.canSend;
  const resultText = result ? interventionResultText(result) : null;

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

export function hasAskQuestionScreen(sessionId: string | undefined): boolean {
  return Boolean(sessionId && getAskQuestionSession(sessionId).screen);
}
