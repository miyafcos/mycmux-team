import { useEffect, useLayoutEffect, type RefObject } from "react";
import { useComposerStore, type DashboardOptimisticMessage } from "../../stores/composerStore";
import type { LiveSessionBrief, SemanticEventEnvelope } from "../../lib/livebrief";
import type { SessionAttention } from "../../stores/sessionAttentionStore";
import type { DashboardCardModel } from "../dashboard/dashboardModel";
import { QuestionCard } from "../dashboard/QuestionCard";
import { ReplyComposer } from "../dashboard/ReplyComposer";
import { DashboardStatusMark } from "../dashboard/DashboardUi";
import { dashboardStrings } from "../dashboard/dashboardStrings";
import { agentTabStrings } from "./agentTabStrings";
import { questionModel } from "../dashboard/interventionRouting";
import { useAskQuestionStore } from "../../stores/askQuestionStore";
import { AgentTabLiveStrip } from "./AgentTabLiveStrip";

const EMPTY: readonly DashboardOptimisticMessage[] = [];
export function AgentTabOptimisticMessages({ sessionId, events, archiveEnabled }: {
  sessionId: string; events: readonly SemanticEventEnvelope[]; archiveEnabled: boolean;
}) {
  const messages = useComposerStore(s => s.dashboardOptimisticMessagesBySession[sessionId] ?? EMPTY);
  const collapse = useComposerStore(s => s.collapseDashboardOptimisticMessages);
  const retry = useComposerStore(s => s.requestDashboardOptimisticRetry);
  useEffect(() => {
    if (!archiveEnabled) collapse(sessionId, events.flatMap(event =>
      event.kind.type === "userMessage" ? [{ text: event.kind.text, occurredAt: event.occurredAt }] : []));
  }, [collapse, sessionId, events, archiveEnabled]);
  return messages.length ? <div className="cmux-dashboard-optimistic-messages" aria-live="polite">
    {messages.map(message => <div key={message.id} data-dashboard-optimistic-message={message.id} data-delivery-state={message.state}
      className={`cmux-dashboard-msg is-user is-optimistic is-${message.state}`}>
      <div className="cmux-dashboard-msg-who"><DashboardStatusMark
        state={message.state === "sent" && message.error ? "unknown" : message.state}
        label={message.state === "sending" ? dashboardStrings.composerMessageSending : message.state === "sent" ? message.error ? dashboardStrings.dispatchUnconfirmed : dashboardStrings.composerMessageSent : dashboardStrings.composerMessageFailed} /></div>
      <div className="cmux-dashboard-msg-plain">{message.text}</div>
      {message.state === "failed" ? <div className="cmux-dashboard-optimistic-retry"><span>{message.error ?? dashboardStrings.composerMessageFailed}</span>
        <button type="button" onClick={() => retry(sessionId, message.id)}>{dashboardStrings.composerRetry}</button></div> : null}
    </div>)}
  </div> : null;
}

export function AgentTabConversationControls({ sessionId, tabId, agentKind, live, brief, events, attention, card, cards, inputRef, active, onTerminal }: {
  sessionId: string; tabId: string | null; agentKind: string; live: boolean; brief?: LiveSessionBrief; events: readonly SemanticEventEnvelope[]; attention?: SessionAttention;
  card: DashboardCardModel | null; cards: readonly DashboardCardModel[]; inputRef: RefObject<HTMLTextAreaElement | null>; active: boolean; onTerminal: () => void;
}) {
  useLayoutEffect(() => {
    const input = inputRef.current;
    // When this optional chunk finishes loading, complete the panel's focus
    // request without taking focus from a search, question, or global dialog.
    if (active && input && !input.disabled && input.closest("[data-terminal-transcript-panel]") === document.activeElement) input.focus();
  }, [active, inputRef]);
  const ask = useAskQuestionStore(s => s.bySession[sessionId]);
  const model = questionModel(brief, events);
  const askHandled = Boolean(ask?.screen && (!attention || attention.kind === "input"));
  const ended = brief?.telemetryHealth === "ended";
  const needsInput = !ended && Boolean(brief?.pendingInputKind || brief?.pendingPrompt || attention?.kind === "input" || attention?.kind === "approval");
  const needsTerminal = needsInput && !(askHandled || model?.canSend);
  return <>
    <div className="agent-tab-conversation-question">
      {needsTerminal ? <button type="button" className="agent-tab-terminal-required" onClick={onTerminal}>{agentTabStrings.terminalRequired}</button> : null}
      {!ended ? <QuestionCard sessionId={sessionId} brief={brief} events={events} attention={attention}
        targetLabel={card?.label ?? agentTabStrings.conversation} onFocusComposer={() => inputRef.current?.focus()} /> : null}
    </div>
    <AgentTabLiveStrip sessionId={sessionId} tabId={tabId} agentKind={agentKind} live={live} needsInput={needsInput} />
    <ReplyComposer tabSessionId={sessionId} tabAgentKind={agentKind} onSlashCommandSent={onTerminal} card={card} inputRef={inputRef} mentionTargets={cards} questionActive={needsInput || askHandled} showSuggestions={false} />
  </>;
}
