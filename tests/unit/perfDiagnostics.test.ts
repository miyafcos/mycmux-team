import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const heartbeatInvoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...await original<typeof import("@tauri-apps/api/core")>(),
  invoke: heartbeatInvoke,
}));

beforeEach(() => { heartbeatInvoke.mockReset().mockResolvedValue(undefined); });

class FakePerformanceObserver {
  static supportedEntryTypes = ["longtask"];
  static instances: FakePerformanceObserver[] = [];

  readonly observe = vi.fn();
  readonly disconnect = vi.fn();

  constructor(readonly callback: PerformanceObserverCallback) {
    FakePerformanceObserver.instances.push(this);
  }

  emit(...durations: number[]): void {
    this.emitEntries(durations.map((duration) => ({ duration })) as PerformanceEntry[]);
  }

  emitEntries(entries: PerformanceEntry[]): void {
    this.callback(
      { getEntries: () => entries } as PerformanceObserverEntryList,
      this as unknown as PerformanceObserver,
    );
  }
}

afterEach(() => {
  if (vi.isFakeTimers()) {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
  FakePerformanceObserver.instances = [];
});

describe("performance diagnostics", () => {
  it("does nothing when longtask observation is unavailable", async () => {
    vi.stubGlobal("PerformanceObserver", undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { initializePerfDiagnostics } = await import("../../src/lib/perfDiagnostics");

    expect(() => initializePerfDiagnostics()).not.toThrow();
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("swallows observer setup failures", async () => {
    class ThrowingPerformanceObserver {
      static supportedEntryTypes = ["longtask"];

      constructor(_callback: PerformanceObserverCallback) {}

      observe(): void {
        throw new Error("unsupported");
      }

      disconnect(): void {}
    }
    vi.stubGlobal("PerformanceObserver", ThrowingPerformanceObserver);
    const { initializePerfDiagnostics } = await import("../../src/lib/perfDiagnostics");

    expect(() => initializePerfDiagnostics()).not.toThrow();
  });

  it("throttles warnings and reports cumulative heartbeat metrics", async () => {
    vi.useFakeTimers();
    let now = 0;
    vi.stubGlobal("performance", {
      now: () => now,
      memory: {
        usedJSHeapSize: 10 * 1024 * 1024,
        totalJSHeapSize: 20 * 1024 * 1024,
        jsHeapSizeLimit: 100 * 1024 * 1024,
      },
    });
    vi.stubGlobal("PerformanceObserver", FakePerformanceObserver);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { initializePerfDiagnostics } = await import("../../src/lib/perfDiagnostics");

    const cleanup = initializePerfDiagnostics();
    expect(initializePerfDiagnostics()).toBe(cleanup);
    expect(FakePerformanceObserver.instances).toHaveLength(1);
    const observer = FakePerformanceObserver.instances[0];

    observer.emit(199, 200.6, 250);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenLastCalledWith("[mycmux-perf] longtask 200.6ms");

    now = 4_999;
    observer.emit(300);
    expect(warn).toHaveBeenCalledTimes(1);

    now = 5_000;
    observer.emit(400);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith("[mycmux-perf] longtask 400ms");

    await vi.advanceTimersByTimeAsync(60_000);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][0]).toContain("[mycmux-perf] heartbeat");
    expect(info.mock.calls[0][0]).toContain("heap_used_mib=10.0");
    expect(info.mock.calls[0][0]).toContain("longtasks=5");
    expect(info.mock.calls[0][0]).toContain("longtask_ms=1350");

    cleanup();
    expect(observer.disconnect).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});


describe("production renderer heartbeat", () => {
  it("reports the agreed payload every 30 seconds and resets interval metrics", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("document", { visibilityState: "hidden", hasFocus: () => true });
    vi.stubGlobal("performance", { memory: {
      usedJSHeapSize: 10.5 * 1024 * 1024,
      totalJSHeapSize: 20 * 1024 * 1024,
      jsHeapSizeLimit: 100 * 1024 * 1024,
    } });
    vi.stubGlobal("PerformanceObserver", FakePerformanceObserver);
    const { liveTerms, termCache } = await import("../../src/components/terminal/terminalCache");
    const { initializeRendererHeartbeat } = await import("../../src/lib/perfDiagnostics");
    const shared = {} as import("@xterm/xterm").Terminal;
    liveTerms.set("live", shared);
    termCache.set("live", { term: shared } as import("../../src/components/terminal/terminalCache").CachedTerm);
    termCache.set("cached", { term: {} } as import("../../src/components/terminal/terminalCache").CachedTerm);
    const cleanup = initializeRendererHeartbeat();
    try {
      expect(initializeRendererHeartbeat()).toBe(cleanup);
      expect(FakePerformanceObserver.instances).toHaveLength(1);
      FakePerformanceObserver.instances[0].emit(49, 50, 51, 225.5);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(heartbeatInvoke).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(heartbeatInvoke).toHaveBeenCalledExactlyOnceWith("report_renderer_heartbeat", { heartbeat: {
        heapUsedMib: 10.5, longTasks: 2, maxLongTaskMs: 225.5, xtermCount: 2,
        heapAlert: false, liveCount: 0, cacheCount: 2, pendingTickets: 0, pendingInvokes: 0, visibility: "hidden", focus: true,
        progress: { timerDelayMs: 0, longestFrameMs: 0, workKind: "long-task", workMs: 226 },
      } });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(heartbeatInvoke).toHaveBeenCalledTimes(2);
      expect(heartbeatInvoke.mock.calls[1][1].heartbeat).toMatchObject({ longTasks: 0, maxLongTaskMs: 0 });
    } finally {
      cleanup(); liveTerms.clear(); termCache.clear();
    }
    expect(FakePerformanceObserver.instances[0].disconnect).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(heartbeatInvoke).toHaveBeenCalledTimes(2);
  });

  it.each(["missing", "throws"])("keeps sending if long-task observation is %s and an invoke never settles", async (support) => {
    vi.useFakeTimers();
    vi.stubGlobal("document", { visibilityState: "visible", hasFocus: () => false });
    vi.stubGlobal("performance", {});
    class BrokenObserver extends FakePerformanceObserver {
      readonly observe = vi.fn(() => { throw new Error("unsupported"); });
    }
    vi.stubGlobal("PerformanceObserver", support === "missing" ? undefined : BrokenObserver);
    heartbeatInvoke.mockImplementation(() => new Promise<void>(() => {}));
    const { initializeRendererHeartbeat } = await import("../../src/lib/perfDiagnostics");
    const cleanup = initializeRendererHeartbeat();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(heartbeatInvoke).toHaveBeenCalledTimes(3);
    expect(heartbeatInvoke).toHaveBeenLastCalledWith("report_renderer_heartbeat", { heartbeat: {
      heapUsedMib: null, longTasks: 0, maxLongTaskMs: 0, xtermCount: 0,
      heapAlert: false, liveCount: 0, cacheCount: 0, pendingTickets: 0, pendingInvokes: 0, visibility: "visible", focus: false,
      progress: { timerDelayMs: 0, longestFrameMs: 0, workKind: "unknown", workMs: 0 },
    } });
    cleanup();
  });

  it("reports the missed renderer timer and dominant work during a long frame", async () => {
    vi.useFakeTimers();
    let now = 0;
    vi.stubGlobal("performance", { now: () => now });
    vi.stubGlobal("document", { visibilityState: "visible", hasFocus: () => true });
    class FrameObserver extends FakePerformanceObserver {
      static supportedEntryTypes = ["longtask", "long-animation-frame"];
    }
    vi.stubGlobal("PerformanceObserver", FrameObserver);
    const { initializeRendererHeartbeat } = await import("../../src/lib/perfDiagnostics");
    const stop = initializeRendererHeartbeat();
    try {
      now = 81_000;
      FrameObserver.instances[0].emitEntries([{
        entryType: "long-animation-frame", startTime: 30_100, duration: 50_429,
        renderStart: 31_100, styleAndLayoutStart: 32_100,
        scripts: [{ duration: 1_000, invokerType: "user-callback", forcedStyleAndLayoutDuration: 100 }],
      } as unknown as PerformanceEntry]);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(heartbeatInvoke.mock.calls[0][1].heartbeat.progress).toEqual({
        timerDelayMs: 51_000, longestFrameMs: 50_429, workKind: "style-layout", workMs: 48_529,
      });
      now = 111_000;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(heartbeatInvoke.mock.calls[1][1].heartbeat.progress).toEqual({
        timerDelayMs: 0, longestFrameMs: 0, workKind: "unknown", workMs: 0,
      });
    } finally { stop(); }
  });

  it("silently ignores backend rejections and synchronous IPC errors", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("document", { visibilityState: "visible", hasFocus: () => false });
    vi.stubGlobal("PerformanceObserver", undefined);
    heartbeatInvoke.mockRejectedValueOnce(new Error("unknown command"))
      .mockImplementationOnce(() => { throw new Error("IPC unavailable"); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { initializeRendererHeartbeat } = await import("../../src/lib/perfDiagnostics");
    const cleanup = initializeRendererHeartbeat();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(heartbeatInvoke).toHaveBeenCalledTimes(3);
    expect(warn).not.toHaveBeenCalled();
    cleanup();
  });
});

it("renderer heartbeat compares each 30-second heap sample and forces early high-heap logging", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("document", { visibilityState: "visible", hasFocus: () => false });
  const memory = { usedJSHeapSize: 100 * 1024 * 1024, totalJSHeapSize: 900 * 1024 * 1024, jsHeapSizeLimit: 2000 * 1024 * 1024 };
  vi.stubGlobal("performance", { memory });
  vi.stubGlobal("PerformanceObserver", undefined);
  const { initializeRendererHeartbeat } = await import("../../src/lib/perfDiagnostics");
  const cleanup = initializeRendererHeartbeat();
  try {
    await vi.advanceTimersByTimeAsync(30_000);
    memory.usedJSHeapSize = 200 * 1024 * 1024;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(heartbeatInvoke.mock.calls[1][1].heartbeat.heapAlert).toBe(true);
    memory.usedJSHeapSize = 210 * 1024 * 1024;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(heartbeatInvoke.mock.calls[2][1].heartbeat.heapAlert).toBe(false);
    memory.usedJSHeapSize = 600 * 1024 * 1024;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(heartbeatInvoke.mock.calls[3][1].heartbeat.heapAlert).toBe(true);
  } finally { cleanup(); }
});

it("heartbeat counts each managed live or cached Terminal instance once", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("document", { visibilityState: "visible", hasFocus: () => false });
  vi.stubGlobal("performance", {});
  vi.stubGlobal("PerformanceObserver", undefined);
  const { liveTerms, termCache } = await import("../../src/components/terminal/terminalCache");
  const { initializeRendererHeartbeat } = await import("../../src/lib/perfDiagnostics");
  const a = {} as import("@xterm/xterm").Terminal, b = {} as typeof a;
  liveTerms.set("front", a);
  liveTerms.set("alias", a);
  liveTerms.set("shared", b);
  termCache.set("shared", { term: b } as import("../../src/components/terminal/terminalCache").CachedTerm);
  const stop = initializeRendererHeartbeat();
  try {
    await vi.advanceTimersByTimeAsync(30000);
    const sample = heartbeatInvoke.mock.calls[0][1].heartbeat;
    expect(sample).toMatchObject({ liveCount: 1, cacheCount: 1, xtermCount: 2 });
    expect(sample).not.toHaveProperty("headlessCount");
  } finally { stop(); liveTerms.clear(); termCache.clear(); }
});
