// Migration baseline: export const SETTINGS_STORE_VERSION = 5;
export const SETTINGS_STORE_VERSION = 6;

export type TerminalRenderer = "auto" | "webgl" | "dom";

export function resolveDefaultTerminalRenderer(): TerminalRenderer {
  return "auto";
}

export function resolveEffectiveTerminalRenderer(
  setting: TerminalRenderer,
  mediaBackgroundActive: boolean,
  terminalOpacity: number,
): "webgl" | "dom" {
  if (setting === "webgl" || setting === "dom") {
    return setting;
  }
  return !mediaBackgroundActive && terminalOpacity >= 1 ? "webgl" : "dom";
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
    if (
      migrated.terminalRenderer !== "auto"
      && migrated.terminalRenderer !== "webgl"
      && migrated.terminalRenderer !== "dom"
    ) {
      migrated.terminalRenderer = legacyWebglPreference === false ? "dom" : "webgl";
    }
  }

  if (
    migrated.terminalRenderer !== "auto"
    && migrated.terminalRenderer !== "webgl"
    && migrated.terminalRenderer !== "dom"
  ) {
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

  // Versions 2 and 3 forced DOM to avoid transparent-background artifacts.
  // Auto keeps DOM for transparent configurations while restoring WebGL for
  // opaque terminal backgrounds.
  if (persistedVersion < 4 && migrated.terminalRenderer === "dom") {
    migrated.terminalRenderer = "auto";
  }
  if (persistedVersion < 5) {
    if (typeof migrated.dispatchWatchdogEnabled !== "boolean") migrated.dispatchWatchdogEnabled = true;
    if (!Number.isFinite(migrated.dispatchWatchdogIntervalMinutes) || Number(migrated.dispatchWatchdogIntervalMinutes) < 1) {
      migrated.dispatchWatchdogIntervalMinutes = 10;
    }
    if (!Number.isFinite(migrated.dispatchStallMinutes) || Number(migrated.dispatchStallMinutes) < 1) {
      migrated.dispatchStallMinutes = 45;
    }
    if (typeof migrated.dispatchWatchdogNotify !== "boolean") migrated.dispatchWatchdogNotify = true;
  }
  if (persistedVersion < 6 && typeof migrated.appearanceAdvancedOpen !== "boolean") {
    migrated.appearanceAdvancedOpen = false;
  }
  return migrated;
}
