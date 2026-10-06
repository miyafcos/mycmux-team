import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession, getCurrentSessionEpoch } from "../../src/lib/ipc";
import { PtyOutputChannel, PTY_CHANNEL_GAP_MS } from "../../src/lib/ptyOutputChannel";

const backend = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tauri-apps/api/core")>(),
  invoke: backend.invoke,
}));

let nextId = 0;
let callbacks: Map<number, (message: unknown) => void>;
let transient: PtyOutputChannel;
const frame = (value: number) => new Uint8Array([value]).buffer;
const start = (id: string) => createSession(id, "shell", [], 80, 24, vi.fn(), undefined, undefined,
  false, { backgroundOnly: true, reason: "background" });

beforeEach(() => {
  vi.useFakeTimers();
  callbacks = new Map();
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {
    transformCallback: (fn: (message: unknown) => void) => {
      callbacks.set(++nextId, fn);
      return nextId;
    },
    unregisterCallback: (id: number) => callbacks.delete(id),
  } });
  backend.invoke.mockReset().mockImplementation(async (command, args) => {
    expect(command).toBe("create_session");
    expect(args.backgroundOnly).toBe(true);
    transient = args.onData;
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("background PTY channel lifetime", () => {
  it("drains native frames and end arriving after the create response", async () => {
    await start("background-late-native-end");
    expect(getCurrentSessionEpoch("background-late-native-end")).toBe(0);
    const deliver = callbacks.get(transient.id);
    expect(deliver).toBeDefined();
    deliver!({ index: 0, message: frame(1) });
    deliver!({ index: 1, message: frame(2) });
    deliver!({ index: 2, end: true });
    expect(callbacks.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still bounds cleanup when a headless channel frame is lost", async () => {
    await start("background-lost-native-frame");
    const deliver = callbacks.get(transient.id);
    expect(deliver).toBeDefined();
    deliver!({ index: 0, message: frame(1) });
    deliver!({ index: 2, message: frame(3) });
    deliver!({ index: 3, end: true });
    await vi.advanceTimersByTimeAsync(PTY_CHANNEL_GAP_MS);
    expect(callbacks.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up after an actual background create rejection", async () => {
    backend.invoke.mockImplementationOnce(async (_command, args) => {
      transient = args.onData; throw new Error("headless spawn failed");
    });
    await expect(start("background-rejected-create")).rejects.toThrow("headless spawn failed");
    expect(callbacks.has(transient.id)).toBe(true);
    callbacks.get(transient.id)!({ index: 0, end: true });
    expect(callbacks.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up a timed out create and ignores its late completion", async () => {
    let resolve!: () => void;
    backend.invoke.mockImplementationOnce((_command, args) => {
      transient = args.onData; return new Promise<void>(yes => { resolve = yes; });
    });
    const creating = start("background-timed-out-create");
    const rejected = expect(creating).rejects.toThrow("Terminal IPC timed out");
    await vi.advanceTimersByTimeAsync(8_000);
    await rejected;
    expect(callbacks.has(transient.id)).toBe(true);
    resolve();
    await Promise.resolve();
    callbacks.get(transient.id)!({ index: 0, message: frame(1) });
    callbacks.get(transient.id)!({ index: 1, end: true });
    expect(callbacks.size).toBe(0);
    expect(getCurrentSessionEpoch("background-timed-out-create")).toBe(0);
  });
});
