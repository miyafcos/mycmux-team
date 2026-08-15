import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, RefObject } from "react";

import { handleSocketCommand } from "../layout/socketCommands";
import { useLiveBriefStore } from "../../stores/liveBriefStore";
import { useComposerStore, type ComposerCommandKind } from "../../stores/composerStore";
import { usePaneDragStore } from "../../stores/paneDragStore";
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

/** pane.send_text (送達確認つき送信) の戻り。確認できたときだけ confirmed が true。 */
interface PaneSendTextOutcome {
  confirmed?: boolean;
  reason?: string;
}

interface ComposerNote {
  text: string;
  error: boolean;
}

type DeliveryState = "pending" | "confirmed" | "unconfirmed" | "failed" | "blocked";

interface DispatchDelivery {
  recipient: MentionRecipient;
  state: DeliveryState;
  detail: string;
}

interface DispatchBatch {
  batchId: string;
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

/**
 * Dashboard command composer. Direct reply remains exactly one selected session;
 * one or more structured @ nodes switch the route into a sealed batch.
 */
export function ReplyComposer({ card, inputRef, mentionTargets }: {
  card: DashboardCardModel | null;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  /** Always all workspace cards, never a search-filtered subset. */
  mentionTargets: readonly DashboardCardModel[];
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
  const rootRef = useRef<HTMLDivElement>(null);
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<ComposerNote | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuQuery, setMenuQuery] = useState("");
  const [mentionRange, setMentionRange] = useState<{ start: number; end: number } | null>(null);
  const [activeMenuIndex, setActiveMenuIndex] = useState(0);
  const [batch, setBatch] = useState<DispatchBatch | null>(null);
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
      const outcome = await handleSocketCommand("pane.send_text", {
        sessionId: recipient.sessionId,
        text,
        enter: true,
      }) as PaneSendTextOutcome | null;
      if (outcome?.confirmed === true) return { state: "confirmed", detail: dashboardStrings.sendConfirmedOnScreen };
      return {
        state: "unconfirmed",
        detail: `${dashboardStrings.sendUnverified}${outcome?.reason ? ` (${outcome.reason})` : ""}`,
      };
    } catch (error) {
      return { state: "failed", detail: `${dashboardStrings.sendFailedBeforeWrite} (${errorText(error)})` };
    }
  };

  const deliverBatchMembers = async (currentBatch: DispatchBatch, requested: readonly MentionRecipient[]) => {
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

  const submitDirect = async () => {
    if (!card || !sessionId || !route || route.kind === "disabled") return;
    if (route.kind === "intervention") {
      const result = await runIntervention(brief, { type: "replyText", text: draft });
      setNote({ text: interventionResultText(result), error: isInterventionConflict(result) });
      // conflict / busy / 未確認では下書きを消さない (自動再送もしない)。
      if (isInterventionAccepted(result)) {
        clearDraft(sessionId);
        setCommandKind(sessionId, "plain");
        setQuestionGuard(sessionId, null);
      }
      return;
    }
    try {
      const outcome = await handleSocketCommand("pane.send_text", {
        sessionId,
        text: draft,
        enter: true,
      }) as PaneSendTextOutcome | null;
      const confirmed = outcome?.confirmed === true;
      const reason = outcome?.reason;
      setNote({
        text: confirmed
          ? dashboardStrings.sendConfirmedOnScreen
          : `${dashboardStrings.sendUnverified}${reason ? ` (${reason})` : ""}`,
        error: false,
      });
      // 端末へは書けているので下書きは残さない (再送は人間の判断で)。
      clearDraft(sessionId);
    } catch (error) {
      // handleSocketCommand が throw したときは書き込み自体が走っていない。
      setNote({ text: `${dashboardStrings.sendFailedBeforeWrite} (${errorText(error)})`, error: true });
    }
  };

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
    const currentBatch: DispatchBatch = {
      batchId,
      commandKind,
      text: draft,
      members,
      deliveries: Object.fromEntries(members.map((recipient) => [memberKey(recipient), {
        recipient,
        state: "pending" as const,
        detail: dashboardStrings.dispatchPending,
      }])),
    };
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
      if (!item || item.kind !== "tab" || item.surface !== "minimap") return;
      const root = rootRef.current;
      const target = document.elementFromPoint(event.clientX, event.clientY);
      if (!root || !target || !root.contains(target)) return;
      const candidate = mentionCandidates.find((entry) => entry.kind === "session" && entry.logicalSessionId === item.tabId);
      if (candidate && candidate.kind === "session") addMentionToken(sessionId, mentionTokenFromCandidate(candidate));
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
    if (event.key !== "Enter" || event.shiftKey) return;
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
      ? <div className={`cmux-dashboard-composer-note${noteIsError ? " is-error" : ""}`}>{noteText}</div>
      : null}
  </div>;
}
