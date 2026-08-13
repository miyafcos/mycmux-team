import { create } from "zustand";

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
  setDraft: (sessionId: string, text: string) => void;
  clearDraft: (sessionId: string) => void;
}

export const useComposerStore = create<ComposerState>((set) => ({
  draftBySession: {},
  setDraft: (sessionId, text) => set((state) => ({
    draftBySession: { ...state.draftBySession, [sessionId]: text },
  })),
  clearDraft: (sessionId) => set((state) => {
    if (!(sessionId in state.draftBySession)) return state;
    const draftBySession = { ...state.draftBySession };
    delete draftBySession[sessionId];
    return { draftBySession };
  }),
}));

export function composerDraft(sessionId: string | null | undefined): string {
  return sessionId ? useComposerStore.getState().draftBySession[sessionId] ?? "" : "";
}
