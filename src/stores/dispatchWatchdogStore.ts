import { create } from "zustand";

import { focusController } from "../lib/focusController";
import { dispatchClaimWatchdog, dispatchScan, type DispatchEntry } from "../lib/ipc";
import { getTabDisplayLabel } from "../lib/tabDisplayLabel";
import type { Pane, PaneTab, Workspace } from "../types";
import { useDashboardViewStore } from "./dashboardViewStore";
import { useSettingsStore } from "./settingsStore";
import { type StallEntry, useStallStore } from "./stallStore";
import { usePaneMetadataStore, useUiStore, useWorkspaceLayoutStore, useWorkspaceListStore } from "./workspaceStore";
import { useSessionAttentionStore } from "./sessionAttentionStore";
import { useToastStore } from "./toastStore";
import { delegationWatchStrings } from "../components/settings/settingsStrings";

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

/**
 * Kinds that raise a toast: each one needs a person to act inside the pane.
 * Timeouts, unverified completions and log-age stalls stay in the queue only.
 * Log age is read per working directory, so a parent session in the same
 * folder keeps it fresh and those kinds cannot be trusted as alarms.
 */
export type NotifyKind = keyof typeof delegationWatchStrings.toastSituations;
export const NOTIFY_KINDS: ReadonlySet<WatchdogKind> = new Set<WatchdogKind>(["ask", "done_needs_review", "tab_queued_input"]);

function isNotifyKind(kind: WatchdogKind): kind is NotifyKind {
  return NOTIFY_KINDS.has(kind);
}

/**
 * Ledger statuses with no pane left to watch. Mirrors INACTIVE_STATUSES in
 * session-dispatch's dispatch_ledger.py and ledger.rs.
 */
export const INACTIVE_DISPATCH_STATUSES: ReadonlySet<string> = new Set([
  "closed", "done-verified-closed", "abandoned", "fallback-inline", "lost",
]);

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

export interface DispatchWatchdogTelemetry {
  running: boolean;
  lastTickAt: number | null;
  nextTickDueAt: number | null;
  lastSkipReason: "hidden" | "not-main-window" | "disabled" | null;
  notifySuppressed: boolean;
}

const INITIAL_TELEMETRY: DispatchWatchdogTelemetry = {
  running: false,
  lastTickAt: null,
  nextTickDueAt: null,
  lastSkipReason: null,
  notifySuppressed: false,
};

/** Display-only telemetry helpers; they do not participate in watchdog decisions. */
export function telemetryForTick(checkedAt: number, intervalMinutes: number, notifyEnabled: boolean): Partial<DispatchWatchdogTelemetry> {
  return {
    running: true,
    lastTickAt: checkedAt,
    nextTickDueAt: checkedAt + Math.max(1, intervalMinutes) * MINUTE_MS,
    lastSkipReason: null,
    notifySuppressed: !notifyEnabled,
  };
}

export function telemetryForSkip(reason: NonNullable<DispatchWatchdogTelemetry["lastSkipReason"]>): Partial<DispatchWatchdogTelemetry> {
  return {
    running: false,
    lastTickAt: null,
    nextTickDueAt: null,
    lastSkipReason: reason,
    notifySuppressed: false,
  };
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

function withConfirmation(item: Omit<WatchdogItem, "confirmations">, previous: ReadonlyMap<string, WatchdogItem>): WatchdogItem {
  return { ...item, confirmations: (previous.get(item.key)?.confirmations ?? 0) + 1 };
}

function ledgerItem(entry: DispatchEntry, kind: WatchdogKind, since: number, occurrenceKey?: string): Omit<WatchdogItem, "confirmations"> {
  return {
    // Evidence files change while the same outstanding task is being worked.
    // Their mtimes must not turn that continuing state into a new occurrence.
    key: occurrenceKey ? `${entry.slug}:${kind}:${occurrenceKey}` : `${entry.slug}:${kind}`,
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
    if (entry.status && INACTIVE_DISPATCH_STATUSES.has(entry.status)) continue;
    // Every finding must point at a pane the user can open. Rows whose pane is
    // gone, or was never recorded, once filled the toasts with slugs of runs
    // that had ended weeks earlier (0 of 102 open rows had a live pane).
    if (!entry.tabSessionId || !input.knownSessionIds.has(entry.tabSessionId)) continue;

    const spawnedAt = parseTimestamp(entry.ts);
    if (spawnedAt === null) continue;
    const elapsed = Math.max(0, input.now - spawnedAt);
    const logAgeMs = entry.sessionLogAgeMinutes * MINUTE_MS;
    let item: Omit<WatchdogItem, "confirmations"> | null = null;

    // no_log intentionally remains eligible after 90 seconds. Applying the
    // broader five-minute spawn grace first would make this documented state
    // unreachable.
    if (entry.sessionLogAgeMinutes < 0 && elapsed >= NO_LOG_MIN_MS && elapsed < SPAWN_GRACE_MS) {
      item = ledgerItem(entry, "no_log", spawnedAt);
    } else if (elapsed < SPAWN_GRACE_MS) {
      continue;
    } else if (entry.hasAsk) {
      item = ledgerItem(entry, "ask", entry.askMtimeMs ?? spawnedAt);
    } else if (entry.liveState === "RATE_LIMITED") {
      // Ranked above the stalled checks on purpose. A rate-limited session stops
      // writing its transcript, so it looks identical to a hang by log age alone.
      const attention = input.attentionBySession?.[entry.tabSessionId ?? ""];
      const stateSince = attention?.stateSince ?? spawnedAt;
      const attentionId = attention?.attentionId ?? "unknown";
      item = ledgerItem(entry, "rate_limited", stateSince, `${attentionId}:${stateSince}`);
    } else if (entry.hasDone && !entry.hasVerdict) {
      item = ledgerItem(entry, "done_unverified", entry.doneMtimeMs ?? spawnedAt);
    } else if (entry.hasVerdict && entry.verify === "auto-fail") {
      item = ledgerItem(entry, "done_needs_review", entry.verdictMtimeMs ?? entry.doneMtimeMs ?? spawnedAt);
    } else {
      if (entry.sessionLogAgeMinutes >= input.stallMinutes && input.attentionBySession?.[entry.tabSessionId ?? ""]?.uiState !== "working") {
        const since = input.now - logAgeMs;
        item = ledgerItem(entry, "stalled", since);
      } else if (elapsed >= TIMEOUT_MS) {
        item = ledgerItem(entry, "timeout", spawnedAt);
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
  telemetry: DispatchWatchdogTelemetry;
  replaceQueue: (queue: WatchdogItem[]) => void;
  markNotified: (keys: readonly string[]) => void;
  setTelemetry: (telemetry: Partial<DispatchWatchdogTelemetry>) => void;
  clear: () => void;
}

export const useDispatchWatchdogStore = create<DispatchWatchdogState>((set) => ({
  queue: [],
  notifiedKeys: new Set(),
  telemetry: INITIAL_TELEMETRY,
  replaceQueue: (queue) => set((state) => {
    const activeKeys = new Set(queue.map((item) => item.key));
    return {
      queue,
      notifiedKeys: new Set([...state.notifiedKeys].filter((key) => activeKeys.has(key))),
    };
  }),
  markNotified: (keys) => set((state) => {
    const notifiedKeys = new Set(state.notifiedKeys);
    for (const key of keys) notifiedKeys.add(key);
    return { notifiedKeys };
  }),
  setTelemetry: (telemetry) => set((state) => ({ telemetry: { ...state.telemetry, ...telemetry } })),
  clear: () => set({ queue: [], notifiedKeys: new Set(), telemetry: INITIAL_TELEMETRY }),
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
  ...delegationWatchStrings.kindLabels,
};

interface SessionLocation {
  workspace: Workspace;
  pane: Pane;
  tab: PaneTab;
}

function locateSession(sessionId: string): SessionLocation | null {
  for (const workspace of useWorkspaceListStore.getState().workspaces) {
    for (const pane of workspace.panes) {
      const tab = pane.tabs.find((candidate) => candidate.sessionId === sessionId)
        ?? (pane.sessionId === sessionId ? pane.tabs.find((candidate) => candidate.id === pane.activeTabId) : undefined);
      if (tab) return { workspace, pane, tab };
    }
  }
  return null;
}

/** Brings the pane a watch toast is about to the front, the way the dashboard jump does. */
export function openWatchdogSession(sessionId: string): void {
  const location = locateSession(sessionId);
  if (!location) return;
  const { workspace, pane, tab } = location;
  const dashboard = useDashboardViewStore.getState();
  if (dashboard.open) dashboard.close();
  if (useWorkspaceListStore.getState().activeWorkspaceId !== workspace.id) {
    useWorkspaceListStore.getState().setActiveWorkspace(workspace.id);
  }
  const zoomedPaneId = useUiStore.getState().zoomedPaneId;
  useWorkspaceLayoutStore.getState().setActivePaneTab(workspace.id, pane.id, tab.id);
  if (zoomedPaneId !== null && zoomedPaneId !== pane.id) useUiStore.getState().setZoomedPaneId(pane.id);
  if (tab.type === undefined || tab.type === "terminal") {
    focusController.request("programmatic", { sessionId: tab.sessionId, focus: true });
  } else {
    focusController.request("programmatic", { sessionId: null, focus: false });
  }
}

function describeWatchdogItem(item: WatchdogItem & { kind: NotifyKind; sessionId: string }, location: SessionLocation): string {
  const { metadata, volatileMetadata } = usePaneMetadataStore.getState();
  const paneLabel = location.tab.label
    ?? item.label
    ?? getTabDisplayLabel(location.tab, location.tab.id === location.pane.activeTabId, metadata, volatileMetadata);
  return delegationWatchStrings.toastItem(paneLabel, location.workspace.name, delegationWatchStrings.toastSituations[item.kind]);
}

export function connectDispatchWatchdog(): () => void {
  let intervalId: number | undefined;
  let disposed = false;
  let tickRunning = false;

  const setTelemetrySafely = (telemetry: Partial<DispatchWatchdogTelemetry>): void => {
    try {
      useDispatchWatchdogStore.getState().setTelemetry(telemetry);
    } catch (error) {
      console.warn("[dispatch-watchdog] Telemetry update failed", error);
    }
  };

  const tick = async (): Promise<void> => {
    if (disposed || tickRunning) return;
    if (document.visibilityState !== "visible") {
      setTelemetrySafely(telemetryForSkip("hidden"));
      return;
    }
    tickRunning = true;
    const checkedAt = Date.now();
    try {
      const settings = useSettingsStore.getState();
      if (!settings.dispatchWatchdogEnabled) {
        setTelemetrySafely(telemetryForSkip("disabled"));
        useDispatchWatchdogStore.getState().replaceQueue([]);
        return;
      }
      const ownsNotificationLease = await dispatchClaimWatchdog(settings.dispatchWatchdogIntervalMinutes * MINUTE_MS * 3);
      const entries = await dispatchScan();
      if (disposed) return;
      const notificationsAllowed = settings.notificationsEnabled && settings.dispatchWatchdogNotify;
      setTelemetrySafely(telemetryForTick(checkedAt, settings.dispatchWatchdogIntervalMinutes, notificationsAllowed));
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
      if (!ownsNotificationLease || !notificationsAllowed) return;

      const state = useDispatchWatchdogStore.getState();
      const notified: string[] = [];
      for (const item of queue) {
        if (notified.length >= MAX_TOASTS_PER_TICK) break;
        if (!isNotifyKind(item.kind) || !item.sessionId || item.confirmations < 2 || state.notifiedKeys.has(item.key)) continue;
        const location = locateSession(item.sessionId);
        if (!location) continue;
        const sessionId = item.sessionId;
        useToastStore.getState().pushToast(
          describeWatchdogItem({ ...item, kind: item.kind, sessionId }, location),
          "warning",
          { label: delegationWatchStrings.toastOpenAction, run: () => openWatchdogSession(sessionId) },
        );
        usePaneMetadataStore.getState().incrementNotification(sessionId);
        notified.push(item.key);
      }
      // Only the items we actually showed are marked as seen, so anything past
      // the per-tick cap surfaces on a later tick. There is no list to send a
      // "N more" toast to, so none is shown.
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
    if (document.visibilityState !== "visible") {
      setTelemetrySafely(telemetryForSkip("hidden"));
      return;
    }
    void tick();
    const minutes = Math.max(1, useSettingsStore.getState().dispatchWatchdogIntervalMinutes);
    intervalId = window.setInterval(() => void tick(), minutes * MINUTE_MS);
  };
  const onVisibilityChange = (): void => startInterval();
  const unsubscribeSettings = useSettingsStore.subscribe((state, previous) => {
    if (state.dispatchWatchdogEnabled !== previous.dispatchWatchdogEnabled
      || state.dispatchWatchdogIntervalMinutes !== previous.dispatchWatchdogIntervalMinutes
      || state.dispatchWatchdogNotify !== previous.dispatchWatchdogNotify
      || state.notificationsEnabled !== previous.notificationsEnabled) startInterval();
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
