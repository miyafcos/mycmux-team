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

interface HeadlessBufferCacheEntry {
  terminal: HeadlessTerminal;
  endOffset: number;
  busy: boolean;
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

function createCacheEntry(): HeadlessBufferCacheEntry {
  return {
    terminal: new Terminal({
      cols: HEADLESS_BUFFER_COLS,
      rows: HEADLESS_BUFFER_ROWS,
      scrollback: HEADLESS_BUFFER_SCROLLBACK,
      allowProposedApi: true,
    }),
    endOffset: 0,
    busy: false,
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
): Promise<string[]> {
  return withSessionWriteQueue(sessionId, async () => {
    let entry = headlessBufferCache.get(sessionId);
    const canReplayDelta = Boolean(
      entry && entry.endOffset >= snapshot.startOffset && entry.endOffset <= snapshot.endOffset,
    );

    if (!entry || !canReplayDelta) {
      if (entry) disposeEntry(sessionId, entry);
      entry = createCacheEntry();
      headlessBufferCache.set(sessionId, entry);
    } else {
      touchEntry(sessionId, entry);
    }

    const replayStart = canReplayDelta ? entry.endOffset - snapshot.startOffset : 0;
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
