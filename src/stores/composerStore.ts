import { create } from "zustand";
import { mentionTokenKey, type MentionToken } from "../lib/mentionModel";

export type ComposerCommandKind = "plain" | "status-request" | "answer-forward" | "continue";
export type DashboardOptimisticMessageState = "sending" | "sent" | "failed";

/**
 * A dashboard-only visual receipt. It intentionally lives next to the shared
 * draft rather than the transcript: the transcript is still the source of
 * truth and removes this receipt once it catches up.
 */
export interface DashboardOptimisticMessage {
  id: string;
  text: string;
  createdAt: number;
  state: DashboardOptimisticMessageState;
  error: string | null;
}

interface DashboardRetryRequest {
  messageId: string;
  requestId: number;
}

let nextDashboardOptimisticMessageId = 1;
let nextDashboardRetryRequestId = 1;

/** Captured only by the QuestionCard UI path; free text never creates one. */
export interface ComposerQuestionGuard {
  questionId: string;
  revision: number;
}

/**
 * Per-session composer drafts, shared by the pane composer and the dashboard's
 * reply box. Both write to the same pane, so one draft per session is the whole
 * point: text started in one place must not go missing when the other is used.
 *
 * Not persisted — a draft is a half-finished instruction to a running session,
 * and restoring it into a session that has moved on would be worse than losing it.
 */
interface ComposerState {
  draftBySession: Record<string, string>;
  /** Structured destination nodes. They are intentionally never serialized into draft text. */
  mentionTokensBySession: Record<string, MentionToken[]>;
  commandKindBySession: Record<string, ComposerCommandKind>;
  questionGuardBySession: Record<string, ComposerQuestionGuard | undefined>;
  dashboardOptimisticMessagesBySession: Record<string, DashboardOptimisticMessage[]>;
  dashboardRetryBySession: Record<string, DashboardRetryRequest | undefined>;
  setDraft: (sessionId: string, text: string) => void;
  clearDraft: (sessionId: string) => void;
  addMentionToken: (sessionId: string, token: MentionToken) => void;
  removeMentionToken: (sessionId: string, token: MentionToken) => void;
  clearMentionTokens: (sessionId: string) => void;
  setCommandKind: (sessionId: string, kind: ComposerCommandKind) => void;
  setQuestionGuard: (sessionId: string, guard: ComposerQuestionGuard | null) => void;
  addDashboardOptimisticMessage: (sessionId: string, text: string) => string;
  setDashboardOptimisticMessageState: (sessionId: string, messageId: string, state: DashboardOptimisticMessageState, error?: string | null) => void;
  collapseDashboardOptimisticMessages: (sessionId: string, transcriptMessages: readonly { text: string; occurredAt: number }[]) => void;
  requestDashboardOptimisticRetry: (sessionId: string, messageId: string) => void;
  consumeDashboardOptimisticRetry: (sessionId: string, requestId: number) => void;
}

export const useComposerStore = create<ComposerState>((set) => ({
  draftBySession: {},
  mentionTokensBySession: {},
  commandKindBySession: {},
  questionGuardBySession: {},
  dashboardOptimisticMessagesBySession: {},
  dashboardRetryBySession: {},
  setDraft: (sessionId, text) => set((state) => ({
    draftBySession: { ...state.draftBySession, [sessionId]: text },
  })),
  clearDraft: (sessionId) => set((state) => {
    if (!(sessionId in state.draftBySession)) return state;
    const draftBySession = { ...state.draftBySession };
    delete draftBySession[sessionId];
    return { draftBySession };
  }),
  addMentionToken: (sessionId, token) => set((state) => {
    const current = state.mentionTokensBySession[sessionId] ?? [];
    if (current.some((item) => mentionTokenKey(item) === mentionTokenKey(token))) return state;
    return { mentionTokensBySession: { ...state.mentionTokensBySession, [sessionId]: [...current, token] } };
  }),
  removeMentionToken: (sessionId, token) => set((state) => {
    const current = state.mentionTokensBySession[sessionId] ?? [];
    const next = current.filter((item) => mentionTokenKey(item) !== mentionTokenKey(token));
    if (next.length === current.length) return state;
    return { mentionTokensBySession: { ...state.mentionTokensBySession, [sessionId]: next } };
  }),
  clearMentionTokens: (sessionId) => set((state) => {
    if (!(sessionId in state.mentionTokensBySession)) return state;
    const mentionTokensBySession = { ...state.mentionTokensBySession };
    delete mentionTokensBySession[sessionId];
    return { mentionTokensBySession };
  }),
  setCommandKind: (sessionId, kind) => set((state) => ({
    commandKindBySession: { ...state.commandKindBySession, [sessionId]: kind },
  })),
  setQuestionGuard: (sessionId, guard) => set((state) => {
    const questionGuardBySession = { ...state.questionGuardBySession };
    if (guard) questionGuardBySession[sessionId] = guard;
    else delete questionGuardBySession[sessionId];
    return { questionGuardBySession };
  }),
  addDashboardOptimisticMessage: (sessionId, text) => {
    const id = `dashboard-optimistic-${Date.now()}-${nextDashboardOptimisticMessageId++}`;
    const message: DashboardOptimisticMessage = {
      id,
      text,
      createdAt: Date.now(),
      state: "sending",
      error: null,
    };
    set((state) => ({
      dashboardOptimisticMessagesBySession: {
        ...state.dashboardOptimisticMessagesBySession,
        [sessionId]: [...(state.dashboardOptimisticMessagesBySession[sessionId] ?? []), message],
      },
    }));
    return id;
  },
  setDashboardOptimisticMessageState: (sessionId, messageId, nextState, error = null) => set((state) => {
    const current = state.dashboardOptimisticMessagesBySession[sessionId] ?? [];
    const index = current.findIndex((message) => message.id === messageId);
    if (index < 0) return state;
    const dashboardOptimisticMessagesBySession = { ...state.dashboardOptimisticMessagesBySession };
    dashboardOptimisticMessagesBySession[sessionId] = current.map((message) => (
      message.id === messageId ? { ...message, state: nextState, error } : message
    ));
    return { dashboardOptimisticMessagesBySession };
  }),
  collapseDashboardOptimisticMessages: (sessionId, transcriptMessages) => set((state) => {
    const current = state.dashboardOptimisticMessagesBySession[sessionId] ?? [];
    const remaining = current.filter((message) => !transcriptMessages.some((transcript) => (
      transcript.occurredAt >= message.createdAt && transcript.text.trim() === message.text.trim()
    )));
    if (remaining.length === current.length) return state;
    const dashboardOptimisticMessagesBySession = { ...state.dashboardOptimisticMessagesBySession };
    if (remaining.length) dashboardOptimisticMessagesBySession[sessionId] = remaining;
    else delete dashboardOptimisticMessagesBySession[sessionId];
    return { dashboardOptimisticMessagesBySession };
  }),
  requestDashboardOptimisticRetry: (sessionId, messageId) => set((state) => {
    const current = state.dashboardOptimisticMessagesBySession[sessionId] ?? [];
    const message = current.find((item) => item.id === messageId);
    if (!message || message.state !== "failed") return state;
    const dashboardOptimisticMessagesBySession = {
      ...state.dashboardOptimisticMessagesBySession,
      [sessionId]: current.map((item) => item.id === messageId ? { ...item, state: "sending" as const, error: null } : item),
    };
    return {
      dashboardOptimisticMessagesBySession,
      dashboardRetryBySession: {
        ...state.dashboardRetryBySession,
        [sessionId]: { messageId, requestId: nextDashboardRetryRequestId++ },
      },
    };
  }),
  consumeDashboardOptimisticRetry: (sessionId, requestId) => set((state) => {
    const current = state.dashboardRetryBySession[sessionId];
    if (!current || current.requestId !== requestId) return state;
    const dashboardRetryBySession = { ...state.dashboardRetryBySession };
    delete dashboardRetryBySession[sessionId];
    return { dashboardRetryBySession };
  }),
}));

export function composerDraft(sessionId: string | null | undefined): string {
  return sessionId ? useComposerStore.getState().draftBySession[sessionId] ?? "" : "";
}
