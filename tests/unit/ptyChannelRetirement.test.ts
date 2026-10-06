import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PtyOutputChannel, PTY_CHANNEL_RETIRE_MS } from "../../src/lib/ptyOutputChannel";

let nextId = 0;
let callbacks: Map<number, (message: unknown) => void>;
const frame = (n: number) => new Uint8Array([n]).buffer;
beforeEach(() => {
  vi.useFakeTimers();
  callbacks = new Map();
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {
    transformCallback: (fn: (message: unknown) => void) => { callbacks.set(++nextId, fn); return nextId; },
    unregisterCallback: (id: number) => callbacks.delete(id),
  } });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("retired PTY transport callbacks", () => {
  it("fences pending and late data while allowing queued native end to clean up", () => {
    const channel = new PtyOutputChannel(); const delivered = vi.fn(); channel.onmessage = delivered;
    const send = callbacks.get(channel.id)!;
    send({ index: 1, message: frame(1) });
    channel.retire();
    expect(callbacks.has(channel.id)).toBe(true);
    send({ index: 0, message: frame(0) });
    send({ index: 2, message: frame(2) });
    expect(delivered).not.toHaveBeenCalled();
    send({ index: 3, end: true });
    expect(callbacks.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up native end even when all retired frames were lost", () => {
    const channel = new PtyOutputChannel(); const send = callbacks.get(channel.id)!;
    channel.retire(); send({ index: 20, end: true });
    expect(callbacks.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds abandoned native end and does not extend the bound on repeated retirement", async () => {
    const channel = new PtyOutputChannel(); channel.retire();
    await vi.advanceTimersByTimeAsync(PTY_CHANNEL_RETIRE_MS - 1);
    expect(callbacks.has(channel.id)).toBe(true); channel.retire();
    await vi.advanceTimersByTimeAsync(1);
    expect(callbacks.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it("still permits immediate forced disposal and clears the retirement timer", () => {
    const channel = new PtyOutputChannel(); const send = callbacks.get(channel.id)!;
    const delivered = vi.fn(); channel.onmessage = delivered;
    channel.retire(); channel.dispose(); send({ index: 0, message: frame(0) });
    expect(delivered).not.toHaveBeenCalled();
    expect(callbacks.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it("does not reopen a channel already ended by native", () => {
    const channel = new PtyOutputChannel(); callbacks.get(channel.id)!({ index: 0, end: true });
    channel.retire();
    expect(callbacks.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
});
