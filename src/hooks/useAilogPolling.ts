import { useEffect, useRef } from "react";

export interface AilogPollPlanInput {
  open: boolean;
  indexRunning: boolean;
  summarizeRunning: boolean;
  eventsHealthy: boolean;
}

export interface AilogPollPlan {
  pollIndex: boolean;
  pollSummarize: boolean;
  nextDelayMs: number | null;
}

export function ailogPollPlan({ open, indexRunning, summarizeRunning, eventsHealthy }: AilogPollPlanInput): AilogPollPlan {
  if (!open || (!indexRunning && !summarizeRunning)) return { pollIndex: false, pollSummarize: false, nextDelayMs: null };
  return {
    pollIndex: indexRunning,
    pollSummarize: summarizeRunning,
    nextDelayMs: eventsHealthy ? 4_000 : 1_500,
  };
}

interface UseAilogPollingOptions extends AilogPollPlanInput {
  refreshIndexStatus: () => Promise<void>;
  refreshSummarizeStatus: () => Promise<void>;
  refreshReports: () => Promise<void>;
}

/** One timeout chain owns job status polling and the single final report refresh. */
export function useAilogPolling(options: UseAilogPollingOptions): void {
  const optionsRef = useRef(options);
  const indexInFlight = useRef(false);
  const summarizeInFlight = useRef(false);
  const wasIndexRunning = useRef(false);
  const wasSummarizeRunning = useRef(false);
  optionsRef.current = options;

  useEffect(() => {
    const current = optionsRef.current;
    if (!current.open) {
      wasIndexRunning.current = false;
      wasSummarizeRunning.current = false;
      return;
    }
    const stopped = (wasIndexRunning.current && !current.indexRunning) || (wasSummarizeRunning.current && !current.summarizeRunning);
    wasIndexRunning.current = current.indexRunning;
    wasSummarizeRunning.current = current.summarizeRunning;
    if (stopped) void current.refreshReports();

    let timer: number | null = null;
    let cancelled = false;
    const schedule = () => {
      const plan = ailogPollPlan(optionsRef.current);
      if (plan.nextDelayMs === null || cancelled) return;
      timer = window.setTimeout(() => {
        const latest = optionsRef.current;
        const next = ailogPollPlan(latest);
        const work: Promise<void>[] = [];
        if (next.pollIndex && !indexInFlight.current) {
          indexInFlight.current = true;
          work.push(latest.refreshIndexStatus().finally(() => { indexInFlight.current = false; }));
        }
        if (next.pollSummarize && !summarizeInFlight.current) {
          summarizeInFlight.current = true;
          work.push(latest.refreshSummarizeStatus().finally(() => { summarizeInFlight.current = false; }));
        }
        void Promise.all(work).finally(schedule);
      }, plan.nextDelayMs);
    };
    schedule();
    return () => { cancelled = true; if (timer !== null) window.clearTimeout(timer); };
  }, [options.open, options.indexRunning, options.summarizeRunning, options.eventsHealthy]);
}
