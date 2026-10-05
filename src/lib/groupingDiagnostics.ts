import { invoke } from "@tauri-apps/api/core";
export type GroupingTraceStage = "entry" | "settings" | "scan" | "jev" | "prepare" | "apply" | "finish";
export type GroupingTraceReason = "shown" | "applied" | "undone" | "folded" | "cancelled" | "timeout" | "error" | "frame" | "timer";
export interface GroupingTraceRecord {
  operationId: string;
  stages: Partial<Record<GroupingTraceStage, number>>;
  reason: GroupingTraceReason;
}
let sequence = 0;
function sendRecord(record: GroupingTraceRecord): void {
  void invoke<void>("log_grouping_operation", { record }).catch(() => {});
}
export function beginGroupingTrace(sink: (record: GroupingTraceRecord) => void = sendRecord, now: () => number = Date.now) {
  const operationId = Date.now() + "-" + ++sequence;
  const stages: GroupingTraceRecord["stages"] = { entry: now() };
  let finished = false;
  return {
    mark(stage: GroupingTraceStage) { if (!finished && stages[stage] === undefined) stages[stage] = now(); },
    finish(reason: GroupingTraceReason) {
      if (finished) return;
      finished = true;
      stages.finish = now();
      try { sink({ operationId, stages: { ...stages }, reason }); } catch { /* Optional diagnostics. */ }
    },
  };
}
