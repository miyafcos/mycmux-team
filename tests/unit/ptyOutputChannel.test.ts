import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PtyOutputChannel, PTY_CHANNEL_GAP_MS, PTY_CHANNEL_PENDING_LIMIT } from "../../src/lib/ptyOutputChannel";

let nextId = 0;
let callbacks: Map<number, (value: unknown) => void>;
const frame = (n: number) => new Uint8Array([n]).buffer;
beforeEach(() => {
  vi.useFakeTimers(); callbacks = new Map();
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {
    transformCallback: (fn: (value: unknown) => void) => { callbacks.set(++nextId, fn); return nextId; },
    unregisterCallback: (id: number) => callbacks.delete(id),
  } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("bounded PTY Channel ordering", () => {
  it("preserves ordinary out-of-order delivery during the reorder grace", async () => {
    const channel = new PtyOutputChannel(); const seen: number[] = [];
    channel.onmessage = bytes => seen.push(new Uint8Array(bytes)[0]);
    const send = callbacks.get(channel.id)!;
    send({ index: 1, message: frame(1) });
    send({ index: 0, message: frame(0) });
    expect(seen).toEqual([0, 1]); expect(channel.consumeGap()).toBe(false);
    expect(vi.getTimerCount()).toBe(0); channel.dispose();
  });
  it.each(["WebView2", "WebKit"])("does not pin %s after one missing fetch result", async () => {
    const channel = new PtyOutputChannel(); const seen: number[] = []; const gaps: boolean[] = [];
    channel.onmessage = bytes => { seen.push(new Uint8Array(bytes)[0]); gaps.push(channel.consumeGap()); };
    const send = callbacks.get(channel.id)!;
    send({ index: 0, message: frame(0) }); send({ index: 2, message: frame(2) });
    await vi.advanceTimersByTimeAsync(PTY_CHANNEL_GAP_MS);
    send({ index: 3, message: frame(3) }); send({ index: 1, message: frame(1) });
    expect(seen).toEqual([0, 2, 3]); expect(gaps).toEqual([false, true, false]);
    send({ index: 4, end: true }); expect(callbacks.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds pending messages even if the timer is delayed by a long JS task", () => {
    const channel = new PtyOutputChannel(); const seen: number[] = [];
    channel.onmessage = bytes => seen.push(new Uint8Array(bytes)[0]);
    const send = callbacks.get(channel.id)!;
    for (let n = 1; n <= PTY_CHANNEL_PENDING_LIMIT; n++) send({ index: n, message: frame(n) });
    expect(seen).toHaveLength(PTY_CHANNEL_PENDING_LIMIT); channel.dispose();
    expect(vi.getTimerCount()).toBe(0); expect(callbacks.size).toBe(0);
  });
  it("cleans up an end notification even if every preceding frame was lost", async () => {
    const channel = new PtyOutputChannel(); callbacks.get(channel.id)!({ index: 10, end: true });
    await vi.advanceTimersByTimeAsync(PTY_CHANNEL_GAP_MS);
    expect(callbacks.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
});
