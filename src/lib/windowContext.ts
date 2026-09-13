import { useSyncExternalStore } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Stable window identity is separate from transferable singleton ownership. */
export const MAIN_WINDOW_LABEL = "main";

/** Prefix of every non-main window label. Keep in sync with the Rust side. */
export const CHILD_WINDOW_LABEL_PREFIX = "mycmux-w";

let cachedLabel: string | null = null;

/**
 * The current window's label, resolved once. Outside a Tauri webview (unit
 * tests, plain browser) we fall back to `main` so nothing silently disables
 * itself in non-Tauri contexts.
 */
export function windowLabel(): string {
  if (cachedLabel === null) {
    try {
      cachedLabel = getCurrentWindow().label;
    } catch {
      cachedLabel = MAIN_WINDOW_LABEL;
    }
  }
  return cachedLabel;
}

export function isMainWindow(): boolean {
  return windowLabel() === MAIN_WINDOW_LABEL;
}

export function isChildWindow(): boolean {
  return !isMainWindow();
}

/** Test-only: drop the memoized label. */
export function resetWindowContextCacheForTests(): void {
  cachedLabel = null;
}

let leader = false;
const roleListeners = new Set<() => void>();
export function hasWindowRole(): boolean { return leader; }
export function setWindowRole(value: boolean): void {
  if (leader === value) return;
  leader = value;
  roleListeners.forEach((listener) => listener());
}
export function subscribeWindowRole(listener: () => void): () => void {
  roleListeners.add(listener);
  return () => { roleListeners.delete(listener); };
}
export function useWindowRole(): boolean {
  return useSyncExternalStore(subscribeWindowRole, hasWindowRole, () => false);
}
