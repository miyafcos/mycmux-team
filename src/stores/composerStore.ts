import { create } from "zustand";
import { mentionTokenKey, type MentionToken } from "../lib/mentionModel";

export type ComposerCommandKind = "plain" | "status-request" | "answer-forward" | "continue";
export type DashboardOptimisticMessageState = "sending" | "sent" | "failed";

export interface PaneSendDraft {
  sessionId: string;
  id: string;
  text: string;
}

interface PaneSend extends PaneSendDraft {
  moved: boolean;
  transfers?: readonly symbol[];
  provisional?: symbol;
}

export interface PaneSendTransfer {
  drafts: () => PaneSendDraft[];
  finish: (committed: boolean) => void;
}

export type PaneSendResult = "sent" | "unconfirmed" | "restore";

const NO_PANE_SENDS: readonly PaneSend[] = [];

export function isRecoverablePaneSend(draft: PaneSend): boolean {
  return draft.moved && !draft.transfers?.length && draft.provisional === undefined;
}

function updatePaneSends(
  current: ComposerState["paneSendsBySession"],
  sessionIds: readonly string[],
  update: (drafts: readonly PaneSend[]) => readonly PaneSend[],
): ComposerState["paneSendsBySession"] {
  const next = { ...current };
  for (const id of sessionIds) {
    if (!current[id]?.length) continue;
    const drafts = update(current[id]);
    if (drafts.length) next[id] = drafts;
    else delete next[id];
  }
  return next;
}

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
  paneSendsBySession: Record<string, readonly PaneSend[]>;
  beginPaneSend: (sessionId: string, text: string) => PaneSendDraft;
  finishPaneSend: (draft: PaneSendDraft, result: PaneSendResult) => void;
  startPaneSendTransfer: (sessionIds: readonly string[]) => PaneSendTransfer;
  adoptPaneSends: (drafts: readonly PaneSendDraft[], provisional?: symbol) => void;
  stagePaneSends: (drafts: readonly PaneSendDraft[]) => (committed: boolean) => void;
  restoreMovedPaneSends: (sessionId: string) => void;
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

const outgoingBySession = new Map<string, Set<symbol>>();

export const useComposerStore = create<ComposerState>((set, get) => ({
  draftBySession: {},
  paneSendsBySession: {},
  beginPaneSend: (sessionId, text) => {
    const draft = { sessionId, id: crypto.randomUUID(), text };
    const transfers = outgoingBySession.get(sessionId);
    set(state => ({
      paneSendsBySession: {
        ...state.paneSendsBySession,
        [sessionId]: [...(state.paneSendsBySession[sessionId] ?? NO_PANE_SENDS),
          { ...draft, moved: false, transfers: transfers ? [...transfers] : undefined }],
      },
    }));
    return draft;
  },
  finishPaneSend: ({ id, sessionId, text }, result) => set(state => {
    const current = state.paneSendsBySession[sessionId]?.find(draft => draft.id === id);
    // The destination owns the draft once the transfer finishes.
    if (!current || current.moved) return state;
    if (current.transfers?.length && result !== "sent") {
      return { paneSendsBySession: updatePaneSends(state.paneSendsBySession, [sessionId],
        drafts => drafts.map(draft => draft === current ? { ...draft, moved: true } : draft)) };
    }
    const paneSendsBySession = updatePaneSends(state.paneSendsBySession, [sessionId],
      drafts => drafts.filter(draft => draft !== current));
    if (result !== "restore") return { paneSendsBySession };
    const existing = state.draftBySession[sessionId];
    return {
      paneSendsBySession,
      draftBySession: { ...state.draftBySession, [sessionId]: existing ? `${text}\n${existing}` : text },
    };
  }),
  startPaneSendTransfer: (sessionIds) => {
    const ids = [...new Set(sessionIds)];
    const transfer = Symbol();
    let finished = false;
    for (const id of ids) {
      const pending = outgoingBySession.get(id) ?? new Set<symbol>();
      pending.add(transfer);
      outgoingBySession.set(id, pending);
    }
    const claimed = (draft: PaneSend) => draft.transfers?.includes(transfer) === true;
    set(state => ({ paneSendsBySession: updatePaneSends(state.paneSendsBySession, ids,
      drafts => drafts.map(draft => draft.provisional === undefined
        ? { ...draft, transfers: [...(draft.transfers ?? []), transfer] } : draft)) }));
    return {
      drafts: () => ids.flatMap(sessionId => (get().paneSendsBySession[sessionId] ?? NO_PANE_SENDS)
        .filter(claimed).map(({ id, text }) => ({ sessionId, id, text }))),
      finish: committed => {
        if (finished) return;
        finished = true;
        for (const id of ids) {
          const pending = outgoingBySession.get(id);
          pending?.delete(transfer);
          if (pending?.size === 0) outgoingBySession.delete(id);
        }
        set(state => ({ paneSendsBySession: updatePaneSends(state.paneSendsBySession, ids, drafts => committed
          ? drafts.filter(draft => !claimed(draft))
          : drafts.map(draft => claimed(draft) ? { ...draft, transfers: draft.transfers!.filter(token => token !== transfer) } : draft)) }));
      },
    };
  },
  adoptPaneSends: (drafts, provisional) => set(state => {
    const paneSendsBySession = { ...state.paneSendsBySession };
    for (const draft of drafts) {
      const prior = paneSendsBySession[draft.sessionId] ?? NO_PANE_SENDS;
      if (prior.some(current => current.id === draft.id)) continue;
      paneSendsBySession[draft.sessionId] = [...prior, { ...draft, moved: true, provisional }];
    }
    return { paneSendsBySession };
  }),
  stagePaneSends: (drafts) => {
    const provisional = Symbol();
    get().adoptPaneSends(drafts, provisional);
    const ids = [...new Set(drafts.map(draft => draft.sessionId))];
    return committed => set(state => ({
      paneSendsBySession: updatePaneSends(state.paneSendsBySession, ids, pending => committed
        ? pending.map(draft => draft.provisional === provisional ? { ...draft, provisional: undefined } : draft)
        : pending.filter(draft => draft.provisional !== provisional)),
    }));
  },
  restoreMovedPaneSends: (sessionId) => set(state => {
    const drafts = state.paneSendsBySession[sessionId] ?? NO_PANE_SENDS;
    const moved = drafts.filter(isRecoverablePaneSend);
    if (!moved.length) return state;
    const pending = drafts.filter(draft => !isRecoverablePaneSend(draft));
    const paneSendsBySession = { ...state.paneSendsBySession };
    if (pending.length) paneSendsBySession[sessionId] = pending;
    else delete paneSendsBySession[sessionId];
    const text = moved.map(draft => draft.text);
    const current = state.draftBySession[sessionId];
    if (current) text.push(current);
    return {
      paneSendsBySession,
      draftBySession: { ...state.draftBySession, [sessionId]: text.join("\n") },
    };
  }),
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
