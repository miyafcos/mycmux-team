import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/ipc", () => ({
  writeToSession: vi.fn(),
}));

import { writeToSession } from "../../src/lib/ipc";
import {
  type CachedTerm,
  cacheOrDisposeOnUnmount,
  enqueueSessionWrite,
  evictTerminalCache,
  MAX_CACHED_TERMINALS,
  termCache,
} from "../../src/components/terminal/terminalCache";
import { __resetToastStoreForTests, useToastStore } from "../../src/stores/toastStore";

const mockedWriteToSession = vi.mocked(writeToSession);
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

function cachedTerm(): CachedTerm {
  return {
    term: { dispose: vi.fn() } as unknown as CachedTerm["term"],
    fitAddon: {} as unknown as CachedTerm["fitAddon"],
    searchAddon: {} as unknown as CachedTerm["searchAddon"],
    xtermElement: {} as unknown as CachedTerm["xtermElement"],
    unlistenExit: vi.fn(),
  };
}

describe("enqueueSessionWrite failure toast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    mockedWriteToSession.mockReset();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    __resetToastStoreForTests();
  });

  afterEach(() => {
    for (const sessionId of Array.from(termCache.keys())) {
      evictTerminalCache(sessionId);
    }
    consoleErrorSpy.mockRestore();
    __resetToastStoreForTests();
    vi.useRealTimers();
  });

  it("debounces write failure toasts per session for three seconds", async () => {
    mockedWriteToSession.mockRejectedValue(new Error("backend gone"));

    enqueueSessionWrite("session-a", "a");
    await flushPromises();
    enqueueSessionWrite("session-a", "b");
    await flushPromises();

    expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual([
      "Terminal input failed to send",
    ]);

    vi.advanceTimersByTime(3000);
    vi.setSystemTime(1_003_000);

    enqueueSessionWrite("session-a", "c");
    await flushPromises();

    expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual([
      "Terminal input failed to send",
      "Terminal input failed to send",
    ]);
  });

  it("debounces write failure toasts independently per session", async () => {
    mockedWriteToSession.mockRejectedValue(new Error("backend gone"));

    enqueueSessionWrite("session-c", "c");
    enqueueSessionWrite("session-d", "d");
    await flushPromises();

    expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual([
      "Terminal input failed to send",
      "Terminal input failed to send",
    ]);
  });

  it("coalesces input that arrives while one IPC write is in flight", async () => {
    let releaseFirstWrite: (() => void) | undefined;
    mockedWriteToSession
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        releaseFirstWrite = resolve;
      }))
      .mockResolvedValue(undefined);

    enqueueSessionWrite("session-coalesce", "a");
    enqueueSessionWrite("session-coalesce", "b");
    enqueueSessionWrite("session-coalesce", "c");

    expect(mockedWriteToSession.mock.calls).toEqual([["session-coalesce", "a"]]);
    releaseFirstWrite?.();
    await flushPromises();

    expect(mockedWriteToSession.mock.calls).toEqual([
      ["session-coalesce", "a"],
      ["session-coalesce", "bc"],
    ]);
  });

  it("retries bounded backend backpressure without duplicating input", async () => {
    mockedWriteToSession
      .mockRejectedValueOnce(new Error("PTY_INPUT_BACKPRESSURE: full"))
      .mockResolvedValue(undefined);

    enqueueSessionWrite("session-retry", "x");
    await flushPromises();
    expect(mockedWriteToSession).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(8);
    await flushPromises();

    expect(mockedWriteToSession.mock.calls).toEqual([
      ["session-retry", "x"],
      ["session-retry", "x"],
    ]);
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it("retains sustained-backpressure input until the backend accepts it", async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      mockedWriteToSession.mockRejectedValueOnce(new Error("PTY_INPUT_BACKPRESSURE: full"));
    }
    mockedWriteToSession.mockResolvedValue(undefined);

    enqueueSessionWrite("session-full", "x");
    await vi.advanceTimersByTimeAsync(2000);
    await flushPromises();

    expect(mockedWriteToSession).toHaveBeenCalledTimes(9);
    expect(mockedWriteToSession.mock.calls.every((call) => call[1] === "x")).toBe(true);
    expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual([
      "Terminal input is backed up; retrying",
    ]);
  });

  it("preserves input order when the rendered terminal is evicted from the LRU", async () => {
    let releaseFirstWrite: (() => void) | undefined;
    mockedWriteToSession
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        releaseFirstWrite = resolve;
      }))
      .mockResolvedValue(undefined);

    enqueueSessionWrite("session-lru", "a");
    enqueueSessionWrite("session-lru", "b");
    cacheOrDisposeOnUnmount("session-lru", cachedTerm());
    for (let index = 0; index < MAX_CACHED_TERMINALS; index += 1) {
      cacheOrDisposeOnUnmount(`other-${index}`, cachedTerm());
    }
    expect(termCache.has("session-lru")).toBe(false);

    enqueueSessionWrite("session-lru", "c");
    expect(mockedWriteToSession.mock.calls).toEqual([["session-lru", "a"]]);
    releaseFirstWrite?.();
    await flushPromises();

    expect(mockedWriteToSession.mock.calls).toEqual([
      ["session-lru", "a"],
      ["session-lru", "bc"],
    ]);
  });

  it("does not split a surrogate pair at the coalesced IPC batch boundary", async () => {
    let releaseFirstWrite: (() => void) | undefined;
    mockedWriteToSession
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        releaseFirstWrite = resolve;
      }))
      .mockResolvedValue(undefined);

    enqueueSessionWrite("session-unicode", "x");
    enqueueSessionWrite("session-unicode", "a".repeat(4095));
    enqueueSessionWrite("session-unicode", "\u{1F600}b");
    releaseFirstWrite?.();
    await flushPromises();

    expect(mockedWriteToSession.mock.calls.map((call) => call[1])).toEqual([
      "x",
      "a".repeat(4095),
      "\u{1F600}b",
    ]);
  });
});
