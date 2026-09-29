const LONG_TASK_WARNING_THRESHOLD_MS = 200;
const LONG_TASK_WARNING_THROTTLE_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 60_000;
const BYTES_PER_MIB = 1024 * 1024;

type HeapSnapshot = {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
};

const noop = (): void => {};
let activeCleanup: (() => void) | null = null;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function readHeapSnapshot(performanceApi: Performance): HeapSnapshot | null {
  if (!("memory" in performanceApi)) return null;
  const memory = performanceApi.memory;
  if (typeof memory !== "object" || memory === null) return null;
  if (
    !("usedJSHeapSize" in memory)
    || !("totalJSHeapSize" in memory)
    || !("jsHeapSizeLimit" in memory)
  ) {
    return null;
  }

  const { usedJSHeapSize, totalJSHeapSize, jsHeapSizeLimit } = memory;
  if (
    !isFiniteNumber(usedJSHeapSize)
    || !isFiniteNumber(totalJSHeapSize)
    || !isFiniteNumber(jsHeapSizeLimit)
  ) {
    return null;
  }
  return { usedJSHeapSize, totalJSHeapSize, jsHeapSizeLimit };
}

function formatMib(bytes: number): string {
  return (bytes / BYTES_PER_MIB).toFixed(1);
}

function clearHeartbeat(heartbeatId: ReturnType<typeof globalThis.setInterval> | null): void {
  if (heartbeatId === null) return;
  try {
    globalThis.clearInterval(heartbeatId);
  } catch {
    // Diagnostics cleanup must never affect the application.
  }
}

export function initializePerfDiagnostics(): () => void {
  if (activeCleanup) return activeCleanup;

  let observer: PerformanceObserver | null = null;
  let heartbeatId: ReturnType<typeof globalThis.setInterval> | null = null;
  try {
    const Observer = globalThis.PerformanceObserver;
    const performanceApi = globalThis.performance;
    if (
      typeof Observer !== "function"
      || !Observer.supportedEntryTypes.includes("longtask")
      || !performanceApi
    ) {
      return noop;
    }

    let longTaskCount = 0;
    let longTaskTotalMs = 0;
    let lastWarningAt = Number.NEGATIVE_INFINITY;

    observer = new Observer((list) => {
      try {
        for (const entry of list.getEntries()) {
          longTaskCount += 1;
          longTaskTotalMs += entry.duration;
          if (entry.duration < LONG_TASK_WARNING_THRESHOLD_MS) continue;

          const now = performanceApi.now();
          if (now - lastWarningAt < LONG_TASK_WARNING_THROTTLE_MS) continue;
          console.warn(`[mycmux-perf] longtask ${entry.duration}ms`);
          lastWarningAt = now;
        }
      } catch {
        // Diagnostics must never affect terminal rendering.
      }
    });
    observer.observe({ entryTypes: ["longtask"] });

    heartbeatId = globalThis.setInterval(() => {
      try {
        const heap = readHeapSnapshot(performanceApi);
        const heapSummary = heap
          ? `heap_used_mib=${formatMib(heap.usedJSHeapSize)} heap_total_mib=${formatMib(heap.totalJSHeapSize)} heap_limit_mib=${formatMib(heap.jsHeapSizeLimit)}`
          : "heap=unavailable";
        console.info(
          `[mycmux-perf] heartbeat ${heapSummary} longtasks=${longTaskCount} longtask_ms=${Math.round(longTaskTotalMs)}`,
        );
      } catch {
        // Diagnostics must never affect the application.
      }
    }, HEARTBEAT_INTERVAL_MS);

    let disposed = false;
    activeCleanup = () => {
      if (disposed) return;
      disposed = true;
      try {
        observer?.disconnect();
      } catch {
        // Ignore diagnostics cleanup failures.
      }
      clearHeartbeat(heartbeatId);
      activeCleanup = null;
    };
    import.meta.hot?.dispose(activeCleanup);
    return activeCleanup;
  } catch {
    try {
      observer?.disconnect();
    } catch {
      // Ignore diagnostics cleanup failures.
    }
    clearHeartbeat(heartbeatId);
    return noop;
  }
}
