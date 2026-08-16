import type { PaneMetadata } from "../stores/paneMetadataStore";
import type { PaneDropTarget, PaneDropZone } from "../stores/paneDragStore";
import type { AgentSessionKind, PaneTab } from "../types";
import { resolveLiveSavepointTargetKind } from "./savepointHandoff";

type HandoffMetadata = Pick<PaneMetadata, "agentKind" | "agentSessionId" | "cwd">;

export interface PaneHandoffEndpoint {
  workspaceId: string;
  paneId: string;
  tab: PaneTab | undefined;
  metadata: HandoffMetadata | undefined;
}

export interface PaneHandoffEligibility {
  sourceAgentKind: AgentSessionKind;
  publishAgentKind: "claude" | "codex";
  sourceAgentSessionId: string;
  sourceCwd: string;
  targetAgentKind: AgentSessionKind;
}

interface PaneDropRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

interface PaneDropSourceIdentity {
  kind: "pane" | "tab";
  workspaceId: string;
  paneId: string;
}

type PaneZoneDropTarget = Extract<PaneDropTarget, { kind: "pane" }>;

export function isPaneDropTargetEligible(
  source: PaneDropSourceIdentity,
  target: PaneZoneDropTarget,
  sourceTabCount: number,
): boolean {
  const isSourcePane = source.workspaceId === target.workspaceId
    && source.paneId === target.paneId;
  if (!isSourcePane) return true;
  if (source.kind === "pane" || target.zone === "center") return false;
  return sourceTabCount >= 2;
}

export function resolvePaneDropZone(
  rect: PaneDropRect,
  x: number,
  y: number,
  edgeRatio = 0.16,
): PaneDropZone {
  const horizontalBand = Math.min(72, Math.max(24, rect.width * edgeRatio));
  const verticalBand = Math.min(60, Math.max(22, rect.height * edgeRatio));
  const distances = [
    { zone: "left" as const, value: x - rect.left, limit: horizontalBand },
    { zone: "right" as const, value: rect.right - x, limit: horizontalBand },
    { zone: "up" as const, value: y - rect.top, limit: verticalBand },
    { zone: "down" as const, value: rect.bottom - y, limit: verticalBand },
  ].sort((a, b) => a.value - b.value);
  const nearest = distances[0];
  return nearest.value <= nearest.limit ? nearest.zone : "center";
}

export function resolvePaneHandoffEligibility(
  source: PaneHandoffEndpoint,
  target: PaneHandoffEndpoint,
): PaneHandoffEligibility | null {
  if (
    source.workspaceId === target.workspaceId
    && source.paneId === target.paneId
  ) {
    return null;
  }
  if (!source.tab || (source.tab.type !== undefined && source.tab.type !== "terminal")) {
    return null;
  }
  const sourceAgentKind = source.metadata?.agentKind;
  const sourceAgentSessionId = source.metadata?.agentSessionId;
  const sourceCwd = source.metadata?.cwd;
  if (!sourceAgentKind || !sourceAgentSessionId || !sourceCwd) return null;
  // Grok is intentionally outside the CRSM/savepoint handoff pipeline for now.
  if (sourceAgentKind === "grok") return null;

  const targetAgentKind = resolveLiveSavepointTargetKind(
    target.tab,
    target.metadata?.agentKind,
  );
  if (!targetAgentKind) return null;

  return {
    sourceAgentKind,
    publishAgentKind: sourceAgentKind === "claude-codex" ? "claude" : sourceAgentKind,
    sourceAgentSessionId,
    sourceCwd,
    targetAgentKind,
  };
}

export function prioritizePaneHandoffDropTarget(
  isHandoffChip: boolean,
  handoffTarget: Extract<PaneDropTarget, { kind: "handoff" }> | null,
  fallbackTarget: PaneDropTarget | null,
): PaneDropTarget | null {
  return isHandoffChip && handoffTarget ? handoffTarget : fallbackTarget;
}
