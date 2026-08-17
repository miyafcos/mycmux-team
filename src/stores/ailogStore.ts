/**
 * State for the AI log dashboard: the selected range, the filters, and the
 * usage reports the panel draws from.
 *
 * Loading rules that matter:
 * - SQL reports are cached per resolved period and effective filters.
 * - A stale response (the user changed the range mid-flight) is dropped by its
 *   resource generation and cache-key guard rather than overwriting newer data.
 * - Errors are surfaced, never swallowed into an empty table.
 */

import { create } from "zustand";

import {
  ailogDashboard,
  ailogBreakdown,
  ailogPivot,
  ailogIndexCancel,
  ailogIndexStart,
  ailogIndexStatus,
  ailogSummarizeCancel,
  ailogSummarizeStart,
  ailogSummarizeStatus,
  ailogSeries,
  ailogSessionDetail,
  ailogSessionSummarize,
  ailogSessionTranscript,
  ailogUsageRhythm,
  buildRange,
  emptyFilters,
  errorMessage,
  type AilogRange,
  type AilogGranularity,
  type BreakdownReport,
  type IndexProgress,
  type IndexStatus,
  type SummarizeProgress,
  type SummarizeStatus,
  type ModelsReport,
  type Overview,
  type SeriesReport,
  type SessionDetail,
  type TranscriptReport,
  type SessionsReport,
  type RangePreset,
  type SeriesGroupBy,
  type SummaryRangePreset,
  type UsageBucket,
  type UsageRhythmReport,
  type PivotAxis,
  type PivotReport,
  granularityFromSeriesAxis,
} from "../lib/ailog";
import type { UsageMetric } from "../components/ailog/usageModel";
import { nextPivotAxes } from "../components/ailog/crossTableModel";

/**
 * Ceiling on the session list fetch. The whole 6.4GB corpus is 995 sessions, so
 * this is headroom rather than a real limit; when it does bite, the panel says
 * so instead of quietly drawing a partial picture.
 */
export const SESSION_FETCH_LIMIT = 5_000;

export const SESSION_PAGE_SIZE = 100;

export type SessionSort = "cost" | "rework" | "recent" | "turns";
export type BreakdownDimension = "project" | "branch" | "effort" | "origin" | "title" | "agent";

export interface Async<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  loadedAt: number | null;
}

export interface JobState<S, P> {
  status: S | null;
  progress: P | null;
  statusError: string | null;
  actionError: string | null;
  dismissedError: string | null;
  eventsAvailable: boolean;
}

export function jobBackgroundError<S extends { running: boolean; lastError: string | null }>(job: JobState<S, unknown>): string | null {
  const { status, dismissedError } = job;
  return !status?.running && status?.lastError && status.lastError !== dismissedError ? status.lastError : null;
}

export function jobDisplayError<S extends { running: boolean; lastError: string | null }>(job: JobState<S, unknown>): string | null {
  return job.actionError ?? job.statusError ?? jobBackgroundError(job);
}

export type SelectionType = "model" | "project";

export interface AilogSelection {
  type: SelectionType;
  key: string;
  label: string;
}

interface AilogState {
  // --- range / filters ---
  preset: RangePreset;
  customFrom: string;
  customTo: string;
  /** Stable instant used to turn a relative preset into a cacheable from/to pair. */
  rangeAnchor: number;
  summaryPreset: SummaryRangePreset;
  excludeSynthetic: boolean;
  includeSidechain: boolean;
  granularity: AilogGranularity;
  usageSeriesAxis: SeriesGroupBy;
  pivotRowBy: PivotAxis;
  pivotColBy: PivotAxis;
  sessionSort: SessionSort;
  sessionPage: number;
  selection: AilogSelection | null;
  breakdownDimension: BreakdownDimension;

  // --- data ---
  overview: Overview | null;
  series: SeriesReport | null;
  models: ModelsReport | null;
  projects: BreakdownReport | null;
  breakdown: BreakdownReport | null;
  /** Scoped to the breakdown section; see `refreshBreakdown`. */
  breakdownError: string | null;
  breakdownLoading: boolean;
  sessions: SessionsReport | null;
  detail: SessionDetail | null;
  detailKey: { kind: string; sessionId: string } | null;
  transcript: TranscriptReport | null;
  transcriptLoading: boolean;
  transcriptError: string | null;
  sessionSummarizing: boolean;
  sessionSummarizeError: string | null;

  // --- status ---
  loading: boolean;
  loadedAt: number | null;
  dashboardError: string | null;
  detailLoading: boolean;
  detailError: string | null;
  index: JobState<IndexStatus, IndexProgress>;
  summarize: JobState<SummarizeStatus, SummarizeProgress>;
  usageMetric: UsageMetric;
  usageStack: "absolute" | "share";
  usageBucket: UsageBucket;
  usageSeries: SeriesReport | null;
  usageRhythm: UsageRhythmReport | null;
  usageLoading: boolean;
  usageError: string | null;
  pivot: PivotReport | null;
  pivotLoading: boolean;
  pivotError: string | null;
  /** Latest usage-surface load duration, measured in the renderer. */
  lastLoadMs: number | null;

  // --- actions ---
  setPreset: (preset: RangePreset) => void;
  setCustomRange: (from: string, to: string) => void;
  setUsageMetric: (metric: UsageMetric) => void;
  setUsageStack: (stack: "absolute" | "share") => void;
  setUsageBucket: (bucket: UsageBucket) => void;
  setUsageSeriesAxis: (axis: SeriesGroupBy) => void;
  setPivotRowBy: (axis: PivotAxis) => void;
  setPivotColBy: (axis: PivotAxis) => void;
  refreshUsage: (options?: { force?: boolean }) => Promise<void>;
  refreshPivot: (options?: { force?: boolean }) => Promise<void>;
  /** Fetches the usage surface (series, dashboard, breakdown, pivot). Never starts LLM work. */
  loadUsage: (options?: { force?: boolean }) => Promise<void>;
  setSummaryPreset: (preset: SummaryRangePreset) => void;
  setExcludeSynthetic: (value: boolean) => void;
  setIncludeSidechain: (value: boolean) => void;
  setGranularity: (value: AilogGranularity) => void;
  setSessionSort: (value: SessionSort) => void;
  setSessionPage: (value: number) => void;
  setSelection: (selection: AilogSelection | null) => void;
  setBreakdownDimension: (value: BreakdownDimension) => void;
  currentRange: () => AilogRange | null;
  refresh: (options?: { force?: boolean }) => Promise<void>;
  refreshBreakdown: (options?: { force?: boolean }) => Promise<void>;
  openDetail: (kind: string, sessionId: string) => Promise<void>;
  loadTranscript: (kind: string, sessionId: string) => Promise<void>;
  summarizeSession: (kind: string, sessionId: string) => Promise<void>;
  closeDetail: () => void;
  dismissIndexError: () => void;
  dismissSummarizeError: () => void;
  setIndexEventsAvailable: (available: boolean) => void;
  setSummarizeEventsAvailable: (available: boolean) => void;
  refreshIndexStatus: () => Promise<void>;
  applyIndexProgress: (progress: IndexProgress) => void;
  startIndex: (full: boolean) => Promise<void>;
  cancelIndex: () => Promise<void>;
  refreshSummarizeStatus: () => Promise<void>;
  applySummarizeProgress: (progress: SummarizeProgress) => void;
  startSummarize: (force?: boolean) => Promise<void>;
  cancelSummarize: () => Promise<void>;
}

let refreshSeq = 0;
let detailSeq = 0;
let transcriptSeq = 0;
let breakdownSeq = 0;
let usageSeq = 0;
let pivotSeq = 0;

type DashboardData = {
  overview: Overview;
  series: SeriesReport;
  models: ModelsReport;
  projects: BreakdownReport;
  sessions: SessionsReport;
};

type UsageData = { series: SeriesReport; rhythm: UsageRhythmReport };

interface CachedResource<T> {
  value?: T;
  pending?: Promise<T>;
  generation: number;
}

interface PeriodCache {
  dashboard: CachedResource<DashboardData>;
  usage: Map<string, CachedResource<UsageData>>;
  breakdown: Map<BreakdownDimension, CachedResource<BreakdownReport>>;
  pivot: Map<string, CachedResource<PivotReport>>;
}

interface CacheContext {
  key: string;
  range: AilogRange;
  filters: ReturnType<typeof emptyFilters>;
  granularity: AilogGranularity;
}

const periodCache = new Map<string, PeriodCache>();

function resource<T>(): CachedResource<T> {
  return { generation: 0 };
}

function periodEntry(key: string): PeriodCache {
  let entry = periodCache.get(key);
  if (!entry) {
    entry = {
      dashboard: resource<DashboardData>(),
      usage: new Map(),
      breakdown: new Map(),
      pivot: new Map(),
    };
    periodCache.set(key, entry);
  }
  return entry;
}

function mapResource<K, T>(map: Map<K, CachedResource<T>>, key: K): CachedResource<T> {
  let entry = map.get(key);
  if (!entry) {
    entry = resource<T>();
    map.set(key, entry);
  }
  return entry;
}

/**
 * Requests one resource at most once per cache key. A forced refresh advances
 * the per-resource generation, so an older response cannot replace it.
 */
function fetchOnce<T>(entry: CachedResource<T>, load: () => Promise<T>, force = false): { promise: Promise<T>; pending: boolean } {
  if (!force && entry.value !== undefined) return { promise: Promise.resolve(entry.value), pending: false };
  if (!force && entry.pending) return { promise: entry.pending, pending: true };
  const generation = ++entry.generation;
  const pending = load().then(
    (value) => {
      if (entry.generation === generation) entry.value = value;
      return value;
    },
    (error) => {
      throw error;
    },
  ).finally(() => {
    if (entry.generation === generation) entry.pending = undefined;
  });
  entry.pending = pending;
  return { promise: pending, pending: true };
}

function resolvedRangeForKey(
  preset: RangePreset,
  customFrom: string,
  customTo: string,
  anchor: number,
): { from: number; to: number } | null {
  const custom = buildRange(preset, customFrom, customTo);
  if (!custom) return null;
  if (preset === "custom") return { from: custom.from!, to: custom.to! };
  const quantizedAnchor = Math.floor(anchor / 300_000) * 300_000;
  const day = 86_400_000;
  const from = preset === "7d" ? quantizedAnchor - 7 * day
    : preset === "30d" ? quantizedAnchor - 30 * day
      : preset === "90d" ? quantizedAnchor - 90 * day
        : preset === "ytd" ? Date.UTC(new Date(quantizedAnchor).getUTCFullYear(), 0, 1)
          : Number.MIN_SAFE_INTEGER;
  return { from, to: quantizedAnchor };
}

function cacheContext(state: Pick<AilogState, "preset" | "customFrom" | "customTo" | "rangeAnchor" | "includeSidechain" | "selection" | "granularity" | "usageSeriesAxis">): CacheContext | null {
  const range = buildRange(state.preset, state.customFrom, state.customTo);
  const resolvedRange = resolvedRangeForKey(state.preset, state.customFrom, state.customTo, state.rangeAnchor);
  if (!range || !resolvedRange) return null;
  const filters = selectionFilters(
    { ...emptyFilters(), includeSidechain: state.includeSidechain },
    state.selection,
  );
  const key = JSON.stringify({
    from: resolvedRange.from,
    to: resolvedRange.to,
    includeSidechain: state.includeSidechain,
    granularity: state.granularity,
    usageSeriesAxis: state.usageSeriesAxis,
    filters: {
      kinds: [...filters.kinds].sort(),
      models: [...filters.models].sort(),
      projects: [...filters.projects].sort(),
      branches: [...filters.branches].sort(),
      efforts: [...filters.efforts].sort(),
      origins: [...filters.origins].sort(),
      minCost: filters.minCost ?? null,
      query: filters.query ?? null,
    },
  });
  return { key, range, filters, granularity: state.granularity };
}

function isCurrentContext(get: () => AilogState, key: string): boolean {
  return cacheContext(get())?.key === key;
}

export function invalidateAilogCaches(): void {
  periodCache.clear();
}

/**
 * A selection the backend can honour: model families and project labels are
 * both real filter inputs on every `ailog_*` query. Work tags are not, so a tag
 * selection never claims to have narrowed the aggregates.
 */
export function isServerFilterable(
  selection: AilogSelection | null,
): boolean {
  return selection !== null;
}

export function selectionFilters<T extends { models: string[]; projects: string[] }>(
  filters: T,
  selection: AilogSelection | null,
): T {
  if (!isServerFilterable(selection) || !selection) return filters;
  if (selection.type === "model") return { ...filters, models: [selection.key] };
  return { ...filters, projects: [selection.key] };
}

const initialState = {
  preset: "30d" as RangePreset,
  customFrom: "",
  customTo: "",
  rangeAnchor: Date.now(),
  summaryPreset: "7d" as SummaryRangePreset,
  excludeSynthetic: true,
  includeSidechain: false,
  granularity: "family" as const,
  usageSeriesAxis: "model" as SeriesGroupBy,
  pivotRowBy: "project" as PivotAxis,
  pivotColBy: "model" as PivotAxis,
  sessionSort: "rework" as SessionSort,
  sessionPage: 0,
  selection: null,
  breakdownDimension: "project" as BreakdownDimension,
  overview: null,
  series: null,
  models: null,
  projects: null,
  breakdown: null,
  breakdownError: null,
  breakdownLoading: false,
  sessions: null,
  detail: null,
  detailKey: null,
  transcript: null,
  transcriptLoading: false,
  transcriptError: null,
  sessionSummarizing: false,
  sessionSummarizeError: null,
  loading: false,
  loadedAt: null,
  dashboardError: null,
  detailLoading: false,
  detailError: null,
  index: { status: null, progress: null, statusError: null, actionError: null, dismissedError: null, eventsAvailable: true },
  summarize: { status: null, progress: null, statusError: null, actionError: null, dismissedError: null, eventsAvailable: true },
  // Fresh input/output is the default: measured in total tokens the picture is
  // 95% cache reads, which answers a different question than "how much did I
  // actually put through a model".
  usageMetric: "ioTokens" as UsageMetric,
  usageStack: "absolute" as "absolute" | "share",
  usageBucket: "day" as UsageBucket,
  usageSeries: null,
  usageRhythm: null,
  usageLoading: false,
  usageError: null,
  pivot: null,
  pivotLoading: false,
  pivotError: null,
  lastLoadMs: null,
};

export const useAilogStore = create<AilogState>((set, get) => ({
  ...initialState,

  setPreset: (preset) => {
    set({ preset, sessionPage: 0, selection: null });
  },

  setCustomRange: (customFrom, customTo) => {
    set({ customFrom, customTo, preset: "custom", sessionPage: 0 });
  },

  setSummaryPreset: (summaryPreset) => {
    set({ summaryPreset });
    void get().refreshSummarizeStatus();
  },

  setExcludeSynthetic: (excludeSynthetic) => set({ excludeSynthetic }),
  setIncludeSidechain: (includeSidechain) => {
    set({ includeSidechain, sessionPage: 0 });
  },
  setGranularity: (granularity) => {
    set({ granularity });
  },
  setUsageSeriesAxis: (usageSeriesAxis) => {
    set({ usageSeriesAxis, granularity: granularityFromSeriesAxis(usageSeriesAxis) });
  },
  setPivotRowBy: (rowBy) => {
    const next = nextPivotAxes({ rowBy: get().pivotRowBy, colBy: get().pivotColBy }, { rowBy });
    set({ pivotRowBy: next.rowBy, pivotColBy: next.colBy });
    void get().refreshPivot();
  },
  setPivotColBy: (colBy) => {
    const next = nextPivotAxes({ rowBy: get().pivotRowBy, colBy: get().pivotColBy }, { colBy });
    set({ pivotRowBy: next.rowBy, pivotColBy: next.colBy });
    void get().refreshPivot();
  },
  setSessionSort: (sessionSort) => set({ sessionSort, sessionPage: 0 }),
  setSessionPage: (sessionPage) => set({ sessionPage: Math.max(0, sessionPage) }),
  setSelection: (selection) => {
    set({ selection, sessionPage: 0 });
  },
  setBreakdownDimension: (breakdownDimension) => {
    set({ breakdownDimension });
  },

  currentRange: () => {
    const { preset, customFrom, customTo } = get();
    return buildRange(preset, customFrom, customTo);
  },

  refresh: async (options = {}) => {
    const context = cacheContext(get());
    if (!context) return;
    const mySeq = ++refreshSeq;
    const cached = fetchOnce(periodEntry(context.key).dashboard, async (): Promise<DashboardData> => {
      const { overview, series, models, projects, sessions } = await ailogDashboard(
        context.range,
        context.filters,
        context.granularity,
      );
      return { overview, series, models, projects, sessions };
    }, options.force);
    if (cached.pending) set({ loading: true, dashboardError: null });
    try {
      const { overview, series, models, projects, sessions } = await cached.promise;
      if (mySeq !== refreshSeq || !isCurrentContext(get, context.key)) return;
      set({
        overview,
        series,
        models,
        projects,
        breakdown: get().breakdownDimension === "project" ? projects : get().breakdown,
        sessions,
        loading: false,
        loadedAt: Date.now(),
        dashboardError: null,
      });
    } catch (error) {
      if (mySeq !== refreshSeq || !isCurrentContext(get, context.key)) return;
      // The whole range failed, so the previous range's numbers would be a lie:
      // the reports are cleared and the reason is shown instead.
      set({
        loading: false,
        dashboardError: errorMessage(error),
        overview: null,
        series: null,
        models: null,
        projects: null,
        breakdown: null,
        sessions: null,
      });
    }
  },

  refreshBreakdown: async (options = {}) => {
    const context = cacheContext(get());
    if (!context) return;
    const dimension = get().breakdownDimension;
    const mySeq = ++breakdownSeq;
    const cached = fetchOnce(
      mapResource(periodEntry(context.key).breakdown, dimension),
      () => ailogBreakdown(context.range, context.filters, dimension),
      options.force,
    );
    if (cached.pending) set({ breakdownLoading: true, breakdownError: null });
    try {
      const breakdown = await cached.promise;
      if (mySeq !== breakdownSeq || get().breakdownDimension !== dimension || !isCurrentContext(get, context.key)) return;
      set({ breakdown, breakdownLoading: false, breakdownError: null });
    } catch (error) {
      if (mySeq !== breakdownSeq || !isCurrentContext(get, context.key)) return;
      // Scoped to the breakdown section. The global `error` is reserved for
      // `refresh()`, which fetches every report at once: setting it here
      // replaced the whole dashboard with a failure screen even though the
      // overview, series and model tables had all loaded fine.
      set({ breakdownLoading: false, breakdownError: errorMessage(error), breakdown: null });
    }
  },

  loadUsage: async (options = {}) => {
    const startedAt = performance.now();
    try {
      await Promise.all([
        get().refreshUsage(options),
        get().refresh(options),
        get().refreshBreakdown(options),
        get().refreshPivot(options),
      ]);
    } finally {
      set({ lastLoadMs: performance.now() - startedAt });
    }
  },

  openDetail: async (kind, sessionId) => {
    const mySeq = ++detailSeq;
    transcriptSeq += 1;
    set({ detailLoading: true, detailError: null, detailKey: { kind, sessionId }, detail: null, transcript: null, transcriptLoading: false, transcriptError: null, sessionSummarizeError: null });
    try {
      const detail = await ailogSessionDetail(kind, sessionId);
      if (mySeq !== detailSeq) return;
      set({ detail, detailLoading: false });
      void get().loadTranscript(kind, sessionId);
    } catch (error) {
      if (mySeq !== detailSeq) return;
      set({ detailLoading: false, detailError: errorMessage(error) });
    }
  },

  loadTranscript: async (kind, sessionId) => {
    const mySeq = ++transcriptSeq;
    set({ transcriptLoading: true, transcriptError: null });
    try {
      const transcript = await ailogSessionTranscript(kind, sessionId);
      if (mySeq !== transcriptSeq) return;
      set({ transcript, transcriptLoading: false });
    } catch (error) {
      if (mySeq !== transcriptSeq) return;
      set({ transcriptLoading: false, transcriptError: errorMessage(error) });
    }
  },

  summarizeSession: async (kind, sessionId) => {
    if (get().sessionSummarizing) return;
    const startedWithoutDetail = get().detailKey === null;
    const isCurrentDetail = () => {
      const detailKey = get().detailKey;
      return detailKey?.kind === kind && detailKey.sessionId === sessionId;
    };
    set({ sessionSummarizing: true, sessionSummarizeError: null });
    try {
      await ailogSessionSummarize(kind, sessionId);
      await Promise.all([
        isCurrentDetail() ? get().openDetail(kind, sessionId) : Promise.resolve(),
        get().refreshSummarizeStatus(),
      ]);
      if (startedWithoutDetail || isCurrentDetail()) set({ sessionSummarizing: false });
    } catch (error) {
      if (startedWithoutDetail || isCurrentDetail()) set({ sessionSummarizing: false, sessionSummarizeError: errorMessage(error) });
    }
  },

  closeDetail: () => {
    detailSeq += 1;
    transcriptSeq += 1;
    set({ detail: null, detailKey: null, detailError: null, detailLoading: false, transcript: null, transcriptLoading: false, transcriptError: null, sessionSummarizing: false, sessionSummarizeError: null });
  },

  dismissIndexError: () => set((state) => ({ index: { ...state.index, dismissedError: state.index.status?.lastError ?? null, actionError: null, statusError: null } })),
  dismissSummarizeError: () => set((state) => ({ summarize: { ...state.summarize, dismissedError: state.summarize.status?.lastError ?? null, actionError: null, statusError: null } })),
  setIndexEventsAvailable: (eventsAvailable) => set((state) => ({ index: { ...state.index, eventsAvailable } })),
  setSummarizeEventsAvailable: (eventsAvailable) => set((state) => ({ summarize: { ...state.summarize, eventsAvailable } })),

  refreshIndexStatus: async () => {
    try {
      const indexStatus = await ailogIndexStatus();
      set((state) => ({ index: { ...state.index, status: indexStatus, statusError: null } }));
    } catch (error) {
      set((state) => ({ index: { ...state.index, statusError: errorMessage(error) } }));
    }
  },

  applyIndexProgress: (indexProgress) => {
    set((state) => ({ index: { ...state.index, progress: indexProgress } }));
    if (indexProgress.phase === "done") {
      invalidateAilogCaches();
      void get().refreshIndexStatus();
    }
  },

  startIndex: async (full) => {
    set((state) => ({ index: { ...state.index, actionError: null, dismissedError: null, progress: null } }));
    try {
      const result = await ailogIndexStart(full);
      if (result.alreadyRunning) {
        set((state) => ({ index: { ...state.index, actionError: "インデックス処理はすでに実行中です" } }));
      }
      await get().refreshIndexStatus();
    } catch (error) {
      set((state) => ({ index: { ...state.index, actionError: errorMessage(error) } }));
    }
  },

  cancelIndex: async () => {
    try {
      await ailogIndexCancel();
      await get().refreshIndexStatus();
    } catch (error) {
      set((state) => ({ index: { ...state.index, actionError: errorMessage(error) } }));
    }
  },

  refreshSummarizeStatus: async () => {
    try {
      const summarizeStatus = await ailogSummarizeStatus({ preset: get().summaryPreset });
      set((state) => ({ summarize: { ...state.summarize, status: summarizeStatus, statusError: null } }));
    } catch (error) {
      set((state) => ({ summarize: { ...state.summarize, statusError: errorMessage(error) } }));
    }
  },

  applySummarizeProgress: (summarizeProgress) => {
    set((state) => ({ summarize: { ...state.summarize, progress: summarizeProgress } }));
    if (summarizeProgress.phase === "done") {
      invalidateAilogCaches();
      void get().refreshSummarizeStatus();
    }
  },

  startSummarize: async (force = false) => {
    set((state) => ({ summarize: { ...state.summarize, actionError: null, dismissedError: null, progress: null } }));
    try {
      const result = await ailogSummarizeStart(undefined, force, { preset: get().summaryPreset });
      if (result.alreadyRunning) set((state) => ({ summarize: { ...state.summarize, actionError: "インデックスまたは要約処理がすでに実行中です" } }));
      await get().refreshSummarizeStatus();
    } catch (error) {
      set((state) => ({ summarize: { ...state.summarize, actionError: errorMessage(error) } }));
    }
  },

  cancelSummarize: async () => {
    try {
      await ailogSummarizeCancel();
      await get().refreshSummarizeStatus();
    } catch (error) {
      set((state) => ({ summarize: { ...state.summarize, actionError: errorMessage(error) } }));
    }
  },

  setUsageMetric: (usageMetric) => set({ usageMetric }),
  setUsageStack: (usageStack) => set({ usageStack }),
  setUsageBucket: (usageBucket) => set({ usageBucket }),

  refreshPivot: async (options = {}) => {
    const context = cacheContext(get());
    if (!context) return;
    const mySeq = ++pivotSeq;
    const rowBy = get().pivotRowBy;
    const colBy = get().pivotColBy;
    const cached = fetchOnce(
      mapResource(periodEntry(context.key).pivot, `${rowBy}:${colBy}`),
      () => ailogPivot(context.range, context.filters, { rowBy, colBy }),
      options.force,
    );
    if (cached.pending) set({ pivotLoading: true, pivotError: null });
    try {
      const pivot = await cached.promise;
      if (mySeq !== pivotSeq || get().pivotRowBy !== rowBy || get().pivotColBy !== colBy || !isCurrentContext(get, context.key)) return;
      set({ pivot, pivotLoading: false, pivotError: null });
    } catch (error) {
      if (mySeq !== pivotSeq || !isCurrentContext(get, context.key)) return;
      set({ pivotLoading: false, pivotError: errorMessage(error), pivot: null });
    }
  },

  /**
   * The usage tab is deliberately independent of `refresh()`: it must render
   * from SQL aggregates alone, so a failure in any other report cannot blank
   * it, and its own failure is scoped to `usageError`.
   */
  refreshUsage: async (options = {}) => {
    const context = cacheContext(get());
    if (!context) return;
    const mySeq = ++usageSeq;
    const bucket = get().usageBucket;
    const groupBy = get().usageSeriesAxis;
    const cached = fetchOnce(
      mapResource(periodEntry(context.key).usage, `${bucket}:${groupBy}`),
      async (): Promise<UsageData> => {
        const [series, rhythm] = await Promise.all([
          ailogSeries(context.range, context.filters, { bucket, groupBy }),
          ailogUsageRhythm(context.range, context.filters),
        ]);
        return { series, rhythm };
      },
      options.force,
    );
    if (cached.pending) set({ usageLoading: true, usageError: null });
    try {
      const { series: usageSeries, rhythm: usageRhythm } = await cached.promise;
      if (mySeq !== usageSeq || !isCurrentContext(get, context.key)) return;
      set({ usageSeries, usageRhythm, usageLoading: false, usageError: null });
    } catch (error) {
      if (mySeq !== usageSeq || !isCurrentContext(get, context.key)) return;
      set({ usageLoading: false, usageError: errorMessage(error) });
    }
  },
}));

export function __resetAilogStoreForTests(): void {
  refreshSeq = 0;
  detailSeq = 0;
  transcriptSeq = 0;
  breakdownSeq = 0;
  usageSeq = 0;
  pivotSeq = 0;
  invalidateAilogCaches();
  useAilogStore.setState({ ...initialState });
}
