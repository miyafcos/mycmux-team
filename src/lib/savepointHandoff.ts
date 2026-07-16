import type { AgentSessionKind, PaneTab } from "../types";

export type SavepointSpawnDirection = "left" | "right";

export type SavepointReleaseDisposition = "cancel" | "commit" | "invalid";

export type SavepointPaneDropIntent =
  | { mode: "paste" }
  | { mode: "spawn"; direction: SavepointSpawnDirection };

export type SavepointDropOpenResult<TFull, TSummary> =
  | { mode: "full"; joined: TFull }
  | { mode: "handoff"; joined: TSummary; fullResumeError: unknown };

interface SavepointDropRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

const TARGET_LABELS: Record<AgentSessionKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
  "claude-codex": "Claude + Codex",
};

function normalizeTargetKind(value: string | undefined): AgentSessionKind | null {
  if (value === "claude" || value === "codex" || value === "claude-codex") return value;
  return null;
}

export function resolveLiveSavepointTargetKind(
  tab: PaneTab | undefined,
  liveKind?: string,
): AgentSessionKind | null {
  if (!tab || (tab.type !== undefined && tab.type !== "terminal")) return null;
  return normalizeTargetKind(liveKind);
}

export function resolveSavepointPaneDropIntent(
  rect: SavepointDropRect,
  x: number,
  y: number,
  canPaste: boolean,
): SavepointPaneDropIntent | null {
  const horizontalBand = Math.min(72, Math.max(24, rect.width * 0.16));
  const bottomBand = Math.min(60, Math.max(22, rect.height * 0.16));
  const candidates = [
    { intent: { mode: "spawn" as const, direction: "left" as const }, distance: x - rect.left, limit: horizontalBand },
    { intent: { mode: "spawn" as const, direction: "right" as const }, distance: rect.right - x, limit: horizontalBand },
    ...(canPaste
      ? [{ intent: { mode: "paste" as const }, distance: rect.bottom - y, limit: bottomBand }]
      : []),
  ]
    .filter((candidate) => candidate.distance >= 0 && candidate.distance <= candidate.limit)
    .sort((a, b) => a.distance - b.distance);
  return candidates[0]?.intent ?? null;
}

export function resolveSavepointReleaseDisposition(
  onCancelSurface: boolean,
  hasTarget: boolean,
): SavepointReleaseDisposition {
  if (onCancelSurface) return "cancel";
  return hasTarget ? "commit" : "invalid";
}

export async function prepareSavepointDropOpen<TFull, TSummary>(
  bundleDir: string,
  joinFull: (bundleDir: string) => Promise<TFull>,
  joinSummary: (bundleDir: string) => Promise<TSummary>,
): Promise<SavepointDropOpenResult<TFull, TSummary>> {
  try {
    return { mode: "full", joined: await joinFull(bundleDir) };
  } catch (fullResumeError) {
    return {
      mode: "handoff",
      joined: await joinSummary(bundleDir),
      fullResumeError,
    };
  }
}

export function savepointTargetLabel(kind: AgentSessionKind): string {
  return TARGET_LABELS[kind];
}

export function sanitizeSavepointHandoffDraft(text: string): string {
  return text.replace(/[\r\n]+/g, " ");
}

export function buildSavepointHandoffLaunchEnv(
  targetKind: AgentSessionKind,
  sourceSessionId: string,
  handoffPath: string,
  sourceKind: AgentSessionKind = "claude",
): Record<string, string> {
  return {
    MYCMUX_AGENT_KIND: targetKind,
    MYCMUX_HANDOFF: targetKind,
    MYCMUX_HANDOFF_FROM: sourceKind,
    MYCMUX_HANDOFF_PROMPT_FILE: handoffPath,
    MYCMUX_HANDOFF_FROM_SESSION: sourceSessionId,
  };
}
