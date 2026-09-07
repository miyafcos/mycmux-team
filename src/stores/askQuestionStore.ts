import { create } from "zustand";

import {
  clearAskQuestionEvidence,
  publishAskQuestionEvidence,
} from "../lib/askQuestionEvidence";
import { scanAskQuestion, type AskScreen } from "../lib/askQuestionScan";
import { useSessionAttentionStore } from "./sessionAttentionStore";

export const ASK_QUESTION_TAIL_LINES = 60;
export const ASK_QUESTION_POLL_MS = 2_000;

export type AskStopReason =
  | "busy"
  | "already_answered"
  | "superseded_launch"
  | "stale_question"
  | "null_scan"
  | "attention_mismatch"
  | "session_revision_mismatch"
  | "target_disappeared"
  | "timed_out"
  | "unchanged_screen"
  | "read_failure"
  | "transport"
  | "ambiguous"
  | "undiscovered_tab"
  | "needs_confirmation";

export type AskConfirmedStage =
  | "idle"
  | "drafting"
  | "sending"
  | "awaiting_confirmation"
  | "review";

export interface AskQuestionSessionState {
  screen: AskScreen | null;
  scannedAt: number;
  revision: number;
  read: boolean;
  inFlight: boolean;
  confirmedStage: AskConfirmedStage;
  stopReason: AskStopReason | null;
  /** PTY input revision captured before this screen identity was observed. */
  expectedInputRevision: number | null;
  /** questionKey → numbered option index the operator already chose. */
  drafts: Record<string, number>;
  /** questionKey → numbered option indexes the operator wants checked. */
  draftChecked: Record<string, number[]>;
  /** questionKeys the operator has explicitly confirmed. */
  confirmedKeys: string[];
}

const EMPTY_SESSION: AskQuestionSessionState = {
  screen: null,
  scannedAt: 0,
  revision: 0,
  read: false,
  inFlight: false,
  confirmedStage: "idle",
  stopReason: null,
  expectedInputRevision: null,
  drafts: {},
  draftChecked: {},
  confirmedKeys: [],
};

interface AskQuestionStoreState {
  bySession: Record<string, AskQuestionSessionState>;
  applyScan: (
    sessionId: string,
    screen: AskScreen,
    scannedAt: number,
    observedInputRevision?: number,
  ) => void;
  clearScreen: (sessionId: string, reason?: AskStopReason | null, observedAt?: number) => void;
  clearSession: (sessionId: string) => void;
  pruneSessions: (liveSessionIds: readonly string[]) => void;
  setInFlight: (sessionId: string, inFlight: boolean) => void;
  setStopReason: (sessionId: string, reason: AskStopReason | null) => void;
  setConfirmedStage: (sessionId: string, stage: AskConfirmedStage) => void;
  rebindInputRevision: (sessionId: string, fromRevision: number, toRevision: number) => void;
  advanceInputRevision: (sessionId: string, expectedRevision: number) => void;
  setDraft: (sessionId: string, key: string, optionIndex: number) => void;
  setDraftChecked: (sessionId: string, key: string, optionIndexes: readonly number[]) => void;
  confirmQuestion: (sessionId: string, key: string) => void;
  markRead: (sessionId: string) => void;
  resetForTests: () => void;
}

export function questionKey(screen: AskScreen): string {
  if (screen.kind === "review") return "review";
  const tab = screen.tabs.find((item) => item.active)?.label ?? "";
  return `${screen.kind}:${tab}:${screen.question}`;
}

/** Identity the operator is answering: prompt, tabs, and option labels. */
export function screenContentKey(screen: AskScreen): string {
  return JSON.stringify({
    kind: screen.kind,
    question: screen.question,
    header: screen.header ?? null,
    multiSelect: screen.multiSelect,
    tabs: screen.tabs.map((tab) => ({ label: tab.label, answered: tab.answered, active: tab.active })),
    options: screen.options.map((option) => ({
      index: option.index,
      label: option.label,
      description: option.description ?? null,
      role: option.role,
    })),
  });
}

/** Full on-screen state, including cursor and checked boxes. */
export function screenStateKey(screen: AskScreen): string {
  return JSON.stringify({
    content: screenContentKey(screen),
    current: screen.options.map((option) => option.current),
    checked: screen.options.map((option) => option.checked ?? null),
  });
}

export function checkedOptionIndexes(screen: AskScreen): number[] {
  return screen.options.flatMap((option) => (
    option.checked === true && option.index !== null ? [option.index] : []
  ));
}

function sessionOrEmpty(
  bySession: Record<string, AskQuestionSessionState>,
  sessionId: string,
): AskQuestionSessionState {
  return bySession[sessionId] ?? EMPTY_SESSION;
}

function writeSession(
  bySession: Record<string, AskQuestionSessionState>,
  sessionId: string,
  next: AskQuestionSessionState,
): Record<string, AskQuestionSessionState> {
  return { ...bySession, [sessionId]: next };
}

function stageForScreen(
  screen: AskScreen,
  previous: AskQuestionSessionState,
): AskConfirmedStage {
  if (previous.inFlight) return "sending";
  if (screen.kind === "review") return "review";
  if (previous.confirmedStage === "awaiting_confirmation") return "awaiting_confirmation";
  if (Object.keys(previous.drafts).length > 0 || Object.keys(previous.draftChecked).length > 0) {
    return "drafting";
  }
  return "idle";
}

function sameTabbedFlow(previous: AskScreen | null, next: AskScreen): boolean {
  if (!previous || previous.kind !== "tabbed" || next.kind === "single") return false;
  const previousLabels = previous.tabs.map((tab) => tab.label);
  const nextLabels = next.tabs.map((tab) => tab.label);
  if (
    previousLabels.length !== nextLabels.length
    || previousLabels.some((label, index) => label !== nextLabels[index])
  ) {
    return false;
  }
  if (next.kind === "review") return true;
  const previousActive = previous.tabs.find((tab) => tab.active)?.label;
  const nextActive = next.tabs.find((tab) => tab.active)?.label;
  return previousActive !== nextActive;
}

export const useAskQuestionStore = create<AskQuestionStoreState>((set) => ({
  bySession: {},

  applyScan: (sessionId, screen, scannedAt, observedInputRevision) => set((state) => {
    const previous = sessionOrEmpty(state.bySession, sessionId);
    if (previous.scannedAt > scannedAt) return state;
    const nextKey = questionKey(screen);
    const previousKey = previous.screen ? questionKey(previous.screen) : null;
    const identityChanged = previousKey !== nextKey;
    const contentChanged = !previous.screen || screenContentKey(previous.screen) !== screenContentKey(screen);
    const descriptionsChanged = Boolean(
      previous.screen
      && !identityChanged
      && (
        previous.screen.options.some((option, index) => (
          (option.description ?? null) !== (screen.options[index]?.description ?? null)
        ))
        || previous.screen.options.length !== screen.options.length
      )
    );
    const stateChanged = !previous.screen || screenStateKey(previous.screen) !== screenStateKey(screen);
    const observedRevision = Number.isInteger(observedInputRevision) && observedInputRevision! >= 0
      ? observedInputRevision!
      : null;
    if (
      previous.screen
      && !stateChanged
      && previous.stopReason === null
      && (observedRevision === null || previous.expectedInputRevision === observedRevision)
    ) {
      return state;
    }
    if (previous.screen && !stateChanged) {
      return {
        bySession: writeSession(state.bySession, sessionId, {
          ...previous,
          scannedAt,
        }),
      };
    }
    const resetAnswers = descriptionsChanged || (contentChanged && !sameTabbedFlow(previous.screen, screen));
    const nextExpectedInputRevision = contentChanged || !previous.screen
      ? observedRevision
      : previous.expectedInputRevision;
    const next: AskQuestionSessionState = {
      ...previous,
      screen,
      scannedAt,
      revision: contentChanged || identityChanged || !previous.screen
        ? previous.revision + 1
        : previous.revision,
      read: identityChanged ? false : previous.read,
      confirmedStage: resetAnswers ? stageForScreen(screen, EMPTY_SESSION) : stageForScreen(screen, previous),
      stopReason: identityChanged ? null : previous.stopReason,
      expectedInputRevision: nextExpectedInputRevision,
      drafts: resetAnswers ? {} : previous.drafts,
      draftChecked: resetAnswers ? {} : previous.draftChecked,
      confirmedKeys: resetAnswers ? [] : previous.confirmedKeys,
    };
    return { bySession: writeSession(state.bySession, sessionId, next) };
  }),

  clearScreen: (sessionId, reason = null, observedAt = Date.now()) => set((state) => {
    const previous = state.bySession[sessionId];
    if (!previous) {
      if (!reason) return state;
      return {
        bySession: writeSession(state.bySession, sessionId, {
          ...EMPTY_SESSION,
          stopReason: reason,
        }),
      };
    }
    if (previous.scannedAt > observedAt) return state;
    if (
      previous.screen === null
      && previous.stopReason === (reason ?? previous.stopReason)
      && !previous.inFlight
    ) {
      if (!reason || previous.stopReason === reason) return state;
    }
    return {
      bySession: writeSession(state.bySession, sessionId, {
        ...previous,
        screen: null,
        scannedAt: observedAt,
        read: true,
        confirmedStage: "idle",
        stopReason: reason ?? null,
        inFlight: previous.inFlight,
        expectedInputRevision: null,
        drafts: {},
        draftChecked: {},
        confirmedKeys: [],
      }),
    };
  }),

  clearSession: (sessionId) => set((state) => {
    if (!(sessionId in state.bySession)) return state;
    const bySession = { ...state.bySession };
    delete bySession[sessionId];
    return { bySession };
  }),

  pruneSessions: (liveSessionIds) => set((state) => {
    const live = new Set(liveSessionIds);
    let changed = false;
    const bySession: Record<string, AskQuestionSessionState> = {};
    for (const [sessionId, session] of Object.entries(state.bySession)) {
      if (live.has(sessionId)) bySession[sessionId] = session;
      else changed = true;
    }
    return changed ? { bySession } : state;
  }),

  setInFlight: (sessionId, inFlight) => set((state) => {
    const previous = sessionOrEmpty(state.bySession, sessionId);
    if (previous.inFlight === inFlight && state.bySession[sessionId]) return state;
    const confirmedStage = inFlight
      ? "sending"
      : previous.stopReason === "needs_confirmation" || previous.stopReason === "undiscovered_tab"
        ? "awaiting_confirmation"
        : previous.screen?.kind === "review"
          ? "review"
          : previous.screen
            ? "idle"
            : previous.confirmedStage === "sending"
              ? "idle"
              : previous.confirmedStage;
    return {
      bySession: writeSession(state.bySession, sessionId, {
        ...previous,
        inFlight,
        confirmedStage,
      }),
    };
  }),

  setStopReason: (sessionId, reason) => set((state) => {
    const previous = sessionOrEmpty(state.bySession, sessionId);
    if (previous.stopReason === reason && state.bySession[sessionId]) return state;
    return {
      bySession: writeSession(state.bySession, sessionId, {
        ...previous,
        stopReason: reason,
        confirmedStage: reason === "needs_confirmation" || reason === "undiscovered_tab"
          ? "awaiting_confirmation"
          : previous.confirmedStage,
      }),
    };
  }),

  setConfirmedStage: (sessionId, stage) => set((state) => {
    const previous = sessionOrEmpty(state.bySession, sessionId);
    if (previous.confirmedStage === stage && state.bySession[sessionId]) return state;
    return {
      bySession: writeSession(state.bySession, sessionId, {
        ...previous,
        confirmedStage: stage,
      }),
    };
  }),

  rebindInputRevision: (sessionId, fromRevision, toRevision) => set((state) => {
    const previous = state.bySession[sessionId];
    if (!previous || previous.expectedInputRevision !== fromRevision) return state;
    return {
      bySession: writeSession(state.bySession, sessionId, {
        ...previous,
        expectedInputRevision: toRevision,
      }),
    };
  }),

  advanceInputRevision: (sessionId, expectedRevision) => set((state) => {
    const previous = state.bySession[sessionId];
    if (!previous || previous.expectedInputRevision !== expectedRevision) return state;
    return {
      bySession: writeSession(state.bySession, sessionId, {
        ...previous,
        expectedInputRevision: expectedRevision + 1,
      }),
    };
  }),

  setDraft: (sessionId, key, optionIndex) => set((state) => {
    const previous = sessionOrEmpty(state.bySession, sessionId);
    if (previous.drafts[key] === optionIndex) return state;
    return {
      bySession: writeSession(state.bySession, sessionId, {
        ...previous,
        drafts: { ...previous.drafts, [key]: optionIndex },
        confirmedStage: previous.inFlight ? "sending" : "drafting",
      }),
    };
  }),

  setDraftChecked: (sessionId, key, optionIndexes) => set((state) => {
    const previous = sessionOrEmpty(state.bySession, sessionId);
    const next = [...optionIndexes].sort((left, right) => left - right);
    const current = previous.draftChecked[key];
    if (current && current.length === next.length && current.every((value, index) => value === next[index])) {
      return state;
    }
    return {
      bySession: writeSession(state.bySession, sessionId, {
        ...previous,
        draftChecked: { ...previous.draftChecked, [key]: next },
        confirmedStage: previous.inFlight ? "sending" : "drafting",
      }),
    };
  }),

  confirmQuestion: (sessionId, key) => set((state) => {
    const previous = sessionOrEmpty(state.bySession, sessionId);
    if (previous.confirmedKeys.includes(key)) return state;
    return {
      bySession: writeSession(state.bySession, sessionId, {
        ...previous,
        confirmedKeys: [...previous.confirmedKeys, key],
      }),
    };
  }),

  markRead: (sessionId) => set((state) => {
    const previous = state.bySession[sessionId];
    if (!previous || previous.read) return state;
    return {
      bySession: writeSession(state.bySession, sessionId, { ...previous, read: true }),
    };
  }),

  resetForTests: () => set({ bySession: {} }),
}));

export function ingestAskQuestionLines(
  sessionId: string,
  lines: readonly string[],
  scannedAt = Date.now(),
  observedInputRevision?: number,
): AskScreen | null {
  const screen = scanAskQuestion(lines);
  const store = useAskQuestionStore.getState();
  if (screen) store.applyScan(sessionId, screen, scannedAt, observedInputRevision);
  else store.clearScreen(sessionId, store.bySession[sessionId]?.stopReason ?? null, scannedAt);
  return screen;
}

export function getAskQuestionSession(sessionId: string): AskQuestionSessionState {
  return useAskQuestionStore.getState().bySession[sessionId] ?? EMPTY_SESSION;
}

const refreshTailBySession = new Map<string, Promise<void>>();

async function performRefreshAskQuestionFromTail(
  sessionId: string,
  readTail?: (sessionId: string, lines: number) => Promise<string[]>,
  readInputRevision?: (sessionId: string) => Promise<number>,
): Promise<void> {
  try {
    const revisionReader = readInputRevision
      ?? (await import("../lib/ipc")).getSessionInputRevision;
    const observedInputRevision = await revisionReader(sessionId);
    const read = readTail ?? (async (targetSessionId: string, lines: number) => (
      (await import("../components/layout/socketCommands")).readPaneTail(
        targetSessionId,
        lines,
        true,
      )
    ));
    const lines = await read(sessionId, ASK_QUESTION_TAIL_LINES);
    const observedAt = Date.now();
    const screen = ingestAskQuestionLines(sessionId, lines, observedAt, observedInputRevision);
    if (screen) {
      const canonicalAttention = useSessionAttentionStore.getState().attentionBySession[sessionId];
      await publishAskQuestionEvidence(
        sessionId,
        screen,
        observedAt,
        canonicalAttention
          ? { attentionId: canonicalAttention.attentionId, kind: canonicalAttention.kind }
          : undefined,
      );
    } else {
      await clearAskQuestionEvidence(sessionId, observedAt);
    }
  } catch {
    useAskQuestionStore.getState().clearScreen(sessionId, "read_failure", Date.now());
  }
}

export function refreshAskQuestionFromTail(
  sessionId: string,
  readTail?: (sessionId: string, lines: number) => Promise<string[]>,
  readInputRevision?: (sessionId: string) => Promise<number>,
): Promise<void> {
  const previous = refreshTailBySession.get(sessionId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => performRefreshAskQuestionFromTail(sessionId, readTail, readInputRevision));
  refreshTailBySession.set(sessionId, next);
  void next.finally(() => {
    if (refreshTailBySession.get(sessionId) === next) refreshTailBySession.delete(sessionId);
  });
  return next;
}
