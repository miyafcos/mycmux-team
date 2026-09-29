import { create } from "zustand";
import type { UnlistenFn } from "@tauri-apps/api/event";

import {
  getLiveBriefs,
  getLiveEvents,
  onLiveBriefUpdate,
  subscribeLiveBriefs,
  unsubscribeLiveBriefs,
  LIVE_EVENT_DETAIL_LIMIT,
  LIVE_EVENT_LIST_LIMIT,
  type LiveSessionBrief,
  type LiveSessionEvents,
  type SemanticEventEnvelope,
} from "../lib/livebrief";

/** 詳細 (開いている会話すべて) の取得間隔。 */
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
  /** 詳細 (開いている会話・深い limit) 専用のイベント。一覧の浅い取得で踏まない。 */
  eventsBySession: Record<string, SemanticEventEnvelope[]>;
  /** イベントを取得した時刻 (ms)。取得済みかどうかの判定にも使う。 */
  eventsFetchedAtBySession: Record<string, number>;
  /** 一覧行 (表示中の全セッション・浅い limit) 専用のイベント。 */
  listEventsBySession: Record<string, SemanticEventEnvelope[]>;
  listEventsFetchedAtBySession: Record<string, number>;
  applyBrief: (brief: LiveSessionBrief) => void;
  applyBriefs: (briefs: readonly LiveSessionBrief[]) => void;
  applyEvents: (sessionId: string, events: SemanticEventEnvelope[], fetchedAt: number) => void;
  applyDetailBatch: (entries: ReadonlyArray<{ ptySessionId: string; events: SemanticEventEnvelope[] }>, fetchedAt: number) => void;
  applyEventsBatch: (entries: readonly LiveSessionEvents[], fetchedAt: number) => void;
  /** 詳細スライスを `keep` に無いセッションぶんだけ捨てる。取得が止まった古い行を最新より優先させない。 */
  dropDetailExcept: (keep: ReadonlySet<string>) => void;
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
  // 1 回の set() で全キーを入れ替える (開いている会話の数ぶん再描画を撃たない)。
  applyDetailBatch: (entries, fetchedAt) => set((state) => {
    if (!entries.length) return state;
    const eventsBySession = { ...state.eventsBySession };
    const eventsFetchedAtBySession = { ...state.eventsFetchedAtBySession };
    for (const entry of entries) {
      eventsBySession[entry.ptySessionId] = entry.events;
      eventsFetchedAtBySession[entry.ptySessionId] = fetchedAt;
    }
    return { eventsBySession, eventsFetchedAtBySession };
  }),
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
  dropDetailExcept: (keep) => set((state) => {
    const stale = Object.keys(state.eventsBySession).filter((sessionId) => !keep.has(sessionId));
    const staleFetched = Object.keys(state.eventsFetchedAtBySession).filter((sessionId) => !keep.has(sessionId));
    if (!stale.length && !staleFetched.length) return state;
    const eventsBySession = { ...state.eventsBySession };
    const eventsFetchedAtBySession = { ...state.eventsFetchedAtBySession };
    for (const sessionId of stale) delete eventsBySession[sessionId];
    for (const sessionId of staleFetched) delete eventsFetchedAtBySession[sessionId];
    return { eventsBySession, eventsFetchedAtBySession };
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
let connectionGeneration = 0;
let backendSubscribed: boolean | undefined = false;
let backendSubscriptionInFlight = false;
let backendSubscriptionQueue: Promise<void> = Promise.resolve();
let briefVisibilityHooked = false;
let listenerPendingGeneration: number | undefined;

function updateBackendSubscription(): void {
  const shouldSubscribe = subscriberCount > 0 && !isHidden();
  if (backendSubscriptionInFlight || backendSubscribed === shouldSubscribe) return;
  backendSubscriptionInFlight = true;
  backendSubscriptionQueue = Promise.resolve()
    .then(() => shouldSubscribe ? subscribeLiveBriefs() : unsubscribeLiveBriefs())
    .then(() => { backendSubscribed = shouldSubscribe; })
    .catch(() => { backendSubscribed = undefined; })
    .finally(() => {
      backendSubscriptionInFlight = false;
      // Reconcile a visibility/release change that happened during the IPC.
      // A failure with unchanged intent waits for the next poll or visibility event.
      if (shouldSubscribe !== (subscriberCount > 0 && !isHidden())) updateBackendSubscription();
    });
}

function ensureBriefListener(): void {
  if (!subscriberCount || unlisten || listenerPendingGeneration === connectionGeneration) return;
  const generation = connectionGeneration;
  listenerPendingGeneration = generation;
  void onLiveBriefUpdate((brief) => {
    if (generation === connectionGeneration && subscriberCount > 0) {
      useLiveBriefStore.getState().applyBrief(brief);
    }
  }).then((dispose) => {
    if (generation !== connectionGeneration || subscriberCount === 0) dispose();
    else unlisten = dispose;
  }).catch(() => {}).finally(() => {
    if (listenerPendingGeneration === generation) listenerPendingGeneration = undefined;
  });
}

function retryBriefConnection(): void {
  updateBackendSubscription();
  ensureBriefListener();
}

function onBriefVisibilityChange(): void {
  retryBriefConnection();
  if (subscriberCount > 0 && !isHidden()) {
    void refreshLiveBriefs();
  }
}

function refreshLiveBriefs(): Promise<void> {
  return backendSubscriptionQueue
    .then(() => getLiveBriefs())
    .then((snapshot) => useLiveBriefStore.getState().applyBriefs(snapshot))
    .catch(() => {});
}

function attachBriefVisibilityListener(): void {
  if (briefVisibilityHooked || typeof document === "undefined") return;
  briefVisibilityHooked = true;
  document.addEventListener("visibilitychange", onBriefVisibilityChange);
}

function detachBriefVisibilityListener(): void {
  if (!briefVisibilityHooked || typeof document === "undefined") return;
  briefVisibilityHooked = false;
  document.removeEventListener("visibilitychange", onBriefVisibilityChange);
}

/**
 * brief の購読を開始し、購読解除関数を返す。何個の画面から呼ばれても実際の
 * listen は 1 本しか張らない (最後の 1 人が外れたときだけ解除する)。
 */
export function connectLiveBriefStore(): () => void {
  subscriberCount += 1;
  if (subscriberCount === 1) {
    attachBriefVisibilityListener();
    updateBackendSubscription();
    connectionGeneration += 1;
    ensureBriefListener();
    if (!isHidden()) void refreshLiveBriefs();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    subscriberCount = Math.max(0, subscriberCount - 1);
    if (subscriberCount > 0) return;
    updateBackendSubscription();
    detachBriefVisibilityListener();
    unlisten?.();
    unlisten = undefined;
    connectionGeneration += 1;
  };
}

// --- イベント取得は「一覧バッチ」と「詳細バッチ」の 2 系統 ------------------
// 別スライス (listEventsBySession / eventsBySession) に書き分けるので、浅い一覧が
// 深い詳細を上書きすることが構造上ありえない。
//
// Detail ownership covers every open conversation, fetched in bounded batches:
// (アクティブかどうかを問わない) + 選択中 + ペインの会話パネルが hold 中のもの。
// 選択中 1 本だけを深く取っていた頃は、別の列をアクティブにした瞬間から前の列の
// 詳細スライスが二度と更新されないのに「空でない」ので一覧より優先され続け、
// 非アクティブ列の会話がその時点で止まって見えた。
let dashboardDetailIds: string[] = [];
const detailHolds = new Map<string, number>();
let detailTimer: ReturnType<typeof setInterval> | undefined;
let detailInFlight = false;

let listIds: string[] = [];
let listTimer: ReturnType<typeof setInterval> | undefined;
let listInFlight = false;
let listIntervalMs = LIVE_EVENT_LIST_POLL_MS;
let listUnchangedStreak = 0;
let lastListRevisions: Map<string, number> | null = null;
let visibilityHooked = false;

/**
 * ポーリング中は backend の transcript 読み取り (livebrief スレッド) を購読で
 * 起こしておく。`get_live_events` は backend が既に読んだ ring を返すだけなので、
 * 購読者が居ないと (ダッシュボードを閉じたままペインの会話パネルを開いたとき)
 * 止まった ring を 1.5 秒ごとに読み直すだけになり、会話が最後に読んだ時点で
 * 固まって見えた。
 */
let pollingHold: (() => void) | undefined;

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

function uniqueDetailIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter(Boolean))];
}

/** 今この瞬間に深く取るべきセッション (ダッシュボード側 + hold 中)。 */
function detailIds(): string[] {
  return uniqueDetailIds([...dashboardDetailIds, ...detailHolds.keys()]);
}

function reconcilePollingHold(): void {
  const active = listTimer !== undefined || detailTimer !== undefined;
  if (active && !pollingHold) pollingHold = connectLiveBriefStore();
  else if (!active && pollingHold) {
    const release = pollingHold;
    pollingHold = undefined;
    release();
  }
}

/** 集合から外れたセッションの詳細スライスを捨てる (古い行を最新の一覧より優先させない)。 */
function pruneDetailSlices(): void {
  useLiveBriefStore.getState().dropDetailExcept(new Set(detailIds()));
}

/** Refresh every owned detail session, with at most sixty ids in each IPC. */
async function fetchDetailBatch(): Promise<void> {
  retryBriefConnection();
  const ids = detailIds();
  if (detailInFlight || !ids.length) return;
  detailInFlight = true;
  try {
    for (let offset = 0; offset < ids.length; offset += LIVE_EVENT_VISIBLE_LIMIT) {
      if (isHidden()) break;
      const wantedBeforeRequest = new Set(detailIds());
      const batch = ids.slice(offset, offset + LIVE_EVENT_VISIBLE_LIMIT).filter((id) => wantedBeforeRequest.has(id));
      if (!batch.length) continue;
      try {
        const snapshot = await getLiveEvents(batch, LIVE_EVENT_DETAIL_LIMIT);
        const wanted = new Set(detailIds());
        const requested = new Set(batch);
        // Only an explicit entry confirms a loaded transcript; closed columns stay absent.
        const entries = snapshot.filter((entry) => requested.has(entry.ptySessionId) && wanted.has(entry.ptySessionId));
        useLiveBriefStore.getState().applyDetailBatch(entries, Date.now());
      } catch {
        // A failed batch must not starve later held sessions.
      }
    }
  } finally {
    detailInFlight = false;
  }
}

/** 表示中セッションぶんを 1 往復で取り直す。一覧スライスにだけ書く。 */
async function fetchListBatch(): Promise<void> {
  retryBriefConnection();
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
  if (!detailIds().length || isHidden()) return;
  void fetchDetailBatch();
  detailTimer = setInterval(() => { void fetchDetailBatch(); }, LIVE_EVENT_POLL_MS);
}

function onVisibilityChange(): void {
  if (isHidden()) {
    stopListTimer();
    stopDetailTimer();
    reconcilePollingHold();
    return;
  }
  startListPolling();
  startDetailPolling();
  reconcilePollingHold();
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

/** 何も取るものが無くなったら聴取ごと畳む。 */
function settleAfterChange(): void {
  if (!detailIds().length) stopDetailTimer();
  if (!listIds.length) stopListTimer();
  reconcilePollingHold();
  if (listTimer === undefined && detailTimer === undefined && !listIds.length && !detailIds().length) {
    detachVisibilityListener();
  }
}

/**
 * ダッシュボードが要るイベント取得をまとめて張り直す。
 * 一覧 = 表示中の全セッションを浅く、詳細 = 開いている列 + 選択中を深く。
 */
export function syncDashboardEvents(opts: { selectedId: string | null; visibleIds: string[]; detailIds?: readonly string[] }): void {
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

  const wantedDetail = uniqueDetailIds([opts.selectedId ?? "", ...(opts.detailIds ?? [])]);
  const detailChanged = wantedDetail.join(",") !== dashboardDetailIds.join(",");
  dashboardDetailIds = wantedDetail;
  if (detailChanged) pruneDetailSlices();
  if (detailChanged || (detailIds().length && detailTimer === undefined && !isHidden())) startDetailPolling();

  settleAfterChange();
}

/**
 * 1 セッションの詳細を、ダッシュボードの開閉と無関係に取り続ける (ペインの
 * 会話パネル用)。返り値で解放する。同じセッションを何枚が hold しても取得は 1 本。
 */
export function holdDetailSession(sessionId: string): () => void {
  attachVisibilityListener();
  const fresh = !detailIds().includes(sessionId);
  detailHolds.set(sessionId, (detailHolds.get(sessionId) ?? 0) + 1);
  if (fresh || (detailTimer === undefined && !isHidden())) startDetailPolling();
  reconcilePollingHold();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (detailHolds.get(sessionId) ?? 1) - 1;
    if (remaining <= 0) detailHolds.delete(sessionId);
    else detailHolds.set(sessionId, remaining);
    pruneDetailSlices();
    settleAfterChange();
  };
}

/** ダッシュボード側の一覧・詳細を止める。パネルの hold は残る。 */
export function stopEventPolling(): void {
  listIds = [];
  dashboardDetailIds = [];
  listIntervalMs = LIVE_EVENT_LIST_POLL_MS;
  listUnchangedStreak = 0;
  lastListRevisions = null;
  stopListTimer();
  pruneDetailSlices();
  settleAfterChange();
}

export function __resetLiveBriefStoreForTests(): void {
  detailHolds.clear();
  pollingHold = undefined;
  stopEventPolling();
  stopDetailTimer();
  detachVisibilityListener();
  listInFlight = false;
  detailInFlight = false;
  subscriberCount = 0;
  backendSubscribed = false;
  backendSubscriptionInFlight = false;
  listenerPendingGeneration = undefined;
  backendSubscriptionQueue = Promise.resolve();
  detachBriefVisibilityListener();
  unlisten = undefined;
  connectionGeneration += 1;
  useLiveBriefStore.getState().reset();
}
