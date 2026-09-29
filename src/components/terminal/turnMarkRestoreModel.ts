/**
 * Matching core for turn-mark restore.
 *
 * When mycmux replays a pane it never watched being typed, the agent redraws
 * the past conversation into the terminal buffer, and the transcript holds the
 * same prompts in order. Lining those two up is the only way to get turn marks
 * back for that history — but a wrong mark is worse than a missing one, so the
 * matcher is deliberately conservative:
 *
 * - both sides go through the same normalisation, so decoration the agent adds
 *   ("> ", box borders) cancels out instead of having to be predicted;
 * - the nth prompt may only land on a line strictly after the (n-1)th, which
 *   is what keeps short repeated prompts ("Go", "進捗") in their real order;
 * - a prompt with no confident line is skipped and never counted.
 *
 * Everything here is pure so it can be tested against a real xterm buffer
 * without a running app.
 */

import { turnLabelFrom } from "./terminalTurnModel";

/**
 * Leading glyphs agents draw in front of a recorded prompt, plus the markup
 * characters a prompt may start with itself. Both sides are stripped with the
 * same pattern, so over-stripping cannot desynchronise them.
 * `─-╿` is box drawing, `▀-▟` block elements.
 */
const LEADING_DECORATION =
  /^[\s>*|#+\-»•·‣›●○◆❯⏵⏺─-▟]+/u;
/** Right-hand borders and padding a boxed redraw leaves at the end of a row. */
const TRAILING_DECORATION = /[\s|─-▟]+$/u;

/**
 * Bucket width for the line index. Short enough that a prompt shorter than a
 * bucket key still keys on itself, and never wider than the shortest accepted
 * truncated match, so a qualifying line always shares its prompt's bucket.
 */
export const BUCKET_KEY_LENGTH = 8;

/**
 * An agent that hard-wraps its redraw puts only the head of a long prompt on
 * the first row. Such a partial line is accepted as evidence only once it is
 * this long, which keeps generic openings from claiming a line.
 */
export const MIN_TRUNCATED_MATCH_LENGTH = 12;

export interface BufferLineLike {
  translateToString(trimRight?: boolean): string;
  readonly isWrapped: boolean;
}

export interface BufferLike {
  readonly length: number;
  getLine(index: number): BufferLineLike | undefined;
}

/** One buffer row, with any xterm-wrapped continuation rows joined back on. */
export interface LogicalBufferLine {
  /** Absolute buffer row the logical line starts at. */
  line: number;
  text: string;
}

export interface RestorablePrompt {
  text: string;
  at: number;
}

export interface PromptPlacement {
  line: number;
  label: string;
  at: number;
}

export interface PromptMatchResult {
  placements: PromptPlacement[];
  /** Prompts that had no confident line. Never counted as restored. */
  skipped: number;
}

export interface BufferTurnBoundary {
  /** Absolute buffer row where the user prompt starts. */
  line: number;
  label: string;
}

export type UserPromptLinePredicate = (rawLogicalLine: string) => boolean;

/** The user-input gutter observed in restored agent scrollback. */
export const isUserPromptGutterLine: UserPromptLinePredicate = (raw) => {
  if (!/^\s*❯(?=\s|$)/u.test(raw)) return false;
  const body = stripDecoration(raw).trimEnd();
  if (body.length === 0) return false;
  // vitest flags a failing file with the same glyph, and a run in this pane
  // leaves those rows in the scrollback. Observed in live data as
  // "❯ unit tests/unit/x.test.ts(5tests|2failed) 71ms" -- a shape no prompt has.
  if (/\(\d+\s*tests?[^)]*\)\s*\d+\s*ms$/u.test(body)) return false;
  return true;
};

function stripDecoration(line: string): string {
  return line
    .replace(LEADING_DECORATION, "")
    .replace(TRAILING_DECORATION, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * The comparison form of a prompt or a buffer line: its first line with real
 * content, stripped of decoration and with runs of whitespace collapsed.
 *
 * Both sides use this, so a prompt that itself starts with "- " is normalised
 * the same way the redrawn "> - " line is.
 */
export function normalizeMatchText(raw: string): string {
  for (const line of raw.split(/\r?\n/)) {
    const normalized = stripDecoration(line);
    if (normalized.length > 0) return normalized;
  }
  return "";
}

export function bucketKey(normalized: string): string {
  return Array.from(normalized).slice(0, BUCKET_KEY_LENGTH).join("");
}

/**
 * Whether `line` is evidence that `prompt` was drawn there.
 *
 * The buffer line may be a hard-wrapped head of the prompt, so a proper prefix
 * counts — but only in that direction. Accepting the reverse would let the
 * prompt "Go" claim a line reading "Go somewhere else".
 */
export function promptMatchesLine(prompt: string, line: string): boolean {
  if (prompt.length === 0 || line.length === 0) return false;
  if (prompt === line) return true;
  if (!prompt.startsWith(line)) return false;
  return Array.from(line).length >= MIN_TRUNCATED_MATCH_LENGTH;
}

/**
 * Read `maxRows` rows starting at `from`, joining wrapped continuations.
 *
 * Returns the row the next chunk should start at, which is always past a
 * complete logical line, so a chunked scan never splits one in half.
 */
export function collectLogicalLines(
  buffer: BufferLike,
  from: number,
  maxRows: number,
): { lines: LogicalBufferLine[]; nextRow: number } {
  const lines: LogicalBufferLine[] = [];
  const total = buffer.length;
  let row = Math.max(0, from);
  const stopAt = Math.min(total, row + Math.max(1, maxRows));
  while (row < stopAt) {
    const head = buffer.getLine(row);
    if (!head) {
      row += 1;
      continue;
    }
    let text = head.translateToString(false);
    let next = row + 1;
    while (next < total) {
      const continuation = buffer.getLine(next);
      if (!continuation || !continuation.isWrapped) break;
      text += continuation.translateToString(false);
      next += 1;
    }
    lines.push({ line: row, text });
    row = next > row ? next : row + 1;
  }
  return { lines, nextRow: row };
}

/**
 * Find user-turn boundaries directly in a rendered terminal buffer.
 *
 * The predicate owns the user/agent distinction; `stripDecoration` remains the
 * single source of truth for removing gutter glyphs before a label is made.
 */
export function scanTurnBoundaries(
  buffer: BufferLike,
  isUserPromptLine: UserPromptLinePredicate = isUserPromptGutterLine,
): BufferTurnBoundary[] {
  const boundaries: BufferTurnBoundary[] = [];
  const seenLines = new Set<number>();
  let row = 0;
  while (row < buffer.length) {
    const chunk = collectLogicalLines(buffer, row, buffer.length);
    for (let index = 0; index < chunk.lines.length; index += 1) {
      const entry = chunk.lines[index];
      if (!entry) continue;
      if (seenLines.has(entry.line) || !isUserPromptLine(entry.text)) continue;
      const label = turnLabelFrom(stripDecoration(entry.text));
      if (label.length === 0) continue;
      // AskUserQuestion uses `❯` for its choice cursor too. Only exclude a
      // choice-shaped row when the surrounding rendered block has its UI
      // footer; a real user prompt may legitimately start with `1.` or Submit.
      const choiceShaped = /^(?:\d+\.\s|Submit(?: answers)?$|Type something\.?$|Chat about this$)/iu.test(label);
      const nearby = chunk.lines.slice(Math.max(0, index - 12), index + 13);
      const hasChoiceFooter = nearby.some((candidate) =>
        /(?:Enter to select|(?:↑\/↓|Tab\/Arrow keys) to navigate)/iu.test(candidate.text));
      if (choiceShaped && hasChoiceFooter) continue;
      seenLines.add(entry.line);
      boundaries.push({ line: entry.line, label });
    }
    if (chunk.nextRow <= row) break;
    row = chunk.nextRow;
  }
  return boundaries;
}

/**
 * Line up the transcript with the buffer, newest prompt first.
 *
 * The pairing is anchored at the newest end because that is the end the two
 * sides agree on: the buffer bottom is the current moment, while its top is
 * wherever the scrollback happened to be cut, so the transcript almost always
 * reaches further back than the buffer does. Walking forward from the oldest
 * prompt lets a prompt whose own line is long gone claim a much later line
 * that belongs to a repeat of the same text, and every prompt in between is
 * then blocked by the monotonic rule — measured on real panes, that lost 23 of
 * 24 restorable marks. Walking back from the newest prompt cannot make that
 * mistake: the prompts that fall off the top are the ones that get skipped.
 *
 * Either direction keeps the guarantee that matters — the nth prompt sits at a
 * line strictly after the (n-1)th. The buffer is indexed once, and a prompt
 * only ever looks at its own bucket.
 */
export function matchPromptsToBuffer(
  prompts: readonly RestorablePrompt[],
  lines: readonly LogicalBufferLine[],
): PromptMatchResult {
  const buckets = new Map<string, { normalized: string; line: number }[]>();
  for (const entry of lines) {
    const normalized = normalizeMatchText(entry.text);
    if (normalized.length === 0) continue;
    const key = bucketKey(normalized);
    const bucket = buckets.get(key);
    if (bucket) bucket.push({ normalized, line: entry.line });
    else buckets.set(key, [{ normalized, line: entry.line }]);
  }

  // Per-bucket cursors are safe because `boundary` only ever moves backwards:
  // a line already at or past the last placement can never serve an older one.
  const cursors = new Map<string, number>();
  const placements: PromptPlacement[] = [];
  let skipped = 0;
  let boundary = Number.POSITIVE_INFINITY;

  for (let position = prompts.length - 1; position >= 0; position -= 1) {
    const prompt = prompts[position];
    if (!prompt) continue;
    const normalized = normalizeMatchText(prompt.text);
    const key = bucketKey(normalized);
    const bucket = normalized.length > 0 ? buckets.get(key) : undefined;
    if (!bucket) {
      skipped += 1;
      continue;
    }
    let cursor = cursors.get(key) ?? bucket.length - 1;
    while (cursor >= 0 && (bucket[cursor]?.line ?? 0) >= boundary) cursor -= 1;
    cursors.set(key, cursor);

    let found = -1;
    for (let index = cursor; index >= 0; index -= 1) {
      const candidate = bucket[index];
      if (!candidate) continue;
      if (promptMatchesLine(normalized, candidate.normalized)) {
        found = candidate.line;
        break;
      }
    }
    if (found < 0) {
      skipped += 1;
      continue;
    }
    const label = turnLabelFrom(prompt.text);
    if (label.length === 0) {
      skipped += 1;
      continue;
    }
    placements.push({ line: found, label, at: prompt.at });
    boundary = found;
  }

  placements.reverse();
  return { placements, skipped };
}
