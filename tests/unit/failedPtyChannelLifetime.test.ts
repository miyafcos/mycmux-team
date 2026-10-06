import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession, getCurrentSessionEpoch, getSessionChannelId, killSession } from "../../src/lib/ipc";
import { PtyOutputChannel, PTY_CHANNEL_RETIRE_MS } from "../../src/lib/ptyOutputChannel";

const backend = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tauri-apps/api/core")>(), invoke: backend.invoke,
}));
let nextId = 0;
let callbacks: Map<number, (message: unknown) => void>;
let candidate: PtyOutputChannel;
const start = (id: string, deliver = vi.fn(), stillOwned?: () => boolean) =>
  createSession(id, "shell", [], 80, 24, deliver, undefined, undefined, true, { stillOwned });
const frame = () => {
  const bytes = new Uint8Array(41); bytes.set([0x4d, 0x43, 0x58, 0x31]);
  const view = new DataView(bytes.buffer); view.setBigUint64(8, 1n, true);
  view.setBigUint64(16, 1n, true); view.setBigUint64(32, 1n, true); bytes[40] = 65;
  return bytes.buffer;
};
beforeEach(() => {
  vi.useFakeTimers(); callbacks = new Map();
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {
    transformCallback: (fn: (message: unknown) => void) => { callbacks.set(++nextId, fn); return nextId; },
    unregisterCallback: (id: number) => callbacks.delete(id),
  } });
  backend.invoke.mockReset().mockImplementation(async (command, args) => {
    expect(command).toBe("tearout_attach"); candidate = args.onData;
  });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("failed renderer attach channel lifetime", () => {
  it("retains queued native end after a backend rejection without committing the epoch", async () => {
    backend.invoke.mockImplementationOnce(async (_command, args) => {
      candidate = args.onData; throw new Error("attach rejected");
    });
    await expect(start("failed-native-attach")).rejects.toThrow("attach rejected");
    expect(getCurrentSessionEpoch("failed-native-attach")).toBe(0);
    const send = callbacks.get(candidate.id); expect(send).toBeDefined();
    send!({ index: 0, end: true });
    expect(callbacks.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it("fences native data when ownership changed while the attach reply was delayed", async () => {
    let owned = true; const delivered = vi.fn();
    backend.invoke.mockImplementationOnce(async (_command, args) => { candidate = args.onData; owned = false; });
    await expect(start("failed-ownership-attach", delivered, () => owned)).rejects.toThrow("Session closed before start");
    const send = callbacks.get(candidate.id); expect(send).toBeDefined();
    send!({ index: 0, message: frame() });
    expect(delivered).not.toHaveBeenCalled(); expect(getCurrentSessionEpoch("failed-ownership-attach")).toBe(0);
    send!({ index: 1, end: true });
    expect(callbacks.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a timed out attach's late completion and drains its native end", async () => {
    let resolve!: () => void; const delivered = vi.fn();
    backend.invoke.mockImplementationOnce((_command, args) => { candidate = args.onData; return new Promise<void>(yes => { resolve = yes; }); });
    const creating = start("failed-deadline-attach", delivered);
    const rejected = expect(creating).rejects.toThrow("Terminal IPC timed out");
    await vi.advanceTimersByTimeAsync(8_000); await rejected;
    const send = callbacks.get(candidate.id); expect(send).toBeDefined();
    send!({ index: 0, message: frame() }); resolve(); await Promise.resolve();
    expect(delivered).not.toHaveBeenCalled(); expect(getCurrentSessionEpoch("failed-deadline-attach")).toBe(0);
    send!({ index: 1, end: true });
    expect(callbacks.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it("also bounds callback cleanup when neither the failed reply nor native end arrives", async () => {
    backend.invoke.mockImplementationOnce((_command, args) => { candidate = args.onData; return new Promise<void>(() => {}); });
    const creating = start("failed-no-native-end");
    const rejected = expect(creating).rejects.toThrow("Terminal IPC timed out");
    await vi.advanceTimersByTimeAsync(8_000); await rejected;
    expect(callbacks.has(candidate.id)).toBe(true);
    await vi.advanceTimersByTimeAsync(PTY_CHANNEL_RETIRE_MS);
    expect(callbacks.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
    expect(getCurrentSessionEpoch("failed-no-native-end")).toBe(0);
  });

  it("retires a replaced channel while the next committed attachment renders", async () => {
    const firstDelivered = vi.fn(); const nextDelivered = vi.fn();
    await start("replaced-channel", firstDelivered);
    const first = candidate; const sendFirst = callbacks.get(first.id)!;
    sendFirst({ index: 0, message: frame() }); expect(firstDelivered).toHaveBeenCalledTimes(1);
    await start("replaced-channel", nextDelivered);
    const next = candidate; expect(next.id).not.toBe(first.id); expect(callbacks.has(first.id)).toBe(true);
    sendFirst({ index: 1, message: frame() });
    callbacks.get(next.id)!({ index: 0, message: frame() });
    expect(firstDelivered).toHaveBeenCalledTimes(1); expect(nextDelivered).toHaveBeenCalledTimes(1);
    expect(getCurrentSessionEpoch("replaced-channel")).toBe(2);
    sendFirst({ index: 2, end: true }); callbacks.get(next.id)!({ index: 1, end: true });
    expect(callbacks.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it("fences a killed session before native end arrives behind the kill response", async () => {
    const delivered = vi.fn(); await start("killed-channel", delivered);
    const send = callbacks.get(candidate.id)!;
    send({ index: 0, message: frame() }); expect(delivered).toHaveBeenCalledTimes(1);
    backend.invoke.mockImplementationOnce(async command => { expect(command).toBe("kill_session"); });
    await killSession("killed-channel");
    expect(getSessionChannelId("killed-channel")).toBeUndefined(); expect(callbacks.has(candidate.id)).toBe(true);
    send({ index: 1, message: frame() }); expect(delivered).toHaveBeenCalledTimes(1);
    send({ index: 2, end: true });
    expect(callbacks.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
});
