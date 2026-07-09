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
}

export const termCache = new Map<string, CachedTerm>();
export const liveTerms = new Map<string, Terminal>();
export const terminalSizeCache = new Map<string, { cols: number; rows: number }>();
export const terminalWriteCounters = new Map<string, number>();
export const terminalDeferredBatches = new Map<string, PendingFrontendBatch[]>();
export const terminalRawTailBySession = new Map<string, Uint8Array>();
export const terminalScrollbackResyncNeeded = new Set<string>();
export const terminalInitialReplayMarkers = new Map<string, IMarker>();

const PASTE_CHUNK = 1024;
const TERMINAL_RAW_TAIL_MAX_BYTES = 32 * 1024;
const INPUT_FAILURE_TOAST_DEBOUNCE_MS = 3000;
const terminalInputQueues = new Map<string, Promise<void>>();
const terminalInputFailureToastAt = new Map<string, number>();
const terminalEvictionCleanups = new Set<(sessionId: string) => void>();

// Sessions whose cache slot was evicted while their Terminal was still mounted
// (i.e. an *active* tab was closed, so cacheCurrentTerminal had not yet run and
// the cache lookup in evictTerminalCache missed). The eventual unmount must
// dispose the Terminal instead of re-caching it, otherwise the Terminal leaks
// in termCache forever with no remaining reference (FE-N1).
const sessionsEvictedWhileMounted = new Set<string>();

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
  const previous = terminalInputQueues.get(sessionId) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => writeToSession(sessionId, data));
  terminalInputQueues.set(sessionId, next);
  next
    .catch((error) => {
      console.error(error);
      const now = Date.now();
      const lastToastAt = terminalInputFailureToastAt.get(sessionId) ?? 0;
      if (now - lastToastAt >= INPUT_FAILURE_TOAST_DEBOUNCE_MS) {
        terminalInputFailureToastAt.set(sessionId, now);
        useToastStore.getState().pushToast("Terminal input failed to send", "error");
      }
    })
    .finally(() => {
      if (terminalInputQueues.get(sessionId) === next) {
        terminalInputQueues.delete(sessionId);
      }
    });
}

export function chunkedWrite(sessionId: string, data: string): void {
  if (data.length <= PASTE_CHUNK) {
    enqueueSessionWrite(sessionId, data);
    return;
  }
  for (let offset = 0; offset < data.length; offset += PASTE_CHUNK) {
    enqueueSessionWrite(sessionId, data.slice(offset, offset + PASTE_CHUNK));
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
  for (let start = haystack.byteLength - needle.byteLength; start >= 0; start -= 1) {
    let matched = true;
    for (let offset = 0; offset < needle.byteLength; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return start;
  }
  return -1;
}

export function evictTerminalCache(sessionId: string): void {
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
  } else {
    // Cache miss: the Terminal is still mounted (the *active* tab is being
    // closed) and has not been cached yet. Mark it so that the eventual unmount
    // disposes the Terminal instead of re-caching it into termCache (FE-N1).
    sessionsEvictedWhileMounted.add(sessionId);
    if (import.meta.env.DEV) {
      console.log(`[mycmux-diag xterm:${sessionId}] cache_evict_mounted`);
    }
  }
  terminalSizeCache.delete(sessionId);
  terminalWriteCounters.delete(sessionId);
  terminalInputQueues.delete(sessionId);
  terminalDeferredBatches.delete(sessionId);
  terminalInputFailureToastAt.delete(sessionId);
  terminalRawTailBySession.delete(sessionId);
  terminalScrollbackResyncNeeded.delete(sessionId);
  terminalInitialReplayMarkers.get(sessionId)?.dispose();
  terminalInitialReplayMarkers.delete(sessionId);
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
  return "cached";
}
