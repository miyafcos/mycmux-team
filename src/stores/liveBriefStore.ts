import { create } from "zustand";
import type { UnlistenFn } from "@tauri-apps/api/event";

import {
  getLiveBriefs,
  getLiveEvents,
  onLiveBriefUpdate,
  LIVE_EVENT_LIMIT,
  type LiveSessionBrief,
  type SemanticEventEnvelope,
} from "../lib/livebrief";

export const LIVE_EVENT_POLL_MS = 1_500;

type BriefMap = Record<string, LiveSessionBrief>;

interface LiveBriefStoreState {
  briefsBySession: BriefMap;
  eventsBySession: Record<string, SemanticEventEnvelope[]>;
  /** イベントを取得した時刻 (ms)。取得済みかどうかの判定にも使う。 */
  eventsFetchedAtBySession: Record<string, number>;
  applyBrief: (brief: LiveSessionBrief) => void;
  applyBriefs: (briefs: readonly LiveSessionBrief[]) => void;
  applyEvents: (sessionId: string, events: SemanticEventEnvelope[], fetchedAt: number) => void;
  reset: () => void;
}

/**
 * 同じセッションの古い brief で新しいものを踏まないためのガード。
 * LiveBriefBlock.tsx が持っていたものをそのまま移送している (挙動は不変)。
 */
export function mergeBrief(previous: BriefMap, incoming: LiveSessionBrief): BriefMap {
  const current = previous[incoming.ptySessionId];
  if (current && (current.serviceEpoch !== incoming.serviceEpoch || current.briefRevision >= incoming.briefRevision)) return previous;
  return { ...previous, [incoming.ptySessionId]: incoming };
}

export const useLiveBriefStore = create<LiveBriefStoreState>((set) => ({
  briefsBySession: {},
  eventsBySession: {},
  eventsFetchedAtBySession: {},
  applyBrief: (brief) => set((state) => {
    const next = mergeBrief(state.briefsBySession, brief);
    return next === state.briefsBySession ? state : { briefsBySession: next };
  }),
  applyBriefs: (briefs) => set((state) => {
    const next = briefs.reduce(mergeBrief, state.briefsBySession);
    return next === state.briefsBySession ? state : { briefsBySession: next };
  }),
  applyEvents: (sessionId, events, fetchedAt) => set((state) => ({
    eventsBySession: { ...state.eventsBySession, [sessionId]: events },
    eventsFetchedAtBySession: { ...state.eventsFetchedAtBySession, [sessionId]: fetchedAt },
  })),
  reset: () => set({ briefsBySession: {}, eventsBySession: {}, eventsFetchedAtBySession: {} }),
}));

// --- livebrief://update の購読はアプリ全体で 1 本だけ持つ ------------------
let subscriberCount = 0;
let unlisten: UnlistenFn | undefined;
let unlistenPending: Promise<UnlistenFn> | undefined;

/**
 * brief の購読を開始し、購読解除関数を返す。何個の画面から呼ばれても実際の
 * listen は 1 本しか張らない (最後の 1 人が外れたときだけ解除する)。
 */
export function connectLiveBriefStore(): () => void {
  subscriberCount += 1;
  if (subscriberCount === 1) {
    unlistenPending = onLiveBriefUpdate((brief) => useLiveBriefStore.getState().applyBrief(brief));
    void unlistenPending.then((dispose) => {
      if (subscriberCount === 0) dispose();
      else unlisten = dispose;
    }).catch(() => {});
    void getLiveBriefs()
      .then((snapshot) => useLiveBriefStore.getState().applyBriefs(snapshot))
      .catch(() => {});
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    subscriberCount = Math.max(0, subscriberCount - 1);
    if (subscriberCount > 0) return;
    unlisten?.();
    unlisten = undefined;
    unlistenPending = undefined;
  };
}

// --- イベントのポーリングは「選択中の 1 セッション」だけ -------------------
let pollingSessionId: string | null = null;
let pollTimer: ReturnType<typeof setInterval> | undefined;
const inFlightSessions = new Set<string>();

/** 1 回だけイベントを取り直す。ポーリングの 1 打ちと初回取得を兼ねる。 */
export async function ensureEvents(sessionId: string, limit: number = LIVE_EVENT_LIMIT): Promise<void> {
  if (inFlightSessions.has(sessionId)) return;
  inFlightSessions.add(sessionId);
  try {
    const snapshot = await getLiveEvents([sessionId], limit);
    const entry = snapshot.find((item) => item.ptySessionId === sessionId);
    useLiveBriefStore.getState().applyEvents(sessionId, entry?.events ?? [], Date.now());
  } catch {
    // 取得できない間は前回の行を出したままにする (画面を空にしない)。
  } finally {
    inFlightSessions.delete(sessionId);
  }
}

/** 選択中セッションのイベント取得を開始する。別セッションへ切り替えたら張り直す。 */
export function startEventPolling(sessionId: string, intervalMs: number = LIVE_EVENT_POLL_MS): void {
  if (pollingSessionId === sessionId && pollTimer !== undefined) return;
  stopEventPolling();
  pollingSessionId = sessionId;
  void ensureEvents(sessionId);
  pollTimer = setInterval(() => {
    if (pollingSessionId) void ensureEvents(pollingSessionId);
  }, intervalMs);
}

export function stopEventPolling(): void {
  if (pollTimer !== undefined) clearInterval(pollTimer);
  pollTimer = undefined;
  pollingSessionId = null;
}

export function __resetLiveBriefStoreForTests(): void {
  stopEventPolling();
  inFlightSessions.clear();
  subscriberCount = 0;
  unlisten = undefined;
  unlistenPending = undefined;
  useLiveBriefStore.getState().reset();
}
