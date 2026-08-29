export const GROUPING_DIAGRAM_FLIGHT_MS = 160;
export const GROUPING_DIAGRAM_COMMIT_PROGRESS = 0.5;
export const GROUPING_DIAGRAM_PATH_SAMPLES = 16;

export interface GroupingApplyAnimationPoint {
  x: number;
  y: number;
}

export interface GroupingApplyAnimationItem {
  tabId: string;
  width: number;
  height: number;
  sourceCenter: GroupingApplyAnimationPoint;
  destinationCenter: GroupingApplyAnimationPoint;
  pathSegments: readonly string[];
  proxyElement: HTMLElement;
  sourceElement: HTMLElement;
  destinationElement: HTMLElement;
}

export interface GroupingApplyAnimationCallbacks<T> {
  onCommit: () => T;
  commitSucceeded: (outcome: T) => boolean;
  shouldReverse: (outcome: T) => boolean;
  onFinished: (outcome: T) => void;
}

export type GroupingApplyAnimationStarter<T> = (
  callbacks: GroupingApplyAnimationCallbacks<T>,
) => boolean;

export interface GroupingApplyAnimationController {
  settleImmediately: () => void;
  cancel: () => void;
  phase: () => "forward" | "reverse" | "finished";
}

interface PreparedItem extends GroupingApplyAnimationItem {
  samples: readonly GroupingApplyAnimationPoint[];
  sourceOffset: GroupingApplyAnimationPoint;
  destinationOffset: GroupingApplyAnimationPoint;
  sourceOpacity: string;
  destinationOpacity: string;
}

interface StartGroupingApplyAnimationOptions<T> extends GroupingApplyAnimationCallbacks<T> {
  items: readonly GroupingApplyAnimationItem[];
  durationMs?: number;
  seamProgress?: number;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
}

function pathTokens(path: string): string[] {
  return path.match(/[MLC]|-?(?:\d+(?:\.\d+)?|\.\d+)/g) ?? [];
}

function parseNumber(tokens: readonly string[], index: number): number {
  const value = Number(tokens[index]);
  if (!Number.isFinite(value)) throw new Error("Grouping animation path contains an invalid number");
  return value;
}

function cubicPoint(
  start: GroupingApplyAnimationPoint,
  control1: GroupingApplyAnimationPoint,
  control2: GroupingApplyAnimationPoint,
  end: GroupingApplyAnimationPoint,
  progress: number,
): GroupingApplyAnimationPoint {
  const inverse = 1 - progress;
  return {
    x: inverse ** 3 * start.x
      + 3 * inverse ** 2 * progress * control1.x
      + 3 * inverse * progress ** 2 * control2.x
      + progress ** 3 * end.x,
    y: inverse ** 3 * start.y
      + 3 * inverse ** 2 * progress * control1.y
      + 3 * inverse * progress ** 2 * control2.y
      + progress ** 3 * end.y,
  };
}

function pathPolyline(path: string, cubicSteps = 32): GroupingApplyAnimationPoint[] {
  const tokens = pathTokens(path);
  if (tokens.length < 3 || tokens[0] !== "M") {
    throw new Error("Grouping animation only accepts paths beginning with M");
  }
  let index = 1;
  let current = { x: parseNumber(tokens, index), y: parseNumber(tokens, index + 1) };
  index += 2;
  const points = [current];
  while (index < tokens.length) {
    const command = tokens[index];
    index += 1;
    if (command === "L") {
      current = { x: parseNumber(tokens, index), y: parseNumber(tokens, index + 1) };
      index += 2;
      points.push(current);
      continue;
    }
    if (command === "C") {
      const control1 = { x: parseNumber(tokens, index), y: parseNumber(tokens, index + 1) };
      const control2 = { x: parseNumber(tokens, index + 2), y: parseNumber(tokens, index + 3) };
      const end = { x: parseNumber(tokens, index + 4), y: parseNumber(tokens, index + 5) };
      index += 6;
      const start = current;
      for (let step = 1; step <= cubicSteps; step += 1) {
        points.push(cubicPoint(start, control1, control2, end, step / cubicSteps));
      }
      current = end;
      continue;
    }
    throw new Error(`Grouping animation path command ${command ?? "<missing>"} is unsupported`);
  }
  return points;
}

function distance(left: GroupingApplyAnimationPoint, right: GroupingApplyAnimationPoint): number {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function interpolate(
  from: GroupingApplyAnimationPoint,
  to: GroupingApplyAnimationPoint,
  progress: number,
): GroupingApplyAnimationPoint {
  return {
    x: from.x + (to.x - from.x) * progress,
    y: from.y + (to.y - from.y) * progress,
  };
}

export function sampleGroupingApplyPath(
  pathSegments: readonly string[],
  sampleCount = GROUPING_DIAGRAM_PATH_SAMPLES,
): readonly GroupingApplyAnimationPoint[] {
  if (sampleCount < 1) throw new Error("Grouping animation requires at least one path sample");
  const polyline: GroupingApplyAnimationPoint[] = [];
  for (const path of pathSegments) {
    const segment = pathPolyline(path);
    if (segment.length === 0) continue;
    const last = polyline[polyline.length - 1];
    const first = segment[0];
    if (last && last.x === first.x && last.y === first.y) polyline.push(...segment.slice(1));
    else polyline.push(...segment);
  }
  if (polyline.length < 2) throw new Error("Grouping animation path has no travel distance");

  const cumulative = [0];
  for (let index = 1; index < polyline.length; index += 1) {
    cumulative.push(cumulative[index - 1] + distance(polyline[index - 1], polyline[index]));
  }
  const total = cumulative[cumulative.length - 1] ?? 0;
  if (total <= 0) throw new Error("Grouping animation path has no travel distance");

  return Array.from({ length: sampleCount + 1 }, (_, sampleIndex) => {
    const target = total * sampleIndex / sampleCount;
    let segmentIndex = 1;
    while (segmentIndex < cumulative.length && cumulative[segmentIndex] < target) segmentIndex += 1;
    if (segmentIndex >= cumulative.length) return polyline[polyline.length - 1];
    const segmentStart = cumulative[segmentIndex - 1];
    const segmentLength = cumulative[segmentIndex] - segmentStart;
    const segmentProgress = segmentLength <= 0 ? 0 : (target - segmentStart) / segmentLength;
    return interpolate(polyline[segmentIndex - 1], polyline[segmentIndex], segmentProgress);
  });
}

export function groupingApplyTrackPoint(
  samples: readonly GroupingApplyAnimationPoint[],
  progress: number,
): GroupingApplyAnimationPoint {
  if (samples.length === 0) throw new Error("Grouping animation track is empty");
  if (samples.length === 1) return samples[0];
  const clamped = Math.max(0, Math.min(1, progress));
  const scaled = clamped * (samples.length - 1);
  const index = Math.min(samples.length - 2, Math.floor(scaled));
  return interpolate(samples[index], samples[index + 1], scaled - index);
}

function preparedItem(item: GroupingApplyAnimationItem): PreparedItem {
  const samples = sampleGroupingApplyPath(item.pathSegments);
  const start = samples[0];
  const end = samples[samples.length - 1];
  return {
    ...item,
    samples,
    sourceOffset: { x: item.sourceCenter.x - start.x, y: item.sourceCenter.y - start.y },
    destinationOffset: { x: item.destinationCenter.x - end.x, y: item.destinationCenter.y - end.y },
    sourceOpacity: item.sourceElement.style.opacity,
    destinationOpacity: item.destinationElement.style.opacity,
  };
}

export function startGroupingApplyAnimation<T>(
  options: StartGroupingApplyAnimationOptions<T>,
): GroupingApplyAnimationController | null {
  const requestFrame = options.requestFrame ?? globalThis.requestAnimationFrame?.bind(globalThis);
  const cancelFrame = options.cancelFrame ?? globalThis.cancelAnimationFrame?.bind(globalThis);
  if (!requestFrame || !cancelFrame || options.items.length === 0) return null;

  let items: PreparedItem[];
  try {
    items = options.items.map(preparedItem);
  } catch {
    return null;
  }
  const durationMs = Math.max(1, options.durationMs ?? GROUPING_DIAGRAM_FLIGHT_MS);
  const seamProgress = Math.max(0, Math.min(1, options.seamProgress ?? GROUPING_DIAGRAM_COMMIT_PROGRESS));
  let currentPhase: "forward" | "reverse" | "finished" = "forward";
  let frame: number | null = null;
  let startedAt: number | null = null;
  let reverseStartedAt: number | null = null;
  let reverseFrom = 0;
  let commitIssued = false;
  let outcome: T | undefined;
  let finished = false;

  for (const item of items) {
    item.sourceElement.style.opacity = "0";
    item.destinationElement.style.opacity = "0";
  }

  const render = (progress: number, opacity = 1) => {
    for (const item of items) {
      const pathPoint = groupingApplyTrackPoint(item.samples, progress);
      const offset = interpolate(item.sourceOffset, item.destinationOffset, progress);
      const center = { x: pathPoint.x + offset.x, y: pathPoint.y + offset.y };
      item.proxyElement.style.transform = `translate3d(${center.x - item.width / 2}px, ${center.y - item.height / 2}px, 0)`;
      item.proxyElement.style.opacity = String(opacity);
    }
  };

  const restore = () => {
    for (const item of items) {
      item.sourceElement.style.opacity = item.sourceOpacity;
      item.destinationElement.style.opacity = item.destinationOpacity;
    }
  };

  const finish = () => {
    if (finished || outcome === undefined) return;
    finished = true;
    currentPhase = "finished";
    if (frame !== null) cancelFrame(frame);
    frame = null;
    restore();
    options.onFinished(outcome);
  };

  const issueCommit = (timestamp: number) => {
    if (commitIssued) return;
    commitIssued = true;
    outcome = options.onCommit();
    if (options.shouldReverse(outcome)) {
      currentPhase = "reverse";
      reverseStartedAt = timestamp;
      reverseFrom = Math.max(seamProgress, reverseFrom);
      return;
    }
    if (!options.commitSucceeded(outcome)) {
      render(reverseFrom || seamProgress, 0);
      finish();
    }
  };

  const tick = (timestamp: number) => {
    frame = null;
    if (finished) return;
    if (currentPhase === "forward") {
      if (startedAt === null) startedAt = timestamp;
      const progress = Math.min(1, Math.max(0, (timestamp - startedAt) / durationMs));
      reverseFrom = progress;
      render(progress);
      if (!commitIssued && progress >= seamProgress) issueCommit(timestamp);
      if (currentPhase === "forward" && commitIssued && progress >= 1) finish();
    } else {
      if (reverseStartedAt === null) reverseStartedAt = timestamp;
      const reverseDuration = Math.max(1, durationMs * Math.max(reverseFrom, seamProgress));
      const elapsed = Math.max(0, timestamp - reverseStartedAt);
      const progress = Math.max(0, reverseFrom * (1 - elapsed / reverseDuration));
      render(progress);
      if (progress <= 0) finish();
    }
    if (!finished) frame = requestFrame(tick);
  };

  render(0);
  frame = requestFrame(tick);

  return {
    settleImmediately: () => {
      if (finished) return;
      if (!commitIssued) issueCommit(startedAt ?? performance.now());
      if (outcome === undefined) return;
      if (options.shouldReverse(outcome)) render(0);
      else if (options.commitSucceeded(outcome)) render(1);
      else render(reverseFrom || seamProgress, 0);
      finish();
    },
    cancel: () => {
      if (finished) return;
      finished = true;
      currentPhase = "finished";
      if (frame !== null) cancelFrame(frame);
      frame = null;
      restore();
    },
    phase: () => currentPhase,
  };
}
