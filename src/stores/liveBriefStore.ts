import { create } from "zustand";
import type { UnlistenFn } from "@tauri-apps/api/event";

import {
  getLiveBriefs,
  getLiveEvents,
  onLiveBriefUpdate,
  LIVE_EVENT_DETAIL_LIMIT,
  LIVE_EVENT_LIST_LIMIT,
  type LiveSessionBrief,
  type LiveSessionEvents,
  type SemanticEventEnvelope,
} from "../lib/livebrief";

/** 詳細 (選択中 1 セッション) の取得間隔。 */
export const LIVE_EVENT_POLL_MS = 1_500;
/** 一覧 (表示中の全セッション) の取得間隔。動きが無ければ下の上限まで伸ばす。 */
export const LIVE_EVENT_LIST_POLL_MS = 3_000;
export const LIVE_EVENT_LIST_POLL_MAX_MS = 6_000;
/** 1 回の一覧バッチに載せるセッション数の上限。 */
export const LIVE_EVENT_VISIBLE_LIMIT = 60;
/** 一覧応答がこの回数だけ連続で全 briefRevision 不変なら間隔を倍にする。 */
const LIST_BACKOFF_STREAK = 2;

type BriefMap = Record<string, LiveSessionBrief>;

interface LiveBriefStoreState {
  briefsBySession: BriefMap;
  /** 詳細 (選択中・深い limit) 専用のイベント。一覧の浅い取得で踏まない。 */
  eventsBySession: Record<string, SemanticEventEnvelope[]>;
  /** イベントを取得した時刻 (ms)。取得済みかどうかの判定にも使う。 */
  eventsFetchedAtBySession: Record<string, number>;
  /** 一覧行 (表示中の全セッション・浅い limit) 専用のイベント。 */
  listEventsBySession: Record<string, SemanticEventEnvelope[]>;
  listEventsFetchedAtBySession: Record<string, number>;
  applyBrief: (brief: LiveSessionBrief) => void;
  applyBriefs: (briefs: readonly LiveSessionBrief[]) => void;
  applyEvents: (sessionId: string, events: SemanticEventEnvelope[], fetchedAt: number) => void;
  applyEventsBatch: (entries: readonly LiveSessionEvents[], fetchedAt: number) => void;
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
  listEventsBySession: {},
  listEventsFetchedAtBySession: {},
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
  // 1 回の set() で全キーを入れ替える (セッション数ぶん再描画を撃たない)。
  applyEventsBatch: (entries, fetchedAt) => set((state) => {
    if (!entries.length) return state;
    const listEventsBySession = { ...state.listEventsBySession };
    const listEventsFetchedAtBySession = { ...state.listEventsFetchedAtBySession };
    for (const entry of entries) {
      listEventsBySession[entry.ptySessionId] = entry.events;
      listEventsFetchedAtBySession[entry.ptySessionId] = fetchedAt;
    }
    return { listEventsBySession, listEventsFetchedAtBySession };
  }),
  reset: () => set({
    briefsBySession: {},
    eventsBySession: {},
    eventsFetchedAtBySession: {},
    listEventsBySession: {},
    listEventsFetchedAtBySession: {},
  }),
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

// --- イベント取得は「一覧バッチ」と「選択中 1 本」の 2 系統 -----------------
// 別スライス (listEventsBySession / eventsBySession) に書き分けるので、浅い一覧が
// 深い詳細を上書きすることが構造上ありえない。
let detailSessionId: string | null = null;
let detailTimer: ReturnType<typeof setInterval> | undefined;
let detailInFlight = false;

let listIds: string[] = [];
let listTimer: ReturnType<typeof setInterval> | undefined;
let listInFlight = false;
let listIntervalMs = LIVE_EVENT_LIST_POLL_MS;
let listUnchangedStreak = 0;
let lastListRevisions: Map<string, number> | null = null;
let visibilityHooked = false;

function isHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function clampVisibleIds(ids: readonly string[]): string[] {
  const unique: string[] = [];
  for (const id of ids) {
    if (!id || unique.includes(id)) continue;
    unique.push(id);
    if (unique.length >= LIVE_EVENT_VISIBLE_LIMIT) break;
  }
  return unique;
}

/** 1 回だけ選択中セッションのイベントを取り直す。詳細スライスにだけ書く。 */
export async function ensureEvents(sessionId: string, limit: number = LIVE_EVENT_DETAIL_LIMIT): Promise<void> {
  if (detailInFlight) return;
  detailInFlight = true;
  try {
    const snapshot = await getLiveEvents([sessionId], limit);
    const entry = snapshot.find((item) => item.ptySessionId === sessionId);
    useLiveBriefStore.getState().applyEvents(sessionId, entry?.events ?? [], Date.now());
  } catch {
    // 取得できない間は前回の行を出したままにする (画面を空にしない)。
  } finally {
    detailInFlight = false;
  }
}

/** 表示中セッションぶんを 1 往復で取り直す。一覧スライスにだけ書く。 */
async function fetchListBatch(): Promise<void> {
  if (listInFlight || !listIds.length) return;
  listInFlight = true;
  try {
    const snapshot = await getLiveEvents([...listIds], LIVE_EVENT_LIST_LIMIT);
    useLiveBriefStore.getState().applyEventsBatch(snapshot, Date.now());
    applyListBackoff(snapshot);
  } catch {
    // 取得できない間は前回の行を出したままにする (一覧を空にしない)。
  } finally {
    listInFlight = false;
  }
}

/** 全 briefRevision が動かない状態が続いたら一覧の間隔を伸ばす。動いたら戻す。 */
function applyListBackoff(snapshot: readonly LiveSessionEvents[]): void {
  const next = new Map(snapshot.map((entry) => [entry.ptySessionId, entry.briefRevision] as const));
  const previous = lastListRevisions;
  lastListRevisions = next;
  const changed = previous === null
    || previous.size !== next.size
    || [...next].some(([id, revision]) => previous.get(id) !== revision);
  if (changed) {
    listUnchangedStreak = 0;
    if (listIntervalMs !== LIVE_EVENT_LIST_POLL_MS) {
      listIntervalMs = LIVE_EVENT_LIST_POLL_MS;
      rearmListTimer();
    }
    return;
  }
  listUnchangedStreak += 1;
  if (listUnchangedStreak < LIST_BACKOFF_STREAK) return;
  listUnchangedStreak = 0;
  const slower = Math.min(listIntervalMs * 2, LIVE_EVENT_LIST_POLL_MAX_MS);
  if (slower === listIntervalMs) return;
  listIntervalMs = slower;
  rearmListTimer();
}

/** 間隔だけ張り替える (即時の 1 打ちはしない)。 */
function rearmListTimer(): void {
  if (listTimer === undefined) return;
  clearInterval(listTimer);
  listTimer = setInterval(() => { void fetchListBatch(); }, listIntervalMs);
}

function stopListTimer(): void {
  if (listTimer !== undefined) clearInterval(listTimer);
  listTimer = undefined;
}

function stopDetailTimer(): void {
  if (detailTimer !== undefined) clearInterval(detailTimer);
  detailTimer = undefined;
}

function startListPolling(): void {
  stopListTimer();
  if (!listIds.length || isHidden()) return;
  void fetchListBatch();
  listTimer = setInterval(() => { void fetchListBatch(); }, listIntervalMs);
}

function startDetailPolling(): void {
  stopDetailTimer();
  if (!detailSessionId || isHidden()) return;
  void ensureEvents(detailSessionId);
  detailTimer = setInterval(() => {
    if (detailSessionId) void ensureEvents(detailSessionId);
  }, LIVE_EVENT_POLL_MS);
}

function onVisibilityChange(): void {
  if (isHidden()) {
    stopListTimer();
    stopDetailTimer();
    return;
  }
  startListPolling();
  startDetailPolling();
}

function attachVisibilityListener(): void {
  if (visibilityHooked || typeof document === "undefined") return;
  visibilityHooked = true;
  document.addEventListener("visibilitychange", onVisibilityChange);
}

function detachVisibilityListener(): void {
  if (!visibilityHooked || typeof document === "undefined") return;
  visibilityHooked = false;
  document.removeEventListener("visibilitychange", onVisibilityChange);
}

/**
 * ダッシュボードが要るイベント取得をまとめて張り直す。
 * 一覧 = 表示中の全セッションを浅く、詳細 = 選択中 1 本だけ深く。
 */
export function syncDashboardEvents(opts: { selectedId: string | null; visibleIds: string[] }): void {
  attachVisibilityListener();

  const ids = clampVisibleIds(opts.visibleIds);
  const listChanged = ids.join(",") !== listIds.join(",");
  listIds = ids;
  if (listChanged) {
    lastListRevisions = null;
    listUnchangedStreak = 0;
    listIntervalMs = LIVE_EVENT_LIST_POLL_MS;
  }
  if (listChanged || (ids.length && listTimer === undefined && !isHidden())) startListPolling();
  if (!ids.length) stopListTimer();

  const detailChanged = opts.selectedId !== detailSessionId;
  detailSessionId = opts.selectedId;
  if (detailChanged || (detailSessionId && detailTimer === undefined && !isHidden())) startDetailPolling();
  if (!detailSessionId) stopDetailTimer();
}

/** 一覧・詳細どちらのポーリングも止める。 */
export function stopEventPolling(): void {
  stopListTimer();
  stopDetailTimer();
  listIds = [];
  detailSessionId = null;
  listIntervalMs = LIVE_EVENT_LIST_POLL_MS;
  listUnchangedStreak = 0;
  lastListRevisions = null;
  detachVisibilityListener();
}

export function __resetLiveBriefStoreForTests(): void {
  stopEventPolling();
  listInFlight = false;
  detailInFlight = false;
  subscriberCount = 0;
  unlisten = undefined;
  unlistenPending = undefined;
  useLiveBriefStore.getState().reset();
}
