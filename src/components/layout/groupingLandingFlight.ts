import type { GroupingApplyAnimationPoint } from "./groupingApplyAnimation";

/**
 * Pure logic for phase 2 of the grouping apply animation: after the in-diagram
 * flight commits, the same proxy leaves the panel, crosses the viewport on a
 * tangent-continuous cubic bridge, and lands on the real pane (or on the
 * workspace navigation entry for tabs bound to a non-visible workspace, per
 * the settled ruling on 2026-08-29).
 */

export const GROUPING_BRIDGE_FLIGHT_MS = 140;
export const GROUPING_LANDING_SETTLE_FRAMES = 2;
export const GROUPING_LANDING_SETTLE_THRESHOLD_PX = 1;
export const GROUPING_LANDING_WAIT_LIMIT_MS = 100;

export interface GroupingLandingRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Unit tangent of the diagram path at its end, taken from the last pair of
 * distinct samples. Returns null when the path has no direction (all samples
 * identical), letting the caller fall back to a straight bridge.
 */
export function groupingExitTangent(
  samples: readonly GroupingApplyAnimationPoint[],
): GroupingApplyAnimationPoint | null {
  for (let index = samples.length - 1; index > 0; index -= 1) {
    const dx = samples[index].x - samples[index - 1].x;
    const dy = samples[index].y - samples[index - 1].y;
    const length = Math.hypot(dx, dy);
    if (length > 1e-6) return { x: dx / length, y: dy / length };
  }
  return null;
}

/**
 * Cubic bridge from the diagram exit point to the landing point that keeps the
 * exit tangent, so the hand-off from the frozen preview path is seamless. The
 * result is an SVG path string consumable by sampleGroupingApplyPath.
 */
export function groupingBridgePath(
  exit: GroupingApplyAnimationPoint,
  tangent: GroupingApplyAnimationPoint | null,
  landing: GroupingApplyAnimationPoint,
): string {
  const span = Math.hypot(landing.x - exit.x, landing.y - exit.y);
  if (span <= 1e-6 || !tangent) {
    return `M ${exit.x} ${exit.y} L ${landing.x} ${landing.y}`;
  }
  const reach = span / 3;
  const control1 = { x: exit.x + tangent.x * reach, y: exit.y + tangent.y * reach };
  const control2 = {
    x: control1.x + (landing.x - control1.x) / 2,
    y: control1.y + (landing.y - control1.y) / 2,
  };
  return `M ${exit.x} ${exit.y} C ${control1.x} ${control1.y} ${control2.x} ${control2.y} ${landing.x} ${landing.y}`;
}

export type GroupingLandingSettleState =
  | { state: "pending" }
  | { state: "settled"; rect: GroupingLandingRect }
  | { state: "expired"; rect: GroupingLandingRect | null };

export interface GroupingLandingSettleTracker {
  observe: (rect: GroupingLandingRect | null, nowMs: number) => GroupingLandingSettleState;
}

function rectDelta(left: GroupingLandingRect, right: GroupingLandingRect): number {
  return Math.max(
    Math.abs(left.left - right.left),
    Math.abs(left.top - right.top),
    Math.abs(left.width - right.width),
    Math.abs(left.height - right.height),
  );
}

/**
 * Frame-fed stability gate for the landing rect: settled once the rect moved
 * less than the threshold across the required consecutive frame pairs, expired
 * once the wait limit passes (reporting the freshest rect seen, which the
 * caller uses as the fallback landing point).
 */
export function createGroupingLandingSettleTracker(
  startMs: number,
  options?: {
    thresholdPx?: number;
    framesNeeded?: number;
    timeLimitMs?: number;
  },
): GroupingLandingSettleTracker {
  const threshold = options?.thresholdPx ?? GROUPING_LANDING_SETTLE_THRESHOLD_PX;
  const framesNeeded = options?.framesNeeded ?? GROUPING_LANDING_SETTLE_FRAMES;
  const timeLimitMs = options?.timeLimitMs ?? GROUPING_LANDING_WAIT_LIMIT_MS;
  let previous: GroupingLandingRect | null = null;
  let freshest: GroupingLandingRect | null = null;
  let stableFrames = 0;
  let done = false;

  return {
    observe: (rect, nowMs) => {
      if (done) throw new Error("Grouping landing settle tracker already finished");
      if (rect) {
        freshest = rect;
        if (previous && rectDelta(previous, rect) < threshold) stableFrames += 1;
        else stableFrames = 0;
        previous = rect;
        if (stableFrames >= framesNeeded - 1) {
          done = true;
          return { state: "settled", rect };
        }
      } else {
        previous = null;
        stableFrames = 0;
      }
      if (nowMs - startMs >= timeLimitMs) {
        done = true;
        return { state: "expired", rect: freshest };
      }
      return { state: "pending" };
    },
  };
}

export interface GroupingLandingMovedTab {
  tabId: string;
  workspaceId: string;
  paneId: string;
}

export interface GroupingLandingAssignments {
  /** Tabs bound to the visible workspace: each proxy lands on its real pane/tab. */
  paneLandings: readonly GroupingLandingMovedTab[];
  /**
   * Tabs bound to non-visible workspaces, bundled per destination workspace:
   * their proxies converge on that workspace's navigation entry.
   */
  bundles: ReadonlyMap<string, readonly GroupingLandingMovedTab[]>;
}

export function groupingLandingAssignments(
  moved: readonly GroupingLandingMovedTab[],
  visibleWorkspaceId: string | null,
): GroupingLandingAssignments {
  const paneLandings: GroupingLandingMovedTab[] = [];
  const bundles = new Map<string, GroupingLandingMovedTab[]>();
  for (const tab of moved) {
    if (tab.workspaceId === visibleWorkspaceId) {
      paneLandings.push(tab);
      continue;
    }
    const bundle = bundles.get(tab.workspaceId);
    if (bundle) bundle.push(tab);
    else bundles.set(tab.workspaceId, [tab]);
  }
  return { paneLandings, bundles };
}
