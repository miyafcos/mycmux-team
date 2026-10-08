// @ts-expect-error @xterm/headless@6.0.0 publishes this ESM file without colocated declarations.
import { Terminal as PublishedTerminal } from "@xterm/headless/lib-headless/xterm-headless.mjs";
import type { ScrollbackCursor, ScrollbackSnapshot } from "../../lib/ipc";
import { withTerminalDeadline } from "../../lib/terminalDeadline";
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
// Leave time to parse before the send-confirmation snapshot deadline (250 ms).
const HEADLESS_BUFFER_FETCH_TIMEOUT_MS = 200;
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
  sessionEpoch?: number;
  sizeRevision?: number;
  busy: boolean;
  cols: number;
  rows: number;
}

function resolveSize(
  size: HeadlessBufferSize | undefined,
  snapshot?: Pick<ScrollbackSnapshot, "cols" | "rows">,
): HeadlessBufferSize {
  const dimension = (cached: number | undefined, backend: number | undefined, min: number, fallback: number) => {
    const value = [cached, backend].find((candidate) => Number.isFinite(candidate) && (candidate ?? 0) >= min);
    return value === undefined ? fallback : Math.floor(value);
  };
  return {
    cols: dimension(size?.cols, snapshot?.cols, 2, HEADLESS_BUFFER_COLS),
    rows: dimension(size?.rows, snapshot?.rows, 1, HEADLESS_BUFFER_ROWS),
  };
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

type SnapshotLoader = (since?: ScrollbackCursor) => Promise<ScrollbackSnapshot>;

export function getHeadlessBufferLines(
  sessionId: string, snapshot: ScrollbackSnapshot, maxLines: number, size?: HeadlessBufferSize,
): Promise<string[]> {
  return replayHeadlessBuffer(sessionId, snapshot, maxLines, size);
}

export function readHeadlessBufferLines(
  sessionId: string, loadSnapshot: SnapshotLoader, maxLines: number, size?: HeadlessBufferSize,
): Promise<string[]> {
  return replayHeadlessBuffer(sessionId, loadSnapshot, maxLines, size);
}

function replayHeadlessBuffer(
  sessionId: string, source: ScrollbackSnapshot | SnapshotLoader, maxLines: number, size?: HeadlessBufferSize,
): Promise<string[]> {
  return withSessionWriteQueue(sessionId, async () => {
    let entry = headlessBufferCache.get(sessionId);
    // Pin cached parser state while fetching, and serialize fetch + parse so a
    // second reader requests the cursor the first reader actually committed.
    if (entry) entry.busy = true;
    try {
      const previousSize = entry ? resolveSize(size, entry) : undefined;
      const canRequestDelta = entry && previousSize?.cols === entry.cols && previousSize.rows === entry.rows
        && entry.sessionEpoch !== undefined && entry.sizeRevision !== undefined;
      const cursor: ScrollbackCursor | undefined = canRequestDelta && entry ? {
        endOffset: entry.endOffset, sessionEpoch: entry.sessionEpoch!, sizeRevision: entry.sizeRevision!,
      } : undefined;
      // Bound the fetch phase inside the queue, including a possible full retry.
      // No parser/cursor/geometry changes happen before this await succeeds.
      // On timeout keep the last committed state; late results cannot resume
      // this operation, and the next reader can request its still-valid cursor.
      const fetchDeadline = performance.now() + HEADLESS_BUFFER_FETCH_TIMEOUT_MS;
      const loadSnapshot = (since?: ScrollbackCursor) => {
        if (typeof source !== "function") throw new Error("PTY scrollback delta requires a full snapshot");
        return withTerminalDeadline(source(since), "headless get_session_scrollback",
          Math.max(0, fetchDeadline - performance.now()));
      };
      let snapshot = typeof source === "function" ? await loadSnapshot(cursor) : source;
      let wanted = resolveSize(size, snapshot);
      const canAppend = () => Boolean(entry && entry.cols === wanted.cols && entry.rows === wanted.rows
        && entry.sessionEpoch === snapshot.sessionEpoch && entry.sizeRevision === snapshot.sizeRevision
        && entry.endOffset >= snapshot.startOffset && entry.endOffset <= snapshot.endOffset);
      // A delta alone cannot initialize a fresh parser. Retry once with the
      // entire retained ring if the producer returned incompatible metadata.
      if (snapshot.isDelta && !canAppend()) {
        if (typeof source !== "function") throw new Error("PTY scrollback delta requires a full snapshot");
        snapshot = await loadSnapshot();
        wanted = resolveSize(size, snapshot);
        if (snapshot.isDelta && !canAppend()) throw new Error("PTY scrollback delta requires a full snapshot");
      }
      // A warm parser may retain screen cells from bytes already dropped by
      // the ring. Preserve it while the cursor is valid. Cold/delta equivalence
      // requires retained bytes that reconstruct the same parser/screen state.
      const replayDelta = canAppend();
      if (!entry || !replayDelta) {
        // Eviction or incompatible metadata loses that earlier state. Replaying
        // the retained raw ring is best effort: partial-update TUIs can have
        // missing screen cells because the ring is not a screen checkpoint.
        if (entry) disposeEntry(sessionId, entry);
        if (headlessBufferCache.size >= HEADLESS_BUFFER_CACHE_LIMIT) {
          const oldestIdle = [...headlessBufferCache.entries()].find(([, candidate]) => !candidate.busy);
          if (oldestIdle) disposeEntry(oldestIdle[0], oldestIdle[1]);
        }
        entry = createCacheEntry(wanted);
        if (headlessBufferCache.size < HEADLESS_BUFFER_CACHE_LIMIT) headlessBufferCache.set(sessionId, entry);
      } else {
        touchEntry(sessionId, entry);
      }
      const replayStart = replayDelta ? entry.endOffset - snapshot.startOffset : 0;
      entry.busy = true;
      try {
        await writeToTerminal(entry.terminal, snapshot.data.subarray(replayStart));
        entry.endOffset = snapshot.endOffset;
        entry.sessionEpoch = snapshot.sessionEpoch;
        entry.sizeRevision = snapshot.sizeRevision;
        const lines = getBufferLines(entry.terminal, maxLines);
        if (headlessBufferCache.get(sessionId) === entry) touchEntry(sessionId, entry);
        else entry.terminal.dispose(); // All slots were busy; this replay is temporary.
        return lines;
      } catch (error) {
        disposeEntry(sessionId, entry);
        throw error;
      }
    } finally {
      if (entry) entry.busy = false;
      evictOverflow();
    }
  });
}

export function __headlessBufferCacheSizeForTests(): number { return headlessBufferCache.size; }

export function __resetHeadlessBufferCacheForTests(): void {
  for (const [sessionId, entry] of headlessBufferCache) disposeEntry(sessionId, entry);
  headlessBufferCache.clear();
  sessionWriteQueues.clear();
}
