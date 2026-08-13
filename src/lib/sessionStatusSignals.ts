export type SessionActivity = "streaming" | "running_silent" | "idle" | "unknown";
export type SessionHealth = "fresh" | "stale" | "degraded" | "unknown";

export interface SessionStatusSignals {
  activity: SessionActivity;
  health: SessionHealth;
  lastOutputAt: number | null;
  lastMonitorAt: number | null;
  lastEvidenceAt: number | null;
  processStartedAt: number | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function timestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function activity(value: unknown): SessionActivity {
  if (value === "streaming" || value === "Streaming") return "streaming";
  if (value === "running_silent" || value === "RunningSilent") return "running_silent";
  if (value === "idle" || value === "Idle") return "idle";
  return "unknown";
}

function health(value: unknown): SessionHealth {
  if (value === "fresh" || value === "Fresh") return "fresh";
  if (value === "stale" || value === "Stale") return "stale";
  if (value === "degraded" || value === "Degraded") return "degraded";
  return "unknown";
}

/**
 * Reads optional fields added by the Rust status feed without coupling callers
 * to a particular frontend IPC declaration or feed version.
 */
export function readSessionStatusSignals(raw: unknown): SessionStatusSignals {
  const status = record(raw);
  const process = record(status?.process);
  return {
    activity: activity(status?.activity),
    health: health(status?.health),
    lastOutputAt: timestamp(status?.last_output_at),
    lastMonitorAt: timestamp(status?.last_monitor_at),
    lastEvidenceAt: timestamp(status?.last_evidence_at),
    processStartedAt: timestamp(process?.started_at),
  };
}
