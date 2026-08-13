/**
 * State for the AI log dashboard: the selected range, the filters, and the five
 * reports the panel draws from.
 *
 * Loading rules that matter:
 * - Every report for one refresh is fetched together and committed together,
 *   so the screen never mixes two different ranges.
 * - A stale response (the user changed the range mid-flight) is dropped by the
 *   sequence guard rather than overwriting newer data.
 * - Errors are surfaced, never swallowed into an empty table.
 */

import { create } from "zustand";

import {
  ailogDashboard,
  ailogBreakdown,
  ailogEfficiency,
  ailogFindings,
  ailogGetPrices,
  ailogReworkRankings,
  ailogRuleCheck,
  ailogSetPrice,
  ailogDigestGenerate,
  ailogDigestGet,
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
  dayOffsetInput,
  emptyFilters,
  errorMessage,
  parseDayInput,
  shiftDayInput,
  type AilogRange,
  type BreakdownReport,
  type EfficiencyReport,
  type DigestReport,
  type FindingKind,
  type FindingsReport,
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
  type SummaryRangePreset,
  type ReworkRankingsReport,
  type PriceEntry,
  type RuleCheckReport,
  type UsageRhythmReport,
} from "../lib/ailog";
import type { LeafDimension } from "../components/ailog/sankeyModel";
import type { UsageMetric } from "../components/ailog/usageModel";

/**
 * Ceiling on the session list fetch. The whole 6.4GB corpus is 995 sessions, so
 * this is headroom rather than a real limit; when it does bite, the panel says
 * so instead of quietly drawing a partial picture.
 */
export const SESSION_FETCH_LIMIT = 5_000;

export const SESSION_PAGE_SIZE = 100;
export const FINDINGS_PAGE_SIZE = 50;

export type SessionSort = "cost" | "rework" | "recent";
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

export type SelectionType = "model" | "tag" | "topic" | "leaf" | "project";

export interface AilogSelection {
  type: SelectionType;
  key: string;
  label: string;
}

export interface TopNSetting {
  model: number;
  tag: number;
  leaf: number;
}

interface AilogState {
  // --- range / filters ---
  preset: RangePreset;
  customFrom: string;
  customTo: string;
  summaryPreset: SummaryRangePreset;
  excludeSynthetic: boolean;
  includeSidechain: boolean;
  leafDimension: LeafDimension;
  topN: TopNSetting;
  granularity: "family" | "raw";
  sessionSort: SessionSort;
  sessionPage: number;
  selection: AilogSelection | null;
  /** Project whose titles are expanded under the diagram. */
  drillProject: string | null;
  breakdownDimension: BreakdownDimension;

  // --- data ---
  overview: Overview | null;
  series: SeriesReport | null;
  models: ModelsReport | null;
  projects: BreakdownReport | null;
  breakdown: BreakdownReport | null;
  /** Scoped to the breakdown section; see `refreshBreakdown`. */
  breakdownError: string | null;
  sessions: SessionsReport | null;
  detail: SessionDetail | null;
  detailKey: { kind: string; sessionId: string } | null;
  transcript: TranscriptReport | null;
  transcriptLoading: boolean;
  transcriptError: string | null;
  sessionSummarizing: boolean;
  sessionSummarizeError: string | null;
  findings: FindingsReport | null;
  rankings: ReworkRankingsReport | null;
  findingKind: FindingKind | null;
  findingQuery: string;

  // --- status ---
  loading: boolean;
  loadedAt: number | null;
  dashboardError: string | null;
  detailLoading: boolean;
  detailError: string | null;
  index: JobState<IndexStatus, IndexProgress>;
  summarize: JobState<SummarizeStatus, SummarizeProgress>;
  digestDate: string;
  digestReport: DigestReport | null;
  digestLoading: boolean;
  digestGenerating: boolean;
  digestError: string | null;
  learningLoading: boolean;
  learningError: string | null;
  efficiency: EfficiencyReport | null;
  ruleCheck: RuleCheckReport | null;
  experimentLoading: boolean;
  experimentError: string | null;
  usageMetric: UsageMetric;
  usageStack: "absolute" | "share";
  usageBucket: "day" | "week" | "month";
  usageSeries: SeriesReport | null;
  usageRhythm: UsageRhythmReport | null;
  usageLoading: boolean;
  usageError: string | null;
  prices: PriceEntry[] | null;
  pricesLoading: boolean;
  pricesError: string | null;
  repricedSessions: number | null;

  // --- actions ---
  setPreset: (preset: RangePreset) => void;
  setCustomRange: (from: string, to: string) => void;
  setUsageMetric: (metric: UsageMetric) => void;
  setUsageStack: (stack: "absolute" | "share") => void;
  setUsageBucket: (bucket: "day" | "week" | "month") => void;
  refreshUsage: () => Promise<void>;
  setSummaryPreset: (preset: SummaryRangePreset) => void;
  setExcludeSynthetic: (value: boolean) => void;
  setIncludeSidechain: (value: boolean) => void;
  setLeafDimension: (value: LeafDimension) => void;
  setTopN: (layer: keyof TopNSetting, value: number) => void;
  setGranularity: (value: "family" | "raw") => void;
  setSessionSort: (value: SessionSort) => void;
  setSessionPage: (value: number) => void;
  setSelection: (selection: AilogSelection | null) => void;
  setDrillProject: (value: string | null) => void;
  setBreakdownDimension: (value: BreakdownDimension) => void;
  currentRange: () => AilogRange | null;
  refresh: () => Promise<void>;
  refreshBreakdown: () => Promise<void>;
  refreshExperiment: () => Promise<void>;
  refreshPrices: () => Promise<void>;
  savePrice: (entry: PriceEntry) => Promise<void>;
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
  setDigestDate: (date: string) => void;
  stepDigestDate: (days: number) => void;
  refreshDigest: (date?: string) => Promise<void>;
  generateDigest: (force?: boolean) => Promise<void>;
  setFindingKind: (kind: FindingKind | null) => void;
  setFindingQuery: (query: string) => void;
  refreshLearning: (append?: boolean) => Promise<void>;
}

let refreshSeq = 0;
let detailSeq = 0;
let transcriptSeq = 0;
let digestSeq = 0;
let learningSeq = 0;
let breakdownSeq = 0;
let experimentSeq = 0;
let priceSeq = 0;
let usageSeq = 0;

/**
 * Digest dates name a local day, matching the day buckets every other ailog
 * surface reports. Deriving them in UTC would ask for yesterday's digest for
 * nine hours of every local day.
 */
function localDayOffset(days: number): string {
  return dayOffsetInput(days);
}

function shiftLocalDay(date: string, days: number): string {
  const shifted = shiftDayInput(date, days);
  return shifted === date && parseDayInput(date) === null ? localDayOffset(days) : shifted;
}

/**
 * A selection the backend can honour: model families and project labels are
 * both real filter inputs on every `ailog_*` query. Work tags are not, so a tag
 * selection never claims to have narrowed the aggregates.
 */
export function isServerFilterable(
  selection: AilogSelection | null,
  leafDimension: LeafDimension,
): boolean {
  if (!selection) return false;
  if (selection.type === "model" || selection.type === "project") return true;
  return selection.type === "leaf" && leafDimension === "project";
}

export function selectionFilters<T extends { models: string[]; projects: string[] }>(
  filters: T,
  selection: AilogSelection | null,
  leafDimension: LeafDimension,
): T {
  if (!isServerFilterable(selection, leafDimension) || !selection) return filters;
  if (selection.type === "model") return { ...filters, models: [selection.key] };
  return { ...filters, projects: [selection.key] };
}

const initialState = {
  preset: "30d" as RangePreset,
  customFrom: "",
  customTo: "",
  summaryPreset: "7d" as SummaryRangePreset,
  excludeSynthetic: true,
  includeSidechain: false,
  leafDimension: "project" as LeafDimension,
  topN: { model: 8, tag: 8, leaf: 8 },
  granularity: "family" as const,
  sessionSort: "cost" as SessionSort,
  sessionPage: 0,
  selection: null,
  drillProject: null,
  breakdownDimension: "project" as BreakdownDimension,
  overview: null,
  series: null,
  models: null,
  projects: null,
  breakdown: null,
  breakdownError: null,
  sessions: null,
  detail: null,
  detailKey: null,
  transcript: null,
  transcriptLoading: false,
  transcriptError: null,
  sessionSummarizing: false,
  sessionSummarizeError: null,
  findings: null,
  rankings: null,
  findingKind: null,
  findingQuery: "",
  loading: false,
  loadedAt: null,
  dashboardError: null,
  detailLoading: false,
  detailError: null,
  index: { status: null, progress: null, statusError: null, actionError: null, dismissedError: null, eventsAvailable: true },
  summarize: { status: null, progress: null, statusError: null, actionError: null, dismissedError: null, eventsAvailable: true },
  digestDate: localDayOffset(-1),
  digestReport: null,
  digestLoading: false,
  digestGenerating: false,
  digestError: null,
  learningLoading: false,
  learningError: null,
  efficiency: null,
  ruleCheck: null,
  experimentLoading: false,
  experimentError: null,
  // Fresh input/output is the default: measured in total tokens the picture is
  // 95% cache reads, which answers a different question than "how much did I
  // actually put through a model".
  usageMetric: "ioTokens" as UsageMetric,
  usageStack: "absolute" as "absolute" | "share",
  usageBucket: "day" as "day" | "week" | "month",
  usageSeries: null,
  usageRhythm: null,
  usageLoading: false,
  usageError: null,
  prices: null,
  pricesLoading: false,
  pricesError: null,
  repricedSessions: null,
};

export const useAilogStore = create<AilogState>((set, get) => ({
  ...initialState,

  setPreset: (preset) => {
    set({ preset, sessionPage: 0, selection: null, drillProject: null });
    if (get().currentRange()) {
      void get().refresh();
      void get().refreshUsage();
    }
  },

  setCustomRange: (customFrom, customTo) => {
    set({ customFrom, customTo, preset: "custom", sessionPage: 0 });
    if (get().currentRange()) {
      void get().refresh();
      void get().refreshUsage();
    }
  },

  setSummaryPreset: (summaryPreset) => {
    set({ summaryPreset });
    void get().refreshSummarizeStatus();
  },

  setExcludeSynthetic: (excludeSynthetic) => set({ excludeSynthetic }),
  setIncludeSidechain: (includeSidechain) => {
    set({ includeSidechain, sessionPage: 0 });
    void get().refresh();
    void get().refreshUsage();
  },
  setLeafDimension: (leafDimension) => set({ leafDimension, drillProject: null }),
  setTopN: (layer, value) => set((state) => ({ topN: { ...state.topN, [layer]: value } })),
  setGranularity: (granularity) => {
    set({ granularity });
    void get().refresh();
    void get().refreshUsage();
  },
  setSessionSort: (sessionSort) => set({ sessionSort, sessionPage: 0 }),
  setSessionPage: (sessionPage) => set({ sessionPage: Math.max(0, sessionPage) }),
  setSelection: (selection) => {
    const previous = get().selection;
    set({ selection, sessionPage: 0 });
    // Model and project selections are real backend filters, so the whole
    // dashboard narrows with them. A work-tag selection has no backend filter
    // (F1 exposes none) and stays a session-list filter, which the panel says.
    if (isServerFilterable(previous, get().leafDimension) || isServerFilterable(selection, get().leafDimension)) {
      void get().refresh();
    }
  },
  setDrillProject: (drillProject) => set({ drillProject }),
  setBreakdownDimension: (breakdownDimension) => {
    set({ breakdownDimension });
    void get().refreshBreakdown();
  },

  currentRange: () => {
    const { preset, customFrom, customTo } = get();
    return buildRange(preset, customFrom, customTo);
  },

  refresh: async () => {
    const range = get().currentRange();
    if (!range) return;
    const filters = selectionFilters(
      { ...emptyFilters(), includeSidechain: get().includeSidechain },
      get().selection,
      get().leafDimension,
    );
    const granularity = get().granularity;
    const mySeq = ++refreshSeq;
    set({ loading: true, dashboardError: null });
    try {
      const { overview, series, models, projects, sessions } = await ailogDashboard(
        range,
        filters,
        granularity,
      );
      if (mySeq !== refreshSeq) return;
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
      if (mySeq !== refreshSeq) return;
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

  refreshBreakdown: async () => {
    const range = get().currentRange();
    if (!range) return;
    const dimension = get().breakdownDimension;
    const filters = selectionFilters(
      { ...emptyFilters(), includeSidechain: get().includeSidechain },
      get().selection,
      get().leafDimension,
    );
    const mySeq = ++breakdownSeq;
    try {
      const breakdown = await ailogBreakdown(range, filters, dimension);
      if (mySeq !== breakdownSeq || get().breakdownDimension !== dimension) return;
      set({ breakdown, breakdownError: null });
    } catch (error) {
      if (mySeq !== breakdownSeq) return;
      // Scoped to the breakdown section. The global `error` is reserved for
      // `refresh()`, which fetches every report at once: setting it here
      // replaced the whole dashboard with a failure screen even though the
      // overview, series and model tables had all loaded fine.
      set({ breakdownError: errorMessage(error), breakdown: null });
    }
  },

  refreshExperiment: async () => {
    const range = get().currentRange();
    if (!range) return;
    const filters = selectionFilters(
      { ...emptyFilters(), includeSidechain: get().includeSidechain },
      get().selection,
      get().leafDimension,
    );
    const mySeq = ++experimentSeq;
    set({ experimentLoading: true, experimentError: null });
    try {
      const [efficiency, ruleCheck] = await Promise.all([
        ailogEfficiency(range, filters),
        ailogRuleCheck(range, filters),
      ]);
      if (mySeq !== experimentSeq) return;
      set({ efficiency, ruleCheck, experimentLoading: false });
    } catch (error) {
      if (mySeq !== experimentSeq) return;
      set({ experimentLoading: false, experimentError: errorMessage(error), efficiency: null, ruleCheck: null });
    }
  },

  refreshPrices: async () => {
    const mySeq = ++priceSeq;
    set({ pricesLoading: true, pricesError: null });
    try {
      const prices = await ailogGetPrices();
      if (mySeq !== priceSeq) return;
      set({ prices, pricesLoading: false });
    } catch (error) {
      if (mySeq !== priceSeq) return;
      set({ pricesLoading: false, pricesError: errorMessage(error) });
    }
  },

  savePrice: async (entry) => {
    set({ pricesError: null, repricedSessions: null });
    try {
      const result = await ailogSetPrice(entry);
      set({ repricedSessions: result.repricedSessions });
      await Promise.all([get().refresh(), get().refreshPrices(), get().refreshBreakdown(), get().refreshExperiment()]);
    } catch (error) {
      set({ pricesError: errorMessage(error) });
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
    set({ sessionSummarizing: true, sessionSummarizeError: null });
    try {
      await ailogSessionSummarize(kind, sessionId);
      await Promise.all([get().openDetail(kind, sessionId), get().refresh(), get().refreshSummarizeStatus()]);
      set({ sessionSummarizing: false });
    } catch (error) {
      set({ sessionSummarizing: false, sessionSummarizeError: errorMessage(error) });
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
    if (indexProgress.phase === "done") void get().refreshIndexStatus();
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
    if (summarizeProgress.phase === "done") void get().refreshSummarizeStatus();
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

  setDigestDate: (digestDate) => {
    digestSeq += 1;
    set({ digestDate, digestGenerating: false });
    void get().refreshDigest(digestDate);
  },

  stepDigestDate: (days) => get().setDigestDate(shiftLocalDay(get().digestDate, days)),

  refreshDigest: async (date = get().digestDate) => {
    const mySeq = ++digestSeq;
    set({ digestLoading: true, digestError: null });
    try {
      const digestReport = await ailogDigestGet(date);
      if (mySeq !== digestSeq) return;
      set({ digestReport, digestLoading: false, digestError: null });
    } catch (error) {
      if (mySeq !== digestSeq) return;
      set({ digestReport: null, digestLoading: false, digestError: errorMessage(error) });
    }
  },

  generateDigest: async (force = false) => {
    const date = get().digestDate;
    const mySeq = ++digestSeq;
    set({ digestGenerating: true, digestError: null });
    try {
      const digestReport = await ailogDigestGenerate(date, force);
      if (mySeq !== digestSeq) return;
      set({ digestReport, digestLoading: false, digestError: null });
    } catch (error) {
      if (mySeq !== digestSeq) return;
      set({ digestError: errorMessage(error) });
    } finally {
      if (mySeq === digestSeq) set({ digestGenerating: false });
    }
  },

  setFindingKind: (findingKind) => {
    set({ findingKind, findings: null });
    void get().refreshLearning();
  },

  setFindingQuery: (findingQuery) => {
    set({ findingQuery, findings: null });
    void get().refreshLearning();
  },

  setUsageMetric: (usageMetric) => set({ usageMetric }),
  setUsageStack: (usageStack) => set({ usageStack }),
  setUsageBucket: (usageBucket) => {
    set({ usageBucket });
    void get().refreshUsage();
  },

  /**
   * The usage tab is deliberately independent of `refresh()`: it must render
   * from SQL aggregates alone, so a failure in any other report cannot blank
   * it, and its own failure is scoped to `usageError`.
   */
  refreshUsage: async () => {
    const range = get().currentRange();
    if (!range) return;
    const filters = selectionFilters(
      { ...emptyFilters(), includeSidechain: get().includeSidechain },
      get().selection,
      get().leafDimension,
    );
    const mySeq = ++usageSeq;
    set({ usageLoading: true, usageError: null });
    try {
      const [usageSeries, usageRhythm] = await Promise.all([
        ailogSeries(range, filters, {
          bucket: get().usageBucket,
          // `model` is the family; `model_raw` keeps sol / terra / luna apart.
          groupBy: get().granularity === "raw" ? "model_raw" : "model",
        }),
        ailogUsageRhythm(range, filters),
      ]);
      if (mySeq !== usageSeq) return;
      set({ usageSeries, usageRhythm, usageLoading: false, usageError: null });
    } catch (error) {
      if (mySeq !== usageSeq) return;
      set({ usageLoading: false, usageError: errorMessage(error) });
    }
  },

  refreshLearning: async (append = false) => {
    const range = get().currentRange();
    if (!range) return;
    const filters = selectionFilters(
      { ...emptyFilters(), includeSidechain: get().includeSidechain },
      get().selection,
      get().leafDimension,
    );
    const previous = get().findings;
    const offset = append ? (previous?.rows.length ?? 0) : 0;
    const mySeq = ++learningSeq;
    set({ learningLoading: true, learningError: null });
    try {
      const [findings, rankings] = await Promise.all([
        ailogFindings(range, filters, { kind: get().findingKind, query: get().findingQuery, limit: FINDINGS_PAGE_SIZE, offset }),
        append && get().rankings ? Promise.resolve(get().rankings) : ailogReworkRankings(range, filters),
      ]);
      if (mySeq !== learningSeq) return;
      set({
        findings: append && previous ? { ...findings, rows: [...previous.rows, ...findings.rows] } : findings,
        rankings,
        learningLoading: false,
        learningError: null,
      });
    } catch (error) {
      if (mySeq !== learningSeq) return;
      set({ learningLoading: false, learningError: errorMessage(error) });
    }
  },
}));

export function __resetAilogStoreForTests(): void {
  refreshSeq = 0;
  detailSeq = 0;
  digestSeq = 0;
  learningSeq = 0;
  usageSeq = 0;
  useAilogStore.setState({ ...initialState });
}
