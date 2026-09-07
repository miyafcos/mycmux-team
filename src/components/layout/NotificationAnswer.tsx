import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import type { AskOption } from "../../lib/askQuestionScan";
import { freezeExpectation, sendIntervention, targetKey, type LiveSessionBrief } from "../../lib/livebrief";
import { connectLiveBriefStore, useLiveBriefStore } from "../../stores/liveBriefStore";
import { getAskQuestionSession, screenContentKey, useAskQuestionStore } from "../../stores/askQuestionStore";
import { useSessionAttentionStore } from "../../stores/sessionAttentionStore";
import { QuestionCard, hasAskQuestionScreen } from "../dashboard/QuestionCard";
import {
  submitAskQuestionChoice, submitAskQuestionMultiSelect, submitAskQuestionReview,
  toggleAskQuestionDraft, type AskSubmitResult,
} from "../dashboard/askQuestionRouting";
import { dashboardStrings } from "../dashboard/dashboardStrings";
import { notificationPanelStrings as strings } from "./notificationPanelStrings";
import "../dashboard/DashboardView.css";

// Use the dashboard's reference-counted subscription; closing this popover must
// not unsubscribe another dashboard that is still visible.
export function useNotificationBriefs(closing: boolean) {
  useEffect(() => closing ? undefined : connectLiveBriefStore(), [closing]);
}

const contentStyle: CSSProperties = {
  minWidth: 0, padding: "0 12px 12px", fontSize: 12, overflowWrap: "anywhere",
};
const fieldStyle: CSSProperties = { border: 0, margin: 0, padding: 0, minWidth: 0 };
// The backend deliberately excludes lastSuccessfulReadAt-only changes from
// update events. Its health is authoritative; cached timestamp age is not.
function fresh(brief: LiveSessionBrief | undefined): brief is LiveSessionBrief {
  return Boolean(brief && brief.telemetryHealth === "live" && brief.operationalState === "needsHuman"
    && brief.lastSuccessfulReadAt !== null);
}

function ignoreKey(event: KeyboardEvent) {
  return event.nativeEvent.isComposing || event.keyCode === 229 || event.repeat
    || event.altKey || event.ctrlKey || event.metaKey;
}

function isFreeInput(option: AskOption) {
  return option.role === "typeSomething" || option.role === "chatAbout"
    || strings.freeInputLabels.includes(option.label.trim());
}

interface Props {
  sessionId: string;
  label: string;
  onOpen: () => void;
  onBusyChange: (busy: boolean) => void;
  active?: boolean;
}

export function NotificationAnswer(props: Props) {
  const ask = useAskQuestionStore((s) => s.bySession[props.sessionId]);
  const attention = useSessionAttentionStore((s) => s.attentionBySession[props.sessionId]);
  const brief = useLiveBriefStore((s) => s.briefsBySession[props.sessionId]);
  const isAsk = attention?.kind === "input" && hasAskQuestionScreen(props.sessionId);
  const owner = `${attention?.attentionId}:${attention?.kind}:${attention?.sessionEpoch}`;
  const lastOwner = useRef(owner);
  const lastAskIdentity = useRef<string | null>(null);
  if (lastOwner.current !== owner) {
    lastAskIdentity.current = null;
    lastOwner.current = owner;
  }
  if (isAsk && ask?.screen) lastAskIdentity.current = `ask:${ask.revision}:${screenContentKey(ask.screen)}`;
  const identity = lastAskIdentity.current ?? (brief ? `brief:${targetKey(brief)}:${brief.serviceEpoch}:${brief.promptEventId}:${brief.promptHash}` : "missing");
  const container = useRef<HTMLDivElement>(null);
  const hadFocus = useRef(false);
  useLayoutEffect(() => {
    if (hadFocus.current && document.activeElement === document.body && !container.current?.closest("[hidden]")) {
      container.current?.querySelector<HTMLElement>("[data-notification-answer]")?.focus();
    }
  }, [identity]);
  return <div ref={container}
    onFocusCapture={() => { hadFocus.current = true; }}
    onBlurCapture={(event) => {
      if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) hadFocus.current = false;
    }}>
    <AnswerBody key={`${props.sessionId}:${owner}:${identity}`} {...props}
      isAsk={isAsk} isAskFlow={lastAskIdentity.current !== null} brief={brief} />
  </div>;
}

function AnswerBody({ sessionId, label, onOpen, onBusyChange, active = true, isAsk, isAskFlow, brief }: Props & {
  isAsk: boolean;
  isAskFlow: boolean;
  brief: LiveSessionBrief | undefined;
}) {
  const ask = useAskQuestionStore((s) => s.bySession[sessionId]);
  const screen = isAsk ? ask?.screen : null;
  const [status, setStatus] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [retryable, setRetryable] = useState(false);
  const locked = useRef(false);
  const busy = sending || Boolean(isAskFlow && ask?.inFlight);
  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);

  const canApprove = !isAskFlow && !screen && fresh(brief)
    && (brief.pendingInputKind === "permission" || brief.pendingInputKind === "yesNo" || brief.pendingInputKind === "choice")
    && brief.pendingOptions.length > 0 && Boolean(brief.promptEventId && brief.promptHash);
  const stopped = !retryable && (Boolean(status) || Boolean(isAskFlow && ask?.stopReason && ask.stopReason !== "needs_confirmation"));
  const disabled = busy || stopped;
  const freeOptions = screen?.options.filter((option) => option.role === "typeSomething" || option.role === "chatAbout") ?? [];

  async function runAsk(operation: () => Promise<AskSubmitResult>) {
    if (locked.current || disabled || getAskQuestionSession(sessionId).inFlight) return;
    locked.current = true;
    setSending(true);
    setRetryable(false);
    try {
      const result = await operation();
      if (!result.ok && result.keysSent.length === 0) {
        locked.current = false;
        setRetryable(true);
      }
      if (result.ok) setStatus(strings.sent);
      else if (result.stopReason !== "needs_confirmation") {
        const message = result.stopReason ? dashboardStrings.askQuestionStopReason(result.stopReason) : strings.unconfirmed;
        setStatus(result.detail ? `${message} (${result.detail})` : message);
      }
    } catch {
      setStatus(strings.unconfirmed);
    } finally {
      setSending(false);
      // Attempts that wrote keys stay sealed until the prompt identity changes.
    }
  }

  function choose(index: number) {
    if (!screen || locked.current || disabled || getAskQuestionSession(sessionId).inFlight) return;
    const option = screen.options.find((item) => item.index === index);
    if (!option) return;
    if (isFreeInput(option)) { onOpen(); return; }
    if (screen.kind === "review") {
      if (index === 1 && option.role === "submit") void runAsk(() => submitAskQuestionReview(sessionId));
    } else if (option.role === "option") {
      if (screen.multiSelect) toggleAskQuestionDraft(sessionId, index);
      else void runAsk(() => submitAskQuestionChoice(sessionId, index));
    }
  }

  async function approve(optionId: string) {
    if (locked.current || disabled || !canApprove || !fresh(brief)) return;
    const expectation = freezeExpectation(brief);
    if (!expectation) return;
    locked.current = true;
    setSending(true);
    try {
      const result = await sendIntervention(expectation, { type: "choose", optionId });
      setStatus(result.type === "conflict" ? strings.changed
        : result.type === "confirmed" || result.type === "writtenAwaitingEvidence" ? strings.sent : strings.unconfirmed);
    } catch {
      setStatus(strings.unconfirmed);
    } finally {
      setSending(false);
    }
  }

  return <div data-notification-answer tabIndex={-1} style={contentStyle}
    onKeyDown={(event) => {
      if (ignoreKey(event)) {
        if (/^[1-9]$/.test(event.key) || event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      if (/^[1-9]$/.test(event.key)) {
        event.preventDefault(); event.stopPropagation();
        if (screen) choose(Number(event.key));
        else {
          const option = canApprove ? brief.pendingOptions[Number(event.key) - 1] : undefined;
          if (option) void approve(option.id);
        }
      } else if (event.key === "Enter" && screen?.multiSelect
        && !(event.target as HTMLElement).closest("[data-notification-open]")) {
        event.preventDefault(); event.stopPropagation();
        void runAsk(() => submitAskQuestionMultiSelect(sessionId));
      }
    }}>
    <fieldset disabled={disabled} style={fieldStyle} aria-busy={busy}>
      {screen ? <>
        {active && <QuestionCard compact sessionId={sessionId} brief={undefined} events={undefined}
          targetLabel={label} onFocusComposer={onOpen} onChooseOption={choose} />}
        {screen.multiSelect && screen.options.some((option) => option.role === "submit" && option.index === null) ? (
          <button type="button" className="cmux-dashboard-qcard-option"
            onClick={() => void runAsk(() => submitAskQuestionMultiSelect(sessionId))}>{strings.submit}</button>
        ) : null}
        {freeOptions.map((option) => <button key={option.index ?? option.role} type="button"
          data-notification-open data-notification-option={option.index} className="cmux-dashboard-qcard-other"
          style={{ maxWidth: "100%", overflowWrap: "anywhere" }} onClick={onOpen}>
          {option.index ? `${option.index}. ` : ""}{option.label} — {strings.answer}
        </button>)}
      </> : canApprove ? (
        <div className="cmux-dashboard-qcard is-compact">
          <div className="cmux-dashboard-qcard-prompt">{brief.pendingPrompt}</div>
          <div className="cmux-dashboard-qcard-options">
            {brief.pendingOptions.map((option, index) => <button key={option.id} type="button"
              data-notification-option={index + 1} className="cmux-dashboard-qcard-option" style={{ maxWidth: "100%", overflowWrap: "anywhere" }}
              onClick={() => void approve(option.id)}><span>{index + 1}</span><span>{option.label}</span></button>)}
          </div>
        </div>
      ) : null}
    </fieldset>
    {screen ? <div style={{ fontSize: 11, marginTop: 6 }}>{strings.freeInput}</div> : null}
    <div role="status" aria-live="polite" style={{ fontSize: 11, marginTop: 6 }}>
      {busy ? strings.sending : status ?? (!screen && isAskFlow && ask?.stopReason ? dashboardStrings.askQuestionStopReason(ask.stopReason) : null)}
    </div>
    <button type="button" data-notification-open className="cmux-dashboard-qcard-other"
      disabled={busy} style={{ marginTop: 6, fontSize: 11 }} onClick={onOpen}>
      {screen || canApprove ? strings.open : strings.answer}
    </button>
    {screen ? <button type="button" data-notification-open className="cmux-dashboard-qcard-other"
      disabled={busy} style={{ marginTop: 6, fontSize: 11 }} onClick={onOpen}>{strings.answer}</button> : null}
  </div>;
}
