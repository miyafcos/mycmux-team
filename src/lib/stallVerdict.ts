import type { PromptShapeMatch } from "./promptShape";
import type { SessionActivity } from "./sessionStatusSignals";

export interface StallSignals {
  processActivity: SessionActivity;
  queuedInput: boolean;
  screenAdvanced: boolean;
  screenSilentMs: number;
  promptShape: PromptShapeMatch | null;
  ptyAlive: boolean;
}

export type StallVerdict =
  | { state: "working" }
  | { state: "waiting"; reason: "prompt" | "queued_input" }
  | { state: "stalled"; reason: "silent" | "pty_dead" }
  | { state: "unknown" };

export function resolveStallVerdict(signals: StallSignals, thresholdMs: number): StallVerdict {
  if (signals.queuedInput) return { state: "waiting", reason: "queued_input" };
  if (!signals.ptyAlive) return { state: "stalled", reason: "pty_dead" };
  if (signals.promptShape !== null) return { state: "waiting", reason: "prompt" };
  if (signals.processActivity === "streaming") return { state: "working" };
  if (signals.processActivity === "running_silent"
    && !signals.screenAdvanced
    && signals.screenSilentMs >= thresholdMs) return { state: "stalled", reason: "silent" };
  if (signals.processActivity === "idle" && !signals.screenAdvanced) return { state: "stalled", reason: "silent" };
  return { state: "unknown" };
}
