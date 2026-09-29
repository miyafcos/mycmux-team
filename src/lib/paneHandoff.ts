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

/** Outer third of the width splits left/right — the edge you aim at in Explorer. */
export const PANE_HORIZONTAL_EDGE_RATIO = 1 / 3;
/** Outer quarter of the height splits up/down; stacking is the rarer intent. */
export const PANE_VERTICAL_EDGE_RATIO = 1 / 4;
const PANE_EDGE_STICKY_PX = 4;

/**
 * Five-zone hit test for a pane. The bands are a share of the pane rather than
 * a pixel cap, so the outer edge of the window always answers: a capped band
 * (the old 24-72px) is a sliver of a wide pane and has to be hunted for.
 *
 * Both bands overlap in a corner, so the winner is the one the pointer sits
 * deepest inside *relative to that band* — comparing raw pixels would hand
 * every corner to the narrower band. The zone already in hand keeps four
 * pixels of grip (the minimap's MINIMAP_EDGE_HYSTERESIS_PX idea) so the
 * preview does not flicker on a boundary or along a corner diagonal.
 */
export function resolvePaneDropZone(
  rect: PaneDropRect,
  x: number,
  y: number,
  previousZone: PaneDropZone = "center",
): PaneDropZone {
  const horizontalBand = rect.width * PANE_HORIZONTAL_EDGE_RATIO;
  const verticalBand = rect.height * PANE_VERTICAL_EDGE_RATIO;
  const candidates = [
    { zone: "left" as const, distance: x - rect.left, band: horizontalBand },
    { zone: "right" as const, distance: rect.right - x, band: horizontalBand },
    { zone: "up" as const, distance: y - rect.top, band: verticalBand },
    { zone: "down" as const, distance: rect.bottom - y, band: verticalBand },
  ];
  let best: { zone: PaneDropZone; ratio: number } | null = null;
  for (const candidate of candidates) {
    if (candidate.band <= 0) continue;
    const distance = candidate.distance
      - (candidate.zone === previousZone ? PANE_EDGE_STICKY_PX : 0);
    if (distance > candidate.band) continue;
    const ratio = distance / candidate.band;
    if (!best || ratio < best.ratio) best = { zone: candidate.zone, ratio };
  }
  return best?.zone ?? "center";
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
