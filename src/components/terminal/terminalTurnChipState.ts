import type { TranscriptPrompt } from "../../lib/livebrief";
import {
  findTurnIndexForViewport,
  type TurnMarkData,
} from "./terminalTurnModel";

const TURN_LIST_MAX_ROWS = 200;
const MATCH_PREFIX_LENGTH = 80;

export interface TurnChipState {
  index: number;
  total: number;
  canPrev: boolean;
  canNext: boolean;
}

export interface TurnListRow {
  key: string;
  label: string;
  markIndex: number | null;
  at?: number;
}

export function resolveTurnChipState({
  marks,
  viewportY,
  isAtBottom,
  bufferType,
}: {
  marks: readonly TurnMarkData[];
  viewportY: number;
  isAtBottom: boolean;
  bufferType: string;
}): TurnChipState | null {
  if (bufferType !== "normal" || marks.length === 0) return null;

  const index = isAtBottom
    ? marks.length - 1
    : Math.max(0, findTurnIndexForViewport(marks, viewportY));
  return {
    index,
    total: marks.length,
    canPrev: index > 0,
    canNext: index < marks.length - 1 || !isAtBottom,
  };
}

export const TURN_CHIP_SHOW_DEBOUNCE_MS = 100;
export const TURN_CHIP_HIDE_DELAY_MS = 900;
export const TURN_CHIP_EXIT_MS = 180;

export interface TurnChipVisibilityInput {
  isAtBottom: boolean;
  lastLeftBottomAt: number | null;
  lastReturnedBottomAt: number | null;
  wasVisible: boolean;
  now: number;
  showDebounceMs?: number;
  hideDelayMs?: number;
}

export function resolveTurnChipVisibility({
  isAtBottom,
  lastLeftBottomAt,
  lastReturnedBottomAt,
  wasVisible,
  now,
  showDebounceMs = TURN_CHIP_SHOW_DEBOUNCE_MS,
  hideDelayMs = TURN_CHIP_HIDE_DELAY_MS,
}: TurnChipVisibilityInput): boolean {
  if (!isAtBottom) {
    if (wasVisible) return true;
    return lastLeftBottomAt != null && now - lastLeftBottomAt >= showDebounceMs;
  }
  if (!wasVisible || lastReturnedBottomAt == null) return false;
  return now - lastReturnedBottomAt < hideDelayMs;
}

export function nextTurnChipVisibilityAt(input: TurnChipVisibilityInput): number | null {
  const showDebounceMs = input.showDebounceMs ?? TURN_CHIP_SHOW_DEBOUNCE_MS;
  const hideDelayMs = input.hideDelayMs ?? TURN_CHIP_HIDE_DELAY_MS;
  const visible = resolveTurnChipVisibility(input);
  if (!input.isAtBottom && !visible && input.lastLeftBottomAt != null) {
    return input.lastLeftBottomAt + showDebounceMs;
  }
  if (input.isAtBottom && visible && input.lastReturnedBottomAt != null) {
    return input.lastReturnedBottomAt + hideDelayMs;
  }
  return null;
}

export interface TurnChipVisibilityController {
  setAtBottom: (isAtBottom: boolean) => boolean;
  isVisible: () => boolean;
  dispose: () => void;
}

export function createTurnChipVisibilityController(options: {
  now?: () => number;
  setTimeout?: (handler: () => void, delayMs: number) => unknown;
  clearTimeout?: (id: unknown) => void;
  onChange?: (visible: boolean) => void;
} = {}): TurnChipVisibilityController {
  const nowFn = options.now ?? Date.now;
  const schedule = options.setTimeout
    ?? ((handler: () => void, delayMs: number) => globalThis.setTimeout(handler, delayMs));
  const cancel = options.clearTimeout
    ?? ((id: unknown) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>));

  let isAtBottom = true;
  let lastLeftBottomAt: number | null = null;
  let lastReturnedBottomAt: number | null = null;
  let visible = false;
  let timer: unknown = null;
  let disposed = false;

  const clearTimer = (): void => {
    if (timer == null) return;
    cancel(timer);
    timer = null;
  };

  const snapshot = (now: number): TurnChipVisibilityInput => ({
    isAtBottom,
    lastLeftBottomAt,
    lastReturnedBottomAt,
    wasVisible: visible,
    now,
  });

  const armTimer = (now: number): void => {
    clearTimer();
    const at = nextTurnChipVisibilityAt(snapshot(now));
    if (at == null) return;
    timer = schedule(() => {
      timer = null;
      sync(true);
    }, Math.max(0, at - now));
  };

  const sync = (emit: boolean, now = nowFn()): boolean => {
    const next = resolveTurnChipVisibility(snapshot(now));
    const changed = next !== visible;
    visible = next;
    armTimer(now);
    if (emit && changed) options.onChange?.(visible);
    return visible;
  };

  return {
    setAtBottom: (nextAtBottom: boolean): boolean => {
      if (disposed) return false;
      const now = nowFn();
      if (nextAtBottom !== isAtBottom) {
        if (nextAtBottom) lastReturnedBottomAt = now;
        else lastLeftBottomAt = now;
        isAtBottom = nextAtBottom;
      }
      return sync(false, now);
    },
    isVisible: (): boolean => visible,
    dispose: (): void => {
      disposed = true;
      visible = false;
      clearTimer();
    },
  };
}

function normalizeTurnText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function firstPromptLine(value: string): string {
  return value.split(/\r?\n/, 1)[0] ?? "";
}

function labelsMatch(markLabel: string, promptText: string): boolean {
  const mark = normalizeTurnText(markLabel);
  const prompt = normalizeTurnText(firstPromptLine(promptText));
  if (!mark || !prompt) return false;
  const markPrefix = mark.slice(0, MATCH_PREFIX_LENGTH);
  const promptPrefix = prompt.slice(0, MATCH_PREFIX_LENGTH);
  return markPrefix.startsWith(promptPrefix) || promptPrefix.startsWith(markPrefix);
}

export function buildTurnListRows(
  marks: readonly TurnMarkData[],
  transcriptPrompts: readonly TranscriptPrompt[],
): TurnListRow[] {
  const usedMarkIndexes = new Set<number>();
  const unmatchedPrompts: Array<{ prompt: TranscriptPrompt; index: number }> = [];

  transcriptPrompts.forEach((prompt, promptIndex) => {
    const matchedIndex = marks.findIndex((mark, markIndex) =>
      !usedMarkIndexes.has(markIndex) && labelsMatch(mark.label, prompt.text));
    if (matchedIndex >= 0) {
      usedMarkIndexes.add(matchedIndex);
    } else {
      unmatchedPrompts.push({ prompt, index: promptIndex });
    }
  });

  const survivingRows = marks
    .map((mark, markIndex): TurnListRow => ({
      key: `mark-${markIndex}-${mark.at}`,
      label: mark.label,
      markIndex,
      at: mark.at,
    }))
    .reverse();
  const unreachableRows = unmatchedPrompts
    .reverse()
    .map(({ prompt, index }): TurnListRow => ({
      key: `transcript-${index}-${prompt.occurredAt}`,
      label: normalizeTurnText(firstPromptLine(prompt.text)),
      markIndex: null,
      at: prompt.occurredAt,
    }));

  return [...survivingRows, ...unreachableRows].slice(0, TURN_LIST_MAX_ROWS);
}
