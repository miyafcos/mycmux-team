import { create } from "zustand";
import { mentionTokenKey, type MentionToken } from "../lib/mentionModel";

export type ComposerCommandKind = "plain" | "status-request" | "answer-forward";

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
  setDraft: (sessionId: string, text: string) => void;
  clearDraft: (sessionId: string) => void;
  addMentionToken: (sessionId: string, token: MentionToken) => void;
  removeMentionToken: (sessionId: string, token: MentionToken) => void;
  clearMentionTokens: (sessionId: string) => void;
  setCommandKind: (sessionId: string, kind: ComposerCommandKind) => void;
  setQuestionGuard: (sessionId: string, guard: ComposerQuestionGuard | null) => void;
}

export const useComposerStore = create<ComposerState>((set) => ({
  draftBySession: {},
  mentionTokensBySession: {},
  commandKindBySession: {},
  questionGuardBySession: {},
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
}));

export function composerDraft(sessionId: string | null | undefined): string {
  return sessionId ? useComposerStore.getState().draftBySession[sessionId] ?? "" : "";
}
