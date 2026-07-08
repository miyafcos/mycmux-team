import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CachedTerm,
  bumpTerminalWriteCounter,
  cacheOrDisposeOnUnmount,
  evictTerminalCache,
  getTerminalWriteCounter,
  rememberTerminalRawTail,
  replaceTerminalRawTail,
  termCache,
  terminalRawTailBySession,
  terminalWriteCounters,
} from "../../src/components/terminal/terminalCache";

// FE-N1: Closing the *active* tab evicts the cache slot while the Terminal is
// still mounted (cache miss), then unmount runs cacheCurrentTerminal which used
// to unconditionally re-cache the Terminal — leaking it in termCache forever.
// These tests exercise the cache-or-dispose decision at the terminalCache API
// level (no XTermWrapper mount) to lock in the dispose-on-close behaviour while
// preserving re-cache on tab switch.

function makeCachedTerm(): { entry: CachedTerm; dispose: ReturnType<typeof vi.fn>; unlistenExit: ReturnType<typeof vi.fn> } {
  const dispose = vi.fn();
  const unlistenExit = vi.fn();
  const entry = {
    term: { dispose } as unknown as CachedTerm["term"],
    fitAddon: {} as unknown as CachedTerm["fitAddon"],
    searchAddon: {} as unknown as CachedTerm["searchAddon"],
    xtermElement: {} as unknown as CachedTerm["xtermElement"],
    unlistenExit,
  } satisfies CachedTerm;
  return { entry, dispose, unlistenExit };
}

afterEach(() => {
  termCache.clear();
  terminalWriteCounters.clear();
  terminalRawTailBySession.clear();
});

describe("terminal cache eviction (FE-N1)", () => {
  it("disposes instead of re-caching after an active-tab (cache-miss) evict", () => {
    const sessionId = "sess-active-close";
    const { entry, dispose, unlistenExit } = makeCachedTerm();

    // Active tab close: cache miss because the Terminal is still mounted.
    expect(termCache.has(sessionId)).toBe(false);
    evictTerminalCache(sessionId);

    // Later unmount tries to cache the still-mounted Terminal.
    const outcome = cacheOrDisposeOnUnmount(sessionId, entry);

    expect(outcome).toBe("disposed");
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(unlistenExit).toHaveBeenCalledTimes(1);
    expect(termCache.has(sessionId)).toBe(false);
  });

  it("re-caches on unmount when no evict happened (tab switch path)", () => {
    const sessionId = "sess-tab-switch";
    const { entry, dispose } = makeCachedTerm();

    const outcome = cacheOrDisposeOnUnmount(sessionId, entry);

    expect(outcome).toBe("cached");
    expect(dispose).not.toHaveBeenCalled();
    expect(termCache.get(sessionId)).toBe(entry);
  });

  it("does not let the evicted mark linger: a later mount re-caches normally", () => {
    const sessionId = "sess-mark-consumed";

    // First lifecycle: active-tab close disposes.
    evictTerminalCache(sessionId);
    const first = makeCachedTerm();
    expect(cacheOrDisposeOnUnmount(sessionId, first.entry)).toBe("disposed");

    // A subsequent unmount for the same id (no fresh evict) must re-cache,
    // proving the mark was consumed and does not persist.
    const second = makeCachedTerm();
    expect(cacheOrDisposeOnUnmount(sessionId, second.entry)).toBe("cached");
    expect(second.dispose).not.toHaveBeenCalled();
    expect(termCache.get(sessionId)).toBe(second.entry);
  });

  it("disposes and clears the mark on a cache-hit evict", () => {
    const sessionId = "sess-cache-hit";
    const { entry, dispose } = makeCachedTerm();

    // Non-active tab was already cached before close.
    termCache.set(sessionId, entry);
    evictTerminalCache(sessionId);

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(termCache.has(sessionId)).toBe(false);

    // No lingering mark: a fresh unmount re-caches.
    const next = makeCachedTerm();
    expect(cacheOrDisposeOnUnmount(sessionId, next.entry)).toBe("cached");
  });

  it("blocks in-flight writes from resurrecting bookkeeping between evict and unmount", () => {
    const sessionId = "sess-inflight";
    const { entry } = makeCachedTerm();

    evictTerminalCache(sessionId);

    // In-flight write pump resumes after the evict wiped the maps but before the
    // component unmounts. These must not re-create per-session entries.
    bumpTerminalWriteCounter(sessionId);
    rememberTerminalRawTail(sessionId, new Uint8Array([1, 2, 3]));
    replaceTerminalRawTail(sessionId, new Uint8Array([4, 5, 6]));

    expect(getTerminalWriteCounter(sessionId)).toBe(0);
    expect(terminalWriteCounters.has(sessionId)).toBe(false);
    expect(terminalRawTailBySession.has(sessionId)).toBe(false);

    // After the unmount disposes and consumes the mark, normal bookkeeping resumes.
    expect(cacheOrDisposeOnUnmount(sessionId, entry)).toBe("disposed");
    bumpTerminalWriteCounter(sessionId);
    expect(getTerminalWriteCounter(sessionId)).toBe(1);
  });
});
