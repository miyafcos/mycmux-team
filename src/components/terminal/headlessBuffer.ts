// @ts-expect-error @xterm/headless@6.0.0 publishes this ESM file without colocated declarations.
import { Terminal as PublishedTerminal } from "@xterm/headless/lib-headless/xterm-headless.mjs";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { LightDarkColorAdaptController } from "../../lib/lightDarkColorAdapt";
import { SgrLightRewriter } from "./sgrLightTheme";
import { readHeadlessAppearance, headlessScreenViewport } from "./headlessAppearance";
import { snapshotTerminalScreen, type TerminalScreenSnapshot } from "./terminalScreenSnapshot";
import { trackTerminalScreenState, terminalScreenCursorVisible, terminalScreenThemeFor, terminalScreenPaletteOverrides } from "./terminalScreenState";
import type { ScrollbackCursor, ScrollbackSnapshot } from "../../lib/ipc";
import { TERMINAL_IPC_TIMEOUT_MS, withTerminalDeadline } from "../../lib/terminalDeadline";
import { currentPtyRead, ptyReadGeneration, retainPtyReads, subscribePtyReads, validatePtySnapshot, type PtyReadGeneration } from "../../lib/ptyReadGeneration";
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
  sessionId: string;
  terminal: HeadlessTerminal;
  decoder: TextDecoder;
  colorAdapter: LightDarkColorAdaptController;
  sgrRewriter: SgrLightRewriter;
  generation: PtyReadGeneration;
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

// Both uses share one LRU and its total limit, but never a parser.
const headlessBufferCache = new Map<string, HeadlessBufferCacheEntry>();
const sessionWriteQueues = new Map<string, Promise<void>>();
subscribePtyReads(sessionId => {
  for (const [cacheKey, entry] of headlessBufferCache) {
    if (entry.sessionId !== sessionId) continue;
    headlessBufferCache.delete(cacheKey);
    // A parser callback must settle before disposal. Its generation check below
    // prevents the retired parser from committing or re-entering the cache.
    if (!entry.busy) entry.terminal.dispose();
  }
});

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

function createCacheEntry(sessionId: string, size: HeadlessBufferSize, generation: PtyReadGeneration): HeadlessBufferCacheEntry {
  const terminal = new Terminal({
    cols: size.cols,
    rows: size.rows,
    scrollback: HEADLESS_BUFFER_SCROLLBACK,
    windowsPty: readHeadlessAppearance(sessionId).windowsPty,
    allowProposedApi: true,
  });
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = "11";
  trackTerminalScreenState(terminal, () => readHeadlessAppearance(sessionId).theme, sessionId);
  return {
    sessionId,
    terminal,
    decoder: new TextDecoder(),
    colorAdapter: new LightDarkColorAdaptController(),
    sgrRewriter: new SgrLightRewriter(),
    generation,
    endOffset: 0,
    busy: false,
    cols: size.cols,
    rows: size.rows,
  };
}

function disposeEntry(cacheKey: string, entry: HeadlessBufferCacheEntry): void {
  if (headlessBufferCache.get(cacheKey) === entry) headlessBufferCache.delete(cacheKey);
  entry.terminal.dispose();
}

function touchEntry(cacheKey: string, entry: HeadlessBufferCacheEntry): void {
  headlessBufferCache.delete(cacheKey);
  headlessBufferCache.set(cacheKey, entry);
}

function evictOverflow(): void {
  while (headlessBufferCache.size > HEADLESS_BUFFER_CACHE_LIMIT) {
    const oldestIdle = [...headlessBufferCache.entries()].find(([, entry]) => !entry.busy);
    if (!oldestIdle) return;
    disposeEntry(oldestIdle[0], oldestIdle[1]);
  }
}

function writeToTerminal(terminal: HeadlessTerminal, data: string): Promise<void> {
  if (data.length === 0) return Promise.resolve();
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
  return replayHeadlessBuffer(sessionId, snapshot, entry => getBufferLines(entry.terminal, maxLines), size);
}

export function readHeadlessBufferLines(
  sessionId: string, loadSnapshot: SnapshotLoader, maxLines: number, size?: HeadlessBufferSize,
  fetchTimeoutMs = HEADLESS_BUFFER_FETCH_TIMEOUT_MS, purpose?: "observation", isCurrent = () => true,
): Promise<string[]> {
  return replayHeadlessBuffer(sessionId, loadSnapshot, entry => getBufferLines(entry.terminal, maxLines), size, fetchTimeoutMs, purpose, isCurrent);
}

/** Screen polling always uses observation fetches: IPC never owns the queue. */
export function readHeadlessBufferScreen(
  sessionId: string, loadSnapshot: SnapshotLoader, scrollback: unknown, size?: HeadlessBufferSize,
  fetchTimeoutMs = TERMINAL_IPC_TIMEOUT_MS, isCurrent = () => true,
): Promise<TerminalScreenSnapshot> {
  return replayHeadlessBuffer(sessionId, loadSnapshot, entry => snapshotTerminalScreen(
    entry.terminal, terminalScreenThemeFor(entry.terminal, readHeadlessAppearance(sessionId).theme), {
      scrollback, cursorVisible: terminalScreenCursorVisible(entry.terminal),
      paletteOverrides: terminalScreenPaletteOverrides(entry.terminal),
      viewportY: headlessScreenViewport(sessionId, entry.terminal.buffer.active.baseY),
    },
  ), size, fetchTimeoutMs, "observation", isCurrent, true);
}

async function replayHeadlessBuffer<T>(
  sessionId: string, source: ScrollbackSnapshot | SnapshotLoader, read: (entry: HeadlessBufferCacheEntry) => T, size?: HeadlessBufferSize,
  fetchTimeoutMs = HEADLESS_BUFFER_FETCH_TIMEOUT_MS, purpose?: "observation", isCurrent = () => true,
  preserveScreenOnResize = false,
): Promise<T> {
  const release = retainPtyReads(sessionId);
  try {
    const generation = ptyReadGeneration(sessionId);
    const cacheKey = `${preserveScreenOnResize ? "screen" : "lines"}:${sessionId}`;
    const cursorFor = (entry?: HeadlessBufferCacheEntry): ScrollbackCursor | undefined => {
      const wanted = entry ? resolveSize(size, entry) : undefined;
      return entry && currentPtyRead(sessionId, entry.generation) && wanted?.cols === entry.cols && wanted.rows === entry.rows
        && entry.sessionEpoch !== undefined && entry.sizeRevision !== undefined
        ? { endOffset: entry.endOffset, sessionEpoch: entry.sessionEpoch, sizeRevision: entry.sizeRevision } : undefined;
    };
    let fetchDeadline = performance.now() + fetchTimeoutMs;
    const load = (cursor?: ScrollbackCursor): Promise<ScrollbackSnapshot> => {
      if (!currentPtyRead(sessionId, generation) || !isCurrent()) return Promise.reject(new Error("PTY read generation changed"));
      if (typeof source !== "function") return Promise.reject(new Error("PTY scrollback delta requires a full snapshot"));
      return withTerminalDeadline(source(cursor), "headless get_session_scrollback", Math.max(0, fetchDeadline - performance.now()));
    };
    const commit = async (snapshot: ScrollbackSnapshot): Promise<T | undefined> => {
      if (!isCurrent()) throw new Error("pane read lifetime changed");
      validatePtySnapshot(sessionId, generation, snapshot.sessionEpoch);
      let entry = headlessBufferCache.get(cacheKey);
      const wanted = resolveSize(size, snapshot);
      const compatible = Boolean(entry && entry.generation === generation && entry.sessionEpoch === snapshot.sessionEpoch
        && (preserveScreenOnResize || (entry.cols === wanted.cols && entry.rows === wanted.rows && entry.sizeRevision === snapshot.sizeRevision)));
      // An interactive reader may advance the cursor while an observer is fetching.
      // Never rewind the committed parser to that observer's older reply.
      if (entry?.generation === generation && entry.sessionEpoch === snapshot.sessionEpoch
        && (entry.endOffset > snapshot.endOffset || (entry.sizeRevision !== undefined && snapshot.sizeRevision !== undefined
          && entry.sizeRevision > snapshot.sizeRevision))) return read(entry);
      const canAppend = compatible && entry!.endOffset >= snapshot.startOffset && entry!.endOffset <= snapshot.endOffset;
      if (snapshot.isDelta && !canAppend) return undefined;
      if (!entry || !canAppend) {
        if (entry) disposeEntry(cacheKey, entry);
        if (headlessBufferCache.size >= HEADLESS_BUFFER_CACHE_LIMIT) {
          const idle = [...headlessBufferCache.entries()].find(([, candidate]) => !candidate.busy);
          if (idle) disposeEntry(idle[0], idle[1]);
        }
        entry = createCacheEntry(sessionId, wanted, generation);
        if (headlessBufferCache.size < HEADLESS_BUFFER_CACHE_LIMIT) headlessBufferCache.set(cacheKey, entry);
      }
      const replayStart = canAppend ? entry.endOffset - snapshot.startOffset : 0;
      entry.busy = true;
      try {
        if (preserveScreenOnResize && (entry.cols !== wanted.cols || entry.rows !== wanted.rows)) {
          entry.terminal.resize(wanted.cols, wanted.rows);
          entry.cols = wanted.cols; entry.rows = wanted.rows;
        }
        const appearance = readHeadlessAppearance(sessionId);
        const output = entry.decoder.decode(snapshot.data.subarray(replayStart), { stream: true });
        const adapted = entry.colorAdapter.transform(output, appearance.adaptColors);
        await writeToTerminal(entry.terminal, entry.sgrRewriter.transform(adapted, appearance.light));
        if (!isCurrent()) throw new Error("pane read lifetime changed");
        validatePtySnapshot(sessionId, generation, snapshot.sessionEpoch);
        entry.endOffset = snapshot.endOffset;
        entry.sessionEpoch = snapshot.sessionEpoch;
        entry.sizeRevision = snapshot.sizeRevision;
        const lines = read(entry);
        if (headlessBufferCache.get(cacheKey) === entry) touchEntry(cacheKey, entry);
        else entry.terminal.dispose();
        return lines;
      } catch (error) {
        disposeEntry(cacheKey, entry);
        throw error;
      } finally {
        entry.busy = false;
        evictOverflow();
      }
    };
    if (purpose === "observation") {
      // Only parser mutations share the queue. A four-second observer IPC wait
      // cannot consume an ordinary read or send-confirmation's deadline.
      let snapshot = typeof source === "function" ? await load(cursorFor(headlessBufferCache.get(cacheKey))) : source;
      let lines = await withSessionWriteQueue(sessionId, () => commit(snapshot));
      if (lines === undefined) {
        snapshot = await load(); // One full retry, outside the queue, same budget.
        lines = await withSessionWriteQueue(sessionId, () => commit(snapshot));
      }
      if (lines === undefined) throw new Error("PTY scrollback delta requires a full snapshot");
      return lines;
    }
    return await withSessionWriteQueue(sessionId, async () => {
      // Preserve the default reader's serialized cursor and 200 ms fetch budget.
      fetchDeadline = performance.now() + fetchTimeoutMs;
      let snapshot = typeof source === "function" ? await load(cursorFor(headlessBufferCache.get(cacheKey))) : source;
      let lines = await commit(snapshot);
      if (lines === undefined) { snapshot = await load(); lines = await commit(snapshot); }
      if (lines === undefined) throw new Error("PTY scrollback delta requires a full snapshot");
      return lines;
    });
  } finally { release(); }
}

export function __headlessBufferCacheSizeForTests(): number { return headlessBufferCache.size; }

export function __headlessBufferStateForTests() {
  return { entries: [...headlessBufferCache.values()].map(entry => ({ sessionId: entry.sessionId, generation: entry.generation,
    epoch: entry.sessionEpoch, endOffset: entry.endOffset, busy: entry.busy })), queued: [...sessionWriteQueues.keys()] };
}

export function __resetHeadlessBufferCacheForTests(): void {
  for (const [cacheKey, entry] of headlessBufferCache) disposeEntry(cacheKey, entry);
  headlessBufferCache.clear();
  sessionWriteQueues.clear();
}
