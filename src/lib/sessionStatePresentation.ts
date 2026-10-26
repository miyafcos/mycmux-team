import type { LiveReadObservation, LiveSessionBrief } from "./livebrief";
import type { SessionStatusSignals } from "./sessionStatusSignals";
import type { SessionAttention } from "../stores/sessionAttentionStore";

export type PresentedSessionState = "needsHuman" | "running" | "done" | "error" | "unknown" | "idle" | "stopped";
export const SESSION_STATE_LABELS: Record<PresentedSessionState, string> = {
  needsHuman: "要回答", running: "作業中", done: "返答終了", error: "エラー",
  unknown: "状態確認不能", idle: "待機", stopped: "終了済み",
};
const FRESH_MS = 30_000;
const recent = (at: number | null | undefined, now: number): boolean =>
  typeof at === "number" && Number.isFinite(at) && now >= at && now - at <= FRESH_MS;

/** The same evidence order drives headers and dashboard rows. Silence is not a stop signal. */
export function presentSessionState({ attention, signals, brief, observation, identity, now = Date.now() }: {
  attention?: SessionAttention;
  signals?: SessionStatusSignals;
  brief?: LiveSessionBrief;
  observation?: LiveReadObservation;
  identity?: { sessionId: string; agentKind?: string; agentSessionId?: string };
  now?: number;
}): PresentedSessionState | null {
  if (attention && signals) {
    const fresh = signals.health === "fresh" && recent(Math.max(signals.lastMonitorAt ?? 0, signals.lastEvidenceAt ?? 0), now);
    if (fresh) {
      if (attention.kind === "input" || attention.kind === "approval") return "needsHuman";
      if (attention.kind === "error" || attention.kind === "rate_limited") return "error";
      if (attention.kind === "done" || attention.uiState === "done") return "done";
      if (attention.uiState === "idle") return "idle";
      if (attention.uiState === "working") return "running";
      return "unknown";
    }
    // A stale canonical feed can yield only to proof for the current owner.
    if (!brief || attention.sessionId !== brief.ptySessionId || attention.sessionEpoch !== brief.ptyGeneration
      || !identity?.agentKind || !identity.agentSessionId) return "unknown";
  }
  if (!brief) return null;
  if (identity && (identity.sessionId !== brief.ptySessionId
    || (identity.agentKind && identity.agentKind !== brief.agentKind)
    || (identity.agentSessionId && identity.agentSessionId !== brief.agentSessionId))) return "unknown";
  if (brief.telemetryHealth === "ended") return "stopped";
  const proof = observation?.serviceEpoch === brief.serviceEpoch
    && observation.ptySessionId === brief.ptySessionId && observation.agentKind === brief.agentKind
    && observation.agentSessionId === brief.agentSessionId && observation.ptyGeneration === brief.ptyGeneration
    && observation.ptyInstanceId === brief.ptyInstanceId ? observation.lastSuccessfulReadAt : null;
  if (brief.telemetryHealth !== "live" || !recent(proof ?? brief.lastSuccessfulReadAt, now)) return "unknown";
  if (brief.operationalState === "needsHuman") return "needsHuman";
  const autonomy = brief.autonomy;
  const recentWork = brief.lastEventAt !== null && now - brief.lastEventAt < 30 * 60_000;
  const pendingNotification = (autonomy?.pendingNotificationCount ?? 0) > 0
    && (autonomy?.turnState !== "complete" || brief.lastEventAt === null || recentWork);
  if (autonomy?.turnState === "active" || (autonomy?.openToolCount ?? 0) > 0
    || (autonomy?.armedBackgroundCount ?? 0) > 0 || pendingNotification
    || (recentWork && (autonomy?.turnState === "unknown" || autonomy?.backgroundState === "unknown"))) return "running";
  if (autonomy?.turnState === "complete") return "done";
  if (autonomy?.turnState === "idle") return "idle";
  if (brief.operationalState === "running") return "running";
  return "unknown";
}
