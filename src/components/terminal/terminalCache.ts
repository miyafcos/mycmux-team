import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon } from "@xterm/addon-search";
import type { IMarker, Terminal } from "@xterm/xterm";
import { writeToSession, type FrontendDataBatch } from "../../lib/ipc";
import { useToastStore } from "../../stores/toastStore";
import {
  TERMINAL_BATCH_RETAINED_MAX_BYTES,
  trimOldestBatchesToByteCap,
} from "../../lib/terminalBatchQueue";

export interface PendingFrontendBatch {
  batch: FrontendDataBatch;
  acked: boolean;
}

export interface CachedTerm {
  term: Terminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  xtermElement: HTMLElement;
  unlistenExit: (() => void) | null;
  scrollbackEnd?: number;
}

export const termCache = new Map<string, CachedTerm>();
export const liveTerms = new Map<string, Terminal>();
export const terminalSizeCache = new Map<string, { cols: number; rows: number }>();
export const terminalWriteCounters = new Map<string, number>();
export const terminalDeferredBatches = new Map<string, PendingFrontendBatch[]>();
export const terminalRawTailBySession = new Map<string, Uint8Array>();
export const terminalScrollbackResyncNeeded = new Set<string>();
export const terminalInitialReplayMarkers = new Map<string, IMarker>();
export const MAX_CACHED_TERMINALS = 12;
const terminalOutputDecoders = new Map<string, TextDecoder>();

const PASTE_CHUNK = 1024;
const INPUT_IPC_BATCH_CHARS = 4 * 1024;
const INPUT_BACKPRESSURE_RETRY_DELAYS_MS = [8, 16, 32, 64, 128, 256, 512] as const;
const INPUT_BACKPRESSURE_RETRY_PAUSE_MS = 512;
const TERMINAL_RAW_TAIL_MAX_BYTES = 32 * 1024;
const INPUT_FAILURE_TOAST_DEBOUNCE_MS = 3000;
interface TerminalInputQueue {
  pending: string[];
  draining: boolean;
  cancelled: boolean;
}
const terminalInputQueues = new Map<string, TerminalInputQueue>();
const terminalInputFailureToastAt = new Map<string, number>();
const terminalEvictionCleanups = new Set<(sessionId: string) => void>();

// Sessions whose cache slot was evicted while their Terminal was still mounted
// (i.e. an *active* tab was closed, so cacheCurrentTerminal had not yet run and
// the cache lookup in evictTerminalCache missed). The eventual unmount must
// dispose the Terminal instead of re-caching it, otherwise the Terminal leaks
// in termCache forever with no remaining reference (FE-N1).
const sessionsEvictedWhileMounted = new Set<string>();

export function getTerminalOutputDecoder(sessionId: string): TextDecoder {
  const existing = terminalOutputDecoders.get(sessionId);
  if (existing) return existing;
  const decoder = new TextDecoder();
  terminalOutputDecoders.set(sessionId, decoder);
  return decoder;
}

export function resetTerminalOutputDecoder(sessionId: string): TextDecoder {
  const decoder = new TextDecoder();
  terminalOutputDecoders.set(sessionId, decoder);
  return decoder;
}

// True only for the window between an active-tab evict and its unmount. Used by
// the write-side helpers to avoid re-creating per-session bookkeeping entries
// (write counters / raw tails) that evictTerminalCache just deleted, in case an
// in-flight write pump resumes before the component unmounts.
function isSessionEvictedWhileMounted(sessionId: string): boolean {
  return sessionsEvictedWhileMounted.has(sessionId);
}

export function registerTerminalCacheEvictionCleanup(callback: (sessionId: string) => void): () => void {
  terminalEvictionCleanups.add(callback);
  return () => terminalEvictionCleanups.delete(callback);
}

export function enqueueSessionWrite(sessionId: string, data: string): void {
  if (!data) return;
  const queue = terminalInputQueues.get(sessionId) ?? {
    pending: [],
    draining: false,
    cancelled: false,
  };
  queue.pending.push(data);
  terminalInputQueues.set(sessionId, queue);
  if (!queue.draining) {
    queue.draining = true;
    void drainTerminalInputQueue(sessionId, queue);
  }
}

function isInputBackpressure(error: unknown): boolean {
  return String(error).includes("PTY_INPUT_BACKPRESSURE");
}

function waitForInputRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function writeTerminalInputWithRetry(sessionId: string, data: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await writeToSession(sessionId, data);
      return;
    } catch (error) {
      if (!isInputBackpressure(error) || attempt >= INPUT_BACKPRESSURE_RETRY_DELAYS_MS.length) {
        throw error;
      }
      await waitForInputRetry(INPUT_BACKPRESSURE_RETRY_DELAYS_MS[attempt]);
    }
  }
}

function takeTerminalInputBatch(queue: TerminalInputQueue): string {
  let batch = "";
  while (queue.pending.length > 0 && batch.length < INPUT_IPC_BATCH_CHARS) {
    const next = queue.pending[0];
    const available = INPUT_IPC_BATCH_CHARS - batch.length;
    if (next.length <= available) {
      batch += next;
      queue.pending.shift();
      continue;
    }
    if (
      available === 1
      && batch.length > 0
      && next.length > 1
      && next.charCodeAt(0) >= 0xd800
      && next.charCodeAt(0) <= 0xdbff
      && next.charCodeAt(1) >= 0xdc00
      && next.charCodeAt(1) <= 0xdfff
    ) {
      break;
    }
    const end = computeSafeChunkEnd(next, 0, available);
    batch += next.slice(0, end);
    queue.pending[0] = next.slice(end);
  }
  return batch;
}

async function drainTerminalInputQueue(
  sessionId: string,
  queue: TerminalInputQueue,
): Promise<void> {
  try {
    while (!queue.cancelled && queue.pending.length > 0) {
      const batch = takeTerminalInputBatch(queue);
      try {
        await writeTerminalInputWithRetry(sessionId, batch);
      } catch (error) {
        const backedUp = isInputBackpressure(error);
        // The backend rejects backpressured writes before enqueueing them.
        // Put the exact batch back at the front so typed/pasted input remains
        // ordered and is never lost merely because ConPTY stayed busy longer
        // than one bounded retry window.
        if (backedUp && !queue.cancelled) {
          queue.pending.unshift(batch);
        }
        console.error(error);
        const now = Date.now();
        const lastToastAt = terminalInputFailureToastAt.get(sessionId) ?? 0;
        if (now - lastToastAt >= INPUT_FAILURE_TOAST_DEBOUNCE_MS) {
          terminalInputFailureToastAt.set(sessionId, now);
          const message = backedUp
            ? "Terminal input is backed up; retrying"
            : "Terminal input failed to send";
          useToastStore.getState().pushToast(message, "error");
        }
        if (backedUp && !queue.cancelled) {
          await waitForInputRetry(INPUT_BACKPRESSURE_RETRY_PAUSE_MS);
        }
      }
    }
  } finally {
    queue.draining = false;
    if (queue.pending.length === 0 && terminalInputQueues.get(sessionId) === queue) {
      terminalInputQueues.delete(sessionId);
    } else if (
      !queue.cancelled
      && queue.pending.length > 0
      && terminalInputQueues.get(sessionId) === queue
      && !queue.draining
    ) {
      queue.draining = true;
      void drainTerminalInputQueue(sessionId, queue);
    }
  }
}

// Given a proposed chunk-end offset (exclusive), pull it back by one UTF-16
// code unit if it would split a surrogate pair (high surrogate at end-1 with
// its low surrogate immediately after at end). This keeps astral-plane
// characters (emoji, some CJK extension characters) intact across chunks
// instead of letting Rust's String (which cannot hold an unpaired surrogate)
// corrupt them at the IPC boundary. `start` bounds how far back we can pull
// so a chunk never becomes empty (degenerate case: two low surrogates in a
// row would otherwise never find a safe boundary going backwards).
export function computeSafeChunkEnd(data: string, start: number, end: number): number {
  if (end >= data.length || end <= start) return end;
  const before = data.charCodeAt(end - 1);
  const after = data.charCodeAt(end);
  const isHighSurrogate = before >= 0xd800 && before <= 0xdbff;
  const isLowSurrogate = after >= 0xdc00 && after <= 0xdfff;
  if (isHighSurrogate && isLowSurrogate && end - 1 > start) {
    return end - 1;
  }
  return end;
}

export function chunkedWrite(sessionId: string, data: string): void {
  if (data.length <= PASTE_CHUNK) {
    enqueueSessionWrite(sessionId, data);
    return;
  }
  let offset = 0;
  while (offset < data.length) {
    const end = computeSafeChunkEnd(data, offset, Math.min(offset + PASTE_CHUNK, data.length));
    enqueueSessionWrite(sessionId, data.slice(offset, end));
    offset = end;
  }
}

export function takeDeferredTerminalBatches(sessionId: string): PendingFrontendBatch[] {
  const batches = terminalDeferredBatches.get(sessionId);
  terminalDeferredBatches.delete(sessionId);
  return batches ?? [];
}

export function stashDeferredTerminalBatches(
  sessionId: string,
  batches: PendingFrontendBatch[],
  ackDropped?: (pending: PendingFrontendBatch) => void,
): void {
  if (batches.length === 0) return;
  const next = [...(terminalDeferredBatches.get(sessionId) ?? []), ...batches];
  const trimmed = trimOldestBatchesToByteCap(next, TERMINAL_BATCH_RETAINED_MAX_BYTES);
  if (trimmed.needsScrollbackResync) {
    terminalScrollbackResyncNeeded.add(sessionId);
    for (const pending of trimmed.dropped) {
      ackDropped?.(pending);
    }
  }
  if (trimmed.retained.length > 0) {
    terminalDeferredBatches.set(sessionId, trimmed.retained);
  } else {
    terminalDeferredBatches.delete(sessionId);
  }
}

export function rememberTerminalRawTail(sessionId: string, chunk: Uint8Array): void {
  if (chunk.byteLength === 0) return;
  // Do not resurrect the raw tail for a session that was evicted while mounted;
  // its Terminal is about to be disposed and this entry would leak (FE-N1).
  if (isSessionEvictedWhileMounted(sessionId)) return;
  const previous = terminalRawTailBySession.get(sessionId);
  const totalLength = (previous?.byteLength ?? 0) + chunk.byteLength;
  const combined = new Uint8Array(Math.min(totalLength, TERMINAL_RAW_TAIL_MAX_BYTES));
  let writeOffset = combined.length;
  const chunkStart = Math.max(0, chunk.byteLength - writeOffset);
  const chunkSlice = chunk.slice(chunkStart);
  writeOffset -= chunkSlice.byteLength;
  combined.set(chunkSlice, writeOffset);
  if (previous && writeOffset > 0) {
    const previousStart = Math.max(0, previous.byteLength - writeOffset);
    combined.set(previous.slice(previousStart), 0);
  }
  terminalRawTailBySession.set(sessionId, combined);
}

export function replaceTerminalRawTail(sessionId: string, scrollback: Uint8Array): void {
  if (isSessionEvictedWhileMounted(sessionId)) return;
  const start = Math.max(0, scrollback.byteLength - TERMINAL_RAW_TAIL_MAX_BYTES);
  terminalRawTailBySession.set(sessionId, scrollback.slice(start));
}

export function findLastSubarray(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.byteLength === 0) return haystack.byteLength;
  if (needle.byteLength > haystack.byteLength) return -1;

  // Knuth-Morris-Pratt keeps recovery linear even when terminal output and the
  // remembered tail contain long repeated runs (for example progress bars).
  const prefix = new Uint32Array(needle.byteLength);
  for (let index = 1, matched = 0; index < needle.byteLength; index += 1) {
    while (matched > 0 && needle[index] !== needle[matched]) {
      matched = prefix[matched - 1];
    }
    if (needle[index] === needle[matched]) {
      matched += 1;
    }
    prefix[index] = matched;
  }

  let lastMatch = -1;
  for (let index = 0, matched = 0; index < haystack.byteLength; index += 1) {
    while (matched > 0 && haystack[index] !== needle[matched]) {
      matched = prefix[matched - 1];
    }
    if (haystack[index] === needle[matched]) {
      matched += 1;
    }
    if (matched === needle.byteLength) {
      lastMatch = index - needle.byteLength + 1;
      matched = prefix[matched - 1];
    }
  }
  return lastMatch;
}

export type TerminalScrollbackRecoveryPlan =
  | { action: "append"; data: Uint8Array }
  | { action: "initial-replay"; data: Uint8Array }
  | { action: "replace"; data: Uint8Array }
  | { action: "skip-truncated"; data: Uint8Array };

/**
 * Raw PTY scrollback is a byte ring, not a VT terminal-state snapshot. A ring
 * whose startOffset is greater than zero can begin inside UTF-8 or a control
 * sequence, so it must never be replayed into a reset terminal. Prefer the
 * exact absolute cursor, then a remembered suffix, and only rebuild when the
 * snapshot still starts at process byte zero.
 */
export function planTerminalScrollbackRecovery(
  scrollback: Uint8Array,
  startOffset: number,
  endOffset: number,
  synchronizedEnd: number,
  knownTail?: Uint8Array,
): TerminalScrollbackRecoveryPlan {
  const cursorIsInsideSnapshot = synchronizedEnd >= startOffset
    && synchronizedEnd <= endOffset
    && synchronizedEnd > 0;
  if (cursorIsInsideSnapshot) {
    const relativeOffset = Math.max(
      0,
      Math.min(scrollback.byteLength, Math.trunc(synchronizedEnd - startOffset)),
    );
    return { action: "append", data: scrollback.slice(relativeOffset) };
  }

  if (knownTail && knownTail.byteLength > 0) {
    const tailStart = findLastSubarray(scrollback, knownTail);
    if (tailStart >= 0) {
      return {
        action: "append",
        data: scrollback.slice(tailStart + knownTail.byteLength),
      };
    }
  }

  if (startOffset === 0) {
    return {
      action: synchronizedEnd === 0 ? "initial-replay" : "replace",
      data: scrollback,
    };
  }
  return { action: "skip-truncated", data: new Uint8Array() };
}

export function sliceBatchAfterScrollbackOffset(
  batch: FrontendDataBatch,
  data: Uint8Array,
  synchronizedEnd: number,
): Uint8Array {
  const skipped = Math.max(
    0,
    Math.min(data.byteLength, Math.trunc(synchronizedEnd - batch.scrollbackStart)),
  );
  return skipped === 0 ? data : data.slice(skipped);
}

export interface TerminalCacheEvictionOptions {
  preserveInputQueue?: boolean;
}

export function evictTerminalCache(
  sessionId: string,
  options: TerminalCacheEvictionOptions = {},
): void {
  const cached = termCache.get(sessionId);
  if (cached) {
    cached.unlistenExit?.();
    cached.term.dispose();
    termCache.delete(sessionId);
    // Cache hit: the Terminal was already disposed here, so there is nothing for
    // a later unmount to leak. Clear any stale mark defensively.
    sessionsEvictedWhileMounted.delete(sessionId);
    if (import.meta.env.DEV) {
      console.log(`[mycmux-diag xterm:${sessionId}] cache_evict`);
    }
  } else if (liveTerms.has(sessionId)) {
    // Cache miss: the Terminal is still mounted (the *active* tab is being
    // closed) and has not been cached yet. Mark it so that the eventual unmount
    // disposes the Terminal instead of re-caching it into termCache (FE-N1).
    sessionsEvictedWhileMounted.add(sessionId);
    if (import.meta.env.DEV) {
      console.log(`[mycmux-diag xterm:${sessionId}] cache_evict_mounted`);
    }
  } else if (import.meta.env.DEV) {
    console.log(`[mycmux-diag xterm:${sessionId}] cache_evict_absent`);
  }
  terminalSizeCache.delete(sessionId);
  terminalWriteCounters.delete(sessionId);
  if (!options.preserveInputQueue) {
    const inputQueue = terminalInputQueues.get(sessionId);
    if (inputQueue) {
      inputQueue.cancelled = true;
      inputQueue.pending.length = 0;
    }
    terminalInputQueues.delete(sessionId);
  }
  terminalDeferredBatches.delete(sessionId);
  terminalInputFailureToastAt.delete(sessionId);
  terminalRawTailBySession.delete(sessionId);
  terminalScrollbackResyncNeeded.delete(sessionId);
  terminalInitialReplayMarkers.get(sessionId)?.dispose();
  terminalInitialReplayMarkers.delete(sessionId);
  terminalOutputDecoders.delete(sessionId);
  for (const cleanup of terminalEvictionCleanups) {
    cleanup(sessionId);
  }
}

export function getTerminalWriteCounter(sessionId: string): number {
  return terminalWriteCounters.get(sessionId) ?? 0;
}

export function bumpTerminalWriteCounter(sessionId: string): void {
  // Don't resurrect a counter for a session that was evicted while mounted; its
  // Terminal is about to be disposed and this entry would leak (FE-N1).
  if (isSessionEvictedWhileMounted(sessionId)) return;
  terminalWriteCounters.set(sessionId, (terminalWriteCounters.get(sessionId) ?? 0) + 1);
}

/**
 * Decide, on Terminal unmount, whether to re-cache the Terminal (normal path,
 * e.g. tab switch or pane hidden) or dispose it (active-tab close, where
 * evictTerminalCache already ran and missed the cache). Returns which action
 * was taken. Consumes the "evicted while mounted" mark so it never lingers.
 *
 * This is the single source of truth for the cache-or-dispose decision so it can
 * be unit-tested without mounting XTermWrapper (FE-N1 regression coverage).
 */
export function cacheOrDisposeOnUnmount(
  sessionId: string,
  entry: CachedTerm,
): "cached" | "disposed" {
  if (sessionsEvictedWhileMounted.delete(sessionId)) {
    entry.unlistenExit?.();
    entry.term.dispose();
    if (import.meta.env.DEV) {
      console.log(`[mycmux-diag xterm:${sessionId}] unmount_dispose_evicted`);
    }
    return "disposed";
  }
  termCache.set(sessionId, entry);
  while (termCache.size > MAX_CACHED_TERMINALS) {
    const oldestSessionId = termCache.keys().next().value as string | undefined;
    if (!oldestSessionId) break;
    // The PTY stays alive when only its rendered Terminal leaves the LRU.
    // Preserve an in-flight paste/key queue so a later remount cannot overtake it.
    evictTerminalCache(oldestSessionId, { preserveInputQueue: true });
  }
  return "cached";
}
