import { openChildWindow, type OpenChildWindowOptions } from "./ipc";

declare global {
  interface Window {
    __mycmuxOpenChildWindow?: (options?: OpenChildWindowOptions) => Promise<string>;
  }
}

/**
 * Dev-only entry point for Phase 3a multi-window testing.
 *
 * Deliberately not a UI affordance: Phase 3b adds the real surface (sidebar
 * context menu 「新しいウィンドウで開く」), and a temporary button would have
 * to be designed, translated and then removed again. Debug builds already open
 * devtools automatically (lib.rs `#[cfg(debug_assertions)]`), so
 * `__mycmuxOpenChildWindow()` in the console is the least invasive hook.
 *
 * No-op in production builds.
 */
export function installChildWindowDevHook(): void {
  if (!import.meta.env.DEV) return;
  if (typeof window === "undefined") return;

  window.__mycmuxOpenChildWindow = async (options: OpenChildWindowOptions = {}) => {
    const label = await openChildWindow(options);
    console.info(`[multiwindow] opened child window ${label}`);
    return label;
  };
  console.info(
    "[multiwindow] dev hook ready — call window.__mycmuxOpenChildWindow() to open a child window",
  );
}
