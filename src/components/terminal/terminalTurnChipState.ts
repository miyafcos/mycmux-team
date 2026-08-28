import type { TranscriptPrompt } from "../../lib/livebrief";
import {
  findTurnIndexForViewport,
  type TurnMarkData,
} from "./terminalTurnModel";

const TURN_LIST_MAX_ROWS = 200;
const MATCH_PREFIX_LENGTH = 80;

/**
 * The viewport is sitting at the live end of the buffer, so new output keeps
 * scrolling into view. A refit reflows the wrapped lines and moves `viewportY`
 * out from under the reader, which is why callers record this *before* fitting
 * and restore it afterwards.
 */
export function viewportIsAtBottom(buffer: { viewportY: number; baseY: number }): boolean {
  return buffer.viewportY >= buffer.baseY;
}

export type TurnChipMode = "scroll" | "transcript";

export interface TurnChipState {
  index: number;
  total: number;
  canPrev: boolean;
  canNext: boolean;
  mode: TurnChipMode;
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
  hasTranscript = false,
}: {
  marks: readonly TurnMarkData[];
  viewportY: number;
  isAtBottom: boolean;
  bufferType: string;
  /** The pane runs an agent (claude / codex / grok) whose transcript the dashboard can walk. */
  hasTranscript?: boolean;
}): TurnChipState | null {
  // An agent pane always walks the dashboard transcript, whichever buffer its
  // TUI happens to draw in. claude runs on the alternate screen and keeps no
  // history in the buffer at all; codex and grok draw in the normal buffer and
  // do keep some. Deciding by buffer type made one chip mean two different
  // things depending on the agent, so the pane's kind decides instead.
  if (hasTranscript) {
    const latest = Math.max(0, marks.length - 1);
    return {
      index: latest,
      total: marks.length,
      canPrev: true,
      canNext: true,
      mode: "transcript",
    };
  }

  // A plain shell has no transcript to walk: the chip is only ever a scrollback
  // index, so it needs real marks to point at.
  if (bufferType !== "normal" || marks.length === 0) return null;

  const index = isAtBottom
    ? marks.length - 1
    : Math.max(0, findTurnIndexForViewport(marks, viewportY));
  return {
    index,
    total: marks.length,
    canPrev: index > 0,
    canNext: index < marks.length - 1 || !isAtBottom,
    mode: "scroll",
  };
}

export const TURN_CHIP_SHOW_DEBOUNCE_MS = 100;
export const TURN_CHIP_HIDE_DELAY_MS = 900;
export const TURN_CHIP_EXIT_MS = 180;
// A wheel-up inside a pane whose app owns the mouse (Claude Code, codex, any
// TUI) never moves the xterm viewport, so "left the bottom" can never fire
// there. The wheel itself is the intent to look back: it keeps the chip up
// for this long after the last wheel, and hovering the chip extends it.
export const TURN_CHIP_INTENT_HOLD_MS = 2500;

export interface TurnChipVisibilityInput {
  isAtBottom: boolean;
  lastLeftBottomAt: number | null;
  lastReturnedBottomAt: number | null;
  wasVisible: boolean;
  now: number;
  /** Last wheel-up / chip hover; null when the user never asked to look back. */
  lastIntentAt?: number | null;
  showDebounceMs?: number;
  hideDelayMs?: number;
  intentHoldMs?: number;
}

export function resolveTurnChipVisibility({
  isAtBottom,
  lastLeftBottomAt,
  lastReturnedBottomAt,
  wasVisible,
  now,
  lastIntentAt = null,
  showDebounceMs = TURN_CHIP_SHOW_DEBOUNCE_MS,
  hideDelayMs = TURN_CHIP_HIDE_DELAY_MS,
  intentHoldMs = TURN_CHIP_INTENT_HOLD_MS,
}: TurnChipVisibilityInput): boolean {
  if (lastIntentAt != null && now - lastIntentAt < intentHoldMs) return true;
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
  const intentHoldMs = input.intentHoldMs ?? TURN_CHIP_INTENT_HOLD_MS;
  const visible = resolveTurnChipVisibility(input);
  if (input.lastIntentAt != null && input.now - input.lastIntentAt < intentHoldMs) {
    // Re-evaluate when the intent hold expires; the scroll rules take over then.
    return input.lastIntentAt + intentHoldMs;
  }
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
  /** Wheel-up or chip hover: show now and hold for TURN_CHIP_INTENT_HOLD_MS. */
  noteLookBackIntent: () => boolean;
  /** Drop leave/return/intent history. Used when the active buffer type changes. */
  reset: () => void;
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
  let lastIntentAt: number | null = null;
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
    lastIntentAt,
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
    noteLookBackIntent: (): boolean => {
      if (disposed) return false;
      const now = nowFn();
      lastIntentAt = now;
      return sync(true, now);
    },
    isVisible: (): boolean => visible,
    reset: (): void => {
      if (disposed) return;
      clearTimer();
      isAtBottom = true;
      lastLeftBottomAt = null;
      lastReturnedBottomAt = null;
      lastIntentAt = null;
      visible = false;
    },
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

export function labelsMatch(markLabel: string, promptText: string): boolean {
  const mark = normalizeTurnText(markLabel);
  const prompt = normalizeTurnText(firstPromptLine(promptText));
  if (!mark || !prompt) return false;
  const markPrefix = mark.slice(0, MATCH_PREFIX_LENGTH);
  const promptPrefix = prompt.slice(0, MATCH_PREFIX_LENGTH);
  return markPrefix.startsWith(promptPrefix) || promptPrefix.startsWith(markPrefix);
}

export type TranscriptTurnIntent =
  | { kind: "prev" }
  | { kind: "next" }
  | { kind: "row"; label: string }
  | { kind: "hint" };

export type TranscriptTurnRequestPayload =
  | { kind: "step"; delta: -1 | 1 }
  | { kind: "label"; label: string }
  | { kind: "latest" };

/** Decide the dashboard request for an alternate-buffer chip action. Missing tab → none. */
export function resolveTranscriptTurnAction(
  intent: TranscriptTurnIntent,
  context: { tabId: string | null },
): TranscriptTurnRequestPayload | null {
  if (!context.tabId) return null;
  if (intent.kind === "prev") return { kind: "step", delta: -1 };
  if (intent.kind === "next") return { kind: "step", delta: 1 };
  if (intent.kind === "hint") return { kind: "latest" };
  const label = intent.label.trim();
  if (!label) return null;
  return { kind: "label", label };
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
