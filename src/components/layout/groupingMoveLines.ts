import type { Workspace } from "../../types/workspace";
import { WORKSPACE_COLORS, resolveWorkspaceColor } from "../../lib/workspaceColors";
import { findTabLocation } from "./tabGrouping";

export type GroupingMoveLineOrientation = "horizontal" | "vertical";

export interface GroupingLineRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface GroupingLineEndAnchor {
  anchor: GroupingLineRect;
  leadIn: GroupingLineRect | null;
}

export interface GroupingLinePoint {
  x: number;
  y: number;
}

export interface GroupingMoveLine {
  tabId: string;
  label: string;
  fromWorkspaceId: string;
  toWorkspaceId: string;
  fromRect: GroupingLineRect | null;
  toRect: GroupingLineRect | null;
}

export type GroupingMoveKind = "cross-workspace" | "within-workspace";

export interface GroupingMoveDiff {
  tabId: string;
  label: string;
  kind: GroupingMoveKind;
  fromWorkspaceId: string;
  toWorkspaceId: string;
  fromPaneId: string;
  toPaneId: string;
  fromColumnIndex: number;
  toColumnIndex: number;
}

export type MeasuredGroupingMoveLine = GroupingMoveLine & {
  destinationRect: GroupingLineRect;
  leadIn: GroupingLineRect | null;
  routePoints: readonly GroupingLinePoint[] | null;
};

export interface GroupingMeasureInput {
  lines: readonly GroupingMoveLine[];
  fromRects: ReadonlyMap<string, GroupingLineRect>;
  toRects: ReadonlyMap<string, GroupingLineRect>;
  afterChipRects?: ReadonlyMap<string, GroupingLineRect>;
  paneRects?: ReadonlyMap<string, GroupingLineRect>;
  sourcePaneIds?: ReadonlyMap<string, string>;
  destinationPaneIds?: ReadonlyMap<string, string>;
  workspaceRects: ReadonlyMap<string, GroupingLineRect>;
  orientation: GroupingMoveLineOrientation;
}

function paneColumnIndex(workspaces: readonly Workspace[], workspaceId: string, paneId: string): number {
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) return 0;
  const columns = workspace.splitColumns ?? [workspace.panes.map((pane) => pane.id)];
  const index = columns.findIndex((column) => column.includes(paneId));
  return index < 0 ? 0 : index;
}

export function groupingMoveDiffs(
  before: readonly Workspace[],
  after: readonly Workspace[],
): GroupingMoveDiff[] {
  const diffs: GroupingMoveDiff[] = [];
  for (const workspace of after) {
    const columns = workspace.splitColumns ?? [workspace.panes.map((pane) => pane.id)];
    for (const [toColumnIndex, column] of columns.entries()) {
      for (const paneId of column) {
        const pane = workspace.panes.find((candidate) => candidate.id === paneId);
        if (!pane) continue;
        for (const tab of pane.tabs) {
          const from = findTabLocation(before, tab.id);
          if (!from || (from.workspaceId === workspace.id && from.paneId === pane.id)) continue;
          diffs.push({
            tabId: tab.id,
            label: tab.label?.trim() ?? "",
            kind: from.workspaceId === workspace.id ? "within-workspace" : "cross-workspace",
            fromWorkspaceId: from.workspaceId,
            toWorkspaceId: workspace.id,
            fromPaneId: from.paneId,
            toPaneId: pane.id,
            fromColumnIndex: paneColumnIndex(before, from.workspaceId, from.paneId),
            toColumnIndex,
          });
        }
      }
    }
  }
  return diffs;
}

export function groupingMoveLines(
  before: readonly Workspace[],
  after: readonly Workspace[],
): GroupingMoveLine[] {
  return groupingMoveDiffs(before, after)
    .filter((diff) => diff.kind === "cross-workspace")
    .map((diff) => ({
      tabId: diff.tabId,
      label: diff.label,
      fromWorkspaceId: diff.fromWorkspaceId,
      toWorkspaceId: diff.toWorkspaceId,
      fromRect: null,
      toRect: null,
    }));
}

export function groupingRelativeRect(
  target: GroupingLineRect,
  container: GroupingLineRect,
): GroupingLineRect {
  return {
    left: target.left - container.left,
    top: target.top - container.top,
    width: target.width,
    height: target.height,
  };
}

function rounded(value: number): number {
  return Number(value.toFixed(2));
}

function rectsIntersect(left: GroupingLineRect, right: GroupingLineRect): boolean {
  return left.left < right.left + right.width
    && right.left < left.left + left.width
    && left.top < right.top + right.height
    && right.top < left.top + left.height;
}

function segmentPaintRect(
  from: GroupingLinePoint,
  to: GroupingLinePoint,
  halfStroke = 2,
): GroupingLineRect {
  return {
    left: Math.min(from.x, to.x) - halfStroke,
    top: Math.min(from.y, to.y) - halfStroke,
    width: Math.abs(to.x - from.x) + halfStroke * 2,
    height: Math.abs(to.y - from.y) + halfStroke * 2,
  };
}

function lineEndpoints(
  from: GroupingLineRect,
  to: GroupingLineRect,
  orientation: GroupingMoveLineOrientation,
): { start: GroupingLinePoint; end: GroupingLinePoint } {
  return orientation === "horizontal"
    ? {
      start: { x: from.left + from.width, y: from.top + from.height / 2 },
      end: { x: to.left, y: to.top + to.height / 2 },
    }
    : {
      start: { x: from.left + from.width / 2, y: from.top + from.height },
      end: { x: to.left + to.width / 2, y: to.top },
    };
}

function cubicCrossesObstacles(
  from: GroupingLineRect,
  to: GroupingLineRect,
  orientation: GroupingMoveLineOrientation,
  obstacles: readonly GroupingLineRect[],
): boolean {
  const { start, end } = lineEndpoints(from, to, orientation);
  const delta = orientation === "horizontal"
    ? Math.max(24, (end.x - start.x) * 0.5)
    : Math.max(24, (end.y - start.y) * 0.5);
  const control1 = orientation === "horizontal"
    ? { x: start.x + delta, y: start.y }
    : { x: start.x, y: start.y + delta };
  const control2 = orientation === "horizontal"
    ? { x: end.x - delta, y: end.y }
    : { x: end.x, y: end.y - delta };
  const xs = [start.x, control1.x, control2.x, end.x];
  const ys = [start.y, control1.y, control2.y, end.y];
  const paintedBounds = {
    left: Math.min(...xs) - 2,
    top: Math.min(...ys) - 2,
    width: Math.max(...xs) - Math.min(...xs) + 4,
    height: Math.max(...ys) - Math.min(...ys) + 4,
  };
  return obstacles.some((obstacle) => rectsIntersect(paintedBounds, obstacle));
}

function measuredLineLeadInObstacles(line: MeasuredGroupingMoveLine, orientation: GroupingMoveLineOrientation): GroupingLineRect[] {
  return line.leadIn ? [leadInPaintRect(line.leadIn, orientation, 4)] : [];
}

function routeIsClear(points: readonly GroupingLinePoint[], obstacles: readonly GroupingLineRect[]): boolean {
  for (let index = 1; index < points.length; index += 1) {
    const paintedSegment = segmentPaintRect(points[index - 1], points[index]);
    for (const obstacle of obstacles) {
      if (rectsIntersect(paintedSegment, obstacle)) return false;
    }
  }
  return true;
}

function clearDetourRoute(
  from: GroupingLineRect,
  to: GroupingLineRect,
  orientation: GroupingMoveLineOrientation,
  obstacles: readonly GroupingLineRect[],
  sourcePane: GroupingLineRect | null,
  destinationPane: GroupingLineRect | null,
  routeVariant = 0,
): readonly GroupingLinePoint[] {
  const endpoints = lineEndpoints(from, to, orientation);
  const alternateRoute = routeVariant === 1;
  const start = alternateRoute
    ? (orientation === "horizontal"
      ? { x: from.left, y: from.top + from.height / 2 }
      : { x: from.left + from.width / 2, y: from.top })
    : endpoints.start;
  const { end } = endpoints;
  if (orientation === "horizontal") {
    let minimumY = Math.min(start.y, end.y);
    let maximumY = Math.max(start.y, end.y);
    let minimumX = Number.POSITIVE_INFINITY;
    let maximumX = Number.NEGATIVE_INFINITY;
    for (const rect of obstacles) {
      minimumY = Math.min(minimumY, rect.top);
      maximumY = Math.max(maximumY, rect.top + rect.height);
      minimumX = Math.min(minimumX, rect.left);
      maximumX = Math.max(maximumX, rect.left + rect.width);
    }
    const routeYs = [
      minimumY - 5,
      maximumY + 5,
      ...obstacles.flatMap((rect) => [rect.top - 5, rect.top + rect.height + 5]),
    ];
    const destinations = [
      { end, approach: { x: destinationPane ? destinationPane.left - 3 : end.x - 3, y: end.y } },
      {
        end: { x: to.left + to.width, y: to.top + to.height / 2 },
        approach: {
          x: destinationPane ? destinationPane.left + destinationPane.width + 3 : to.left + to.width + 3,
          y: to.top + to.height / 2,
        },
      },
    ];
    if (alternateRoute) destinations.reverse();
    const sourceApproach = {
      x: sourcePane
        ? (alternateRoute ? sourcePane.left - 3 : sourcePane.left + sourcePane.width + 3)
        : start.x,
      y: start.y,
    };
    for (const destination of destinations) {
      for (const routeY of routeYs) {
        const route = [
          start,
          sourceApproach,
          { x: sourceApproach.x, y: routeY },
          { x: destination.approach.x, y: routeY },
          destination.approach,
          destination.end,
        ];
        if (routeIsClear(route, obstacles)) return route;
      }
    }
  } else {
    let minimumX = Math.min(start.x, end.x);
    let maximumX = Math.max(start.x, end.x);
    let minimumY = Number.POSITIVE_INFINITY;
    let maximumY = Number.NEGATIVE_INFINITY;
    for (const rect of obstacles) {
      minimumX = Math.min(minimumX, rect.left);
      maximumX = Math.max(maximumX, rect.left + rect.width);
      minimumY = Math.min(minimumY, rect.top);
      maximumY = Math.max(maximumY, rect.top + rect.height);
    }
    const routeXs = [
      minimumX - 5,
      maximumX + 5,
      ...obstacles.flatMap((rect) => [rect.left - 5, rect.left + rect.width + 5]),
    ];
    const destinations = [
      { end, approach: { x: end.x, y: destinationPane ? destinationPane.top - 3 : end.y - 3 } },
      {
        end: { x: to.left + to.width / 2, y: to.top + to.height },
        approach: {
          x: to.left + to.width / 2,
          y: destinationPane ? destinationPane.top + destinationPane.height + 3 : to.top + to.height + 3,
        },
      },
    ];
    if (alternateRoute) destinations.reverse();
    const sourceApproach = {
      x: start.x,
      y: sourcePane
        ? (alternateRoute ? sourcePane.top - 3 : sourcePane.top + sourcePane.height + 3)
        : start.y,
    };
    for (const destination of destinations) {
      for (const routeX of routeXs) {
        const route = [
          start,
          sourceApproach,
          { x: routeX, y: sourceApproach.y },
          { x: routeX, y: destination.approach.y },
          destination.approach,
          destination.end,
        ];
        if (routeIsClear(route, obstacles)) return route;
      }
    }
  }
  throw new Error("No collision-free grouping move route is available");
}

function anchorInsideRect(anchor: GroupingLineRect, rect: GroupingLineRect): boolean {
  const x = anchor.left + anchor.width / 2;
  const y = anchor.top + anchor.height / 2;
  return x > rect.left
    && x < rect.left + rect.width
    && y > rect.top
    && y < rect.top + rect.height;
}

function leadInPaintRect(
  leadIn: GroupingLineRect,
  orientation: GroupingMoveLineOrientation,
  thickness: number,
): GroupingLineRect {
  if (thickness <= 0) return leadIn;
  const half = thickness / 2;
  return orientation === "horizontal"
    ? { left: leadIn.left, top: leadIn.top - half, width: leadIn.width, height: thickness }
    : { left: leadIn.left - half, top: leadIn.top, width: thickness, height: leadIn.height };
}

function paneFrameObstacles(
  pane: GroupingLineRect,
  orientation: GroupingMoveLineOrientation,
  destination: GroupingLineRect | null,
): GroupingLineRect[] {
  const frame = 2;
  const top = { left: pane.left, top: pane.top, width: pane.width, height: frame };
  const right = { left: pane.left + pane.width - frame, top: pane.top, width: frame, height: pane.height };
  const bottom = { left: pane.left, top: pane.top + pane.height - frame, width: pane.width, height: frame };
  const left = { left: pane.left, top: pane.top, width: frame, height: pane.height };
  if (!destination) return [top, right, bottom, left];
  if (orientation === "horizontal") {
    const openingTop = Math.max(pane.top, destination.top - 4);
    const openingBottom = Math.min(pane.top + pane.height, destination.top + destination.height + 4);
    const splitVertical = (edge: GroupingLineRect) => [
      { ...edge, height: Math.max(0, openingTop - pane.top) },
      { ...edge, top: openingBottom, height: Math.max(0, pane.top + pane.height - openingBottom) },
    ];
    return [top, bottom, ...splitVertical(left), ...splitVertical(right)]
      .filter((rect) => rect.width > 0 && rect.height > 0);
  }
  const openingLeft = Math.max(pane.left, destination.left - 4);
  const openingRight = Math.min(pane.left + pane.width, destination.left + destination.width + 4);
  const splitHorizontal = (edge: GroupingLineRect) => [
    { ...edge, width: Math.max(0, openingLeft - pane.left) },
    { ...edge, left: openingRight, width: Math.max(0, pane.left + pane.width - openingRight) },
  ];
  return [left, right, ...splitHorizontal(top), ...splitHorizontal(bottom)]
    .filter((rect) => rect.width > 0 && rect.height > 0);
}

function clearWorkspaceEdgeAnchor(
  toChip: GroupingLineRect,
  toWorkspace: GroupingLineRect,
  siblings: readonly GroupingLineRect[],
  orientation: GroupingMoveLineOrientation,
): GroupingLineRect {
  const preferred = orientation === "horizontal"
    ? { left: toWorkspace.left, top: toChip.top, width: 0, height: toChip.height }
    : { left: toChip.left, top: toWorkspace.top, width: toChip.width, height: 0 };
  if (!siblings.some((sibling) => anchorInsideRect(preferred, sibling))) return preferred;

  const preferredCoordinate = orientation === "horizontal"
    ? toChip.top + toChip.height / 2
    : toChip.left + toChip.width / 2;
  const minimum = orientation === "horizontal" ? toWorkspace.top : toWorkspace.left;
  const maximum = minimum + (orientation === "horizontal" ? toWorkspace.height : toWorkspace.width);
  for (let distance = 0; distance <= maximum - minimum; distance += 4) {
    for (const coordinate of [preferredCoordinate - distance, preferredCoordinate + distance]) {
      if (coordinate < minimum || coordinate > maximum) continue;
      const candidate = orientation === "horizontal"
        ? { left: toWorkspace.left, top: coordinate, width: 0, height: 0 }
        : { left: coordinate, top: toWorkspace.top, width: 0, height: 0 };
      if (!siblings.some((sibling) => anchorInsideRect(candidate, sibling))) return candidate;
    }
  }
  return orientation === "horizontal"
    ? { left: toWorkspace.left, top: minimum, width: 0, height: 0 }
    : { left: minimum, top: toWorkspace.top, width: 0, height: 0 };
}

export function groupingLineEndAnchor(
  toChip: GroupingLineRect,
  toWorkspace: GroupingLineRect | null,
  siblings: readonly GroupingLineRect[],
  orientation: GroupingMoveLineOrientation,
  leadInThickness = 0,
): GroupingLineEndAnchor {
  if (!toWorkspace) return { anchor: toChip, leadIn: null };

  if (orientation === "vertical") {
    const anchorTop = Math.min(toWorkspace.top, toChip.top);
    const anchor = clearWorkspaceEdgeAnchor(toChip, toWorkspace, siblings, orientation);
    if (anchor.width === 0) return { anchor, leadIn: null };
    const height = toChip.top - anchorTop;
    if (height <= 0) return { anchor, leadIn: null };
    const leadIn = { left: toChip.left + toChip.width / 2, top: anchorTop, width: 0, height };
    const paintedLeadIn = leadInPaintRect(leadIn, orientation, leadInThickness);
    return {
      anchor,
      leadIn: siblings.some((sibling) => sibling !== toChip && rectsIntersect(paintedLeadIn, sibling)) ? null : leadIn,
    };
  }

  const anchorLeft = Math.min(toWorkspace.left, toChip.left);
  const anchor = clearWorkspaceEdgeAnchor(toChip, toWorkspace, siblings, orientation);
  if (anchor.height === 0) return { anchor, leadIn: null };
  const width = toChip.left - anchorLeft;
  if (width <= 0) return { anchor, leadIn: null };
  const leadIn = { left: anchorLeft, top: toChip.top + toChip.height / 2, width, height: 0 };
  const paintedLeadIn = leadInPaintRect(leadIn, orientation, leadInThickness);
  return {
    anchor,
    leadIn: siblings.some((sibling) => sibling !== toChip && rectsIntersect(paintedLeadIn, sibling)) ? null : leadIn,
  };
}

export function groupingMeasuredMoveLines(input: GroupingMeasureInput): MeasuredGroupingMoveLine[] {
  const afterChipEntries = [...(input.afterChipRects ?? input.toRects).entries()];
  const paneEntries = [...(input.paneRects ?? new Map<string, GroupingLineRect>()).entries()];
  const paneFrameEntries = paneEntries.map(([paneId, rect]) => ({
    paneId,
    rect,
    frames: rect.width > 0 && rect.height > 0 ? paneFrameObstacles(rect, input.orientation, null) : [],
  }));
  const paneRectsById = new Map(paneEntries);
  const occupiedRoutesByDestination = new Map<string, GroupingLineRect[]>();
  const detourVariantsByDestination = new Map<string, number>();
  const measuredByTabId = new Map<string, MeasuredGroupingMoveLine>();
  const lineToRects = new Map(input.lines.map((line) => [line.tabId, input.toRects.get(line.tabId)]));
  const linesByDestination = new Map<string, GroupingMoveLine[]>();
  for (const line of input.lines) {
    const destinationLines = linesByDestination.get(line.toWorkspaceId) ?? [];
    destinationLines.push(line);
    linesByDestination.set(line.toWorkspaceId, destinationLines);
  }
  const orderedLines = [...linesByDestination.values()].flatMap((destinationLines) => {
    if (destinationLines.length < 2) return destinationLines;
    return destinationLines.sort((left, right) => {
      const leftRect = lineToRects.get(left.tabId);
      const rightRect = lineToRects.get(right.tabId);
      const leftCoordinate = input.orientation === "horizontal" ? leftRect?.top ?? 0 : leftRect?.left ?? 0;
      const rightCoordinate = input.orientation === "horizontal" ? rightRect?.top ?? 0 : rightRect?.left ?? 0;
      return rightCoordinate - leftCoordinate;
    });
  });
  for (const line of orderedLines) {
    const fromRect = input.fromRects.get(line.tabId);
    const toRect = lineToRects.get(line.tabId);
    if (!fromRect || !toRect) continue;
    const sourcePaneId = input.sourcePaneIds?.get(line.tabId);
    const destinationPaneId = input.destinationPaneIds?.get(line.tabId);
    const sourcePaneRect = sourcePaneId ? paneRectsById.get(sourcePaneId) ?? null : null;
    const destinationPaneRect = destinationPaneId ? paneRectsById.get(destinationPaneId) ?? null : null;
    const destinationWorkspaceRect = input.workspaceRects.get(line.toWorkspaceId) ?? null;
    const routeVariant = detourVariantsByDestination.get(line.toWorkspaceId) ?? 0;
    const routePaintPadding = 5;
    const routeMinimum = input.orientation === "horizontal"
      ? Math.min(
        sourcePaneRect?.left ?? fromRect.left,
        destinationPaneRect?.left ?? toRect.left,
        destinationWorkspaceRect?.left ?? toRect.left,
      ) - routePaintPadding
      : Math.min(
        sourcePaneRect?.top ?? fromRect.top,
        destinationPaneRect?.top ?? toRect.top,
        destinationWorkspaceRect?.top ?? toRect.top,
      ) - routePaintPadding;
    const routeMaximum = input.orientation === "horizontal"
      ? Math.max(sourcePaneRect ? sourcePaneRect.left + sourcePaneRect.width : fromRect.left + fromRect.width, destinationPaneRect
        ? destinationPaneRect.left + destinationPaneRect.width
        : toRect.left + toRect.width) + routePaintPadding
      : Math.max(sourcePaneRect ? sourcePaneRect.top + sourcePaneRect.height : fromRect.top + fromRect.height, destinationPaneRect
        ? destinationPaneRect.top + destinationPaneRect.height
        : toRect.top + toRect.height) + routePaintPadding;
    const withinRouteSpan = (rect: GroupingLineRect) => input.orientation === "horizontal"
      ? rect.left < routeMaximum && rect.left + rect.width > routeMinimum
      : rect.top < routeMaximum && rect.top + rect.height > routeMinimum;
    const routeObstacles: GroupingLineRect[] = [];
    for (const [tabId, rect] of afterChipEntries) {
      if (tabId !== line.tabId && rect.width > 0 && rect.height > 0 && withinRouteSpan(rect)) routeObstacles.push(rect);
    }
    for (const pane of paneFrameEntries) {
      if (pane.paneId === sourcePaneId || pane.paneId === destinationPaneId) continue;
      for (const frame of pane.frames) {
        if (withinRouteSpan(frame)) routeObstacles.push(frame);
      }
    }
    if (sourcePaneRect) routeObstacles.push(...paneFrameObstacles(sourcePaneRect, input.orientation, fromRect));
    if (destinationPaneRect) routeObstacles.push(...paneFrameObstacles(destinationPaneRect, input.orientation, toRect));
    for (const occupied of occupiedRoutesByDestination.get(line.toWorkspaceId) ?? []) {
      if (withinRouteSpan(occupied)) routeObstacles.push(occupied);
    }
    const end = groupingLineEndAnchor(
      toRect,
      destinationWorkspaceRect,
      routeObstacles,
      input.orientation,
      4,
    );
    const anchorReachesDestination = input.orientation === "horizontal"
      ? end.anchor.left === toRect.left && end.anchor.top + end.anchor.height / 2 === toRect.top + toRect.height / 2
      : end.anchor.top === toRect.top && end.anchor.left + end.anchor.width / 2 === toRect.left + toRect.width / 2;
    const mainBlocked = cubicCrossesObstacles(fromRect, end.anchor, input.orientation, routeObstacles);
    const continuous = Boolean(end.leadIn) || anchorReachesDestination;
    let measuredLine: MeasuredGroupingMoveLine;
    if (!mainBlocked && continuous) {
      measuredLine = { ...line, fromRect, toRect: end.anchor, destinationRect: toRect, leadIn: end.leadIn, routePoints: null };
    } else {
      measuredLine = {
        ...line,
        fromRect,
        toRect,
        destinationRect: toRect,
        leadIn: null,
        routePoints: clearDetourRoute(
          fromRect,
          toRect,
          input.orientation,
          routeObstacles,
          sourcePaneRect,
          destinationPaneRect,
          routeVariant,
        ),
      };
      detourVariantsByDestination.set(line.toWorkspaceId, routeVariant + 1);
    }
    measuredByTabId.set(line.tabId, measuredLine);
    const occupied = occupiedRoutesByDestination.get(line.toWorkspaceId) ?? [];
    occupied.push(...measuredLineLeadInObstacles(measuredLine, input.orientation));
    occupiedRoutesByDestination.set(line.toWorkspaceId, occupied);
  }
  return input.lines.flatMap((line) => {
    const measured = measuredByTabId.get(line.tabId);
    return measured ? [measured] : [];
  });
}

export function groupingMoveLineRoutePath(points: readonly GroupingLinePoint[]): string {
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${rounded(point.x)} ${rounded(point.y)}`).join(" ");
}

export function groupingLeadInPath(
  leadIn: GroupingLineRect,
  orientation: GroupingMoveLineOrientation,
): string {
  const x2 = orientation === "horizontal" ? leadIn.left + leadIn.width : leadIn.left;
  const y2 = orientation === "vertical" ? leadIn.top + leadIn.height : leadIn.top;
  return `M ${rounded(leadIn.left)} ${rounded(leadIn.top)} L ${rounded(x2)} ${rounded(y2)}`;
}

export function groupingMoveLinePath(
  from: GroupingLineRect,
  to: GroupingLineRect,
  orientation: GroupingMoveLineOrientation,
): string {
  if (orientation === "vertical") {
    const x1 = from.left + from.width / 2;
    const y1 = from.top + from.height;
    const x2 = to.left + to.width / 2;
    const y2 = to.top;
    const dy = Math.max(24, (y2 - y1) * 0.5);
    return `M ${rounded(x1)} ${rounded(y1)} C ${rounded(x1)} ${rounded(y1 + dy)} ${rounded(x2)} ${rounded(y2 - dy)} ${rounded(x2)} ${rounded(y2)}`;
  }

  const x1 = from.left + from.width;
  const y1 = from.top + from.height / 2;
  const x2 = to.left;
  const y2 = to.top + to.height / 2;
  const dx = Math.max(24, (x2 - x1) * 0.5);
  return `M ${rounded(x1)} ${rounded(y1)} C ${rounded(x1 + dx)} ${rounded(y1)} ${rounded(x2 - dx)} ${rounded(y2)} ${rounded(x2)} ${rounded(y2)}`;
}

export function groupingSideBySideOrientation(width: number): GroupingMoveLineOrientation {
  return width > 0 && width < 960 ? "vertical" : "horizontal";
}

const GROUPING_FALLBACK_COLOR_ORDER = [5, 0, 3, 7, 2, 6, 1, 4] as const;

export function groupingMoveLineColor(
  destinations: readonly Workspace[],
  destinationIndex: number,
): string {
  if (destinationIndex < 0 || destinationIndex >= destinations.length) {
    return WORKSPACE_COLORS[GROUPING_FALLBACK_COLOR_ORDER[0]].value;
  }

  const explicitColors = destinations.map((workspace) => resolveWorkspaceColor(workspace.color)?.value);
  const explicit = explicitColors[destinationIndex];
  if (explicit) return explicit;

  const used = new Set(explicitColors.filter((color): color is string => Boolean(color)));
  let fallbackCursor = 0;
  for (let index = 0; index <= destinationIndex; index += 1) {
    if (explicitColors[index]) continue;

    let fallback: string | undefined;
    for (let attempt = 0; attempt < WORKSPACE_COLORS.length; attempt += 1) {
      const paletteIndex = GROUPING_FALLBACK_COLOR_ORDER[fallbackCursor % WORKSPACE_COLORS.length];
      fallbackCursor += 1;
      const candidate = WORKSPACE_COLORS[paletteIndex].value;
      if (used.size < WORKSPACE_COLORS.length && used.has(candidate)) continue;
      fallback = candidate;
      break;
    }
    fallback ??= WORKSPACE_COLORS[GROUPING_FALLBACK_COLOR_ORDER[fallbackCursor % WORKSPACE_COLORS.length]].value;
    if (index === destinationIndex) return fallback;
    used.add(fallback);
  }

  return WORKSPACE_COLORS[GROUPING_FALLBACK_COLOR_ORDER[0]].value;
}
