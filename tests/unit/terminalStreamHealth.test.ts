import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalHealthMonitor, TerminalStreamHealth, TERMINAL_STREAM_STALE_MS,
  TERMINAL_RECOVERY_COOLDOWN_MS, TERMINAL_RECOVERY_WINDOW_MS } from "../../src/lib/terminalStreamHealth";
afterEach(() => vi.useRealTimers());

describe("visible terminal stream recovery", () => {
  it("detects a lost channel and an ACKing-but-unparsed pump on the same deadline", () => {
    let now = 0; const channel = new TerminalStreamHealth(() => now);
    const pump = new TerminalStreamHealth(() => now);
    channel.inspect(true, 1); pump.inspect(true, 1);
    pump.received();
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

it("samples visibility only once after awaiting the backend and skips a removed watch", async () => {
  let reply!: (value: Record<string, number>) => void;
  const monitor = new TerminalHealthMonitor(() => new Promise(resolve => { reply = resolve; }));
  const visible = vi.fn(() => true);
  const health = new TerminalStreamHealth();
  const inspectPaint = vi.spyOn(health, "inspectPaint");
  const stop = monitor.watch({ sessionId: "open", visible, health,
    paint: { sized: () => true, repair: vi.fn() }, recover: vi.fn(async () => {}) });
  const removed = vi.fn(() => true);
  const stopRemoved = monitor.watch({ sessionId: "removed", visible: removed,
    health: new TerminalStreamHealth(), recover: vi.fn(async () => {}) });
  try {
    const pending = monitor.poll();
    visible.mockReturnValue(false);
    stopRemoved();
    reply({ open: Date.now(), removed: Date.now() });
    await pending;
    expect(visible).toHaveBeenCalledTimes(2);
    expect(inspectPaint).toHaveBeenCalledWith(false, expect.any(Number));
    expect(removed).toHaveBeenCalledOnce();
  } finally { stop(); stopRemoved(); }
});

it("uses elapsed time for the automatic channel-attempt cooldown across wall-clock changes", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const health = new TerminalStreamHealth();
  health.inspect(true, null);
  await vi.advanceTimersByTimeAsync(10_000);
  const outputAt = Date.now() - 1;
  expect(health.inspect(true, outputAt)).toBe("channel-stall");
  vi.setSystemTime(Date.now() + 60_000);
  expect(health.inspect(true, outputAt)).toBeNull();
  vi.setSystemTime(Date.now() - 50_000);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(health.inspect(true, outputAt)).toBe("channel-stall");
});

it("keeps parse diagnostics when an empty snapshot clears paint evidence", async () => {
  let now = 1_000_000;
  let reply!: (snapshot: Record<string, number | null>) => void;
  const snapshot = vi.fn<() => Promise<Record<string, number | null>>>()
    .mockImplementationOnce(() => new Promise(resolve => { reply = resolve; }));
  const monitor = new TerminalHealthMonitor(snapshot);
  const health = new TerminalStreamHealth(() => now);
  const repair = vi.fn(() => health.rendered());
  const recover = vi.fn(async () => {});
  const stop = monitor.watch({ sessionId: "one", visible: () => true, health,
    paint: { sized: () => true, repair }, recover });
  try {
    const pending = monitor.poll();
    now += 100;
    const outputAt = now;
    health.received();
    const source = { revision: 1, available: true };
    health.observeReceipt(source, 1, 6);
    health.observeParse(source, 1, 6);
    health.applied();
    reply({ one: null });
    await pending;
    snapshot.mockResolvedValue({ one: outputAt });
    for (let ms = 2_000; ms < 12_000; ms += 2_000) {
      now = 1_000_000 + ms;
      await monitor.poll();
    }
    expect(repair).not.toHaveBeenCalled();
    now = 1_012_000;
    await monitor.poll();
    expect(health.diagnosticProgress(source)).toEqual({ generation: 1, received_end: 6, parsed_end: 6 });
    expect(repair).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
  } finally { stop(); }
});

it("recovers a missing frame after a backward clock step and a current parse", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const health = new TerminalStreamHealth();
  health.inspect(true, null);
  vi.setSystemTime(800_000);
  await vi.advanceTimersByTimeAsync(100);
  health.received();
  health.applied();
  const missingOutputAt = Date.now() + 100;
  await vi.advanceTimersByTimeAsync(9_999);
  expect(health.inspect(true, missingOutputAt)).toBeNull();
  await vi.advanceTimersByTimeAsync(1);
  expect(health.inspect(true, missingOutputAt)).toBe("channel-stall");
});

it("starts the unparsed deadline with the first receipt after idle even while more receipts arrive", () => {
  let now = 1_000_000;
  const health = new TerminalStreamHealth(() => now);
  health.inspect(true, null);
  now += 22_500;
  const first = now;
  health.received();
  now += 15;
  expect(health.inspect(true, first)).toBeNull();
  now = first + 9_999;
  health.received();
  expect(health.inspect(true, now)).toBeNull();
  now += 1;
  expect(health.inspect(true, now)).toBe("write-stall");
});

it("does not classify a fresh frame as stalled after a forward clock step", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const health = new TerminalStreamHealth();
  health.inspect(true, null);
  vi.setSystemTime(1_060_000);
  await vi.advanceTimersByTimeAsync(10);
  const outputAt = Date.now();
  health.received();
  expect(health.inspect(true, outputAt)).toBeNull();
  await vi.advanceTimersByTimeAsync(9_999);
  health.received();
  expect(health.inspect(true, outputAt)).toBeNull();
  await vi.advanceTimersByTimeAsync(1);
  expect(health.inspect(true, outputAt)).toBe("write-stall");
});
