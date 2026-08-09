import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Which window this frontend instance is running in.
 *
 * Phase 3a runs the same bundle in every window, so every main-window-only
 * singleton (persistence engine, socket-request handler, quit path, updater,
 * dormancy sweep, startup reveal gate) is gated on `isMainWindow()`. Child
 * windows use the `mycmux-w<n>` labels allocated by
 * `commands::window::open_child_window` — the same set the capability glob
 * (`capabilities/default.json`: `"windows": ["main", "mycmux-w*"]`) grants
 * permissions to.
 */
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
