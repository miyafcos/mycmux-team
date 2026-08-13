import { create } from "zustand";

import { dispatchClaimWatchdog, dispatchScan, type DispatchEntry } from "../lib/ipc";
import { useSettingsStore } from "./settingsStore";
import { type StallEntry, useStallStore } from "./stallStore";
import { usePaneMetadataStore, useWorkspaceListStore } from "./workspaceStore";
import { useSessionAttentionStore } from "./sessionAttentionStore";
import { useToastStore } from "./toastStore";

const MINUTE_MS = 60_000;
const SPAWN_GRACE_MS = 5 * MINUTE_MS;
const NO_LOG_MIN_MS = 90_000;
const TIMEOUT_MS = 180 * MINUTE_MS;
const MAX_TOASTS_PER_TICK = 3;

export type WatchdogKind =
  | "ask" | "rate_limited" | "done_unverified" | "done_needs_review" | "no_log" | "stalled" | "timeout"
  | "tab_no_output" | "tab_queued_input" | "tab_silent";

/**
 * Kinds that describe a session legitimately waiting rather than stuck.
 * Later phases must not poke these or run their verification gate: a 429 clears
 * on its own, and prodding it only burns more of the limit it is waiting out.
 */
export const WAITING_KINDS: ReadonlySet<WatchdogKind> = new Set<WatchdogKind>(["ask", "rate_limited"]);

export interface WatchdogItem {
  key: string;
  kind: WatchdogKind;
  slug?: string;
  sessionId?: string;
  label?: string;
  since: number;
  confirmations: number;
  detail?: string;
}

export interface WatchdogAttention {
  uiState?: string;
  attentionId?: string | null;
  stateSince?: number;
}

export interface BuildWatchdogQueueInput {
  entries: readonly DispatchEntry[];
  stallEntries: Readonly<Record<string, StallEntry>>;
  knownSessionIds: ReadonlySet<string>;
  previous: readonly WatchdogItem[];
  now: number;
  stallMinutes: number;
  attentionBySession?: Readonly<Record<string, WatchdogAttention | undefined>>;
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function minuteStamp(timestamp: number): number {
  return Math.floor(timestamp / MINUTE_MS);
}

function withConfirmation(item: Omit<WatchdogItem, "confirmations">, previous: ReadonlyMap<string, WatchdogItem>): WatchdogItem {
  return { ...item, confirmations: (previous.get(item.key)?.confirmations ?? 0) + 1 };
}

function ledgerItem(entry: DispatchEntry, kind: WatchdogKind, since: number, evidenceStamp: string | number): Omit<WatchdogItem, "confirmations"> {
  return {
    key: `${entry.slug}:${kind}:${evidenceStamp}`,
    kind,
    slug: entry.slug,
    sessionId: entry.tabSessionId ?? undefined,
    label: entry.label ?? undefined,
    since,
  };
}

export function buildWatchdogQueue(input: BuildWatchdogQueueInput): { queue: WatchdogItem[]; abandonedSlugs: string[] } {
  const previous = new Map(input.previous.map((item) => [item.key, item]));
  const queue: WatchdogItem[] = [];
  const abandonedSlugs: string[] = [];
  const ledgerSessionIds = new Set<string>();

  for (const entry of input.entries) {
    if (entry.tabSessionId) ledgerSessionIds.add(entry.tabSessionId);
    if (entry.tabSessionId && !input.knownSessionIds.has(entry.tabSessionId)) abandonedSlugs.push(entry.slug);
    if (entry.status === "closed" || entry.status === "abandoned") continue;

    const spawnedAt = parseTimestamp(entry.ts);
    if (spawnedAt === null) continue;
    const elapsed = Math.max(0, input.now - spawnedAt);
    const logAgeMs = entry.sessionLogAgeMinutes * MINUTE_MS;
    let item: Omit<WatchdogItem, "confirmations"> | null = null;

    // no_log intentionally remains eligible after 90 seconds. Applying the
    // broader five-minute spawn grace first would make this documented state
    // unreachable.
    if (entry.sessionLogAgeMinutes < 0 && elapsed >= NO_LOG_MIN_MS && elapsed < SPAWN_GRACE_MS) {
      item = ledgerItem(entry, "no_log", spawnedAt, minuteStamp(spawnedAt));
    } else if (elapsed < SPAWN_GRACE_MS) {
      continue;
    } else if (entry.hasAsk) {
      item = ledgerItem(entry, "ask", entry.askMtimeMs ?? spawnedAt, entry.askMtimeMs ?? spawnedAt);
    } else if (entry.liveState === "RATE_LIMITED") {
      // Ranked above the stalled checks on purpose. A rate-limited session stops
      // writing its transcript, so it looks identical to a hang by log age alone.
      const attention = input.attentionBySession?.[entry.tabSessionId ?? ""];
      const stateSince = attention?.stateSince ?? spawnedAt;
      const attentionId = attention?.attentionId ?? "unknown";
      item = ledgerItem(entry, "rate_limited", stateSince, `${attentionId}:${stateSince}`);
    } else if (entry.hasDone && !entry.hasVerdict) {
      item = ledgerItem(entry, "done_unverified", entry.doneMtimeMs ?? spawnedAt, entry.doneMtimeMs ?? spawnedAt);
    } else if (entry.hasVerdict && entry.verify === "auto-fail") {
      item = ledgerItem(entry, "done_needs_review", entry.verdictMtimeMs ?? entry.doneMtimeMs ?? spawnedAt, entry.verdictMtimeMs ?? entry.doneMtimeMs ?? spawnedAt);
    } else {
      if (entry.sessionLogAgeMinutes >= input.stallMinutes && input.attentionBySession?.[entry.tabSessionId ?? ""]?.uiState !== "working") {
        const since = input.now - logAgeMs;
        item = ledgerItem(entry, "stalled", since, minuteStamp(since));
      } else if (elapsed >= TIMEOUT_MS) {
        item = ledgerItem(entry, "timeout", spawnedAt, minuteStamp(spawnedAt));
      }
    }
    if (item) queue.push(withConfirmation(item, previous));
  }

  for (const [sessionId, entry] of Object.entries(input.stallEntries)) {
    if (ledgerSessionIds.has(sessionId) || entry.reason === "pty_dead") continue;
    const kind = entry.reason === "no_output"
      ? "tab_no_output"
      : entry.reason === "queued_input"
        ? "tab_queued_input"
        : "tab_silent";
    queue.push(withConfirmation({
      key: `${sessionId}:${kind}:${entry.since}`,
      kind,
      sessionId,
      since: entry.since,
      detail: entry.detail,
    }, previous));
  }
  return { queue, abandonedSlugs };
}

interface DispatchWatchdogState {
  queue: WatchdogItem[];
  notifiedKeys: Set<string>;
  replaceQueue: (queue: WatchdogItem[]) => void;
  markNotified: (keys: readonly string[]) => void;
  clear: () => void;
}

export const useDispatchWatchdogStore = create<DispatchWatchdogState>((set) => ({
  queue: [],
  notifiedKeys: new Set(),
  replaceQueue: (queue) => set({ queue }),
  markNotified: (keys) => set((state) => {
    const notifiedKeys = new Set(state.notifiedKeys);
    for (const key of keys) notifiedKeys.add(key);
    return { notifiedKeys };
  }),
  clear: () => set({ queue: [], notifiedKeys: new Set() }),
}));

function knownSessionIds(): Set<string> {
  const ids = new Set<string>();
  for (const workspace of useWorkspaceListStore.getState().workspaces) {
    for (const pane of workspace.panes) {
      ids.add(pane.sessionId);
      for (const tab of pane.tabs) ids.add(tab.sessionId);
    }
  }
  return ids;
}

export const WATCHDOG_KIND_LABELS: Record<WatchdogKind, string> = {
  ask: "判断待ち", rate_limited: "レート制限で待機中",
  done_unverified: "完了・未確認", done_needs_review: "確認が必要な完了",
  no_log: "ログ未作成", stalled: "停止", timeout: "タイムアウト",
  tab_no_output: "出力停止", tab_queued_input: "未送信の入力", tab_silent: "無応答で停止",
};

function describe(item: WatchdogItem): string {
  const subject = item.label ?? item.slug ?? item.sessionId ?? "セッション";
  return `${subject}: ${WATCHDOG_KIND_LABELS[item.kind]}`;
}

export function connectDispatchWatchdog(): () => void {
  let intervalId: number | undefined;
  let disposed = false;
  let tickRunning = false;

  const tick = async (): Promise<void> => {
    if (disposed || tickRunning || document.visibilityState !== "visible") return;
    tickRunning = true;
    try {
      const settings = useSettingsStore.getState();
      if (!settings.dispatchWatchdogEnabled) {
        useDispatchWatchdogStore.getState().replaceQueue([]);
        return;
      }
      const ownsNotificationLease = await dispatchClaimWatchdog(settings.dispatchWatchdogIntervalMinutes * MINUTE_MS * 3);
      const entries = await dispatchScan();
      if (disposed) return;
      const queue = buildWatchdogQueue({
        entries,
        stallEntries: useStallStore.getState().entries,
        knownSessionIds: knownSessionIds(),
        previous: useDispatchWatchdogStore.getState().queue,
        now: Date.now(),
        stallMinutes: settings.dispatchStallMinutes,
        attentionBySession: useSessionAttentionStore.getState().attentionBySession,
      }).queue;
      useDispatchWatchdogStore.getState().replaceQueue(queue);
      if (!ownsNotificationLease || !settings.dispatchWatchdogNotify) return;

      const state = useDispatchWatchdogStore.getState();
      const pending = queue.filter((item) => item.confirmations >= 2 && !state.notifiedKeys.has(item.key));
      const direct = pending.slice(0, MAX_TOASTS_PER_TICK);
      const notified = direct.map((item) => item.key);
      for (const item of direct) {
        useToastStore.getState().pushToast(describe(item), "warning");
        if (item.sessionId) usePaneMetadataStore.getState().incrementNotification(item.sessionId);
      }
      // Only the items we actually showed are marked as seen. The overflow keeps
      // its unseen state so the next tick surfaces it individually instead of
      // collapsing it into a count the user can never expand.
      if (pending.length > MAX_TOASTS_PER_TICK) {
        useToastStore.getState().pushToast(`ほか ${pending.length - MAX_TOASTS_PER_TICK} 件の要確認があります`, "warning");
      }
      if (notified.length > 0) useDispatchWatchdogStore.getState().markNotified(notified);
    } catch (error) {
      console.warn("[dispatch-watchdog] Detection tick failed", error);
    } finally {
      tickRunning = false;
    }
  };

  const stopInterval = (): void => {
    if (intervalId !== undefined) window.clearInterval(intervalId);
    intervalId = undefined;
  };
  const startInterval = (): void => {
    stopInterval();
    if (document.visibilityState !== "visible") return;
    void tick();
    const minutes = Math.max(1, useSettingsStore.getState().dispatchWatchdogIntervalMinutes);
    intervalId = window.setInterval(() => void tick(), minutes * MINUTE_MS);
  };
  const onVisibilityChange = (): void => startInterval();
  const unsubscribeSettings = useSettingsStore.subscribe((state, previous) => {
    if (state.dispatchWatchdogEnabled !== previous.dispatchWatchdogEnabled
      || state.dispatchWatchdogIntervalMinutes !== previous.dispatchWatchdogIntervalMinutes) startInterval();
  });
  document.addEventListener("visibilitychange", onVisibilityChange);
  startInterval();
  return () => {
    disposed = true;
    stopInterval();
    document.removeEventListener("visibilitychange", onVisibilityChange);
    unsubscribeSettings();
    useDispatchWatchdogStore.getState().clear();
  };
}
