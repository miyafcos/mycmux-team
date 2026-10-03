import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalAckCoalescer } from "../../src/lib/terminalAckCoalescer";

afterEach(() => {
  vi.useRealTimers();
});

describe("TerminalAckCoalescer", () => {
  it("coalesces cumulative ACKs to the highest sequence", async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValue(undefined);
    const queue = new TerminalAckCoalescer(send);

    for (let seq = 1; seq <= 100; seq += 1) {
      queue.enqueue({ generation: 4, seq, bytes: 4096 });
    }
    await vi.advanceTimersByTimeAsync(32);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith({ generation: 4, seq: 100, bytes: 4096 });
    queue.flushAndDispose();
  });

  it("retries the latest ACK after a transient IPC failure", async () => {
    vi.useFakeTimers();
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("busy"))
      .mockResolvedValue(undefined);
    const queue = new TerminalAckCoalescer(send);

    queue.enqueue({ generation: 2, seq: 9, bytes: 12 });
    await vi.advanceTimersByTimeAsync(32);
    await vi.advanceTimersByTimeAsync(50);

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith({ generation: 2, seq: 9, bytes: 12 });
    queue.flushAndDispose();
  });

  it("never lets an older generation replace the current ACK", async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValue(undefined);
    const queue = new TerminalAckCoalescer(send);

    queue.enqueue({ generation: 7, seq: 3, bytes: 30 });
    queue.enqueue({ generation: 6, seq: 99, bytes: 99 });
    await vi.advanceTimersByTimeAsync(32);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ generation: 7, seq: 3, bytes: 30 });
    queue.flushAndDispose();
  });

  it("sends a new generation even when the replaced invoke never settles", async () => {
    vi.useFakeTimers();
    const send = vi.fn((ack: { generation: number }) => (
      ack.generation === 1 ? new Promise<void>(() => {}) : Promise.resolve()
    ));
    const queue = new TerminalAckCoalescer(send);

    queue.enqueue({ generation: 1, seq: 1, bytes: 4 });
    await vi.advanceTimersByTimeAsync(0);
    queue.enqueue({ generation: 2, seq: 1, bytes: 4 });
    await vi.advanceTimersByTimeAsync(0);

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith({ generation: 2, seq: 1, bytes: 4 });
    queue.flushAndDispose();
  });

  it("rejects an older generation after the current ACK succeeds", async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValue(undefined);
    const queue = new TerminalAckCoalescer(send);

    queue.enqueue({ generation: 7, seq: 3, bytes: 30 });
    await vi.advanceTimersByTimeAsync(0);
    queue.enqueue({ generation: 6, seq: 99, bytes: 99 });
    await vi.advanceTimersByTimeAsync(100);

    expect(send).toHaveBeenCalledTimes(1);
    queue.flushAndDispose();
  });

  it("flushes the latest cumulative ACK when disposed before the timer fires", () => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValue(undefined);
    const queue = new TerminalAckCoalescer(send);

    queue.enqueue({ generation: 3, seq: 4, bytes: 40 });
    queue.enqueue({ generation: 3, seq: 5, bytes: 50 });
    queue.flushAndDispose();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ generation: 3, seq: 5, bytes: 50 });
  });

  it("releases timed-out attempts so a new ACK in the same generation can be sent", async () => {
    vi.useFakeTimers();
    const send = vi.fn()
      .mockImplementationOnce(() => new Promise<void>(() => {}))
      .mockImplementationOnce(() => new Promise<void>(() => {}))
      .mockResolvedValue(undefined);
    const queue = new TerminalAckCoalescer(send);
    queue.enqueue({ generation: 5, seq: 1, bytes: 4 });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000 + 50);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    queue.enqueue({ generation: 5, seq: 2, bytes: 8 });
    await vi.advanceTimersByTimeAsync(100);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenLastCalledWith({ generation: 5, seq: 2, bytes: 8 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).toHaveBeenCalledTimes(3);
    queue.flushAndDispose();
  });

  it("a late invoke completion does not release another live attempt", async () => {
    vi.useFakeTimers();
    let resolveOld!: () => void;
    let resolveCurrent!: () => void;
    const send = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { resolveOld = resolve; }))
      .mockImplementationOnce(() => new Promise<void>((resolve) => { resolveCurrent = resolve; }))
      .mockResolvedValue(undefined);
    const queue = new TerminalAckCoalescer(send);
    queue.enqueue({ generation: 5, seq: 1, bytes: 4 });
    await vi.advanceTimersByTimeAsync(1050);
    queue.enqueue({ generation: 5, seq: 2, bytes: 8 });
    resolveOld();
    await vi.advanceTimersByTimeAsync(32);
    expect(send).toHaveBeenCalledTimes(2);
    resolveCurrent();
    await vi.advanceTimersByTimeAsync(32);
    expect(send).toHaveBeenLastCalledWith({ generation: 5, seq: 2, bytes: 8 });
    queue.flushAndDispose();
  });
});
