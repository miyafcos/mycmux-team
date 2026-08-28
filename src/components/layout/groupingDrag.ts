import {
  paneRefKey,
  parsePaneRefKey,
  type GroupingEditTarget,
} from "./groupingEdit";
import type { GroupingPlan } from "./tabGrouping";

export const GROUPING_DRAG_THRESHOLD_PX = 7;
export const GROUPING_AUTOSCROLL_EDGE_PX = 24;
export const GROUPING_AUTOSCROLL_STEP_PX = 8;

export type GroupingDragCancelReason =
  | "pointercancel"
  | "escape"
  | "unmount"
  | "lost-capture"
  | "blur"
  | "target-gone"
  | "revision-changed"
  | "mode-changed"
  | "resize"
  | "noop"
  | "layout-changed"
  | "focus-moved"
  | "secondary-button"
  | "stale-selection";

export interface GroupingDragOrigin {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  readonly sourceTabId: string;
  readonly tabIds: readonly string[];
}

export type GroupingDragState =
  | { readonly phase: "idle" }
  | { readonly phase: "armed"; readonly origin: GroupingDragOrigin }
  | {
      readonly phase: "dragging";
      readonly origin: GroupingDragOrigin;
      readonly x: number;
      readonly y: number;
      readonly dropId: string | null;
    }
  | {
      readonly phase: "dropping";
      readonly origin: GroupingDragOrigin;
      readonly dropId: string;
    };

export type GroupingDragEvent =
  | { readonly kind: "press"; readonly origin: GroupingDragOrigin }
  | {
      readonly kind: "move";
      readonly pointerId: number;
      readonly x: number;
      readonly y: number;
      readonly dropId: string | null;
    }
  | {
      readonly kind: "release";
      readonly pointerId: number;
      readonly dropId: string | null;
    }
  | { readonly kind: "settle" }
  | { readonly kind: "cancel"; readonly reason: GroupingDragCancelReason };

export type GroupingDragEffect =
  | { readonly kind: "none" }
  | { readonly kind: "begin"; readonly origin: GroupingDragOrigin }
  | { readonly kind: "click"; readonly sourceTabId: string }
  | {
      readonly kind: "drop";
      readonly tabIds: readonly string[];
      readonly dropId: string;
    }
  | { readonly kind: "cancelled"; readonly reason: GroupingDragCancelReason };

const NONE: GroupingDragEffect = { kind: "none" };
const IDLE: GroupingDragState = { phase: "idle" };
const KEEP_CURRENT_DROP_ID = "keep-current";
const GROUP_DROP_PREFIX = "group:";

function encodeOpaqueGroupId(groupId: string): string {
  try {
    return encodeURIComponent(groupId);
  } catch {
    let encoded = "";
    for (let index = 0; index < groupId.length; index += 1) {
      encoded += `%u${groupId.charCodeAt(index).toString(16).padStart(4, "0").toUpperCase()}`;
    }
    return encoded;
  }
}

function decodeOpaqueGroupId(encoded: string): string {
  if (/^(?:%u[0-9A-F]{4})+$/.test(encoded)) {
    let decoded = "";
    for (let index = 0; index < encoded.length; index += 6) {
      decoded += String.fromCharCode(Number.parseInt(encoded.slice(index + 2, index + 6), 16));
    }
    return decoded;
  }
  return decodeURIComponent(encoded);
}

export function groupingDropIdForTarget(target: GroupingEditTarget): string {
  if (target.kind === "unassigned") return KEEP_CURRENT_DROP_ID;
  if (target.kind === "pane") return paneRefKey(target);
  return `${GROUP_DROP_PREFIX}${encodeOpaqueGroupId(target.groupId)}`;
}

function groupTargetFromDropId(dropId: string): GroupingEditTarget | null {
  if (!dropId.startsWith(GROUP_DROP_PREFIX)) return null;
  const encodedGroupId = dropId.slice(GROUP_DROP_PREFIX.length);
  if (encodedGroupId.length === 0) return null;
  try {
    const target: GroupingEditTarget = {
      kind: "group",
      groupId: decodeOpaqueGroupId(encodedGroupId),
    };
    return target.groupId.length > 0 && groupingDropIdForTarget(target) === dropId
      ? target
      : null;
  } catch {
    return null;
  }
}

export function groupingDragReduce(
  state: GroupingDragState,
  event: GroupingDragEvent,
  thresholdPx = GROUPING_DRAG_THRESHOLD_PX,
): { readonly state: GroupingDragState; readonly effect: GroupingDragEffect } {
  if (state.phase === "idle") {
    if (event.kind === "press") {
      return {
        state: { phase: "armed", origin: event.origin },
        effect: NONE,
      };
    }
    return { state, effect: NONE };
  }

  if (state.phase === "armed") {
    if (event.kind === "move") {
      if (event.pointerId !== state.origin.pointerId) return { state, effect: NONE };
      const distance = Math.hypot(event.x - state.origin.x, event.y - state.origin.y);
      if (distance < thresholdPx) return { state, effect: NONE };
      return {
        state: {
          phase: "dragging",
          origin: state.origin,
          x: event.x,
          y: event.y,
          dropId: event.dropId,
        },
        effect: { kind: "begin", origin: state.origin },
      };
    }
    if (event.kind === "release") {
      if (event.pointerId !== state.origin.pointerId) return { state, effect: NONE };
      return {
        state: IDLE,
        effect: { kind: "click", sourceTabId: state.origin.sourceTabId },
      };
    }
    if (event.kind === "cancel") {
      return {
        state: IDLE,
        effect: { kind: "cancelled", reason: event.reason },
      };
    }
    return { state, effect: NONE };
  }

  if (state.phase === "dragging") {
    if (event.kind === "move") {
      if (event.pointerId !== state.origin.pointerId) return { state, effect: NONE };
      return {
        state: {
          phase: "dragging",
          origin: state.origin,
          x: event.x,
          y: event.y,
          dropId: event.dropId,
        },
        effect: NONE,
      };
    }
    if (event.kind === "release") {
      if (event.pointerId !== state.origin.pointerId) return { state, effect: NONE };
      if (event.dropId === null) {
        return {
          state: IDLE,
          effect: { kind: "cancelled", reason: "target-gone" },
        };
      }
      return {
        state: {
          phase: "dropping",
          origin: state.origin,
          dropId: event.dropId,
        },
        effect: {
          kind: "drop",
          tabIds: state.origin.tabIds,
          dropId: event.dropId,
        },
      };
    }
    if (event.kind === "cancel") {
      return {
        state: IDLE,
        effect: { kind: "cancelled", reason: event.reason },
      };
    }
    return { state, effect: NONE };
  }

  if (event.kind === "settle") return { state: IDLE, effect: NONE };
  if (event.kind === "cancel") {
    return {
      state: IDLE,
      effect: { kind: "cancelled", reason: event.reason },
    };
  }
  return { state, effect: NONE };
}

export function resolveGroupingDropTarget(
  dropId: string | null,
  validDropIds: ReadonlySet<string>,
  targetsByDropId?: ReadonlyMap<string, GroupingEditTarget>,
): GroupingEditTarget | null {
  if (dropId === null || !validDropIds.has(dropId)) return null;
  const mappedTarget = targetsByDropId?.get(dropId);
  if (mappedTarget) {
    return groupingDropIdForTarget(mappedTarget) === dropId ? mappedTarget : null;
  }
  if (dropId === KEEP_CURRENT_DROP_ID) return { kind: "unassigned" };
  const group = groupTargetFromDropId(dropId);
  if (group) return group;
  const pane = parsePaneRefKey(dropId);
  if (pane) {
    const target: GroupingEditTarget = { kind: "pane", ...pane };
    return groupingDropIdForTarget(target) === dropId ? target : null;
  }
  return null;
}

export function groupingDropIsNoop(
  plan: GroupingPlan | null,
  tabIds: readonly string[],
  target: GroupingEditTarget,
): boolean {
  if (plan === null || tabIds.length === 0) return true;
  if (!groupingDragTabsArePresent(plan, tabIds)) return false;
  let destinationTabIds: readonly string[] | null = null;
  if (target.kind === "unassigned") {
    destinationTabIds = plan.unassignedTabIds;
  } else {
    const group = plan.groups.find((candidate) => candidate.groupId === target.groupId);
    if (!group) return false;
    if (target.kind === "group") {
      destinationTabIds = group.layout?.columns[0]?.panes[0]?.tabIds ?? group.tabIds;
    } else {
      destinationTabIds = group.layout?.columns[target.columnIndex]?.panes[target.paneIndex]?.tabIds ?? null;
    }
  }
  if (destinationTabIds === null) return false;
  const destination = new Set(destinationTabIds);
  return tabIds.every((tabId) => destination.has(tabId));
}

function groupingPlanTabIds(plan: GroupingPlan): ReadonlySet<string> {
  const tabIds = new Set(plan.unassignedTabIds);
  for (const group of plan.groups) {
    if (group.layout) {
      for (const column of group.layout.columns) {
        for (const pane of column.panes) {
          for (const tabId of pane.tabIds) tabIds.add(tabId);
        }
      }
    } else {
      for (const tabId of group.tabIds) tabIds.add(tabId);
    }
  }
  return tabIds;
}

export function groupingDragTabsArePresent(
  plan: GroupingPlan | null,
  tabIds: readonly string[],
): boolean {
  if (plan === null || tabIds.length === 0) return false;
  const present = groupingPlanTabIds(plan);
  return tabIds.every((tabId) => present.has(tabId));
}

export function groupingAutoScrollStep(
  pointerY: number,
  bounds: { readonly top: number; readonly bottom: number },
  scroll: {
    readonly scrollTop: number;
    readonly scrollHeight: number;
    readonly clientHeight: number;
  },
  edgePx = GROUPING_AUTOSCROLL_EDGE_PX,
  stepPx = GROUPING_AUTOSCROLL_STEP_PX,
): number {
  if (scroll.scrollHeight <= scroll.clientHeight) return 0;
  const maxScrollTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
  if (pointerY <= bounds.top + edgePx) {
    const available = Math.min(stepPx, Math.max(0, scroll.scrollTop));
    return available === 0 ? 0 : -available;
  }
  if (pointerY >= bounds.bottom - edgePx) {
    return Math.min(stepPx, Math.max(0, maxScrollTop - scroll.scrollTop));
  }
  return 0;
}
