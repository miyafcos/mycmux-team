import { useSyncExternalStore } from "react";

// One display-only clock per webview, shared by visible state consumers.
const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
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
  tick();
  if (listeners.size && document.visibilityState !== "hidden") timer = setInterval(tick, 1_000);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    document.addEventListener("visibilitychange", syncVisibility);
    syncVisibility();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    document.removeEventListener("visibilitychange", syncVisibility);
  };
}

/** Hidden panes unsubscribe; document hiding pauses ticks until visibility returns. */
export function useSessionStateClock(enabled = true): number {
  return useSyncExternalStore(enabled ? subscribe : inactive, snapshot, serverSnapshot);
}
