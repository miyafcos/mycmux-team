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
