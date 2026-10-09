import type { AgentSessionKind, Pane, PaneTab } from "../types";
import type { SessionAttentionKind, WindowFragment } from "./ipc";

// 2026-07-30 作者の裁定: 120 → 60。mycmux 再起動直後のワークスペース巡回で
// 復活した claude/codex が RAM を占有する時間窓を半減する (localStorage
// `mycmux:agent-dormant-minutes` でいつでも上書き可)。
export const DEFAULT_AGENT_DORMANT_MINUTES = 60;
export const AGENT_DORMANT_SWEEP_INTERVAL_MS = 10 * 60 * 1_000;
export const AGENT_DORMANT_MINUTES_STORAGE_KEY = "mycmux:agent-dormant-minutes";
export const AGENT_DORMANCY_SETTINGS_EVENT = "mycmux:agent-dormancy-settings";
export const DORMANCY_HISTORY_SCAN_LINES = 400;
export const DORMANCY_SCREEN_TAIL_LINES = 24;

export type DormantAction = "kill" | "evictCache" | "saveTranscript" | "none";
export type DormancyNotificationState = "none" | "completion_only" | "blocking";
export const AGENT_DORMANT_LABEL = "休止中";
export const AGENT_DORMANT_DESCRIPTION = "休止中・会話は再開できる (プロセスは終了している)";

export function dormantAgentDescription(mark: { kind: string; dormant: boolean } | null | undefined): string | undefined {
  return mark?.dormant && (mark.kind === "claude" || mark.kind === "codex") ? AGENT_DORMANT_DESCRIPTION : undefined;
}

export function classifyDormancyNotifications(input: {
  attentionKind?: SessionAttentionKind;
  unseenCompletion: boolean;
  notificationCount: number;
  workDoneCount: number;
  waiting: boolean;
  hasQuestion: boolean;
}): DormancyNotificationState {
  if (input.waiting || input.hasQuestion || input.notificationCount > 0
    || (input.attentionKind && ["input", "approval", "error", "rate_limited"].includes(input.attentionKind))) return "blocking";
  return input.unseenCompletion || input.workDoneCount > 0 ? "completion_only" : "none";
}

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
  rateLimited: boolean;
  screenWorking: boolean;
  lastActivityAt: number;
  thresholdMs: number;
  notificationState?: DormancyNotificationState;
  allowUnreadCompletion?: boolean;
  completionTranscriptSaved?: boolean;
}

export interface DormancyObservation {
  endOffset: number;
  processStatusAt: number | null;
  semanticFingerprint: string | null;
  lastActivityAt: number;
}

export interface DormancyPressureSettings {
  enabled: boolean;
  memoryPressureMiB: number;
  severeMemoryMiB: number;
  panePressureCount: number;
  severePaneCount: number;
  pressureIdleMinutes: number;
  severeIdleMinutes: number;
}

export const DEFAULT_DORMANCY_PRESSURE_SETTINGS: Readonly<DormancyPressureSettings> = Object.freeze({
  enabled: true,
  memoryPressureMiB: 2048,
  severeMemoryMiB: 1024,
  panePressureCount: 40,
  severePaneCount: 60,
  pressureIdleMinutes: 15,
  severeIdleMinutes: 5,
});

export interface DormancyPressureSample {
  availableMemoryMiB: number | null;
  paneCount: number;
}

/** Include other windows' published seats; the live local copy wins during moves. */
export function countDormancySeats(
  workspaces: readonly { id: string; panes: readonly { tabs: readonly Pick<PaneTab, "id">[] }[] }[],
  fragments: readonly WindowFragment[] = [],
): number {
  const seenWorkspaces = new Set(workspaces.map((workspace) => workspace.id));
  let count = workspaces.reduce((total, workspace) => total + workspace.panes.reduce((n, pane) => n + pane.tabs.length, 0), 0);
  for (const fragment of fragments) {
    for (const workspace of fragment.workspaces ?? []) {
      if (seenWorkspaces.has(workspace.id)) continue;
      seenWorkspaces.add(workspace.id);
      count += workspace.panes.reduce((n, pane) => n + (pane.tabs?.length ?? 1), 0);
    }
  }
  return count;
}

export type DormancyStage = "time_only" | "normal" | "pressure" | "severe";
export interface DormancyDecision {
  stage: DormancyStage;
  thresholdMs: number;
  action: DormantAction;
  candidate: boolean;
  requiresConfirmation: boolean;
  memoryAvailable: boolean;
}

export function normalizeDormancyPressureSettings(input: Partial<DormancyPressureSettings>): DormancyPressureSettings {
  const positive = (key: Exclude<keyof DormancyPressureSettings, "enabled">): number => {
    const value = input[key];
    return typeof value === "number" && Number.isFinite(value) && value >= 1
      ? Math.round(value) : DEFAULT_DORMANCY_PRESSURE_SETTINGS[key];
  };
  const memoryPressureMiB = positive("memoryPressureMiB");
  const panePressureCount = positive("panePressureCount");
  const pressureIdleMinutes = positive("pressureIdleMinutes");
  return {
    enabled: typeof input.enabled === "boolean" ? input.enabled : true,
    memoryPressureMiB,
    severeMemoryMiB: Math.min(memoryPressureMiB, positive("severeMemoryMiB")),
    panePressureCount,
    severePaneCount: Math.max(panePressureCount, positive("severePaneCount")),
    pressureIdleMinutes,
    severeIdleMinutes: Math.min(pressureIdleMinutes, positive("severeIdleMinutes")),
  };
}

/** Pure policy: pressure can propose an earlier stop, never authorize it. */
export function evaluateDormancy(
  session: DormantSessionCandidate,
  now: number,
  sample: DormancyPressureSample,
  input: DormancyPressureSettings = DEFAULT_DORMANCY_PRESSURE_SETTINGS,
): DormancyDecision {
  const settings = normalizeDormancyPressureSettings(input);
  const memory = sample.availableMemoryMiB;
  const memoryAvailable = memory !== null && Number.isFinite(memory) && memory >= 0;
  let stage: DormancyStage = "time_only";
  if (settings.enabled && memoryAvailable) {
    stage = memory! <= settings.severeMemoryMiB || sample.paneCount >= settings.severePaneCount ? "severe"
      : memory! <= settings.memoryPressureMiB || sample.paneCount >= settings.panePressureCount ? "pressure" : "normal";
  }
  const thresholdMs = stage === "pressure" || stage === "severe"
    ? Math.min(session.thresholdMs, (stage === "severe" ? settings.severeIdleMinutes : settings.pressureIdleMinutes) * 60_000)
    : session.thresholdMs;
  const action = resolveDormantAction({ ...session, thresholdMs }, now);
  const candidate = action === "kill" || action === "saveTranscript";
  return { stage, thresholdMs, action, candidate, memoryAvailable,
    requiresConfirmation: candidate && (stage === "pressure" || stage === "severe") };
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

export function resolveDormantMinutes(rawMinutes: string | null | undefined): number {
  const trimmed = rawMinutes?.trim();
  if (!trimmed) return DEFAULT_AGENT_DORMANT_MINUTES;
  const minutes = Number(trimmed);
  if (!Number.isFinite(minutes) || minutes < 0) {
    return DEFAULT_AGENT_DORMANT_MINUTES;
  }
  return minutes;
}

export function resolveDormantThresholdMs(rawMinutes: string | null | undefined): number {
  return resolveDormantMinutes(rawMinutes) * 60 * 1_000;
}

export function readDormantMinutes(): number {
  try {
    return resolveDormantMinutes(window.localStorage.getItem(AGENT_DORMANT_MINUTES_STORAGE_KEY));
  } catch {
    return DEFAULT_AGENT_DORMANT_MINUTES;
  }
}

export function readDormantThresholdMs(): number {
  return readDormantMinutes() * 60 * 1_000;
}

/** Persist a UI-selected timeout and notify the active dormancy sweep immediately. */
export function writeDormantMinutes(minutes: number): number {
  const normalized = resolveDormantMinutes(String(minutes));
  try {
    window.localStorage.setItem(AGENT_DORMANT_MINUTES_STORAGE_KEY, String(normalized));
    window.dispatchEvent(new Event(AGENT_DORMANCY_SETTINGS_EVENT));
  } catch {
    // Storage can be unavailable in restricted WebViews. Keep the caller's UI
    // deterministic by returning the normalized value even when persistence fails.
  }
  return normalized;
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

export function hasBlockingDormancyAttention(candidate: DormantSessionCandidate): boolean {
  if (candidate.notificationState === "blocking") return true;
  if (candidate.notificationState === "completion_only") return candidate.allowUnreadCompletion !== true;
  return candidate.hasAttention;
}

export function resolveDormantAction(
  candidate: DormantSessionCandidate,
  now: number,
): DormantAction {
  const eligible = candidate.thresholdMs > 0
    && (candidate.agentKind === "claude" || candidate.agentKind === "codex")
    && Boolean(candidate.resumeSessionId)
    && !candidate.visible
    && !hasBlockingDormancyAttention(candidate)
    && !candidate.rateLimited
    && !candidate.screenWorking
    && !hasFreshAgentWork(candidate)
    && !isEffectivelyWorking(candidate)
    && now - candidate.lastActivityAt >= candidate.thresholdMs;
  if (!eligible) return "none";
  if (candidate.mounted) return "evictCache";
  if (candidate.notificationState === "completion_only" && !candidate.completionTranscriptSaved) return "saveTranscript";
  return "kill";
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

function findClaudeInputFooterStart(lines: readonly string[], screenStart: number): number | null {
  const isInputRule = (line: string): boolean => /^\s*\u2500{4,}\s*$/u.test(line);
  // A footer belongs to the current screen only when matching full-width rules
  // enclose a Claude input prompt. A lone rule, body table or shell prompt cannot
  // establish the boundary. Search backwards so earlier conversation is retained.
  for (let lower = lines.length - 1; lower >= screenStart; lower -= 1) {
    if (!isInputRule(lines[lower])) continue;
    let upper = lower - 1;
    while (upper >= screenStart && !isInputRule(lines[upper])) upper -= 1;
    if (upper < screenStart || lines[upper].trim() !== lines[lower].trim()) continue;
    let prompt = upper + 1;
    while (prompt < lower && !lines[prompt].trim()) prompt += 1;
    if (prompt < lower && /^\s*\u276f(?:\s|$)/u.test(lines[prompt])) return lower + 1;
  }
  return null;
}

export async function fingerprintDormancySemanticState(
  lines: readonly string[],
  screenTailLines: number = DORMANCY_SCREEN_TAIL_LINES,
): Promise<string | null> {
  if (lines.length === 0) return null;
  const tailCount = Math.max(0, Math.trunc(screenTailLines));
  const screenStart = Math.max(0, lines.length - tailCount);
  const footerStart = findClaudeInputFooterStart(lines, screenStart);
  const semanticLines = lines.slice(0, footerStart ?? lines.length).map((line, index) => (
    index < screenStart ? line : normalizeDormancyScreenLine(line)
  ));
  // One marker also ignores footer row-count changes, including wrapped status
  // lines. Working evidence is still checked separately against the raw screen.
  if (footerStart !== null) semanticLines.push("<claude-input-footer>");
  const semanticState = semanticLines.join("\u0000");
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
