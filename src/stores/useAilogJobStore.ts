import { create } from "zustand";

import {
  ailogIndexCancel,
  ailogIndexStart,
  ailogIndexStatus,
  ailogSummarizeCancel,
  ailogSummarizeStart,
  ailogSummarizeStatus,
  errorMessage,
  type IndexProgress,
  type IndexStatus,
  type SummarizeProgress,
  type SummarizeStatus,
  type SummaryRangePreset,
} from "../lib/ailog";
import { invalidateAilogCaches, type JobState } from "./ailogStore";

export { jobBackgroundError, jobDisplayError } from "./ailogStore";

type IndexJobState = JobState<IndexStatus, IndexProgress> & { autoStarted: boolean };

type AilogJobState = {
  index: IndexJobState;
  summarize: JobState<SummarizeStatus, SummarizeProgress>;
  lastAutoStartedAt: number;
  setIndexEventsAvailable: (available: boolean) => void;
  setSummarizeEventsAvailable: (available: boolean) => void;
  applyIndexProgress: (progress: IndexProgress) => void;
  applySummarizeProgress: (progress: SummarizeProgress) => void;
  refreshIndexStatus: () => Promise<boolean>;
  refreshSummarizeStatus: (preset: SummaryRangePreset) => Promise<boolean>;
  startIndex: (full: boolean, opts?: { silent?: boolean }) => Promise<void>;
  cancelIndex: () => Promise<void>;
  startSummarize: (preset: SummaryRangePreset, force?: boolean) => Promise<void>;
  cancelSummarize: (preset: SummaryRangePreset) => Promise<void>;
  dismissIndexError: () => void;
  dismissSummarizeError: () => void;
};

const emptyJob = { status: null, progress: null, statusError: null, actionError: null, dismissedError: null, eventsAvailable: true };

export const useAilogJobStore = create<AilogJobState>((set, get) => ({
  index: { ...emptyJob, autoStarted: false },
  summarize: { ...emptyJob },
  lastAutoStartedAt: 0,
  setIndexEventsAvailable: (eventsAvailable) => set((state) => ({ index: { ...state.index, eventsAvailable } })),
  setSummarizeEventsAvailable: (eventsAvailable) => set((state) => ({ summarize: { ...state.summarize, eventsAvailable } })),
  dismissIndexError: () => set((state) => ({ index: { ...state.index, dismissedError: state.index.status?.lastError ?? null, actionError: null, statusError: null } })),
  dismissSummarizeError: () => set((state) => ({ summarize: { ...state.summarize, dismissedError: state.summarize.status?.lastError ?? null, actionError: null, statusError: null } })),
  applyIndexProgress: (progress) => {
    set((state) => ({ index: { ...state.index, progress } }));
    if (progress.phase === "done") {
      invalidateAilogCaches();
      void get().refreshIndexStatus();
    }
  },
  applySummarizeProgress: (progress) => {
    set((state) => ({ summarize: { ...state.summarize, progress } }));
    if (progress.phase === "done") {
      invalidateAilogCaches();
    }
  },
  refreshIndexStatus: async () => {
    const wasRunning = get().index.status?.running ?? false;
    try {
      const status = await ailogIndexStatus();
      set((state) => ({ index: { ...state.index, status, statusError: null } }));
      if (wasRunning && !status.running) invalidateAilogCaches();
      return wasRunning && !status.running;
    } catch (error) {
      set((state) => ({ index: { ...state.index, statusError: errorMessage(error) } }));
      return false;
    }
  },
  refreshSummarizeStatus: async (preset) => {
    const wasRunning = get().summarize.status?.running ?? false;
    try {
      const status = await ailogSummarizeStatus({ preset });
      set((state) => ({ summarize: { ...state.summarize, status, statusError: null } }));
      if (wasRunning && !status.running) invalidateAilogCaches();
      return wasRunning && !status.running;
    } catch (error) {
      set((state) => ({ summarize: { ...state.summarize, statusError: errorMessage(error) } }));
      return false;
    }
  },
  startIndex: async (full, opts) => {
    const silent = opts?.silent === true;
    set((state) => ({
      lastAutoStartedAt: silent ? Date.now() : state.lastAutoStartedAt,
      index: { ...state.index, actionError: null, dismissedError: null, progress: null, autoStarted: silent },
    }));
    try {
      const result = await ailogIndexStart(full);
      if (result.alreadyRunning && !silent) set((state) => ({ index: { ...state.index, actionError: "インデックス処理はすでに実行中です" } }));
      await get().refreshIndexStatus();
    } catch (error) {
      set((state) => ({ index: { ...state.index, actionError: errorMessage(error) } }));
    }
  },
  cancelIndex: async () => {
    try { await ailogIndexCancel(); await get().refreshIndexStatus(); }
    catch (error) { set((state) => ({ index: { ...state.index, actionError: errorMessage(error) } })); }
  },
  startSummarize: async (preset, force = false) => {
    set((state) => ({ summarize: { ...state.summarize, actionError: null, dismissedError: null, progress: null } }));
    try {
      const result = await ailogSummarizeStart(undefined, force, { preset });
      if (result.alreadyRunning) set((state) => ({ summarize: { ...state.summarize, actionError: "インデックスまたは要約処理がすでに実行中です" } }));
      await get().refreshSummarizeStatus(preset);
    } catch (error) {
      set((state) => ({ summarize: { ...state.summarize, actionError: errorMessage(error) } }));
    }
  },
  cancelSummarize: async (preset) => {
    try { await ailogSummarizeCancel(); await get().refreshSummarizeStatus(preset); }
    catch (error) { set((state) => ({ summarize: { ...state.summarize, actionError: errorMessage(error) } })); }
  },
}));

export function __resetAilogJobStoreForTests(): void {
  useAilogJobStore.setState({
    index: { ...emptyJob, autoStarted: false },
    summarize: { ...emptyJob },
    lastAutoStartedAt: 0,
  });
}
