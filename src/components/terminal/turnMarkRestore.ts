/**
 * Rebuilds turn marks for the part of a conversation mycmux never watched.
 *
 * Live turn marks are placed the moment a prompt is written to the PTY. A pane
 * that mycmux restores has no such moment for anything the agent redraws, so
 * the boundary mark ("復元前の履歴") used to be all there was above it. This
 * module reads the same prompts back out of the transcript and finds them in
 * the redrawn buffer.
 *
 * It runs only on a restored pane: the entry point returns immediately unless
 * the restore boundary mark is present, which is placed exactly where a replay
 * finished. Nothing here touches the live `noteTurnSubmit` path.
 */

import type { Terminal } from "@xterm/xterm";

import { getTranscriptUserPrompts, type TranscriptPrompt } from "../../lib/livebrief";
import { getTerminalWriteCounter, registerTerminalCacheEvictionCleanup } from "./terminalCache";
import {
  getTurnMarkData,
  resolveTurnTerminal,
  restoreTurnMarksAtLines,
  RESTORE_BOUNDARY_LABEL,
} from "./terminalTurnMarkers";
import {
  collectLogicalLines,
  matchPromptsToBuffer,
  type LogicalBufferLine,
  type PromptPlacement,
} from "./turnMarkRestoreModel";

/** How often the settle watcher samples the pane's write counter. */
const SETTLE_POLL_MS = 250;
/** Consecutive quiet samples that count as "the redraw is done". */
const SETTLE_STABLE_POLLS = 3;
/** A pane that never goes quiet is scanned anyway rather than never. */
const SETTLE_TIMEOUT_MS = 15_000;
/** Rows per scan slice, so a full scrollback never blocks one frame. */
const SCAN_CHUNK_ROWS = 1_000;

export type TurnMarkRestoreOutcome =
  | "restored"
  | "not-restored-pane"
  | "already-attempted"
  | "no-terminal"
  | "no-prompts"
  | "buffer-moved";

export interface TurnMarkRestoreReport {
  sessionId: string;
  outcome: TurnMarkRestoreOutcome;
  /** Prompts that got a mark. Always equals the marks actually registered. */
  restored: number;
  /** Prompts that could not be located and were therefore not counted. */
  skipped: number;
}

export interface TurnMarkRestoreDeps {
  fetchPrompts: (sessionId: string) => Promise<TranscriptPrompt[]>;
  resolveTerminal: (sessionId: string) => Terminal | undefined;
  hasRestoreBoundary: (sessionId: string) => boolean;
  place: (sessionId: string, term: Terminal, placements: readonly PromptPlacement[]) => number;
  writeCounter: (sessionId: string) => number;
  wait: (ms: number) => Promise<void>;
  now: () => number;
  report: (report: TurnMarkRestoreReport) => void;
}

const attempted = new Set<string>();

registerTerminalCacheEvictionCleanup((sessionId) => {
  attempted.delete(sessionId);
});

export function __resetTurnMarkRestoreForTests(): void {
  attempted.clear();
}

function defaultReport(report: TurnMarkRestoreReport): void {
  if (!import.meta.env.DEV) return;
  console.log(
    `[mycmux-diag turn-restore:${report.sessionId}] ${report.outcome} restored=${report.restored} skipped=${report.skipped}`,
  );
}

const defaultDeps: TurnMarkRestoreDeps = {
  fetchPrompts: (sessionId) => getTranscriptUserPrompts(sessionId),
  resolveTerminal: resolveTurnTerminal,
  hasRestoreBoundary: (sessionId) =>
    getTurnMarkData(sessionId).some((mark) => mark.label === RESTORE_BOUNDARY_LABEL),
  place: restoreTurnMarksAtLines,
  writeCounter: getTerminalWriteCounter,
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  report: defaultReport,
};

/**
 * Wait until the pane stops being written to. The redraw arrives as ordinary
 * output after the replay, so scanning immediately would read a half-drawn
 * conversation.
 */
async function waitForRedrawToSettle(
  sessionId: string,
  deps: TurnMarkRestoreDeps,
): Promise<boolean> {
  const deadline = deps.now() + SETTLE_TIMEOUT_MS;
  let last = deps.writeCounter(sessionId);
  let stable = 0;
  while (stable < SETTLE_STABLE_POLLS) {
    await deps.wait(SETTLE_POLL_MS);
    if (!deps.resolveTerminal(sessionId)) return false;
    const current = deps.writeCounter(sessionId);
    if (current === last) stable += 1;
    else {
      stable = 0;
      last = current;
    }
    if (deps.now() >= deadline) break;
  }
  return true;
}

async function collectBuffer(
  term: Terminal,
  deps: TurnMarkRestoreDeps,
): Promise<LogicalBufferLine[]> {
  const buffer = term.buffer.active;
  const lines: LogicalBufferLine[] = [];
  let row = 0;
  while (row < buffer.length) {
    const chunk = collectLogicalLines(buffer, row, SCAN_CHUNK_ROWS);
    lines.push(...chunk.lines);
    if (chunk.nextRow <= row) break;
    row = chunk.nextRow;
    if (row < buffer.length) await deps.wait(0);
  }
  return lines;
}

/**
 * Restore turn marks for `sessionId`, once.
 *
 * Callers fire this right after the restore boundary is placed. Everything
 * before the transcript read is a cheap guard, so a pane that was not restored
 * costs nothing at all.
 */
export async function restoreTurnMarksFromTranscript(
  sessionId: string,
  overrides: Partial<TurnMarkRestoreDeps> = {},
): Promise<TurnMarkRestoreReport> {
  const deps = { ...defaultDeps, ...overrides };
  const finish = (
    outcome: TurnMarkRestoreOutcome,
    restored: number,
    skipped: number,
  ): TurnMarkRestoreReport => {
    const report = { sessionId, outcome, restored, skipped };
    deps.report(report);
    return report;
  };

  // Not a restored pane: the live path already marks every turn as it happens.
  if (!deps.hasRestoreBoundary(sessionId)) return finish("not-restored-pane", 0, 0);
  if (attempted.has(sessionId)) return finish("already-attempted", 0, 0);
  attempted.add(sessionId);

  if (!(await waitForRedrawToSettle(sessionId, deps))) return finish("no-terminal", 0, 0);

  let prompts: TranscriptPrompt[];
  try {
    prompts = await deps.fetchPrompts(sessionId);
  } catch {
    return finish("no-prompts", 0, 0);
  }
  if (prompts.length === 0) return finish("no-prompts", 0, 0);

  const term = deps.resolveTerminal(sessionId);
  if (!term) return finish("no-terminal", 0, 0);
  const buffer = term.buffer.active;
  if (buffer.type !== "normal") return finish("no-terminal", 0, 0);

  // Line numbers are only meaningful while the buffer holds still. If output
  // arrived during the sliced scan the scrollback may have shifted underneath
  // it, and a shifted line is exactly the wrong place for a mark.
  const counterBefore = deps.writeCounter(sessionId);
  const lengthBefore = buffer.length;
  const lines = await collectBuffer(term, deps);
  if (deps.writeCounter(sessionId) !== counterBefore || buffer.length !== lengthBefore) {
    return finish("buffer-moved", 0, prompts.length);
  }

  const { placements, skipped } = matchPromptsToBuffer(
    prompts.map((prompt) => ({ text: prompt.text, at: prompt.occurredAt })),
    lines,
  );
  const restored = placements.length > 0 ? deps.place(sessionId, term, placements) : 0;
  return finish("restored", restored, skipped + (placements.length - restored));
}
