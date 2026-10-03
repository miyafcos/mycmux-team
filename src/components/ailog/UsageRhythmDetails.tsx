import { useEffect } from "react";

import { useAilogStore } from "../../stores/ailogStore";
import type { RhythmMetric } from "./usageModel";
import { UsageRhythm } from "./UsageRhythm";
import { EmptyState, RefreshingBlock, SkeletonBlock } from "./ui";

/** Mounted only when the rhythm disclosure is expanded. */
export function UsageRhythmDetails({ metric }: { metric: RhythmMetric }) {
  const report = useAilogStore((state) => state.usageRhythm);
  const loading = useAilogStore((state) => state.usageRhythmLoading);
  const error = useAilogStore((state) => state.usageRhythmError);
  const preset = useAilogStore((state) => state.preset);
  const from = useAilogStore((state) => state.customFrom);
  const to = useAilogStore((state) => state.customTo);
  const includeSidechain = useAilogStore((state) => state.includeSidechain);
  const selection = useAilogStore((state) => state.selection);
  const refresh = useAilogStore((state) => state.refreshUsageRhythm);
  const setOpen = useAilogStore((state) => state.setUsageRhythmOpen);

  useEffect(() => {
    setOpen(true);
    return () => setOpen(false);
  }, [setOpen]);
  useEffect(() => { void refresh(); }, [refresh, preset, from, to, includeSidechain, selection]);

  if (error && !report) return <EmptyState kind="error" message={error} onPrimary={() => void refresh({ force: true })} />;
  if (!report) return <SkeletonBlock height={120} label="稼働リズムを読み込み中" />;
  return <RefreshingBlock busy={loading}>{error ? <EmptyState kind="error" message={error} onPrimary={() => void refresh({ force: true })} /> : null}<UsageRhythm report={report} metric={metric} /></RefreshingBlock>;
}
