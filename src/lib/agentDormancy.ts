import type { AgentSessionKind, Pane, PaneTab } from "../types";

// 2026-07-30 宮崎さん裁定: 120 → 60。mycmux 再起動直後のワークスペース巡回で
// 復活した claude/codex が RAM を占有する時間窓を半減する (localStorage
// `mycmux:agent-dormant-minutes` でいつでも上書き可)。
export const DEFAULT_AGENT_DORMANT_MINUTES = 60;
export const AGENT_DORMANT_SWEEP_INTERVAL_MS = 10 * 60 * 1_000;
export const AGENT_DORMANT_MINUTES_STORAGE_KEY = "mycmux:agent-dormant-minutes";
export const DORMANCY_HISTORY_SCAN_LINES = 400;
export const DORMANCY_SCREEN_TAIL_LINES = 24;

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
  processStatusAt: number | null;
  agentStatus: "working" | "waiting" | "done" | "idle" | null;
  agentStatusFresh: boolean;
  hasAttention: boolean;
  screenWorking: boolean;
  lastActivityAt: number;
  thresholdMs: number;
}

export interface DormancyObservation {
  endOffset: number;
  processStatusAt: number | null;
  semanticFingerprint: string | null;
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
  if (candidate.processStatus === null) return true;
  return candidate.processStatus === "working" && !isAgentRestProcess(candidate.processName);
}

export function hasFreshAgentWork(
  candidate: Pick<DormantSessionCandidate, "agentStatus" | "agentStatusFresh">,
): boolean {
  return candidate.agentStatusFresh
    && (candidate.agentStatus === "working" || candidate.agentStatus === "waiting");
}

export function resolveDormantAction(
  candidate: DormantSessionCandidate,
  now: number,
): DormantAction {
  const eligible = candidate.thresholdMs > 0
    && (candidate.agentKind === "claude" || candidate.agentKind === "codex")
    && Boolean(candidate.resumeSessionId)
    && !candidate.visible
    && !candidate.hasAttention
    && !candidate.screenWorking
    && !hasFreshAgentWork(candidate)
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
  processStatusAt: number | null,
  semanticFingerprint: string | null,
  lastFrontendWriteAt: number | undefined,
  now: number,
): DormancyObservation {
  const outputAdvanced = previous?.endOffset !== endOffset;
  const processChanged = previous?.processStatusAt !== processStatusAt;
  const semanticOutputChanged = previous?.semanticFingerprint !== semanticFingerprint;
  const cannotClassifyOutput = outputAdvanced
    && (previous?.semanticFingerprint === null || semanticFingerprint === null);
  if (!previous || processChanged || semanticOutputChanged || cannotClassifyOutput) {
    return { endOffset, processStatusAt, semanticFingerprint, lastActivityAt: now };
  }
  return {
    endOffset,
    processStatusAt,
    semanticFingerprint,
    lastActivityAt: Math.max(previous.lastActivityAt, lastFrontendWriteAt ?? 0),
  };
}

function normalizeDormancyScreenLine(line: string): string {
  if (/[|\u2502]\s*CTX\s+.+[|\u2502]\s*\$[^|\u2502]+[|\u2502].+[|\u2502]\s*API\s+/i.test(line)) {
    return "<claude-context-status>";
  }
  if (/^5h\s+.+[|\u2502]\s*7d\s+/i.test(line)) return "<claude-quota-status>";
  if (/^CC\s+\S+\s+[|\u2502]\s*sid\s+/i.test(line)) return "<claude-version-status>";
  if (/^Context\s+\d+%\s+used\s+\xB7/i.test(line)) {
    return line.replace(/^Context\s+\d+%\s+used/i, "Context <used> used");
  }
  return line;
}

export async function fingerprintDormancySemanticState(
  lines: readonly string[],
  screenTailLines: number = DORMANCY_SCREEN_TAIL_LINES,
): Promise<string | null> {
  if (lines.length === 0) return null;
  const tailCount = Math.max(0, Math.trunc(screenTailLines));
  const screenStart = Math.max(0, lines.length - tailCount);
  const semanticState = lines.map((line, index) => (
    index < screenStart ? line : normalizeDormancyScreenLine(line)
  )).join("\u0000");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(semanticState));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function hasWorkingScreenEvidence(lines: readonly string[]): boolean {
  const screen = lines.slice(-DORMANCY_SCREEN_TAIL_LINES).join("\n");
  return /\besc to interrupt\b/i.test(screen)
    || /(?:^|\s)Working\s*\(\d+[hms]/im.test(screen)
    || /^[\u2736\u273b\u273d\u2722]\s+.+(?:\u2026|\.\.\.).*\(\d+[hms]/mu.test(screen)
    || /\bRunning\s+\d+\s+(?:shell\s+)?commands?\b/i.test(screen);
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
