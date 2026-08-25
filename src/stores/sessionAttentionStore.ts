import { create } from "zustand";
import {
  getSessionStatusSnapshot,
  onSessionStatusChanged,
  type FeedSessionPayload,
  type SessionAttentionKind,
  type SessionStatusChangedPayload,
  type SessionStatusSnapshotPayload,
  type SessionUiState,
} from "../lib/ipc";
import { readSessionStatusSignals, type SessionStatusSignals } from "../lib/sessionStatusSignals";
import type { PaneTab, Workspace } from "../types";

export const SEEN_ATTENTION_STORAGE_KEY = "mycmux:seen-attention-by-tab";
export const DONE_MARK_STORAGE_KEY = "mycmux:done-mark-by-tab";

interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export interface SessionAttention {
  sessionId: string;
  sessionEpoch: number | null;
  attentionId: string | null;
  kind: SessionAttentionKind;
  detail: string | null;
  sessionRevision: number;
  uiState: SessionUiState;
  stateSince: number;
  occurrenceOrder: number;
}

export type AttentionCategory = "waiting" | "error" | "done";

/** Only states that require a person to act belong in notification UI. */
export const BLOCKING_ATTENTION_CATEGORIES = ["waiting", "error"] as const;

export function isBlockingAttention(
  category: AttentionCategory | null | undefined,
): category is (typeof BLOCKING_ATTENTION_CATEGORIES)[number] {
  return category !== null && category !== undefined
    && (BLOCKING_ATTENTION_CATEGORIES as readonly string[]).includes(category);
}

export interface AttentionTabTarget {
  workspaceId: string;
  paneId: string;
  tab: PaneTab;
  attention: SessionAttention;
  category: AttentionCategory;
}

interface SessionAttentionState {
  attentionBySession: Record<string, SessionAttention>;
  statusSignalsBySession: Record<string, SessionStatusSignals>;
  seenAttentionByTab: Map<string, string>;
  doneMarkByTab: Map<string, number>;
  nextOccurrenceOrder: number;
  serverEpoch: string | null;
  lastSeq: number;
  applySnapshot: (payload: SessionStatusSnapshotPayload) => void;
  applyChanged: (payload: SessionStatusChangedPayload) => void;
  markSeen: (tabId: string, attentionId: string) => void;
  markDone: (tabId: string, at: number) => void;
  clearDoneMark: (tabId: string) => void;
  hydrateSeen: () => void;
  resetForTests: () => void;
}

function browserStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readSeenAttention(storage: StorageLike | null = browserStorage()): Map<string, string> {
  if (!storage) return new Map();
  try {
    const raw = storage.getItem(SEEN_ATTENTION_STORAGE_KEY);
    if (!raw) return new Map();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Map();
    return new Map(parsed.filter(
      (entry): entry is [string, string] => Array.isArray(entry)
        && entry.length === 2
        && typeof entry[0] === "string"
        && typeof entry[1] === "string",
    ));
  } catch {
    return new Map();
  }
}

function persistSeenAttention(seen: Map<string, string>): void {
  const storage = browserStorage();
  if (!storage) return;
  try {
    storage.setItem(SEEN_ATTENTION_STORAGE_KEY, JSON.stringify([...seen.entries()]));
  } catch {
    // Client-local read state is best-effort when storage is unavailable.
  }
}

export function readDoneMarks(storage: StorageLike | null = browserStorage()): Map<string, number> {
  if (!storage) return new Map();
  try {
    const raw = storage.getItem(DONE_MARK_STORAGE_KEY);
    if (!raw) return new Map();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Map();
    return new Map(parsed.filter(
      (entry): entry is [string, number] => Array.isArray(entry)
        && entry.length === 2
        && typeof entry[0] === "string"
        && typeof entry[1] === "number"
        && Number.isFinite(entry[1]),
    ));
  } catch {
    return new Map();
  }
}

function persistDoneMarks(doneMarkByTab: Map<string, number>): void {
  const storage = browserStorage();
  if (!storage) return;
  try {
    storage.setItem(DONE_MARK_STORAGE_KEY, JSON.stringify([...doneMarkByTab.entries()]));
  } catch {
    // Client-local read state is best-effort when storage is unavailable.
  }
}

function toSessionAttention(
  payload: FeedSessionPayload,
  occurrenceOrder: number,
): SessionAttention {
  return {
    sessionId: payload.session_id,
    sessionEpoch: payload.status.session_epoch,
    attentionId: payload.status.attention.attention_id,
    kind: payload.status.attention.kind,
    detail: payload.status.attention.detail,
    sessionRevision: payload.session_revision,
    uiState: payload.status.ui_state,
    stateSince: payload.status.attention.state_since,
    occurrenceOrder,
  };
}

function applyPayload(
  state: Pick<SessionAttentionState, "attentionBySession" | "statusSignalsBySession" | "nextOccurrenceOrder">,
  payload: FeedSessionPayload,
): Pick<SessionAttentionState, "attentionBySession" | "statusSignalsBySession" | "nextOccurrenceOrder"> {
  const previous = state.attentionBySession[payload.session_id];
  if (previous && payload.session_revision < previous.sessionRevision) return state;

  const sameAttention = previous?.attentionId === payload.status.attention.attention_id;
  const occurrenceOrder = sameAttention && previous
    ? previous.occurrenceOrder
    : state.nextOccurrenceOrder;
  const next = toSessionAttention(payload, occurrenceOrder);
  const signals = readSessionStatusSignals(payload.status);
  const previousSignals = state.statusSignalsBySession[payload.session_id];
  if (
    previous
    && previous.attentionId === next.attentionId
    && previous.sessionEpoch === next.sessionEpoch
    && previous.kind === next.kind
    && previous.detail === next.detail
    && previous.sessionRevision === next.sessionRevision
    && previous.uiState === next.uiState
    && previous.stateSince === next.stateSince
    && previousSignals?.activity === signals.activity
    && previousSignals?.health === signals.health
    && previousSignals?.lastOutputAt === signals.lastOutputAt
    && previousSignals?.lastMonitorAt === signals.lastMonitorAt
    && previousSignals?.lastEvidenceAt === signals.lastEvidenceAt
    && previousSignals?.processStartedAt === signals.processStartedAt
  ) {
    return state;
  }

  return {
    attentionBySession: {
      ...state.attentionBySession,
      [payload.session_id]: next,
    },
    statusSignalsBySession: {
      ...state.statusSignalsBySession,
      [payload.session_id]: signals,
    },
    nextOccurrenceOrder: sameAttention && previous
      ? state.nextOccurrenceOrder
      : state.nextOccurrenceOrder + 1,
  };
}

export function isAttentionUnseen(
  tabId: string,
  attention: SessionAttention | undefined,
  seenAttentionByTab: Map<string, string>,
): boolean {
  return Boolean(
    attention?.attentionId
    && attention.kind !== "none"
    && seenAttentionByTab.get(tabId) !== attention.attentionId,
  );
}

export function attentionCategory(
  tabId: string,
  attention: SessionAttention | undefined,
  seenAttentionByTab: Map<string, string>,
): AttentionCategory | null {
  if (!attention?.attentionId) return null;
  if (attention.kind === "input" || attention.kind === "approval") return "waiting";
  if (attention.kind === "error" || attention.kind === "rate_limited") return "error";
  if (attention.kind === "done" && isAttentionUnseen(tabId, attention, seenAttentionByTab)) {
    return "done";
  }
  return null;
}

export function attentionDetail(attention: SessionAttention | undefined): string | null {
  if (!attention || (attention.kind !== "input" && attention.kind !== "approval" && attention.kind !== "rate_limited")) return null;
  const detail = attention.detail?.replace(/\s+/g, " ").trim();
  return detail || null;
}

export function resolveAttentionTabs(
  tabs: PaneTab[],
  attentionBySession: Record<string, SessionAttention | undefined>,
  seenAttentionByTab: Map<string, string>,
): Array<{ tab: PaneTab; attention: SessionAttention; category: AttentionCategory }> {
  return tabs
    .map((tab) => {
      const attention = attentionBySession[tab.sessionId];
      const category = attentionCategory(tab.id, attention, seenAttentionByTab);
      return attention && category ? { tab, attention, category } : null;
    })
    .filter((item): item is { tab: PaneTab; attention: SessionAttention; category: AttentionCategory } => Boolean(item))
    .sort((left, right) => left.attention.occurrenceOrder - right.attention.occurrenceOrder);
}

const ATTENTION_PRIORITY: Record<AttentionCategory, number> = {
  waiting: 0,
  error: 1,
  done: 2,
};

export interface UnseenAttentionSummary {
  /** How many of the given tabs carry unseen actionable attention. */
  count: number;
  /** The most urgent of those categories, or null when count is 0. */
  category: AttentionCategory | null;
}

/**
 * Roll a set of tabs up into the single indicator a container row can show.
 *
 * Deliberately built from the same `isAttentionUnseen` + `attentionCategory`
 * pair the pane tab pills use, so a workspace row and its pills can never
 * disagree about what counts as unread.
 */
export function summarizeUnseenAttention(
  tabs: readonly Pick<PaneTab, "id" | "sessionId">[],
  attentionBySession: Record<string, SessionAttention | undefined>,
  seenAttentionByTab: Map<string, string>,
): UnseenAttentionSummary {
  let count = 0;
  let category: AttentionCategory | null = null;
  for (const tab of tabs) {
    const attention = attentionBySession[tab.sessionId];
    if (!isAttentionUnseen(tab.id, attention, seenAttentionByTab)) continue;
    const tabCategory = attentionCategory(tab.id, attention, seenAttentionByTab);
    if (!isBlockingAttention(tabCategory)) continue;
    count += 1;
    if (category === null || ATTENTION_PRIORITY[tabCategory] < ATTENTION_PRIORITY[category]) {
      category = tabCategory;
    }
  }
  return { count, category };
}

export function resolveNextAttentionTarget(
  workspaces: Workspace[],
  attentionBySession: Record<string, SessionAttention>,
  seenAttentionByTab: Map<string, string>,
  currentTabId: string | null,
): AttentionTabTarget | null {
  const candidates: AttentionTabTarget[] = [];
  for (const workspace of workspaces) {
    for (const pane of workspace.panes) {
      for (const tab of pane.tabs) {
        const attention = attentionBySession[tab.sessionId];
        const category = attentionCategory(tab.id, attention, seenAttentionByTab);
        if (attention && isBlockingAttention(category)) {
          candidates.push({ workspaceId: workspace.id, paneId: pane.id, tab, attention, category });
        }
      }
    }
  }
  candidates.sort((left, right) => (
    ATTENTION_PRIORITY[left.category] - ATTENTION_PRIORITY[right.category]
    || left.attention.occurrenceOrder - right.attention.occurrenceOrder
  ));
  if (candidates.length === 0) return null;

  const currentIndex = currentTabId
    ? candidates.findIndex((candidate) => candidate.tab.id === currentTabId)
    : -1;
  if (currentIndex < 0) return candidates[0];
  if (candidates.length === 1) return null;
  return candidates[(currentIndex + 1) % candidates.length];
}

export const useSessionAttentionStore = create<SessionAttentionState>((set) => ({
  attentionBySession: {},
  statusSignalsBySession: {},
  seenAttentionByTab: readSeenAttention(),
  doneMarkByTab: readDoneMarks(),
  nextOccurrenceOrder: 1,
  serverEpoch: null,
  lastSeq: 0,

  applySnapshot: (payload) => set((state) => {
    if (state.serverEpoch === payload.server_epoch && payload.seq < state.lastSeq) return state;
    let next: Pick<SessionAttentionState, "attentionBySession" | "statusSignalsBySession" | "nextOccurrenceOrder"> = {
      attentionBySession: {},
      statusSignalsBySession: {},
      nextOccurrenceOrder: 1,
    };
    const ordered = [...payload.sessions].sort((left, right) => (
      left.status.attention.state_since - right.status.attention.state_since
      || left.session_id.localeCompare(right.session_id)
    ));
    for (const session of ordered) next = applyPayload(next, session);
    return { ...next, serverEpoch: payload.server_epoch, lastSeq: payload.seq };
  }),

  applyChanged: (payload) => set((state) => {
    const sameEpoch = state.serverEpoch === payload.server_epoch;
    if (sameEpoch && payload.seq <= state.lastSeq) return state;
    const base = sameEpoch
      ? state
      : { attentionBySession: {}, statusSignalsBySession: {}, nextOccurrenceOrder: 1 };
    return {
      ...applyPayload(base, payload),
      serverEpoch: payload.server_epoch,
      lastSeq: payload.seq,
    };
  }),

  markSeen: (tabId, attentionId) => set((state) => {
    if (state.seenAttentionByTab.get(tabId) === attentionId) return state;
    const seenAttentionByTab = new Map(state.seenAttentionByTab);
    seenAttentionByTab.set(tabId, attentionId);
    persistSeenAttention(seenAttentionByTab);
    return { seenAttentionByTab };
  }),

  markDone: (tabId, at) => set((state) => {
    if (!Number.isFinite(at) || state.doneMarkByTab.get(tabId) === at) return state;
    const doneMarkByTab = new Map(state.doneMarkByTab);
    doneMarkByTab.set(tabId, at);
    persistDoneMarks(doneMarkByTab);
    return { doneMarkByTab };
  }),

  clearDoneMark: (tabId) => set((state) => {
    if (!state.doneMarkByTab.has(tabId)) return state;
    const doneMarkByTab = new Map(state.doneMarkByTab);
    doneMarkByTab.delete(tabId);
    persistDoneMarks(doneMarkByTab);
    return { doneMarkByTab };
  }),

  hydrateSeen: () => set({ seenAttentionByTab: readSeenAttention(), doneMarkByTab: readDoneMarks() }),

  resetForTests: () => set({
    attentionBySession: {},
    statusSignalsBySession: {},
    seenAttentionByTab: new Map(),
    doneMarkByTab: new Map(),
    nextOccurrenceOrder: 1,
    serverEpoch: null,
    lastSeq: 0,
  }),
}));

export async function connectSessionAttentionStore(): Promise<() => void> {
  const store = useSessionAttentionStore.getState();
  store.hydrateSeen();
  let initializing = true;
  const buffered: SessionStatusChangedPayload[] = [];
  const unlisten = await onSessionStatusChanged((payload) => {
    if (initializing) {
      buffered.push(payload);
      return;
    }
    useSessionAttentionStore.getState().applyChanged(payload);
  });
  try {
    const snapshot = await getSessionStatusSnapshot();
    useSessionAttentionStore.getState().applySnapshot(snapshot);
  } catch (error) {
    console.warn("[attention] Failed to load session status snapshot", error);
  } finally {
    initializing = false;
    for (const payload of buffered) {
      useSessionAttentionStore.getState().applyChanged(payload);
    }
  }
  return unlisten;
}
