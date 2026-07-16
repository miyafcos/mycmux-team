export const SETTINGS_STORE_VERSION = 3;

export type TerminalRenderer = "webgl" | "dom";

// Transparent multi-pane WebGL produced darker/opaque pane backgrounds on
// Windows/WebView2 and reproduced identically on macOS/WKWebView (2026-07-16
// M1 verification), so DOM is the safe default on every platform. GPU
// rendering stays available as an explicit opt-in.
export function resolveDefaultTerminalRenderer(): TerminalRenderer {
  return "dom";
}

function isWindowsUserAgent(userAgent: string): boolean {
  return /Windows/i.test(userAgent);
}

export function migratePersistedSettings(
  persistedState: unknown,
  persistedVersion: number,
  userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "",
): unknown {
  if (
    persistedVersion >= SETTINGS_STORE_VERSION
    || persistedState === null
    || typeof persistedState !== "object"
    || Array.isArray(persistedState)
  ) {
    return persistedState;
  }

  const migrated = { ...(persistedState as Record<string, unknown>) };
  const legacyWebglPreference = migrated.useWebglRenderer;
  delete migrated.useWebglRenderer;

  if (persistedVersion < 1) {
    // v0.14.2 renamed the renderer setting without migrating the old boolean.
    // Carry an explicit legacy choice forward before applying platform safety.
    if (migrated.terminalRenderer !== "webgl" && migrated.terminalRenderer !== "dom") {
      migrated.terminalRenderer = legacyWebglPreference === false ? "dom" : "webgl";
    }
  }

  if (migrated.terminalRenderer !== "webgl" && migrated.terminalRenderer !== "dom") {
    migrated.terminalRenderer = resolveDefaultTerminalRenderer();
  }

  // Transparent multi-pane WebGL has repeatedly produced darker text and
  // shared-atlas trouble on Windows/WebView2. Version 1 also persisted WebGL
  // before the old Windows DOM preference could be recovered. Reset that
  // unsafe default once; users can explicitly opt back into GPU rendering.
  if (
    persistedVersion < 2
    && isWindowsUserAgent(userAgent)
    && migrated.terminalRenderer === "webgl"
    && legacyWebglPreference !== true
  ) {
    migrated.terminalRenderer = "dom";
  }

  // Version 3: non-Windows platforms defaulted to WebGL until the same
  // opaque-pane artifact was confirmed on macOS/WKWebView. A persisted
  // "webgl" there is almost certainly that old default, not a choice —
  // reset it once, keeping explicit legacy opt-ins.
  if (
    persistedVersion < 3
    && !isWindowsUserAgent(userAgent)
    && migrated.terminalRenderer === "webgl"
    && legacyWebglPreference !== true
  ) {
    migrated.terminalRenderer = "dom";
  }
  return migrated;
}
