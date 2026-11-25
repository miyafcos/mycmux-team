import { invoke } from "@tauri-apps/api/core";
import { terminalHeartbeatCounts } from "../components/terminal/terminalCache";

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


const RENDERER_HEARTBEAT_INTERVAL_MS = 30_000;
type RendererWork = "unknown" | "long-task" | "style-layout" | "render-callbacks"
  | "event-listener" | "user-callback" | "promise" | "script";

interface LongAnimationFrame extends PerformanceEntry {
  renderStart: number;
  styleAndLayoutStart: number;
  scripts?: readonly {
    invokerType: string;
    duration: number;
    forcedStyleAndLayoutDuration: number;
  }[];
}

function dominantFrameWork(frame: LongAnimationFrame): { workKind: RendererWork; workMs: number } {
  const duration = (value: number) => Number.isFinite(value)
    ? Math.max(0, Math.min(value, Number.MAX_SAFE_INTEGER)) : 0;
  const end = frame.startTime + frame.duration;
  const layoutStart = Number.isFinite(frame.styleAndLayoutStart) ? frame.styleAndLayoutStart : 0;
  let layoutMs = layoutStart ? duration(end - layoutStart) : 0;
  let workMs = frame.renderStart ? duration((layoutStart || end) - frame.renderStart) : 0;
  let workKind: RendererWork = workMs > 0 ? "render-callbacks" : "unknown";
  for (const script of frame.scripts ?? []) {
    const forcedLayout = duration(script.forcedStyleAndLayoutDuration);
    layoutMs = duration(layoutMs + forcedLayout);
    const scriptMs = duration(script.duration - forcedLayout);
    if (scriptMs <= workMs) continue;
    workMs = scriptMs;
    switch (script.invokerType) {
      case "event-listener": workKind = "event-listener"; break;
      case "user-callback": workKind = "user-callback"; break;
      case "resolve-promise":
      case "reject-promise": workKind = "promise"; break;
      default: workKind = "script";
    }
  }
  return layoutMs > workMs ? { workKind: "style-layout", workMs: layoutMs } : { workKind, workMs };
}

let rendererHeartbeatCleanup: (() => void) | null = null;

/** Lightweight production diagnostics; the verbose DEV diagnostics stay separate. */
export function initializeRendererHeartbeat(): () => void {
  if (rendererHeartbeatCleanup) return rendererHeartbeatCleanup;
  if (typeof document === "undefined") return noop;

  let longTasks = 0;
  let maxLongTaskMs = 0;
  let longestFrame: { duration: number; workKind: RendererWork; workMs: number } | null = null;
  const clock = () => globalThis.performance?.now?.() ?? Date.now();
  let previousAt = clock();
  let previousVisibility = document.visibilityState;
  let observer: PerformanceObserver | null = null;
  try {
    const Observer = globalThis.PerformanceObserver;
    const entryTypes = typeof Observer === "function"
      ? ["longtask", "long-animation-frame"].filter((type) => Observer.supportedEntryTypes.includes(type))
      : [];
    if (entryTypes.length > 0) {
      observer = new Observer((list) => {
        try {
          for (const entry of list.getEntries()) {
            if (!isFiniteNumber(entry.duration) || entry.duration <= 50) continue;
            if (entry.entryType === "long-animation-frame") {
              if (!longestFrame || entry.duration > longestFrame.duration) {
                longestFrame = { duration: entry.duration, ...dominantFrameWork(entry as LongAnimationFrame) };
              }
              continue;
            }
            longTasks += 1;
            maxLongTaskMs = Math.max(maxLongTaskMs, entry.duration);
          }
        } catch {
          // A diagnostics callback must never interrupt rendering.
        }
      });
      observer.observe({ entryTypes });
    }
  } catch {
    try { observer?.disconnect(); } catch { /* optional diagnostics */ }
    observer = null;
  }

  let previousHeapMib: number | null = null;
  let heartbeatId: ReturnType<typeof globalThis.setInterval>;
  try {
    heartbeatId = globalThis.setInterval(() => {
      try {
        const heap = globalThis.performance ? readHeapSnapshot(globalThis.performance) : null;
        const heapMib = heap ? heap.usedJSHeapSize / BYTES_PER_MIB : null;
        const heapAlert = heapMib !== null && (heapMib >= 600 || (previousHeapMib !== null && previousHeapMib > 0 && heapMib >= previousHeapMib * 2));
        previousHeapMib = heapMib;
        const counts = terminalHeartbeatCounts();
        const now = clock();
        const visibility = document.visibilityState;
        const timerDelayMs = previousVisibility === "visible" && visibility === "visible"
          ? Math.max(0, Math.round(now - previousAt - RENDERER_HEARTBEAT_INTERVAL_MS)) : 0;
        previousAt = now;
        previousVisibility = visibility;
        const work = longestFrame && longestFrame.duration >= maxLongTaskMs
          ? longestFrame
          : { workKind: maxLongTaskMs > 0 ? "long-task" : "unknown", workMs: maxLongTaskMs };
        const heartbeat = {
          heapUsedMib: heapMib,
          longTasks,
          maxLongTaskMs,
          xtermCount: counts.liveCount + counts.cacheCount,
          pendingInvokes: 0,
          visibility,
          focus: document.hasFocus(),
          heapAlert, ...counts,
          progress: {
            timerDelayMs,
            longestFrameMs: Math.round(longestFrame?.duration ?? 0),
            workKind: work.workKind,
            workMs: Math.round(work.workMs),
          },
        };
        longTasks = 0;
        maxLongTaskMs = 0;
        longestFrame = null;
        // Never serialize on the reply: even a hung invoke must not silence us.
        void invoke<void>("report_renderer_heartbeat", { heartbeat }).catch(noop);
      } catch {
        // Older backends can lack the command, and metrics are optional.
      }
    }, RENDERER_HEARTBEAT_INTERVAL_MS);
  } catch {
    try { observer?.disconnect(); } catch { /* optional diagnostics */ }
    return noop;
  }

  let disposed = false;
  rendererHeartbeatCleanup = () => {
    if (disposed) return;
    disposed = true;
    clearHeartbeat(heartbeatId);
    try { observer?.disconnect(); } catch { /* optional diagnostics */ }
    rendererHeartbeatCleanup = null;
  };
  import.meta.hot?.dispose(rendererHeartbeatCleanup);
  return rendererHeartbeatCleanup;
}
