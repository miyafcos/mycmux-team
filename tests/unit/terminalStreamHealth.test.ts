import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalHealthMonitor, TerminalStreamHealth, TERMINAL_STREAM_STALE_MS,
  TERMINAL_RECOVERY_COOLDOWN_MS, TERMINAL_RECOVERY_WINDOW_MS } from "../../src/lib/terminalStreamHealth";
afterEach(() => vi.useRealTimers());

describe("visible terminal stream recovery", () => {
  it("detects a lost channel and an ACKing-but-unparsed pump on the same deadline", () => {
    let now = 0; const channel = new TerminalStreamHealth(() => now);
    const pump = new TerminalStreamHealth(() => now);
    channel.inspect(true, 1); pump.inspect(true, 1);
    now = TERMINAL_STREAM_STALE_MS - 1; pump.received();
    expect(channel.inspect(true, now)).toBeNull();
    now += 1;
    expect(channel.inspect(true, now)).toBe("channel-stall");
    expect(pump.inspect(true, now)).toBe("write-stall");
  });
  it("does not reconnect an idle, hidden, or recently returned pane", () => {
    let now = 0; const health = new TerminalStreamHealth(() => now);
    health.inspect(true, null); now = 50_000;
    expect(health.inspect(true, null)).toBeNull(); expect(health.inspect(true, 0)).toBeNull();
    expect(health.inspect(false, now)).toBeNull(); expect(health.inspect(true, now)).toBeNull();
    now += TERMINAL_STREAM_STALE_MS; health.applied();
    expect(health.inspect(true, now)).toBeNull();
  });
  it("admits at most five recoveries per ten minutes and one per thirty seconds", () => {
    let now = 0; const health = new TerminalStreamHealth(() => now); health.inspect(true, 1);
    now = TERMINAL_STREAM_STALE_MS;
    for (let n = 0; n < 5; n++) {
      expect(health.inspect(true, now)).not.toBeNull();
      expect(health.inspect(true, now)).toBeNull(); now += TERMINAL_RECOVERY_COOLDOWN_MS;
    }
    expect(health.inspect(true, now)).toBeNull(); now += TERMINAL_RECOVERY_WINDOW_MS;
    expect(health.inspect(true, now)).not.toBeNull();
  });
  it("shares one snapshot, sends no hidden-pane probes, and serializes reconnects", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const snapshot = vi.fn(async () => ({ one: Date.now(), two: Date.now() }));
    const monitor = new TerminalHealthMonitor(snapshot);
    let visible = false; let finish!: () => void;
    const recover = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const recover2 = vi.fn(async () => {});
    const stop1 = monitor.watch({ sessionId: "one", visible: () => visible, health: new TerminalStreamHealth(), recover });
    const stop2 = monitor.watch({ sessionId: "two", visible: () => visible, health: new TerminalStreamHealth(), recover: recover2 });
    await monitor.poll(); expect(snapshot).not.toHaveBeenCalled();
    visible = true; await monitor.poll();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(snapshot).toHaveBeenCalledTimes(6); expect(recover).toHaveBeenCalledOnce();
    expect(recover2).not.toHaveBeenCalled(); finish(); await Promise.resolve(); await Promise.resolve();
    await vi.advanceTimersByTimeAsync(2_000); expect(recover2).toHaveBeenCalledOnce();
    stop1(); stop2(); expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps bounded recovery available after an attach failure", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const monitor = new TerminalHealthMonitor(async () => ({ one: Date.now() }));
    const recover = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("attach timed out")).mockResolvedValue(undefined);
    const stop = monitor.watch({ sessionId: "one", visible: () => true,
      health: new TerminalStreamHealth(), recover });
    await monitor.poll(); await vi.advanceTimersByTimeAsync(10_000);
    expect(recover).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(TERMINAL_RECOVERY_COOLDOWN_MS);
    expect(recover).toHaveBeenCalledTimes(2); stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("releases the polling slot after an unanswered snapshot", async () => {
    vi.useFakeTimers(); const snapshot = vi.fn<() => Promise<Record<string, number>>>()
      .mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue({});
    const monitor = new TerminalHealthMonitor(snapshot);
    const stop = monitor.watch({ sessionId: "one", visible: () => true, health: new TerminalStreamHealth(), recover: vi.fn(async () => {}) });
    const first = monitor.poll(); await vi.advanceTimersByTimeAsync(4_000); await first;
    await monitor.poll(); expect(snapshot.mock.calls.length).toBeGreaterThanOrEqual(2); stop();
  });
});
