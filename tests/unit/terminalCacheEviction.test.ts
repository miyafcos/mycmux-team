import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CachedTerm,
  bumpTerminalWriteCounter,
  cacheOrDisposeOnUnmount,
  evictTerminalCache,
  findLastSubarray,
  getTerminalOutputDecoder,
  getTerminalWriteCounter,
  liveTerms,
  MAX_CACHED_TERMINALS,
  planTerminalScrollbackRecovery,
  rememberTerminalRawTail,
  replaceTerminalRawTail,
  sliceBatchAfterScrollbackOffset,
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
  liveTerms.clear();
  terminalWriteCounters.clear();
  terminalRawTailBySession.clear();
});

describe("terminal cache eviction (FE-N1)", () => {
  it("disposes instead of re-caching after an active-tab (cache-miss) evict", () => {
    const sessionId = "sess-active-close";
    const { entry, dispose, unlistenExit } = makeCachedTerm();

    // Active tab close: cache miss because the Terminal is still mounted.
    expect(termCache.has(sessionId)).toBe(false);
    liveTerms.set(sessionId, entry.term);
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
    const live = makeCachedTerm();
    liveTerms.set(sessionId, live.entry.term);
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

    liveTerms.set(sessionId, entry.term);
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

  it("evicts the oldest cached terminal when the cache reaches its cap", () => {
    const entries = Array.from({ length: MAX_CACHED_TERMINALS + 1 }, (_, index) => ({
      sessionId: `sess-${index}`,
      ...makeCachedTerm(),
    }));

    for (const { sessionId, entry } of entries) {
      expect(cacheOrDisposeOnUnmount(sessionId, entry)).toBe("cached");
    }

    expect(termCache.size).toBe(MAX_CACHED_TERMINALS);
    expect(termCache.has(entries[0].sessionId)).toBe(false);
    expect(entries[0].dispose).toHaveBeenCalledTimes(1);
    expect(entries[0].unlistenExit).toHaveBeenCalledTimes(1);
    expect(termCache.get(entries.at(-1)!.sessionId)).toBe(entries.at(-1)!.entry);
  });

  it("does not leave an active-close marker for an already absent terminal", () => {
    const sessionId = "sess-already-absent";
    evictTerminalCache(sessionId);

    const next = makeCachedTerm();
    expect(cacheOrDisposeOnUnmount(sessionId, next.entry)).toBe("cached");
    expect(next.dispose).not.toHaveBeenCalled();
  });
});

describe("terminal scrollback tail search", () => {
  it("returns the last overlapping match", () => {
    expect(findLastSubarray(
      new Uint8Array([1, 2, 1, 2, 1]),
      new Uint8Array([1, 2, 1]),
    )).toBe(2);
  });

  it("handles long repetitive non-matches without quadratic scanning", () => {
    const haystack = new Uint8Array(32 * 1024).fill(65);
    const needle = new Uint8Array(4 * 1024).fill(65);
    needle[needle.length - 1] = 66;
    expect(findLastSubarray(haystack, needle)).toBe(-1);
  });
});

describe("terminal scrollback cursor recovery", () => {
  it("drops bytes already included in the synchronized snapshot", () => {
    const batch = {
      generation: 1,
      seq: 1,
      bytes: 6,
      resync: false,
      scrollbackStart: 10,
      scrollbackEnd: 16,
      data: [1, 2, 3, 4, 5, 6],
    };
    const data = new Uint8Array(batch.data);

    expect([...sliceBatchAfterScrollbackOffset(batch, data, 16)]).toEqual([]);
    expect([...sliceBatchAfterScrollbackOffset(batch, data, 13)]).toEqual([4, 5, 6]);
    expect([...sliceBatchAfterScrollbackOffset(batch, data, 10)]).toEqual(batch.data);
  });

  it("appends from an exact absolute scrollback cursor", () => {
    const plan = planTerminalScrollbackRecovery(
      new Uint8Array([10, 11, 12, 13]),
      100,
      104,
      102,
    );
    expect(plan.action).toBe("append");
    expect([...plan.data]).toEqual([12, 13]);
  });

  it("uses a remembered raw suffix when the absolute cursor is unavailable", () => {
    const plan = planTerminalScrollbackRecovery(
      new Uint8Array([1, 2, 3, 4, 5]),
      50,
      55,
      0,
      new Uint8Array([2, 3]),
    );
    expect(plan.action).toBe("append");
    expect([...plan.data]).toEqual([4, 5]);
  });

  it("never treats a truncated raw VT ring as a complete terminal snapshot", () => {
    const plan = planTerminalScrollbackRecovery(
      new Uint8Array([0x5b, 0x32, 0x4a, 0x41]),
      200,
      204,
      0,
    );
    expect(plan.action).toBe("skip-truncated");
    expect(plan.data.byteLength).toBe(0);
  });

  it("allows a full rebuild only when scrollback starts at process byte zero", () => {
    const scrollback = new Uint8Array([0x1b, 0x5b, 0x32, 0x4a]);
    const plan = planTerminalScrollbackRecovery(scrollback, 0, 4, 99);
    expect(plan.action).toBe("replace");
    expect(plan.data).toEqual(scrollback);
  });

  it("marks a byte-zero initial snapshot for a hidden full replay", () => {
    const scrollback = new Uint8Array([0x1b, 0x5b, 0x32, 0x4a, 0x41]);
    const plan = planTerminalScrollbackRecovery(scrollback, 0, 5, 0);

    expect(plan.action).toBe("initial-replay");
    expect(plan.data).toEqual(scrollback);
  });
});

describe("terminal decoder continuity", () => {
  it("keeps a split UTF-8 code point across cached remounts", () => {
    const sessionId = "sess-decoder-remount";
    const firstMount = getTerminalOutputDecoder(sessionId);
    expect(firstMount.decode(new Uint8Array([0xe3, 0x81]), { stream: true })).toBe("");

    const remount = getTerminalOutputDecoder(sessionId);
    expect(remount).toBe(firstMount);
    expect(remount.decode(new Uint8Array([0x82]), { stream: true })).toBe("あ");

    evictTerminalCache(sessionId);
  });
});
