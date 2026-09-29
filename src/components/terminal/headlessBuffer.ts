// @ts-expect-error @xterm/headless@6.0.0 publishes this ESM file without colocated declarations.
import { Terminal as PublishedTerminal } from "@xterm/headless/lib-headless/xterm-headless.mjs";
import type { ScrollbackSnapshot } from "../../lib/ipc";
import {
  TERMINAL_SNAPSHOT_MAX_WRAPPED_LINES,
  TERMINAL_SNAPSHOT_SCAN_MULTIPLIER,
} from "./terminalBufferConstants";

type HeadlessTerminalConstructor = typeof import("@xterm/headless").Terminal;
type HeadlessTerminal = InstanceType<HeadlessTerminalConstructor>;

const Terminal = PublishedTerminal as HeadlessTerminalConstructor;
const HEADLESS_BUFFER_COLS = 80;
const HEADLESS_BUFFER_ROWS = 24;
const HEADLESS_BUFFER_SCROLLBACK = 5000;
const HEADLESS_BUFFER_CACHE_LIMIT = 12;
const TERMINAL_SNAPSHOT_MAX_LINE_CHARS = 8192;

/** Geometry the headless terminal is rendered with. Full-screen TUIs (Claude's
 *  AskUserQuestion, Codex approvals) redraw with cursor moves that only line up
 *  at the size the real pane had, so a mismatch garbles the frame. */
export interface HeadlessBufferSize {
  cols: number;
  rows: number;
}

interface HeadlessBufferCacheEntry {
  terminal: HeadlessTerminal;
  endOffset: number;
  busy: boolean;
  cols: number;
  rows: number;
}

function resolveSize(size: HeadlessBufferSize | undefined): HeadlessBufferSize {
  const cols = Number.isFinite(size?.cols) && (size?.cols ?? 0) >= 2 ? Math.floor(size!.cols) : HEADLESS_BUFFER_COLS;
  const rows = Number.isFinite(size?.rows) && (size?.rows ?? 0) >= 1 ? Math.floor(size!.rows) : HEADLESS_BUFFER_ROWS;
  return { cols, rows };
}

const headlessBufferCache = new Map<string, HeadlessBufferCacheEntry>();
const sessionWriteQueues = new Map<string, Promise<void>>();

function cleanTerminalSnapshotLine(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\x1b\].*?\x07/g, "")
    .replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/g, "")
    .trim();
}

function hasHighReplacementCharRatio(text: string): boolean {
  if (text.length === 0) return false;
  const characters = [...text];
  const replacements = characters.filter((character) => character === "\uFFFD").length;
  return replacements / characters.length > 0.3;
}

function getBufferLines(terminal: HeadlessTerminal, maxLines: number): string[] {
  if (maxLines <= 0) return [];
  try {
    const buffer = terminal.buffer.active;
    const bottom = buffer.length - 1;
    if (bottom < 0) return [];
    const result: string[] = [];
    const minLineIndex = Math.max(0, bottom - maxLines * TERMINAL_SNAPSHOT_SCAN_MULTIPLIER);

    let lineIndex = bottom;
    while (lineIndex >= minLineIndex && result.length < maxLines) {
      let firstLineIndex = lineIndex;
      let wrappedRows = 0;
      while (
        firstLineIndex > minLineIndex &&
        wrappedRows < TERMINAL_SNAPSHOT_MAX_WRAPPED_LINES &&
        buffer.getLine(firstLineIndex)?.isWrapped
      ) {
        firstLineIndex--;
        wrappedRows++;
      }

      let logicalLine = "";
      for (let i = firstLineIndex; i <= lineIndex; i++) {
        const line = buffer.getLine(i);
        if (!line) continue;
        const nextIsWrapped = i < lineIndex && Boolean(buffer.getLine(i + 1)?.isWrapped);
        const part = line.translateToString(!nextIsWrapped);
        const remaining = TERMINAL_SNAPSHOT_MAX_LINE_CHARS - logicalLine.length;
        if (remaining > 0) logicalLine += part.slice(0, remaining);
      }

      const text = cleanTerminalSnapshotLine(logicalLine);
      if (text.length > 0 && !hasHighReplacementCharRatio(text)) result.push(text);
      lineIndex = firstLineIndex - 1;
    }
    return result.reverse();
  } catch {
    return [];
  }
}

function createCacheEntry(size: HeadlessBufferSize): HeadlessBufferCacheEntry {
  return {
    terminal: new Terminal({
      cols: size.cols,
      rows: size.rows,
      scrollback: HEADLESS_BUFFER_SCROLLBACK,
      allowProposedApi: true,
    }),
    endOffset: 0,
    busy: false,
    cols: size.cols,
    rows: size.rows,
  };
}

function disposeEntry(sessionId: string, entry: HeadlessBufferCacheEntry): void {
  if (headlessBufferCache.get(sessionId) === entry) headlessBufferCache.delete(sessionId);
  entry.terminal.dispose();
}

function touchEntry(sessionId: string, entry: HeadlessBufferCacheEntry): void {
  headlessBufferCache.delete(sessionId);
  headlessBufferCache.set(sessionId, entry);
}

function evictOverflow(): void {
  while (headlessBufferCache.size > HEADLESS_BUFFER_CACHE_LIMIT) {
    const oldestIdle = [...headlessBufferCache.entries()].find(([, entry]) => !entry.busy);
    if (!oldestIdle) return;
    disposeEntry(oldestIdle[0], oldestIdle[1]);
  }
}

function writeToTerminal(terminal: HeadlessTerminal, data: Uint8Array): Promise<void> {
  if (data.byteLength === 0) return Promise.resolve();
  return new Promise((resolve) => terminal.write(data, resolve));
}

async function withSessionWriteQueue<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
  const previous = sessionWriteQueues.get(sessionId) ?? Promise.resolve();
  const current = previous.then(operation, operation);
  const settled = current.then(() => undefined, () => undefined);
  sessionWriteQueues.set(sessionId, settled);
  try {
    return await current;
  } finally {
    if (sessionWriteQueues.get(sessionId) === settled) sessionWriteQueues.delete(sessionId);
  }
}

export function getHeadlessBufferLines(
  sessionId: string,
  snapshot: ScrollbackSnapshot,
  maxLines: number,
  size?: HeadlessBufferSize,
): Promise<string[]> {
  return withSessionWriteQueue(sessionId, async () => {
    const wanted = resolveSize(size);
    let entry = headlessBufferCache.get(sessionId);
    const canReplayDelta = Boolean(
      entry && entry.endOffset >= snapshot.startOffset && entry.endOffset <= snapshot.endOffset,
    );
    // A size change invalidates every row already rendered, so replay from the start.
    const sizeMatches = Boolean(entry && entry.cols === wanted.cols && entry.rows === wanted.rows);

    if (!entry || !canReplayDelta || !sizeMatches) {
      if (entry) disposeEntry(sessionId, entry);
      entry = createCacheEntry(wanted);
      headlessBufferCache.set(sessionId, entry);
    } else {
      touchEntry(sessionId, entry);
    }

    const replayStart = canReplayDelta && sizeMatches ? entry.endOffset - snapshot.startOffset : 0;
    const data = snapshot.data.subarray(replayStart);
    entry.busy = true;
    try {
      await writeToTerminal(entry.terminal, data);
      entry.endOffset = snapshot.endOffset;
      const lines = getBufferLines(entry.terminal, maxLines);
      entry.busy = false;
      touchEntry(sessionId, entry);
      evictOverflow();
      return lines;
    } catch (error) {
      entry.busy = false;
      disposeEntry(sessionId, entry);
      evictOverflow();
      throw error;
    }
  });
}

export function __resetHeadlessBufferCacheForTests(): void {
  for (const [sessionId, entry] of headlessBufferCache) disposeEntry(sessionId, entry);
  headlessBufferCache.clear();
  sessionWriteQueues.clear();
}
