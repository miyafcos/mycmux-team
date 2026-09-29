import { printableText } from "../../stores/recentInputStore";

export interface TurnMarkData {
  line: number;
  label: string;
  at: number;
}

export interface SplitSubmitsResult {
  count: number;
  segments: string[];
}

export function splitSubmits(data: string): SplitSubmitsResult {
  const segments: string[] = [];
  let current = "";
  for (let index = 0; index < data.length; index += 1) {
    const character = data[index];
    if (character === "\r" || character === "\n") {
      segments.push(current);
      current = "";
      if (character === "\r" && data[index + 1] === "\n") index += 1;
      continue;
    }
    current += character;
  }
  return { count: segments.length, segments };
}

export function turnLabelFrom(text: string, max = 200): string {
  return printableText(text).replace(/\s+/g, " ").trim().slice(0, max);
}

export interface ShouldMarkTurnInput {
  label: string;
  currentLine: number;
  now: number;
  last?: Pick<TurnMarkData, "line" | "at"> | null;
}

export function shouldMarkTurn({
  label,
  currentLine,
  now,
  last,
}: ShouldMarkTurnInput): boolean {
  if (!label) return false;
  if (last) {
    if (last.line === currentLine) return false;
    const minGapMs = [...label].length <= 1 ? 1000 : 250;
    if (now - last.at < minGapMs) return false;
  }
  return true;
}

export function findTurnIndexForViewport(
  marks: readonly TurnMarkData[],
  viewportY: number,
): number {
  let low = 0;
  let high = marks.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const mark = marks[mid];
    if (!mark) break;
    if (mark.line <= viewportY) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

export function pickJumpTarget(
  marks: readonly TurnMarkData[],
  currentIndex: number,
  direction: -1 | 1,
): TurnMarkData | null {
  if (marks.length === 0) return null;
  const nextIndex = currentIndex < 0
    ? (direction > 0 ? 0 : -1)
    : currentIndex + direction;
  if (nextIndex < 0 || nextIndex >= marks.length) return null;
  return marks[nextIndex] ?? null;
}
