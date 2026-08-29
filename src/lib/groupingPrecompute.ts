import { invoke } from "@tauri-apps/api/core";
import {
  groupingPromptPayload,
  runGroupingAnalysis,
  scanGroupingContext,
  TAB_GROUPING_PROMPT_VERSION,
  type GroupingAnalysisResult,
  type GroupingAnalysisStage,
  type GroupingScan,
} from "../components/layout/tabGrouping";
import { hashCanonical } from "./persistentLayoutProjection";
import { useAiSettingsStore } from "../stores/aiSettingsStore";
import { usePaneMetadataStore, type PaneVolatileMetadata } from "../stores/paneMetadataStore";
import { useUiStore } from "../stores/uiStore";
import { useWorkspaceListStore } from "../stores/workspaceListStore";

export const GROUPING_STRUCTURE_DEBOUNCE_MS = 10_000;
export const GROUPING_PTY_QUIET_MS = 30_000;
export const GROUPING_STRUCTURE_MAX_WAIT_MS = 3 * 60_000;
export const GROUPING_SOFT_TTL_MS = 5 * 60_000;
export const GROUPING_INTEREST_LEASE_MS = 30 * 24 * 60 * 60_000;
export const GROUPING_BACKGROUND_DAILY_LIMIT = 6;
/** A scan reads pane metadata over IPC. If that never comes back the panel sits
 *  on "分析しています…" with nothing to show, so give up and say so instead. */
export const GROUPING_SCAN_TIMEOUT_MS = 20_000;
const GROUPING_STARTUP_DELAY_MS = 90_000;
const MAX_TIMER_DELAY_MS = 2_147_000_000;
const INTEREST_STORAGE_KEY = "mycmux.groupingPrecompute.interestUntil.v1";
const BUDGET_STORAGE_KEY = "mycmux.groupingPrecompute.dailyBudget.v1";

type TimerHandle = ReturnType<typeof setTimeout>;
type AiIdentity = {
  enabled: boolean;
  provider: string;
  model: string;
  promptVersion: string;
};

type GroupingFingerprints = {
  structural: string;
  exact: string;
};

type ReadyRecord = {
  analysis: GroupingAnalysisResult;
  ai: AiIdentity;
  layoutRevision: number;
  fingerprints: GroupingFingerprints;
  scannedAt: number;
  generatedAt: number;
  softDirty: boolean;
};

type PendingRecord = {
  generation: number;
  ai: AiIdentity;
  layoutRevision: number;
  mode: "background" | "foreground";
  exactFingerprint: string | null;
  activeRequestId: string | null;
  progressStage: GroupingAnalysisStage | null;
  progressListeners: Set<(stage: GroupingAnalysisStage) => void>;
  promise: Promise<GroupingProductionResult>;
};

export type GroupingPrecomputeMetrics = {
  dirtyEvents: number;
  debouncePasses: number;
  scans: number;
  actualGenerations: number;
  foregroundGenerations: number;
  budgetSkips: number;
};

export type GroupingPrecomputePeek =
  | { kind: "fresh"; analysis: GroupingAnalysisResult; generatedAt: number }
  | {
    kind: "soft-stale";
    /**
     * "output": pane output moved or the plan aged past its soft TTL. The
     * layout is unchanged, so a background refresh is enough.
     * "structure": the layout revision moved under the plan (tabs opened,
     * closed or moved). The plan is still shown, read-only, while a
     * foreground judge re-derives it. Until 2026-08-30 this case discarded
     * the plan as hard-stale, which in a workspace where agents keep opening
     * tabs meant the panel almost never opened with anything to show.
     */
    reason: "output" | "structure";
    analysis: GroupingAnalysisResult;
    generatedAt: number;
  }
  | { kind: "hard-stale"; previousGeneratedAt: number | null }
  | { kind: "pending" }
  | { kind: "miss" };

export type GroupingProductionResult =
  | { kind: "ready"; analysis: GroupingAnalysisResult; generatedAt: number }
  | { kind: "obsolete" };

type StoredBudget = { day: string; count: number };

export interface GroupingPrecomputeDependencies {
  now: () => number;
  setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer: (timer: TimerHandle) => void;
  getAiIdentity: () => AiIdentity;
  getLayoutRevision: () => number;
  getPtyQuietDelay: (now: number) => number;
  getVisibility: () => DocumentVisibilityState;
  subscribeLayout: (listener: () => void) => () => void;
  subscribePty: (listener: () => void) => () => void;
  subscribeAi: (listener: () => void) => () => void;
  subscribeVisibility: (listener: () => void) => () => void;
  scan: () => Promise<GroupingScan>;
  analyze: (
    scan: GroupingScan,
    judge: (prompt: string, requestId: string) => Promise<string>,
    requestId: () => string,
  ) => Promise<GroupingAnalysisResult>;
  analyzeCurrent: (
    judge: (prompt: string, requestId: string) => Promise<string>,
    requestId: () => string,
    onProgress?: (stage: GroupingAnalysisStage) => void,
  ) => Promise<GroupingAnalysisResult>;
  judge: (prompt: string, requestId: string) => Promise<string>;
  abort: (requestId: string) => Promise<unknown>;
  readStorage: (key: string) => string | null;
  writeStorage: (key: string, value: string) => void;
}

export function groupingActivePtyQuietDelay(
  now: number,
  activeSessionId: string | null,
  volatileMetadata: Record<string, PaneVolatileMetadata>,
): number {
  if (!activeSessionId) return 0;
  const metadata = volatileMetadata[activeSessionId];
  if (!metadata) return 0;
  let delay = metadata.outputActive ? GROUPING_PTY_QUIET_MS : 0;
  if (typeof metadata.backendLastOutputAt === "number") {
    delay = Math.max(delay, metadata.backendLastOutputAt + GROUPING_PTY_QUIET_MS - now);
  }
  return Math.max(0, delay);
}

function activePaneSessionId(): string | null {
  const state = useUiStore.getState();
  return state.activePaneId ?? state.lastActivePaneId;
}

function sameAi(left: AiIdentity, right: AiIdentity): boolean {
  return left.enabled === right.enabled
    && left.provider === right.provider
    && left.model === right.model
    && left.promptVersion === right.promptVersion;
}

function sameCheapIdentity(
  ai: AiIdentity,
  layoutRevision: number,
  otherAi: AiIdentity,
  otherLayoutRevision: number,
): boolean {
  return layoutRevision === otherLayoutRevision && sameAi(ai, otherAi);
}

export function groupingFingerprints(scan: GroupingScan): GroupingFingerprints {
  const exact = groupingPromptPayload(scan);
  const structural = {
    ...exact,
    tabs: exact.tabs.map(({ tail: _tail, lastOutputAt: _lastOutputAt, ...tab }) => tab),
  };
  return {
    structural: hashCanonical(structural),
    exact: hashCanonical(exact),
  };
}

function localDay(now: number): string {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parsePositiveNumber(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Rejects rather than hanging when the scan's IPC never returns. */
async function withScanTimeout<T>(scan: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      scan,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(Object.assign(new Error("grouping_scan_timeout"), {
            code: "timeout",
            detail: `grouping scan timed out after ${GROUPING_SCAN_TIMEOUT_MS}ms`,
          }));
        }, GROUPING_SCAN_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function productionDependencies(): GroupingPrecomputeDependencies {
  return {
    now: Date.now,
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (timer) => clearTimeout(timer),
    getAiIdentity: () => {
      const state = useAiSettingsStore.getState();
      return {
        enabled: state.aiEnabled,
        provider: state.aiProvider,
        model: state.aiModel.trim(),
        promptVersion: TAB_GROUPING_PROMPT_VERSION,
      };
    },
    getLayoutRevision: () => useWorkspaceListStore.getState().layoutRevision,
    getPtyQuietDelay: (now) => groupingActivePtyQuietDelay(
      now,
      activePaneSessionId(),
      usePaneMetadataStore.getState().volatileMetadata,
    ),
    getVisibility: () => (typeof document === "undefined" ? "visible" : document.visibilityState),
    subscribeLayout: (listener) => useWorkspaceListStore.subscribe((state, previous) => {
      if (state.layoutRevision !== previous.layoutRevision) listener();
    }),
    subscribePty: (listener) => usePaneMetadataStore.subscribe((state, previous) => {
      const sessionId = activePaneSessionId();
      if (sessionId
        && state.volatileMetadata[sessionId] !== previous.volatileMetadata[sessionId]) listener();
    }),
    subscribeAi: (listener) => useAiSettingsStore.subscribe((state, previous) => {
      if (state.aiEnabled !== previous.aiEnabled
        || state.aiProvider !== previous.aiProvider
        || state.aiModel !== previous.aiModel) listener();
    }),
    subscribeVisibility: (listener) => {
      if (typeof document === "undefined") return () => {};
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
    scan: () => withScanTimeout(scanGroupingContext()),
    analyze: (scan, judge, requestId) => runGroupingAnalysis({
      scan: async () => scan,
      judge,
      requestId,
    }),
    analyzeCurrent: (judge, requestId, onProgress) => runGroupingAnalysis({
      scan: () => withScanTimeout(scanGroupingContext()),
      judge,
      requestId,
      onProgress,
    }),
    judge: (prompt, requestId) => invoke<string>("run_tab_sweep_judge", {
      prompt,
      requestId,
      mode: "grouping",
    }),
    abort: (requestId) => invoke<boolean>("abort_tab_sweep_judge", { requestId }),
    readStorage: (key) => {
      try {
        return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    writeStorage: (key, value) => {
      try {
        if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
      } catch {
        // A disabled or full localStorage must not break foreground grouping.
      }
    },
  };
}

export function createGroupingPrecomputeCoordinator(
  dependencies: GroupingPrecomputeDependencies,
) {
  let timer: TimerHandle | null = null;
  let leaseTimer: TimerHandle | null = null;
  let started = false;
  let stopped = false;
  let generation = 0;
  let ready: ReadyRecord | null = null;
  let pending: PendingRecord | null = null;
  let previousGeneratedAt: number | null = null;
  let lastPtySignalAt = 0;
  let quietWaitStartedAt: number | null = null;
  let memoryBudget: StoredBudget = { day: "", count: 0 };
  const unsubscribers: Array<() => void> = [];
  const metrics: GroupingPrecomputeMetrics = {
    dirtyEvents: 0,
    debouncePasses: 0,
    scans: 0,
    actualGenerations: 0,
    foregroundGenerations: 0,
    budgetSkips: 0,
  };

  const clearScheduled = () => {
    if (timer === null) return;
    dependencies.clearTimer(timer);
    timer = null;
  };

  const interestUntil = () => parsePositiveNumber(dependencies.readStorage(INTEREST_STORAGE_KEY));
  const hasInterest = () => (interestUntil() ?? 0) > dependencies.now();

  const readBudget = (): StoredBudget => {
    const day = localDay(dependencies.now());
    if (memoryBudget.day !== day) memoryBudget = { day, count: 0 };
    try {
      const parsed = JSON.parse(dependencies.readStorage(BUDGET_STORAGE_KEY) ?? "null") as Partial<StoredBudget> | null;
      if (parsed?.day === day && Number.isInteger(parsed.count) && (parsed.count ?? -1) >= 0) {
        memoryBudget.count = Math.max(memoryBudget.count, parsed.count as number);
      }
    } catch {
      // Reset malformed records below.
    }
    return { ...memoryBudget };
  };

  const takeBackgroundBudget = (): boolean => {
    const budget = readBudget();
    if (budget.count >= GROUPING_BACKGROUND_DAILY_LIMIT) {
      metrics.budgetSkips += 1;
      return false;
    }
    memoryBudget = {
      day: budget.day,
      count: budget.count + 1,
    };
    dependencies.writeStorage(BUDGET_STORAGE_KEY, JSON.stringify(memoryBudget));
    metrics.actualGenerations += 1;
    return true;
  };

  const abortPending = () => {
    generation += 1;
    const requestId = pending?.activeRequestId;
    if (requestId) void dependencies.abort(requestId).catch(() => {});
  };

  /**
   * Stop only what we started on our own. A foreground run is someone waiting
   * at an open panel, and terminals produce output constantly -- killing their
   * judge because a pane printed a line leaves them staring at "判定を中止しました".
   */
  const abortBackgroundOnly = () => {
    if (pending?.mode !== "background") return;
    abortPending();
  };

  const armQuietWait = (reset: boolean) => {
    if (reset || quietWaitStartedAt === null) quietWaitStartedAt = dependencies.now();
  };

  const quietDeadlineReached = (now: number) => quietWaitStartedAt !== null
    && now - quietWaitStartedAt >= GROUPING_STRUCTURE_MAX_WAIT_MS;

  const gatedQuietDelay = (now: number) => {
    if (quietDeadlineReached(now)) return 0;
    const quietDelay = Math.max(
      dependencies.getPtyQuietDelay(now),
      lastPtySignalAt + GROUPING_PTY_QUIET_MS - now,
      0,
    );
    if (quietWaitStartedAt === null) return quietDelay;
    return Math.min(
      quietDelay,
      Math.max(0, quietWaitStartedAt + GROUPING_STRUCTURE_MAX_WAIT_MS - now),
    );
  };

  const clearLeaseTimer = () => {
    if (leaseTimer === null) return;
    dependencies.clearTimer(leaseTimer);
    leaseTimer = null;
  };

  const deactivate = (permanent: boolean) => {
    if (permanent) stopped = true;
    clearScheduled();
    clearLeaseTimer();
    abortPending();
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
    started = false;
  };

  const scheduleLeaseExpiry = () => {
    clearLeaseTimer();
    const until = interestUntil();
    if (until === null || !started) return;
    const remaining = Math.max(0, until - dependencies.now());
    leaseTimer = dependencies.setTimer(() => {
      leaseTimer = null;
      if (!hasInterest()) deactivate(false);
      else scheduleLeaseExpiry();
    }, Math.min(remaining, MAX_TIMER_DELAY_MS));
  };

  // dropReady=false keeps the last plan for peek() to hand out as
  // structure-stale (shown read-only while a fresh judge runs); only an AI
  // identity change makes the old plan meaningless enough to discard.
  const invalidate = (dropReady: boolean) => {
    clearScheduled();
    // A foreground run already scanned the new layout -- let it finish rather
    // than cancelling the user; speculative background work is dropped.
    abortBackgroundOnly();
    if (ready) previousGeneratedAt = ready.generatedAt;
    if (dropReady) ready = null;
  };

  const currentIdentity = () => ({
    ai: dependencies.getAiIdentity(),
    layoutRevision: dependencies.getLayoutRevision(),
  });

  const publish = (
    analysis: GroupingAnalysisResult,
    ai: AiIdentity,
    layoutRevision: number,
    fingerprints: GroupingFingerprints,
    expectedGeneration: number,
    mode: "background" | "foreground" = "background",
  ): GroupingProductionResult => {
    const current = currentIdentity();
    // Same split as the judge gate: speculative work is dropped when the world
    // moved under it, but a result someone is waiting for is delivered. It is
    // still not cached as the ready plan when the layout has changed -- the
    // caller gets it, the next opener re-derives.
    const invalidated = mode === "background"
      ? expectedGeneration !== generation
        || !sameCheapIdentity(ai, layoutRevision, current.ai, current.layoutRevision)
      : !sameAi(ai, current.ai);
    if (invalidated) {
      return { kind: "obsolete" };
    }
    if (mode === "foreground" && layoutRevision !== current.layoutRevision) {
      return { kind: "ready", analysis, generatedAt: dependencies.now() };
    }
    const generatedAt = dependencies.now();
    ready = {
      analysis,
      ai,
      layoutRevision,
      fingerprints,
      scannedAt: analysis.scan.scannedAt,
      generatedAt,
      softDirty: false,
    };
    quietWaitStartedAt = null;
    previousGeneratedAt = generatedAt;
    clearScheduled();
    return { kind: "ready", analysis, generatedAt };
  };

  const produce = async (
    mode: "background" | "foreground",
    force: boolean,
    onProgress?: (stage: GroupingAnalysisStage) => void,
  ): Promise<GroupingProductionResult> => {
    if (mode === "foreground") clearScheduled();
    const identity = currentIdentity();
    if (mode === "foreground" && !force && ready
      && sameCheapIdentity(ready.ai, ready.layoutRevision, identity.ai, identity.layoutRevision)
      && !ready.softDirty
      && dependencies.now() - ready.generatedAt <= GROUPING_SOFT_TTL_MS) {
      return { kind: "ready", analysis: ready.analysis, generatedAt: ready.generatedAt };
    }
    if (pending) {
      // Speculative work never interrupts a foreground run. It can reuse that
      // result even if the cheap identity moved; publish() keeps such a result
      // out of the ready cache while still delivering it to the waiting panel.
      if (mode === "background" && pending.mode === "foreground") {
        return pending.promise;
      }
      // Only ever wait on work of the same standing. A foreground caller has
      // someone watching a panel, and joining a speculative background job
      // means inheriting whatever it is stuck on -- a scan that never returns
      // leaves the panel saying "分析しています…" forever, with no judge process
      // to show for it. Drop the speculation and run our own.
      const joinable = !force
        && pending.mode === mode
        && sameCheapIdentity(
          pending.ai,
          pending.layoutRevision,
          identity.ai,
          identity.layoutRevision,
        );
      if (joinable) {
        if (mode === "foreground" && onProgress) {
          pending.progressListeners.add(onProgress);
          if (pending.progressStage) onProgress(pending.progressStage);
        }
        return pending.promise;
      }
      const abandoned = pending;
      abortPending();
      pending = null;
      if (mode === "background") await abandoned.promise.catch(() => {});
    }

    const expectedGeneration = ++generation;
    metrics.scans += 1;
    let scan: GroupingScan | null = null;
    let fingerprints: GroupingFingerprints | null = null;
    if (mode === "background") {
      scan = await dependencies.scan();
      const afterScan = currentIdentity();
      if (expectedGeneration !== generation
        || !sameCheapIdentity(identity.ai, identity.layoutRevision, afterScan.ai, afterScan.layoutRevision)) {
        return { kind: "obsolete" };
      }
      fingerprints = groupingFingerprints(scan);
      if (ready && sameCheapIdentity(
        ready.ai,
        ready.layoutRevision,
        identity.ai,
        identity.layoutRevision,
      )) {
        if (ready.fingerprints.structural !== fingerprints.structural) {
          previousGeneratedAt = ready.generatedAt;
          ready = null;
        } else if (ready.fingerprints.exact !== fingerprints.exact) {
          ready.softDirty = true;
        }
      }
      if (!force && ready
        && sameCheapIdentity(ready.ai, ready.layoutRevision, identity.ai, identity.layoutRevision)
        && ready.fingerprints.exact === fingerprints.exact
        && dependencies.now() - ready.generatedAt <= GROUPING_SOFT_TTL_MS) {
        ready.softDirty = false;
        quietWaitStartedAt = null;
        return { kind: "ready", analysis: ready.analysis, generatedAt: ready.generatedAt };
      }
    }

    let resolvePending!: (result: GroupingProductionResult) => void;
    let rejectPending!: (error: unknown) => void;
    const promise = new Promise<GroupingProductionResult>((resolve, reject) => {
      resolvePending = resolve;
      rejectPending = reject;
    });
    const record: PendingRecord = {
      generation: expectedGeneration,
      ai: identity.ai,
      layoutRevision: identity.layoutRevision,
      mode,
      exactFingerprint: fingerprints?.exact ?? null,
      activeRequestId: null,
      progressStage: null,
      progressListeners: new Set(onProgress ? [onProgress] : []),
      promise,
    };
    pending = record;

    void (async () => {
      try {
        const judge = async (prompt: string, requestId: string) => {
            const latest = currentIdentity();
            // A background run is speculative: if anything moved under it, the
            // work is wasted and it should stop. A foreground run is a person
            // waiting at an open panel -- it scanned the layout it is about to
            // judge, and a tab moving mid-flight is not a reason to hand them
            // "判定を中止しました". Only an AI provider/model change invalidates
            // it, because that is a different generation contract entirely.
            const invalidated = mode === "background"
              ? record.generation !== generation
                || !sameCheapIdentity(record.ai, record.layoutRevision, latest.ai, latest.layoutRevision)
              : !sameAi(record.ai, latest.ai);
            if (invalidated) {
              throw new Error("grouping_precompute_obsolete");
            }
            if (mode === "background") {
              if (!hasInterest()
                || !latest.ai.enabled
                || dependencies.getVisibility() !== "visible"
                || gatedQuietDelay(dependencies.now()) > 0
                || !takeBackgroundBudget()) {
                throw new Error("grouping_precompute_background_gate");
              }
            } else {
              metrics.foregroundGenerations += 1;
            }
            record.activeRequestId = requestId;
            return dependencies.judge(prompt, requestId);
        };
        const nextRequestId = () => `grouping-${dependencies.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const reportProgress = (stage: GroupingAnalysisStage) => {
          record.progressStage = stage;
          for (const listener of record.progressListeners) listener(stage);
        };
        const result = mode === "background"
          ? await dependencies.analyze(scan as GroupingScan, judge, nextRequestId)
          : await dependencies.analyzeCurrent(judge, nextRequestId, reportProgress);
        const resultFingerprints = fingerprints ?? groupingFingerprints(result.scan);
        resolvePending(publish(
          result,
          record.ai,
          record.layoutRevision,
          resultFingerprints,
          record.generation,
          mode,
        ));
      } catch (error) {
        rejectPending(error);
      } finally {
        record.activeRequestId = null;
        if (pending === record) {
          pending = null;
        }
      }
    })();
    return promise;
  };

  const runScheduled = async () => {
    timer = null;
    metrics.debouncePasses += 1;
    if (!started || stopped) return;
    if (!hasInterest()) {
      deactivate(false);
      return;
    }
    const identity = currentIdentity();
    if (!identity.ai.enabled || dependencies.getVisibility() !== "visible") return;
    const quietDelay = gatedQuietDelay(dependencies.now());
    if (quietDelay > 0) {
      schedule(quietDelay);
      return;
    }
    if (readBudget().count >= GROUPING_BACKGROUND_DAILY_LIMIT) {
      metrics.budgetSkips += 1;
      return;
    }
    try {
      await produce("background", false);
    } catch {
      // Background failures stay silent. Foreground keeps the existing fallback.
    }
  };

  function schedule(delayMs: number) {
    if (!started || stopped) return;
    clearScheduled();
    timer = dependencies.setTimer(() => void runScheduled(), Math.max(0, delayMs));
  }

  const start = (startupDelayMs = GROUPING_STARTUP_DELAY_MS): boolean => {
    if (started || stopped) return started;
    if (!hasInterest()) return false;
    started = true;
    armQuietWait(true);
    let previousAi = dependencies.getAiIdentity();
    unsubscribers.push(
      dependencies.subscribeLayout(() => {
        metrics.dirtyEvents += 1;
        armQuietWait(true);
        invalidate(false);
        schedule(GROUPING_STRUCTURE_DEBOUNCE_MS);
      }),
      dependencies.subscribePty(() => {
        metrics.dirtyEvents += 1;
        lastPtySignalAt = dependencies.now();
        armQuietWait(false);
        const quietDelay = gatedQuietDelay(dependencies.now());
        if (quietDelay > 0) abortBackgroundOnly();
        if (ready) ready.softDirty = true;
        if (quietDelay > 0) schedule(quietDelay);
        else if (pending?.mode !== "background" && timer === null) schedule(0);
      }),
      dependencies.subscribeAi(() => {
        const nextAi = dependencies.getAiIdentity();
        if (sameAi(previousAi, nextAi)) return;
        previousAi = nextAi;
        armQuietWait(true);
        invalidate(true);
        if (nextAi.enabled) schedule(GROUPING_STRUCTURE_DEBOUNCE_MS);
      }),
      dependencies.subscribeVisibility(() => {
        if (dependencies.getVisibility() === "visible") {
          armQuietWait(false);
          schedule(GROUPING_STRUCTURE_DEBOUNCE_MS);
        }
        else {
          clearScheduled();
          if (pending?.mode === "background") abortPending();
        }
      }),
    );
    scheduleLeaseExpiry();
    schedule(startupDelayMs);
    return true;
  };

  return {
    startIfInterested: () => start(),
    markInterest: () => {
      dependencies.writeStorage(
        INTEREST_STORAGE_KEY,
        String(dependencies.now() + GROUPING_INTEREST_LEASE_MS),
      );
      const active = start(GROUPING_STRUCTURE_DEBOUNCE_MS);
      armQuietWait(false);
      scheduleLeaseExpiry();
      return active;
    },
    requestBackgroundRefresh: () => {
      armQuietWait(false);
      schedule(GROUPING_STRUCTURE_DEBOUNCE_MS);
    },
    peek: (): GroupingPrecomputePeek => {
      if (!ready) return previousGeneratedAt === null
        ? (pending ? { kind: "pending" } : { kind: "miss" })
        : { kind: "hard-stale", previousGeneratedAt };
      const identity = currentIdentity();
      if (!sameAi(ready.ai, identity.ai)) {
        previousGeneratedAt = ready.generatedAt;
        ready = null;
        return { kind: "hard-stale", previousGeneratedAt };
      }
      if (ready.layoutRevision !== identity.layoutRevision) {
        previousGeneratedAt = ready.generatedAt;
        return {
          kind: "soft-stale",
          reason: "structure",
          analysis: ready.analysis,
          generatedAt: ready.generatedAt,
        };
      }
      if (ready.softDirty || dependencies.now() - ready.generatedAt > GROUPING_SOFT_TTL_MS) {
        return { kind: "soft-stale", reason: "output", analysis: ready.analysis, generatedAt: ready.generatedAt };
      }
      return { kind: "fresh", analysis: ready.analysis, generatedAt: ready.generatedAt };
    },
    generateForeground: (
      force = false,
      onProgress?: (stage: GroupingAnalysisStage) => void,
    ) => produce("foreground", force, onProgress),
    remember: (
      analysis: GroupingAnalysisResult,
      generatedAt = dependencies.now(),
    ) => {
      const identity = currentIdentity();
      const fingerprints = groupingFingerprints(analysis.scan);
      ready = {
        analysis,
        ai: identity.ai,
        layoutRevision: identity.layoutRevision,
        fingerprints,
        scannedAt: analysis.scan.scannedAt,
        generatedAt,
        softDirty: false,
      };
      previousGeneratedAt = generatedAt;
      quietWaitStartedAt = null;
      clearScheduled();
    },
    getMetrics: (): GroupingPrecomputeMetrics => ({ ...metrics }),
    stop: () => {
      deactivate(true);
    },
  };
}

let groupingPrecompute = createGroupingPrecomputeCoordinator(productionDependencies());

export function startGroupingPrecomputeIfInterested(): boolean {
  return groupingPrecompute.startIfInterested();
}

export function markGroupingInterest(): boolean {
  return groupingPrecompute.markInterest();
}

export function peekGroupingPrecompute(): GroupingPrecomputePeek {
  return groupingPrecompute.peek();
}

export function generateForegroundGroupingAnalysis(
  force = false,
  onProgress?: (stage: GroupingAnalysisStage) => void,
): Promise<GroupingProductionResult> {
  return groupingPrecompute.generateForeground(force, onProgress);
}

export function requestGroupingPrecomputeRefresh(): void {
  groupingPrecompute.requestBackgroundRefresh();
}

export function getGroupingPrecomputeMetrics(): GroupingPrecomputeMetrics {
  return groupingPrecompute.getMetrics();
}

export function rememberGroupingAnalysis(
  analysis: GroupingAnalysisResult,
  generatedAt?: number,
): void {
  groupingPrecompute.remember(analysis, generatedAt);
}

export function __resetGroupingPrecomputeForTests(): void {
  groupingPrecompute.stop();
  groupingPrecompute = createGroupingPrecomputeCoordinator(productionDependencies());
}
