import type { AgentSessionKind, Pane, PaneTab } from "../types";

export const DEFAULT_AGENT_DORMANT_MINUTES = 120;
export const AGENT_DORMANT_SWEEP_INTERVAL_MS = 10 * 60 * 1_000;
export const AGENT_DORMANT_MINUTES_STORAGE_KEY = "mycmux:agent-dormant-minutes";

export type DormantAction = "kill" | "evictCache" | "none";

export interface DormantResumeIdentity {
  agentKind: "claude" | "codex";
  resumeSessionId: string;
}

export interface DormantSessionCandidate {
  agentKind: AgentSessionKind | null;
  resumeSessionId: string | null;
  visible: boolean;
  mounted: boolean;
  processStatus: "working" | "idle" | null;
  processName: string | null;
  lastActivityAt: number;
  thresholdMs: number;
}

export interface DormancyObservation {
  endOffset: number;
  lastActivityAt: number;
}

const frontendWriteAt = new Map<string, number>();

export function resolveRenderedTabId(pane: Pick<Pane, "activeTabId" | "tabs">): string | null {
  return pane.tabs.find((tab) => tab.id === pane.activeTabId)?.id
    ?? pane.tabs[0]?.id
    ?? null;
}

export function resolveDormantResumeIdentity(tab: PaneTab): DormantResumeIdentity | null {
  if (tab.agentKind === "claude") {
    const resumeSessionId = tab.agentSessionId ?? tab.claudeSessionId;
    return resumeSessionId ? { agentKind: "claude", resumeSessionId } : null;
  }
  if (tab.agentKind === "codex" && tab.agentSessionId) {
    return { agentKind: "codex", resumeSessionId: tab.agentSessionId };
  }
  return null;
}

export function resolveDormantThresholdMs(rawMinutes: string | null | undefined): number {
  const trimmed = rawMinutes?.trim();
  if (!trimmed) return DEFAULT_AGENT_DORMANT_MINUTES * 60 * 1_000;
  const minutes = Number(trimmed);
  if (!Number.isFinite(minutes) || minutes < 0) {
    return DEFAULT_AGENT_DORMANT_MINUTES * 60 * 1_000;
  }
  return minutes * 60 * 1_000;
}

export function readDormantThresholdMs(): number {
  try {
    // DevTools: setItem with this key, then restart the app to apply the override.
    return resolveDormantThresholdMs(
      window.localStorage.getItem(AGENT_DORMANT_MINUTES_STORAGE_KEY),
    );
  } catch {
    return resolveDormantThresholdMs(undefined);
  }
}

export function isAgentRestProcess(name: string | null | undefined): boolean {
  const lower = name?.trim().toLowerCase();
  if (!lower) return false;
  const leaf = lower.endsWith(".exe") ? lower.slice(0, -4) : lower;
  return leaf === "claude"
    || leaf === "codex"
    || leaf === "node"
    || leaf === "node_repl";
}

export function isEffectivelyWorking(
  candidate: Pick<DormantSessionCandidate, "processStatus" | "processName">,
): boolean {
  return candidate.processStatus === "working"
    && !isAgentRestProcess(candidate.processName);
}

export function resolveDormantAction(
  candidate: DormantSessionCandidate,
  now: number,
): DormantAction {
  const eligible = candidate.thresholdMs > 0
    && (candidate.agentKind === "claude" || candidate.agentKind === "codex")
    && Boolean(candidate.resumeSessionId)
    && !candidate.visible
    && !isEffectivelyWorking(candidate)
    && now - candidate.lastActivityAt >= candidate.thresholdMs;
  if (!eligible) return "none";
  return candidate.mounted ? "evictCache" : "kill";
}

export function shouldDormantSession(
  candidate: DormantSessionCandidate,
  now: number,
): boolean {
  return resolveDormantAction(candidate, now) === "kill";
}

export function observeDormancyActivity(
  previous: DormancyObservation | undefined,
  endOffset: number,
  lastFrontendWriteAt: number | undefined,
  now: number,
): DormancyObservation {
  if (!previous || previous.endOffset !== endOffset) {
    return { endOffset, lastActivityAt: now };
  }
  return {
    endOffset,
    lastActivityAt: Math.max(previous.lastActivityAt, lastFrontendWriteAt ?? 0),
  };
}

export function markSessionFrontendActivity(sessionId: string, at: number = Date.now()): void {
  frontendWriteAt.set(sessionId, at);
}

export function getSessionFrontendActivity(sessionId: string): number | undefined {
  return frontendWriteAt.get(sessionId);
}

export function clearSessionFrontendActivity(sessionId: string): void {
  frontendWriteAt.delete(sessionId);
}
