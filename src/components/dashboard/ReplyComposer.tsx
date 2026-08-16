import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, RefObject } from "react";

import { handleSocketCommand } from "../layout/socketCommands";
import { useLiveBriefStore } from "../../stores/liveBriefStore";
import { useComposerStore, type ComposerCommandKind } from "../../stores/composerStore";
import { usePaneDragStore } from "../../stores/paneDragStore";
import { useReportInboxStore, type ReportDispatchDelivery } from "../../stores/reportInboxStore";
import { createBatch, sealBatch, type DispatchBatch as SealedDispatchBatch } from "../../lib/dispatchBatch";
import { buildComposerPayload, resolveComposerTarget } from "../../lib/composerSend";
import type { DashboardCardModel } from "./dashboardModel";
import { resolveDisplayState } from "./dashboardModel";
import { stateLabels } from "./stateLabels";
import {
  buildMentionCandidates,
  describeMentionToken,
  filterMentionCandidates,
  findMentionQuery,
  mentionTokenFromCandidate,
  removeMentionQuery,
  resolveMentionRecipients,
  resolveSealedMentionRecipients,
  type MentionMenuCandidate,
  type MentionRecipient,
  type MentionToken,
} from "../../lib/mentionModel";
import { dashboardStrings } from "./dashboardStrings";
import {
  interventionResultText,
  isInterventionAccepted,
  isInterventionConflict,
  resolveComposerRoute,
  runIntervention,
} from "./interventionRouting";
import { NextActionSuggestions, type NextAction } from "./NextActionSuggestions";

/** pane.send_text (送達確認つき送信) の戻り。確認できたときだけ confirmed が true。 */
interface PaneSendTextOutcome {
  confirmed?: boolean;
  reason?: string;
}

interface ComposerNote {
  text: string;
  error: boolean;
}

type DeliveryState = ReportDispatchDelivery["state"];
type DispatchDelivery = ReportDispatchDelivery & { recipient: MentionRecipient };

interface ComposerDispatchBatch {
  batchId: string;
  /** Canonical membership/receipt contract; it is sealed before the first write. */
  sealedBatch: SealedDispatchBatch;
  commandKind: ComposerCommandKind;
  text: string;
  /** Membership is sealed at GO. Retry never expands @動いてる全員 again. */
  members: MentionRecipient[];
  deliveries: Record<string, DispatchDelivery>;
}

let nextBatchSequence = 1;
const EMPTY_MENTION_TOKENS: MentionToken[] = [];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function memberKey(member: MentionRecipient): string {
  return `${member.logicalSessionId}:${member.sessionId}`;
}

function deliveryLabel(state: DeliveryState): string {
  if (state === "pending") return dashboardStrings.dispatchPending;
  if (state === "confirmed") return dashboardStrings.dispatchConfirmed;
  if (state === "unconfirmed") return dashboardStrings.dispatchUnconfirmed;
  if (state === "blocked") return dashboardStrings.dispatchBlocked;
  return dashboardStrings.dispatchFailed;
}

function dashboardSendBody(card: DashboardCardModel, text: string): string {
  const commandArgv = card.tab.commandArgv;
  const target = resolveComposerTarget({
    command: commandArgv?.[0] ?? card.tab.lastProcess ?? card.pane.lastProcess ?? "",
    args: commandArgv?.slice(1),
    agentId: card.tab.agentId ?? card.pane.agentId,
    agentKind: card.tab.agentKind ?? card.pane.agentKind,
    launchEnv: card.tab.launchEnv ?? card.pane.launchEnv,
  });
  return buildComposerPayload({ text, target }).body;
}

function unconfirmedSendText(reason: string | undefined): string {
  if (reason === "target_unmounted") return dashboardStrings.sendUnverifiedTargetUnmounted;
  if (reason === "submit_unconfirmed") return dashboardStrings.sendSubmitUnconfirmed;
  return dashboardStrings.sendUnverified;
}

/**
 * Dashboard command composer. Direct reply remains exactly one selected session;
 * one or more structured @ nodes switch the route into a sealed batch.
 */
export function ReplyComposer({ card, inputRef, mentionTargets, questionActive = false }: {
  card: DashboardCardModel | null;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  /** Always all workspace cards, never a search-filtered subset. */
  mentionTargets: readonly DashboardCardModel[];
  /** QuestionCard owns active questions, so suggestions never duplicate it. */
  questionActive?: boolean;
}) {
  const sessionId = card?.tab.sessionId ?? null;
  const brief = useLiveBriefStore((state) => (sessionId ? state.briefsBySession[sessionId] : undefined));
  const draft = useComposerStore((state) => (sessionId ? state.draftBySession[sessionId] ?? "" : ""));
  const storedTokens = useComposerStore((state) => (sessionId ? state.mentionTokensBySession[sessionId] : undefined));
  const tokens = storedTokens ?? EMPTY_MENTION_TOKENS;
  const commandKind = useComposerStore((state) => (sessionId ? state.commandKindBySession[sessionId] ?? "plain" : "plain"));
  const questionGuard = useComposerStore((state) => (sessionId ? state.questionGuardBySession[sessionId] : undefined));
  const setDraft = useComposerStore((state) => state.setDraft);
  const clearDraft = useComposerStore((state) => state.clearDraft);
  const addMentionToken = useComposerStore((state) => state.addMentionToken);
  const removeMentionToken = useComposerStore((state) => state.removeMentionToken);
  const clearMentionTokens = useComposerStore((state) => state.clearMentionTokens);
  const setCommandKind = useComposerStore((state) => state.setCommandKind);
  const setQuestionGuard = useComposerStore((state) => state.setQuestionGuard);
  const dashboardRetryRequest = useComposerStore((state) => (sessionId ? state.dashboardRetryBySession[sessionId] : undefined));
  const dashboardRetryMessage = useComposerStore((state) => {
    if (!sessionId) return undefined;
    const request = state.dashboardRetryBySession[sessionId];
    return request ? state.dashboardOptimisticMessagesBySession[sessionId]?.find((message) => message.id === request.messageId) : undefined;
  });
  const addDashboardOptimisticMessage = useComposerStore((state) => state.addDashboardOptimisticMessage);
  const setDashboardOptimisticMessageState = useComposerStore((state) => state.setDashboardOptimisticMessageState);
  const consumeDashboardOptimisticRetry = useComposerStore((state) => state.consumeDashboardOptimisticRetry);
  const rootRef = useRef<HTMLDivElement>(null);
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<ComposerNote | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuQuery, setMenuQuery] = useState("");
  const [mentionRange, setMentionRange] = useState<{ start: number; end: number } | null>(null);
  const [activeMenuIndex, setActiveMenuIndex] = useState(0);
  const [batch, setBatch] = useState<ComposerDispatchBatch | null>(null);
  const dragItem = usePaneDragStore((state) => state.item);
  const dragPointer = usePaneDragStore((state) => state.pointer);
  const [dropOver, setDropOver] = useState(false);

  const mentionCandidates = useMemo(() => buildMentionCandidates(mentionTargets.map((target) => {
    const displayState = resolveDisplayState(target);
    return {
      logicalSessionId: target.tab.id,
      sessionId: target.tab.sessionId,
      label: target.label,
      workspaceName: target.workspace.name,
      statusLabel: stateLabels(displayState).tooltip,
      isWorking: stateLabels(displayState).activity === "working",
    };
  })), [mentionTargets]);
  const menuCandidates = useMemo(() => filterMentionCandidates(mentionCandidates, menuQuery), [mentionCandidates, menuQuery]);
  const tokenDescriptions = useMemo(() => tokens.map((token) => ({ token, ...describeMentionToken(token, mentionCandidates) })), [mentionCandidates, tokens]);
  const preview = useMemo(() => resolveMentionRecipients(tokens, mentionCandidates), [mentionCandidates, tokens]);
  const cardByMember = useMemo(() => {
    const result = new Map<string, DashboardCardModel>();
    for (const target of mentionTargets) result.set(`${target.tab.id}:${target.tab.sessionId}`, target);
    return result;
  }, [mentionTargets]);

  // 前のセッションの結果を次のセッションの欄に残さない。
  useEffect(() => {
    setNote(null);
    setBatch(null);
    setMenuOpen(false);
  }, [sessionId]);

  const route = card ? resolveComposerRoute(brief, !card.neverStarted) : null;
  const hasMentions = tokens.length > 0;
  // A mention batch does not depend on the selected card being sendable.
  const blocked = !sessionId || (!hasMentions && (!card || !route || route.kind === "disabled"));
  const disabledNote = !hasMentions && route?.kind === "disabled" ? dashboardStrings.composerNotStarted : null;
  const canSubmit = !blocked && !sending && Boolean(draft.trim());

  const hasCurrentQuestionGuard = () => commandKind !== "answer-forward" || Boolean(
    questionGuard
    && brief?.promptEventId === questionGuard.questionId
    && brief.ptyInputRevision === questionGuard.revision,
  );

  useEffect(() => {
    if (!dragItem || dragItem.kind !== "tab" || dragItem.surface !== "minimap" || !dragPointer || !rootRef.current) {
      setDropOver(false);
      return;
    }
    const rect = rootRef.current.getBoundingClientRect();
    setDropOver(
      dragPointer.x >= rect.left
      && dragPointer.x <= rect.right
      && dragPointer.y >= rect.top
      && dragPointer.y <= rect.bottom,
    );
  }, [dragItem, dragPointer]);

  const closeMenu = () => {
    setMenuOpen(false);
    setMentionRange(null);
    setActiveMenuIndex(0);
  };

  const addToken = (token: MentionToken) => {
    if (!sessionId) return;
    addMentionToken(sessionId, token);
    inputRef.current?.focus();
  };

  const selectMenuCandidate = (candidate: MentionMenuCandidate) => {
    if (!sessionId) return;
    const range = mentionRange ?? findMentionQuery(draft, inputRef.current?.selectionStart ?? draft.length);
    if (range) {
      const replacement = removeMentionQuery(draft, range);
      setDraft(sessionId, replacement.text);
      queueMicrotask(() => {
        if (inputRef.current) inputRef.current.setSelectionRange(replacement.cursor, replacement.cursor);
      });
    }
    addToken(mentionTokenFromCandidate(candidate));
    closeMenu();
  };

  const updateBatchDelivery = (batchId: string, member: MentionRecipient, update: Omit<DispatchDelivery, "recipient">) => {
    const key = memberKey(member);
    useReportInboxStore.getState().updateDispatchDelivery(batchId, member.sessionId, update);
    setBatch((current) => {
      if (!current || current.batchId !== batchId || !current.deliveries[key]) return current;
      return {
        ...current,
        deliveries: { ...current.deliveries, [key]: { recipient: member, ...update } },
      };
    });
  };

  const sendRecipient = async (recipient: MentionRecipient, text: string): Promise<Omit<DispatchDelivery, "recipient">> => {
    const target = cardByMember.get(memberKey(recipient));
    if (!target) return { state: "blocked", detail: dashboardStrings.dispatchTargetMissing };
    const targetRoute = resolveComposerRoute(target.brief, !target.neverStarted);
    if (targetRoute.kind === "disabled") return { state: "failed", detail: dashboardStrings.composerNotStarted };
    try {
      if (targetRoute.kind === "intervention") {
        const result = await runIntervention(target.brief, { type: "replyText", text });
        if (result.type === "confirmed") return { state: "confirmed", detail: interventionResultText(result) };
        // The native writer can have accepted bytes without visible evidence.
        if (result.type === "writtenAwaitingEvidence" || result.type === "writtenUnconfirmed" || result.type === "indeterminatePartial") {
          return { state: "unconfirmed", detail: interventionResultText(result) };
        }
        // A stale question must be consciously re-authored, never retried into a new revision.
        if (result.type === "conflict") return { state: "blocked", detail: interventionResultText(result) };
        return { state: "failed", detail: interventionResultText(result) };
      }
      const body = dashboardSendBody(target, text);
      const outcome = await handleSocketCommand("pane.send_text", {
        sessionId: recipient.sessionId,
        text: body,
        enter: true,
      }) as PaneSendTextOutcome | null;
      if (outcome?.confirmed === true) return { state: "confirmed", detail: dashboardStrings.sendConfirmedOnScreen };
      return {
        state: "unconfirmed",
        detail: unconfirmedSendText(outcome?.reason),
      };
    } catch (error) {
      return { state: "failed", detail: `${dashboardStrings.sendFailedBeforeWrite} (${errorText(error)})` };
    }
  };

  const deliverBatchMembers = async (currentBatch: ComposerDispatchBatch, requested: readonly MentionRecipient[]) => {
    const resolution = resolveSealedMentionRecipients(requested, mentionCandidates);
    const resolvedKeys = new Set(resolution.recipients.map(memberKey));
    for (const member of requested) {
      if (!resolvedKeys.has(memberKey(member))) {
        updateBatchDelivery(currentBatch.batchId, member, { state: "blocked", detail: dashboardStrings.dispatchTargetMissing });
      }
    }
    await Promise.all(resolution.recipients.map(async (recipient) => {
      updateBatchDelivery(currentBatch.batchId, recipient, { state: "pending", detail: dashboardStrings.dispatchPending });
      const result = await sendRecipient(recipient, currentBatch.text);
      updateBatchDelivery(currentBatch.batchId, recipient, result);
    }));
  };

  const submitDirect = async (text = draft, clearDraftAfterSend = true, optimisticMessageId?: string) => {
    if (!card || !sessionId || !route || route.kind === "disabled") {
      if (sessionId && optimisticMessageId) setDashboardOptimisticMessageState(sessionId, optimisticMessageId, "failed", dashboardStrings.dispatchTargetMissing);
      return;
    }
    if (route.kind === "intervention") {
      if (optimisticMessageId) {
        setDashboardOptimisticMessageState(sessionId, optimisticMessageId, "failed", dashboardStrings.composerRetryRouteChanged);
        return;
      }
      const result = await runIntervention(brief, { type: "replyText", text });
      setNote({ text: interventionResultText(result), error: isInterventionConflict(result) });
      // conflict / busy / 未確認では下書きを消さない (自動再送もしない)。
      if (isInterventionAccepted(result) && clearDraftAfterSend) {
        clearDraft(sessionId);
        setCommandKind(sessionId, "plain");
        setQuestionGuard(sessionId, null);
      }
      return;
    }
    const messageId = optimisticMessageId ?? addDashboardOptimisticMessage(sessionId, text);
    // The visual receipt and cleared editor happen before waiting for the PTY
    // acknowledgement, which is the slow part of this path.
    if (clearDraftAfterSend) clearDraft(sessionId);
    try {
      const body = dashboardSendBody(card, text);
      const outcome = await handleSocketCommand("pane.send_text", {
        sessionId,
        text: body,
        enter: true,
      }) as PaneSendTextOutcome | null;
      const confirmed = outcome?.confirmed === true;
      const reason = outcome?.reason;
      setNote({
        text: confirmed
          ? dashboardStrings.sendConfirmedOnScreen
          : unconfirmedSendText(reason),
        error: false,
      });
      setDashboardOptimisticMessageState(sessionId, messageId, "sent");
    } catch (error) {
      // handleSocketCommand が throw したときは書き込み自体が走っていない。
      const detail = `${dashboardStrings.sendFailedBeforeWrite} (${errorText(error)})`;
      setNote({ text: detail, error: true });
      setDashboardOptimisticMessageState(sessionId, messageId, "failed", detail);
    }
  };

  useEffect(() => {
    if (!sessionId || !dashboardRetryRequest) return;
    consumeDashboardOptimisticRetry(sessionId, dashboardRetryRequest.requestId);
    if (!dashboardRetryMessage) return;
    setSending(true);
    void submitDirect(dashboardRetryMessage.text, true, dashboardRetryMessage.id).finally(() => setSending(false));
  }, [consumeDashboardOptimisticRetry, dashboardRetryMessage, dashboardRetryRequest, sessionId, submitDirect]);

  const submit = async () => {
    if (!sessionId || sending || !draft.trim()) return;
    if (!hasCurrentQuestionGuard()) {
      setNote({ text: dashboardStrings.questionGuardConflict, error: true });
      return;
    }
    if (!hasMentions) {
      if (blocked) return;
      setSending(true);
      try {
        await submitDirect();
      } finally {
        setSending(false);
      }
      return;
    }

    const resolution = resolveMentionRecipients(tokens, mentionCandidates);
    if (resolution.missing.length || !resolution.recipients.length) {
      setNote({ text: dashboardStrings.dispatchInvalidTargets, error: true });
      return;
    }
    const members = resolution.recipients;
    const batchId = `mention-batch-${Date.now()}-${nextBatchSequence++}`;
    const deliveries = Object.fromEntries(members.map((recipient) => [memberKey(recipient), {
      recipient,
      state: "pending" as const,
      detail: dashboardStrings.dispatchPending,
    }])) as Record<string, DispatchDelivery>;
    const sealedBatch = sealBatch(createBatch(members.map((recipient) => ({
      logicalSessionId: recipient.logicalSessionId,
      instructionRef: recipient.sessionId,
      label: recipient.label,
    })), { batchId }));
    const currentBatch: ComposerDispatchBatch = {
      batchId,
      sealedBatch,
      commandKind,
      text: draft,
      members,
      deliveries,
    };
    useReportInboxStore.getState().registerSealedDispatchBatch({
      batch: sealedBatch,
      commandKind,
      members: members.map((recipient) => ({
        logicalSessionId: recipient.logicalSessionId,
        ptySessionId: recipient.sessionId,
        label: recipient.label,
        delivery: deliveries[memberKey(recipient)],
      })),
    });
    setNote(null);
    setBatch(currentBatch);
    setSending(true);
    try {
      await deliverBatchMembers(currentBatch, members);
      // A batch snapshot owns retries. Once one destination was actually attempted,
      // do not leave a second fresh GO path in the editor.
      clearDraft(sessionId);
      clearMentionTokens(sessionId);
      setCommandKind(sessionId, "plain");
      setQuestionGuard(sessionId, null);
    } finally {
      setSending(false);
    }
  };

  const submitSuggestion = async (action: NextAction): Promise<void> => {
    if (!card || !sessionId || sending || !route || route.kind === "disabled") return;
    setSending(true);
    setCommandKind(sessionId, "continue");
    setQuestionGuard(sessionId, null);
    try {
      // Keep the regular draft intact: a confirmed suggestion uses the very
      // same direct/intervention route without overwriting typed work.
      await submitDirect(action.prompt, false);
    } finally {
      setCommandKind(sessionId, "plain");
      setSending(false);
    }
  };

  const retryFailed = async () => {
    if (!batch || sending) return;
    const retryable = batch.members.filter((member) => batch.deliveries[memberKey(member)]?.state === "failed");
    if (!retryable.length) return;
    setSending(true);
    try {
      await deliverBatchMembers(batch, retryable);
    } finally {
      setSending(false);
    }
  };

  // The drag core retains pointer capture on minimap chips. A capture-phase
  // window listener is therefore the composer-only drop receiver; it neither
  // changes drag targets nor consumes the event, so layout D&D remains intact.
  useEffect(() => {
    const receiveMinimapDrop = (event: PointerEvent) => {
      if (!sessionId) return;
      const item = usePaneDragStore.getState().item;
      if (!item || item.surface !== "minimap") return;
      // 束ドラッグ (M1) でも @ を刺せること。選択が1件でも束として飛んでくる。
      const droppedTabIds = item.kind === "tab" ? [item.tabId] : item.kind === "tab-bundle" ? item.tabIds : [];
      if (!droppedTabIds.length) return;
      const root = rootRef.current;
      const target = document.elementFromPoint(event.clientX, event.clientY);
      if (!root || !target || !root.contains(target)) return;
      for (const tabId of droppedTabIds) {
        const candidate = mentionCandidates.find((entry) => entry.kind === "session" && entry.logicalSessionId === tabId);
        if (candidate && candidate.kind === "session") addMentionToken(sessionId, mentionTokenFromCandidate(candidate));
      }
    };
    window.addEventListener("pointerup", receiveMinimapDrop, true);
    return () => window.removeEventListener("pointerup", receiveMinimapDrop, true);
  }, [addMentionToken, mentionCandidates, sessionId]);

  const onInputChange = (value: string, cursor: number) => {
    if (!sessionId) return;
    setDraft(sessionId, value);
    const next = findMentionQuery(value, cursor);
    if (!next) {
      closeMenu();
      return;
    }
    setMentionRange({ start: next.start, end: next.end });
    setMenuQuery(next.query);
    setMenuOpen(true);
    setActiveMenuIndex(0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (menuOpen) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (menuCandidates.length) {
          event.preventDefault();
          const delta = event.key === "ArrowDown" ? 1 : -1;
          setActiveMenuIndex((index) => (index + delta + menuCandidates.length) % menuCandidates.length);
        }
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const candidate = menuCandidates[activeMenuIndex];
        if (candidate) {
          event.preventDefault();
          selectMenuCandidate(candidate);
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu();
        return;
      }
    }
    if (event.key === "Backspace" && event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === 0 && tokens.length && sessionId) {
      event.preventDefault();
      removeMentionToken(sessionId, tokens[tokens.length - 1]);
      return;
    }
    if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
    event.preventDefault();
    void submit();
  };

  const noteText = disabledNote ?? note?.text ?? null;
  const noteIsError = disabledNote ? false : Boolean(note?.error);
  const invalidPreview = preview.missing.length > 0 || (hasMentions && preview.recipients.length === 0);
  const retryCount = batch?.members.filter((member) => batch.deliveries[memberKey(member)]?.state === "failed").length ?? 0;

  return <div
    ref={rootRef}
    data-livebrief-interactive="true"
    data-composer-pane-drop-target="true"
    data-command-kind={commandKind}
    className={`cmux-dashboard-composer${dropOver ? " is-mention-drop-over" : ""}`}
  >
    <NextActionSuggestions
      sessionId={sessionId}
      displayState={card ? resolveDisplayState(card) : "idle"}
      questionActive={questionActive}
      sending={sending}
      onConfirm={submitSuggestion}
    />
    {tokens.length ? <div className="cmux-dashboard-mention-tokens" aria-label={dashboardStrings.mentionTokensAriaLabel}>
      {!invalidPreview ? <span className="cmux-dashboard-dispatch-preview">{dashboardStrings.dispatchPreview(preview.recipients.length)}:</span> : null}
      {tokenDescriptions.map(({ token, label, valid, statusLabel }) => <span key={`${token.kind}:${token.kind === "session" ? token.logicalSessionId : token.labelSnapshot}`} className={`cmux-dashboard-mention-token${valid ? "" : " is-invalid"}`} title={valid ? statusLabel ?? undefined : dashboardStrings.dispatchTargetMissing}>
        <span>@{label}</span>
        {statusLabel ? <small>{statusLabel}</small> : null}
        <button type="button" aria-label={dashboardStrings.removeMention(label)} onClick={() => { if (sessionId) removeMentionToken(sessionId, token); }}>×</button>
      </span>)}
    </div> : null}
    {hasMentions && invalidPreview ? <div className="cmux-dashboard-dispatch-preview is-error">{dashboardStrings.dispatchInvalidTargets}</div> : null}
    <div className="cmux-dashboard-composer-row">
      <textarea
        ref={inputRef}
        rows={1}
        value={draft}
        disabled={blocked || sending}
        aria-label={dashboardStrings.composerAriaLabel}
        placeholder={dashboardStrings.composerPlaceholder}
        onChange={(event) => onInputChange(event.target.value, event.target.selectionStart ?? event.target.value.length)}
        onKeyDown={onKeyDown}
        className="cmux-dashboard-composer-input"
      />
      <button
        type="button"
        disabled={!canSubmit}
        className="cmux-dashboard-composer-send"
        style={{ opacity: canSubmit ? 1 : 0.55 }}
        onClick={() => void submit()}
      >{dashboardStrings.composerSend}</button>
    </div>
    {menuOpen ? <div className="cmux-dashboard-mention-menu" role="listbox" aria-label={dashboardStrings.mentionMenuAriaLabel}>
      {menuCandidates.length ? menuCandidates.map((candidate, index) => <button
        key={candidate.kind === "working-all" ? candidate.kind : candidate.logicalSessionId}
        type="button"
        role="option"
        aria-selected={index === activeMenuIndex}
        className={index === activeMenuIndex ? "is-active" : ""}
        onPointerDown={(event: ReactPointerEvent<HTMLButtonElement>) => { event.preventDefault(); selectMenuCandidate(candidate); }}
      >
        <span>@{candidate.label}</span>
        <small>{candidate.kind === "working-all" ? candidate.statusLabel : `${candidate.workspaceName} · ${candidate.statusLabel}`}</small>
      </button>) : <div className="cmux-dashboard-mention-menu-empty">{dashboardStrings.mentionNoMatches}</div>}
    </div> : null}
    {tokens.length ? <div className="cmux-dashboard-status-templates" aria-label={dashboardStrings.statusTemplatesAriaLabel}>
      <button type="button" disabled={!sessionId || sending} onClick={() => { if (sessionId) { setDraft(sessionId, dashboardStrings.statusTemplateWhat); setCommandKind(sessionId, "status-request"); } }}>{dashboardStrings.statusTemplateWhat}</button>
      <button type="button" disabled={!sessionId || sending} onClick={() => { if (sessionId) { setDraft(sessionId, dashboardStrings.statusTemplateGoal); setCommandKind(sessionId, "status-request"); } }}>{dashboardStrings.statusTemplateGoal}</button>
    </div> : null}
    {batch ? <div className="cmux-dashboard-dispatch-results" aria-label={dashboardStrings.dispatchResultsAriaLabel}>
      <div className="cmux-dashboard-dispatch-results-head"><strong>{dashboardStrings.dispatchResults(batch.members.length)}</strong><span>{dashboardStrings.dispatchMode(batch.commandKind)}</span></div>
      {batch.members.map((member) => {
        const delivery = batch.deliveries[memberKey(member)];
        const current = mentionCandidates.find((candidate) => candidate.kind === "session" && candidate.logicalSessionId === member.logicalSessionId && candidate.sessionId === member.sessionId);
        return <div key={memberKey(member)} className={`cmux-dashboard-dispatch-result is-${delivery.state}`}>
          <span aria-hidden="true">{delivery.state === "confirmed" ? "✓" : delivery.state === "pending" ? "…" : delivery.state === "unconfirmed" ? "?" : "✗"}</span>
          <span>@{current && current.kind === "session" ? current.label : member.label}</span>
          <small>{deliveryLabel(delivery.state)} — {delivery.detail}</small>
        </div>;
      })}
      {retryCount ? <button type="button" disabled={sending} onClick={() => void retryFailed()}>{dashboardStrings.dispatchRetryFailed(retryCount)}</button> : null}
    </div> : null}
    {noteText
      ? <div role={noteIsError ? "alert" : "status"} aria-live={noteIsError ? "assertive" : "polite"} className={`cmux-dashboard-composer-note${noteIsError ? " is-error" : ""}`}>{noteText}</div>
      : null}
  </div>;
}
