import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
let media: MediaQueryList | undefined;
let armedFor: number | undefined;

// A resolution query only reports leaving the ratio it was built for, so it is
// rebuilt around every new ratio (monitor move, zoom).
function arm() {
  const ratio = window.devicePixelRatio;
  if (ratio === armedFor) return;
  armedFor = ratio;
  media?.removeEventListener?.("change", check);
  media = typeof window.matchMedia === "function" ? window.matchMedia(`(resolution: ${ratio}dppx)`) : undefined;
  media?.addEventListener?.("change", check);
}

function check() {
  if (window.devicePixelRatio === armedFor) return;
  arm();
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  listeners.add(listener);
  if (listeners.size === 1) {
    arm();
    // Resize is a second trigger in case a query event is missed; any
    // re-render also reads the current ratio.
    window.addEventListener("resize", check);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    window.removeEventListener("resize", check);
    media?.removeEventListener?.("change", check);
    media = undefined;
    armedFor = undefined;
  };
}

function read(): number {
  return typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
}

/** The window's device pixel ratio, kept current when the window changes monitor or zoom. */
export function useDevicePixelRatio(): number {
  return useSyncExternalStore(subscribe, read, () => 1);
}
