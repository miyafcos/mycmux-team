import { ptyReadGeneration } from "../ptyReadGeneration";
import { useSessionAttentionStore, type SessionAttention } from "../../stores/sessionAttentionStore";
import type { LiveTailTarget } from "../../stores/liveTailStore";

/** Acquisition and process liveness do not establish task state. */
function trustedAttention(sessionId: string): SessionAttention | undefined {
  const generation = ptyReadGeneration(sessionId);
  const attention = useSessionAttentionStore.getState().attentionBySession[sessionId];
  if (!generation.available || generation.epoch === undefined || attention?.sessionEpoch !== generation.epoch) return undefined;
  return attention;
}

/** Value identity survives duplicate feed objects, but changes with accepted state. */
export function trustedLiveTailAttentionKey(sessionId: string): string | null {
  const attention = trustedAttention(sessionId);
  return attention ? JSON.stringify([attention.sessionEpoch, attention.sessionRevision, attention.attentionId,
    attention.kind, attention.detail, attention.uiState, attention.stateSince, attention.occurrenceOrder]) : null;
}

export function trustedLiveTailStatus(sessionId: string): LiveTailTarget["status"] | undefined {
  const attention = trustedAttention(sessionId);
  if (!attention) return undefined;
  if (attention.uiState === "waiting" || attention.kind === "input" || attention.kind === "approval" || attention.kind === "rate_limited") return "waiting";
  return attention.uiState === "done" ? "idle" : attention.uiState;
}
