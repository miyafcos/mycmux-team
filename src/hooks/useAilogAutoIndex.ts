/**
 * Panel-open trigger for incremental indexing, plus the job event/poll wiring
 * that used to live on RangeBar.
 *
 * Opening the panel starts at most one incremental index. Summarize / digest /
 * session-summary are never started from this path.
 */

import { useEffect } from "react";

import { listenIndexProgress, listenSummarizeProgress } from "../lib/ailog";
import { useAilogStore } from "../stores/ailogStore";
import { useAilogJobStore } from "../stores/useAilogJobStore";
import { useAilogPolling } from "./useAilogPolling";

const AUTO_INDEX_COOLDOWN_MS = 60_000;

export function useAilogAutoIndex(open: boolean, onJobsSettled: () => void): void {
  const summaryPreset = useAilogStore((state) => state.summaryPreset);
  const indexRunning = useAilogJobStore((state) => state.index.status?.running ?? false);
  const summarizeRunning = useAilogJobStore((state) => state.summarize.status?.running ?? false);
  const indexEventsAvailable = useAilogJobStore((state) => state.index.eventsAvailable);
  const summarizeEventsAvailable = useAilogJobStore((state) => state.summarize.eventsAvailable);
  const setIndexEventsAvailable = useAilogJobStore((state) => state.setIndexEventsAvailable);
  const setSummarizeEventsAvailable = useAilogJobStore((state) => state.setSummarizeEventsAvailable);
  const applyIndexProgress = useAilogJobStore((state) => state.applyIndexProgress);
  const applySummarizeProgress = useAilogJobStore((state) => state.applySummarizeProgress);
  const refreshIndexStatus = useAilogJobStore((state) => state.refreshIndexStatus);
  const refreshSummarizeStatus = useAilogJobStore((state) => state.refreshSummarizeStatus);

  useEffect(() => {
    if (!open) return;
    void refreshIndexStatus();
    void refreshSummarizeStatus(summaryPreset);
  }, [open, refreshIndexStatus, refreshSummarizeStatus, summaryPreset]);

  useEffect(() => {
    if (!open) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    setIndexEventsAvailable(true);
    void listenIndexProgress((progress) => {
      applyIndexProgress(progress);
      if (progress.phase === "done") onJobsSettled();
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    }).catch(() => {
      if (!cancelled) setIndexEventsAvailable(false);
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [applyIndexProgress, onJobsSettled, open, setIndexEventsAvailable]);

  useEffect(() => {
    if (!open) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    setSummarizeEventsAvailable(true);
    void listenSummarizeProgress(applySummarizeProgress).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    }).catch(() => {
      if (!cancelled) setSummarizeEventsAvailable(false);
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [applySummarizeProgress, open, setSummarizeEventsAvailable]);

  useAilogPolling({
    open,
    indexRunning,
    summarizeRunning,
    eventsHealthy: (!indexRunning || indexEventsAvailable) && (!summarizeRunning || summarizeEventsAvailable),
    refreshIndexStatus: async () => {
      if (await refreshIndexStatus()) onJobsSettled();
    },
    refreshSummarizeStatus: async () => {
      if (await refreshSummarizeStatus(summaryPreset)) onJobsSettled();
    },
    refreshReports: async () => {
      onJobsSettled();
    },
  });

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      await refreshIndexStatus();
      if (cancelled) return;
      const { index, lastAutoStartedAt, startIndex } = useAilogJobStore.getState();
      if (index.status?.running) return;
      if (Date.now() - lastAutoStartedAt < AUTO_INDEX_COOLDOWN_MS) return;
      await startIndex(false, { silent: true });
    })();
    return () => {
      cancelled = true;
    };
  }, [open, refreshIndexStatus]);
}
