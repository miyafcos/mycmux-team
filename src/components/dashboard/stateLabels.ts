import type { DashboardDisplayState } from "./dashboardModel";
import { dashboardStrings } from "./dashboardStrings";

export type AttentionState = "needsAnswer" | "needsReview" | null;
export type ActivityState = "working" | "waiting" | "stalled" | "done" | "stopped" | "error";

export interface StateLabels {
  attention: AttentionState;
  activity: ActivityState;
  primary: string;
  primaryKind: "needsAnswer" | "needsReview" | ActivityState;
  activityLabel: string;
  tooltip: string;
}

/** The dashboard's sole old-state to two-axis vocabulary conversion. */
export function stateLabels(state: DashboardDisplayState): StateLabels {
  if (state === "needsHuman") return stateLabelsForAxes("needsAnswer", "waiting");
  if (state === "error") return stateLabelsForAxes("needsReview", "error");
  if (state === "noUpdate") return stateLabelsForAxes("needsReview", "stalled");
  if (state === "running") return stateLabelsForAxes(null, "working");
  if (state === "done") return stateLabelsForAxes("needsReview", "done");
  if (state === "acknowledged") return stateLabelsForAxes(null, "done");
  if (state === "stopped") return stateLabelsForAxes(null, "stopped");
  return stateLabelsForAxes(null, "waiting");
}

/** Resolve the Oracle's eight-step primary-label priority from the two axes. */
export function stateLabelsForAxes(attention: AttentionState, activity: ActivityState): StateLabels {
  const primaryKind = attention === "needsAnswer" ? "needsAnswer" : attention === "needsReview" ? "needsReview" : activity;
  const primary = labelFor(primaryKind);
  const activityLabel = labelFor(activity);
  return { attention, activity, primary, primaryKind, activityLabel, tooltip: attention ? `${primary} · ${activityLabel}` : activityLabel };
}

function labelFor(kind: "needsAnswer" | "needsReview" | ActivityState): string {
  if (kind === "needsAnswer") return dashboardStrings.stateNeedsAnswer;
  if (kind === "needsReview") return dashboardStrings.stateNeedsReview;
  if (kind === "working") return dashboardStrings.stateRunning;
  if (kind === "waiting") return dashboardStrings.stateIdle;
  if (kind === "stalled") return dashboardStrings.stateNoUpdate;
  if (kind === "done") return dashboardStrings.stateDone;
  if (kind === "stopped") return dashboardStrings.stateStopped;
  return dashboardStrings.stateError;
}
