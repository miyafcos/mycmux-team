import { afterEach, describe, expect, it, vi } from "vitest";

class FakePerformanceObserver {
  static supportedEntryTypes = ["longtask"];
  static instances: FakePerformanceObserver[] = [];

  readonly observe = vi.fn();
  readonly disconnect = vi.fn();

  constructor(readonly callback: PerformanceObserverCallback) {
    FakePerformanceObserver.instances.push(this);
  }

  emit(...durations: number[]): void {
    const entries = durations.map((duration) => ({ duration })) as PerformanceEntry[];
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
