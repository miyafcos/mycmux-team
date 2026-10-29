import { useSyncExternalStore } from "react";
import { subscribeTearoutDisplay, tearoutDisplayBusy, tearoutDisplayReasons } from "../lib/tearout/operation";
import { useDetachedDockStore } from "../stores/detachedDockStore";

// One render signal per webview. State freshness uses the actual render time.
const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
let stopTearout: (() => void) | undefined;
let stopDock: (() => void) | undefined;
let pauseTimer: ReturnType<typeof setTimeout> | undefined;
let pauseStarted: number | undefined;
let pauseOverrun = false;
const snapshot = () => now;
const serverSnapshot = () => 0;
const inactive = () => () => {};

function tick(): void {
  now = Date.now();
  for (const listener of listeners) listener();
}

function syncVisibility(): void {
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
  const blocked = tearoutDisplayBusy() || useDetachedDockStore.getState().target !== null;
  if (!blocked) {
    if (pauseTimer !== undefined) clearTimeout(pauseTimer);
    pauseTimer = undefined; pauseStarted = undefined; pauseOverrun = false;
  } else if (!pauseOverrun) {
    if (pauseStarted === undefined) {
      pauseStarted = Date.now();
      pauseTimer = setTimeout(() => {
        pauseTimer = undefined;
        if (tearoutDisplayBusy() || useDetachedDockStore.getState().target !== null) {
          pauseOverrun = true;
          console.warn("[tearout] session state clock pause exceeded 10s", { ...tearoutDisplayReasons(),
            highlight: useDetachedDockStore.getState().target !== null, pausedAt: pauseStarted });
        }
        syncVisibility();
      }, 10_000);
    }
    return;
  }
  tick();
  if (listeners.size && document.visibilityState !== "hidden") timer = setInterval(tick, 1_000);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    document.addEventListener("visibilitychange", syncVisibility);
    stopTearout = subscribeTearoutDisplay(syncVisibility);
    stopDock = useDetachedDockStore.subscribe((state, previous) => {
      if (Boolean(state.target) !== Boolean(previous.target)) syncVisibility();
    });
    syncVisibility();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    if (pauseTimer !== undefined) clearTimeout(pauseTimer);
    pauseTimer = undefined; pauseStarted = undefined; pauseOverrun = false;
    document.removeEventListener("visibilitychange", syncVisibility);
    stopTearout?.(); stopDock?.(); stopTearout = undefined; stopDock = undefined;
  };
}

/** Hidden panes unsubscribe; document hiding pauses ticks until visibility returns. */
export function useSessionStateClock(enabled = true): number {
  const atTick = useSyncExternalStore(enabled ? subscribe : inactive, snapshot, serverSnapshot);
  return Math.max(atTick, Date.now());
}
