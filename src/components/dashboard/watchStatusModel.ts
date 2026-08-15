export type WatchSkipReason = "hidden" | "not-main-window" | "disabled" | null;

export interface WatchStatusModelInput {
  isMainWindow: boolean;
  running: boolean;
  lastTickAt: number | null;
  nextTickDueAt: number | null;
  lastSkipReason: WatchSkipReason;
  notifySuppressed: boolean;
}

export interface WatchStatusModel {
  state: "running" | "stopped" | "unmeasured";
  lastTickAt: number | null;
  nextTickDueAt: number | null;
  skipReason: WatchSkipReason;
  notifySuppressed: boolean;
}

/** Preserve null telemetry rather than inferring liveness in the dashboard. */
export function watchStatusModel(input: WatchStatusModelInput): WatchStatusModel {
  if (!input.isMainWindow) {
    return { state: "stopped", lastTickAt: null, nextTickDueAt: null, skipReason: "not-main-window", notifySuppressed: false };
  }
  const measured = input.lastTickAt !== null || input.nextTickDueAt !== null || input.lastSkipReason !== null;
  return {
    state: input.running ? "running" : measured ? "stopped" : "unmeasured",
    lastTickAt: input.lastTickAt,
    nextTickDueAt: input.nextTickDueAt,
    skipReason: input.lastSkipReason,
    notifySuppressed: input.notifySuppressed,
  };
}
