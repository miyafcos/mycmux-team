import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cancelTerminalResync,
  pendingTerminalResyncSessions,
  requestTerminalResync,
  resetTerminalResyncScheduler,
  TERMINAL_RESYNC_STAGGER_MS,
} from "../../src/components/terminal/terminalResyncScheduler";

beforeEach(() => {
  vi.useFakeTimers();
  resetTerminalResyncScheduler();
});

afterEach(() => {
  resetTerminalResyncScheduler();
  vi.useRealTimers();
});

describe("terminal resync scheduler", () => {
  it("runs the pane the reader is in before the rest", async () => {
    const order: string[] = [];
    // The order they wake in is the order they are mounted, not the order the
    // reader cares about.
    requestTerminalResync("background-1", false, () => { order.push("background-1"); });
    requestTerminalResync("focused", true, () => { order.push("focused"); });
    requestTerminalResync("background-2", false, () => { order.push("background-2"); });

    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["focused"]);

    await vi.advanceTimersByTimeAsync(TERMINAL_RESYNC_STAGGER_MS * 3);
    expect(order).toEqual(["focused", "background-1", "background-2"]);
  });

  it("leaves a gap between panes instead of waking them together", async () => {
    const order: string[] = [];
    requestTerminalResync("a", false, () => { order.push("a"); });
    requestTerminalResync("b", false, () => { order.push("b"); });

    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["a"]);

    await vi.advanceTimersByTimeAsync(TERMINAL_RESYNC_STAGGER_MS - 1);
    expect(order).toEqual(["a"]);

    await vi.advanceTimersByTimeAsync(1);
    expect(order).toEqual(["a", "b"]);
  });

  it("waits for a pane that answers with a promise", async () => {
    const order: string[] = [];
    let release: (() => void) | undefined;
    requestTerminalResync("slow", false, () => {
      order.push("slow:start");
      return new Promise<void>((resolve) => { release = resolve; });
    });
    requestTerminalResync("next", false, () => { order.push("next"); });

    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["slow:start"]);

    await vi.advanceTimersByTimeAsync(TERMINAL_RESYNC_STAGGER_MS * 4);
    expect(order).toEqual(["slow:start"]);

    release?.();
    await vi.advanceTimersByTimeAsync(TERMINAL_RESYNC_STAGGER_MS);
    expect(order).toEqual(["slow:start", "next"]);
  });

  it("keeps one pass per pane, and drops a pane that went away", async () => {
    const runs: string[] = [];
    requestTerminalResync("a", false, () => { runs.push("a:first"); });
    requestTerminalResync("a", false, () => { runs.push("a:second"); });
    requestTerminalResync("gone", false, () => { runs.push("gone"); });
    expect(pendingTerminalResyncSessions()).toEqual(["a", "gone"]);

    cancelTerminalResync("gone");
    await vi.advanceTimersByTimeAsync(TERMINAL_RESYNC_STAGGER_MS * 3);

    expect(runs).toEqual(["a:second"]);
  });

  it("carries on when one pane throws", async () => {
    const runs: string[] = [];
    requestTerminalResync("throws", false, () => { throw new Error("no terminal"); });
    requestTerminalResync("after", false, () => { runs.push("after"); });

    await vi.advanceTimersByTimeAsync(TERMINAL_RESYNC_STAGGER_MS * 3);

    expect(runs).toEqual(["after"]);
  });
});
