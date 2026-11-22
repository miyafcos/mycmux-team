import { afterEach, describe, expect, it, vi } from "vitest";
import { queueTerminalOutputObservation, subscribeTerminalOutputObservations, type ObservedTerminalOutput } from "../../src/stores/terminalObservationStore";
let release: (() => void) | undefined;
afterEach(() => { release?.(); release = undefined; vi.useRealTimers(); });
describe("deferred terminal output observation", () => {
  it("does no data work or scheduling when nobody observes", () => {
    vi.useFakeTimers();
    const data = new Proxy([] as number[], { get() { throw new Error("data touched"); } });
    expect(() => queueTerminalOutputObservation({ sessionId: "s", epoch: 1, startOffset: 0, endOffset: 1, data })).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("defers callbacks and splits large output into bounded byte ranges", () => {
    vi.useFakeTimers(); const seen: ObservedTerminalOutput[] = [];
    release = subscribeTerminalOutputObservations(output => seen.push(output));
    const data = new Uint8Array(100000);
    queueTerminalOutputObservation({ sessionId: "s", epoch: 1, startOffset: 100, endOffset: 100100, data });
    expect(seen).toHaveLength(0);
    vi.runAllTimers();
    expect(seen.reduce((n, item) => n + item.data.length, 0)).toBe(data.length);
    expect(seen.every(item => item.data.length <= 32768 && item.frameEndOffset === 100100)).toBe(true);
    expect(seen[0].startOffset).toBe(100); expect(seen.at(-1)?.endOffset).toBe(100100);
  });
  it("keeps recent queued data bounded and unsubscribes without leaving a timer", () => {
    vi.useFakeTimers(); const seen: ObservedTerminalOutput[] = [];
    release = subscribeTerminalOutputObservations(output => seen.push(output));
    for (let i = 0; i < 100; i++) queueTerminalOutputObservation({ sessionId: "s", epoch: 1,
      startOffset: i * 10000, endOffset: (i + 1) * 10000, data: new Uint8Array(10000) });
    vi.runAllTimers();
    expect(seen.reduce((n, item) => n + item.data.length, 0)).toBeLessThanOrEqual(512 * 1024);
    expect(seen[0].startOffset).toBeGreaterThan(0);
    queueTerminalOutputObservation({ sessionId: "s", epoch: 1, startOffset: 1000000, endOffset: 1000001, data: [1] });
    release(); release = undefined;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("isolates a failing optional observer and handles a baseline without decoding it", () => {
    vi.useFakeTimers(); const seen = vi.fn();
    const stopBroken = subscribeTerminalOutputObservations(() => { throw new Error("visual failed"); });
    release = subscribeTerminalOutputObservations(seen);
    try {
      queueTerminalOutputObservation({ sessionId: "s", epoch: 1, startOffset: 0, endOffset: 100, data: [1], baseline: true });
      expect(() => vi.runAllTimers()).not.toThrow();
      expect(seen).toHaveBeenCalledWith(expect.objectContaining({ startOffset: 100, endOffset: 100, data: new Uint8Array() }));
    } finally { stopBroken(); }
  });
});
