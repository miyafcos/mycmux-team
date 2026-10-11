import type { ConversationHistoryMode } from "../../lib/conversationHistory";
import type { TranscriptDescriptor, LiveSessionBrief, LiveReadObservation } from "../../lib/livebrief";
import type { SessionAttention } from "../../stores/sessionAttentionStore";
import type { SessionStatusSignals } from "../../lib/sessionStatusSignals";

export interface HistorySafety {
  active: boolean; visible: boolean; disposed: boolean;
  composing: boolean; selecting: boolean; dragging: boolean; overlay: boolean;
  liveAgentKind: string | null | undefined; ptyAlive: boolean | undefined;
  descriptor: TranscriptDescriptor | null; ready: boolean;
  attention: SessionAttention | undefined; signals: SessionStatusSignals | undefined;
  brief: LiveSessionBrief | undefined;
  observation?: LiveReadObservation;
  now: number;
}
export function explicitHistorySafe(s: HistorySafety): boolean {
  return s.active && s.visible && !s.disposed && !s.composing && !s.selecting && !s.dragging && !s.overlay && s.ready && s.descriptor !== null;
}
export function automaticHistorySafe(s: HistorySafety): boolean {
  if (!explicitHistorySafe(s) || !s.ptyAlive || s.liveAgentKind !== s.descriptor!.expectedAgentKind) return false;
  const a = s.attention, signals = s.signals, b = s.brief, d = s.descriptor!;
  if (!a || !signals || !b || signals.health !== "fresh" || signals.activity === "unknown") return false;
  if (a.kind !== "none" && a.kind !== "done") return false;
  if (a.uiState === "waiting" || a.uiState === "unknown") return false;
  if (a.sessionEpoch === null || a.sessionEpoch !== b.ptyGeneration) return false;
  const observed = signals.lastMonitorAt ?? signals.lastEvidenceAt;
  if (observed === null || s.now - observed > 5000 || s.now - observed < 0) return false;
  if (b.ptySessionId !== d.ptySessionId || b.agentKind !== d.expectedAgentKind || b.agentSessionId !== d.expectedAgentSessionId || b.telemetryHealth !== "live") return false;
  const proof=s.observation;
  const sameProof=proof && proof.serviceEpoch===b.serviceEpoch && proof.ptyGeneration===b.ptyGeneration && proof.ptyInstanceId===b.ptyInstanceId && proof.ptySessionId===b.ptySessionId && proof.agentKind===b.agentKind && proof.agentSessionId===b.agentSessionId;
  // Once an observation is provided, a foreign proof cannot borrow the brief's
  // old success. Without observations, a fresh initial snapshot remains valid.
  if(proof && !sameProof)return false;
  const readAt=sameProof?proof.lastSuccessfulReadAt:b.lastSuccessfulReadAt;
  if (b.pendingInputKind !== null || b.pendingPrompt !== null || !readAt || s.now - readAt > 5000 || s.now - readAt < 0) return false;
  return b.operationalState === "ready" || b.operationalState === "running";
}
export function isHistoryOverlayPath(event: Event): boolean {
  return event.composedPath().some((node) => node instanceof Element && !!node.closest("[data-terminal-transcript-panel], [data-terminal-search], .terminal-turn-chip, [data-archive-view]"));
}
export interface HistoryBuffer { type: "normal" | "alternate"; baseY: number; viewportY: number }
export class ConversationHistoryArbiter {
  private lastWheelAt = -Infinity;
  private closedAt = -Infinity;
  noteClose(now = Date.now()): void { this.closedAt = now; }
  wheel(event: WheelEvent, mode: ConversationHistoryMode, buffer: HistoryBuffer, safety: HistorySafety, accept: () => boolean): boolean {
    const gap = safety.now - this.lastWheelAt; this.lastWheelAt = safety.now;
    if (mode === "legacy" || mode === "manual" || event.defaultPrevented || event.ctrlKey || event.shiftKey || event.altKey || event.metaKey || !Number.isFinite(event.deltaY) || !Number.isFinite(event.deltaX) || event.deltaY >= 0 || Math.abs(event.deltaX) > Math.abs(event.deltaY) || isHistoryOverlayPath(event) || !automaticHistorySafe(safety) || safety.now - this.closedAt < 400) return false;
    if (mode === "boundary" && (buffer.type !== "normal" || buffer.baseY <= 0 || buffer.viewportY !== 0 || gap < 180)) return false;
    return accept();
  }
  boundary(mode: ConversationHistoryMode, buffer: HistoryBuffer, safety: HistorySafety, accept: () => boolean): boolean {
    return (mode === "boundary" || mode === "agent-wheel") && buffer.type === "normal" && buffer.baseY > 0 && buffer.viewportY === 0 && safety.now - this.closedAt >= 400 && automaticHistorySafe(safety) && accept();
  }
}
export function isExplicitHistoryKey(event: KeyboardEvent, mac: boolean): boolean {
  return event.key === "PageUp" && event.altKey && !event.shiftKey && (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
}
export function isHistoryBoundaryKey(event: KeyboardEvent): boolean {
  return event.key === "PageUp" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey;
}
