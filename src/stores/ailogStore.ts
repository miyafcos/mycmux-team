/**
 * State for the AI log dashboard: the selected range, the filters, and the five
 * reports the panel draws from.
 *
 * Loading rules that matter:
 * - Every report for one refresh is fetched in parallel and committed together,
 *   so the screen never mixes two different ranges.
 * - A stale response (the user changed the range mid-flight) is dropped by the
 *   sequence guard rather than overwriting newer data.
 * - Errors are surfaced, never swallowed into an empty table.
 */

import { create } from "zustand";

import {
  ailogBreakdown,
  ailogIndexCancel,
  ailogIndexStart,
  ailogIndexStatus,
  ailogSummarizeCancel,
  ailogSummarizeStart,
  ailogSummarizeStatus,
  ailogModels,
  ailogOverview,
  ailogSeries,
  ailogSessionDetail,
  ailogSessions,
  buildRange,
  emptyFilters,
  errorMessage,
  type AilogRange,
  type BreakdownReport,
  type IndexProgress,
  type IndexStatus,
  type SummarizeProgress,
  type SummarizeStatus,
  type ModelsReport,
  type Overview,
  type SeriesReport,
  type SessionDetail,
  type SessionsReport,
  type RangePreset,
} from "../lib/ailog";
import type { LeafDimension } from "../components/ailog/sankeyModel";

/**
 * Ceiling on the session list fetch. The whole 6.4GB corpus is 995 sessions, so
 * this is headroom rather than a real limit; when it does bite, the panel says
 * so instead of quietly drawing a partial picture.
 */
export const SESSION_FETCH_LIMIT = 5_000;

export const SESSION_PAGE_SIZE = 100;

export type SessionSort = "cost" | "rework" | "recent";

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

  // --- data ---
  overview: Overview | null;
  series: SeriesReport | null;
  models: ModelsReport | null;
  projects: BreakdownReport | null;
  sessions: SessionsReport | null;
  detail: SessionDetail | null;
  detailKey: { kind: string; sessionId: string } | null;

  // --- status ---
  loading: boolean;
  loadedAt: number | null;
  error: string | null;
  detailLoading: boolean;
  detailError: string | null;
  indexStatus: IndexStatus | null;
  indexProgress: IndexProgress | null;
  indexError: string | null;
  summarizeStatus: SummarizeStatus | null;
  summarizeProgress: SummarizeProgress | null;
  summarizeError: string | null;

  // --- actions ---
  setPreset: (preset: RangePreset) => void;
  setCustomRange: (from: string, to: string) => void;
  setExcludeSynthetic: (value: boolean) => void;
  setIncludeSidechain: (value: boolean) => void;
  setLeafDimension: (value: LeafDimension) => void;
  setTopN: (layer: keyof TopNSetting, value: number) => void;
  setGranularity: (value: "family" | "raw") => void;
  setSessionSort: (value: SessionSort) => void;
  setSessionPage: (value: number) => void;
  setSelection: (selection: AilogSelection | null) => void;
  setDrillProject: (value: string | null) => void;
  currentRange: () => AilogRange | null;
  refresh: () => Promise<void>;
  openDetail: (kind: string, sessionId: string) => Promise<void>;
  closeDetail: () => void;
  refreshIndexStatus: () => Promise<void>;
  applyIndexProgress: (progress: IndexProgress) => void;
  startIndex: (full: boolean) => Promise<void>;
  cancelIndex: () => Promise<void>;
  refreshSummarizeStatus: () => Promise<void>;
  applySummarizeProgress: (progress: SummarizeProgress) => void;
  startSummarize: () => Promise<void>;
  cancelSummarize: () => Promise<void>;
}

let refreshSeq = 0;
let detailSeq = 0;

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
  excludeSynthetic: true,
  includeSidechain: false,
  leafDimension: "project" as LeafDimension,
  topN: { model: 8, tag: 8, leaf: 8 },
  granularity: "family" as const,
  sessionSort: "cost" as SessionSort,
  sessionPage: 0,
  selection: null,
  drillProject: null,
  overview: null,
  series: null,
  models: null,
  projects: null,
  sessions: null,
  detail: null,
  detailKey: null,
  loading: false,
  loadedAt: null,
  error: null,
  detailLoading: false,
  detailError: null,
  indexStatus: null,
  indexProgress: null,
  indexError: null,
  summarizeStatus: null,
  summarizeProgress: null,
  summarizeError: null,
};

export const useAilogStore = create<AilogState>((set, get) => ({
  ...initialState,

  setPreset: (preset) => {
    set({ preset, sessionPage: 0, selection: null, drillProject: null });
    if (get().currentRange()) void get().refresh();
  },

  setCustomRange: (customFrom, customTo) => {
    set({ customFrom, customTo, preset: "custom", sessionPage: 0 });
    if (get().currentRange()) void get().refresh();
  },

  setExcludeSynthetic: (excludeSynthetic) => set({ excludeSynthetic }),
  setIncludeSidechain: (includeSidechain) => {
    set({ includeSidechain, sessionPage: 0 });
    void get().refresh();
  },
  setLeafDimension: (leafDimension) => set({ leafDimension, drillProject: null }),
  setTopN: (layer, value) => set((state) => ({ topN: { ...state.topN, [layer]: value } })),
  setGranularity: (granularity) => {
    set({ granularity });
    void get().refresh();
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
    set({ loading: true, error: null });
    try {
      const [overview, series, models, projects, sessions] = await Promise.all([
        ailogOverview(range, filters),
        ailogSeries(range, filters, { bucket: "day", groupBy: "none" }),
        ailogModels(range, filters, { granularity, bucket: "day" }),
        ailogBreakdown(range, filters, "project"),
        ailogSessions(range, filters, { sort: "cost", limit: SESSION_FETCH_LIMIT, offset: 0 }),
      ]);
      if (mySeq !== refreshSeq) return;
      set({
        overview,
        series,
        models,
        projects,
        sessions,
        loading: false,
        loadedAt: Date.now(),
        error: null,
      });
    } catch (error) {
      if (mySeq !== refreshSeq) return;
      // The whole range failed, so the previous range's numbers would be a lie:
      // the reports are cleared and the reason is shown instead.
      set({
        loading: false,
        error: errorMessage(error),
        overview: null,
        series: null,
        models: null,
        projects: null,
        sessions: null,
      });
    }
  },

  openDetail: async (kind, sessionId) => {
    const mySeq = ++detailSeq;
    set({ detailLoading: true, detailError: null, detailKey: { kind, sessionId }, detail: null });
    try {
      const detail = await ailogSessionDetail(kind, sessionId);
      if (mySeq !== detailSeq) return;
      set({ detail, detailLoading: false });
    } catch (error) {
      if (mySeq !== detailSeq) return;
      set({ detailLoading: false, detailError: errorMessage(error) });
    }
  },

  closeDetail: () => {
    detailSeq += 1;
    set({ detail: null, detailKey: null, detailError: null, detailLoading: false });
  },

  refreshIndexStatus: async () => {
    try {
      const indexStatus = await ailogIndexStatus();
      set({ indexStatus, indexError: indexStatus.lastError });
    } catch (error) {
      set({ indexError: errorMessage(error) });
    }
  },

  applyIndexProgress: (indexProgress) => {
    set({ indexProgress });
    if (indexProgress.phase === "done") void get().refreshIndexStatus();
  },

  startIndex: async (full) => {
    set({ indexError: null, indexProgress: null });
    try {
      const result = await ailogIndexStart(full);
      if (result.alreadyRunning) {
        set({ indexError: "インデックス処理はすでに実行中です" });
      }
      await get().refreshIndexStatus();
    } catch (error) {
      set({ indexError: errorMessage(error) });
    }
  },

  cancelIndex: async () => {
    try {
      await ailogIndexCancel();
      await get().refreshIndexStatus();
    } catch (error) {
      set({ indexError: errorMessage(error) });
    }
  },

  refreshSummarizeStatus: async () => {
    try {
      const summarizeStatus = await ailogSummarizeStatus();
      set({ summarizeStatus, summarizeError: summarizeStatus.lastError });
    } catch (error) {
      set({ summarizeError: errorMessage(error) });
    }
  },

  applySummarizeProgress: (summarizeProgress) => {
    set({ summarizeProgress });
    if (summarizeProgress.phase === "done") void get().refreshSummarizeStatus();
  },

  startSummarize: async () => {
    set({ summarizeError: null });
    try {
      const result = await ailogSummarizeStart();
      if (result.alreadyRunning) set({ summarizeError: "インデックスまたは要約処理がすでに実行中です" });
      await get().refreshSummarizeStatus();
    } catch (error) {
      set({ summarizeError: errorMessage(error) });
    }
  },

  cancelSummarize: async () => {
    try {
      await ailogSummarizeCancel();
      await get().refreshSummarizeStatus();
    } catch (error) {
      set({ summarizeError: errorMessage(error) });
    }
  },
}));

export function __resetAilogStoreForTests(): void {
  refreshSeq = 0;
  detailSeq = 0;
  useAilogStore.setState({ ...initialState });
}
