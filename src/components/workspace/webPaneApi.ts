import { invoke } from "@tauri-apps/api/core";

export interface WebPanePreset {
  id: string;
  label: string;
  url: string;
  profileDir: string;
}

export interface WebPaneBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

let presetsPromise: Promise<WebPanePreset[]> | null = null;

export function loadWebPanePresets(): Promise<WebPanePreset[]> {
  presetsPromise ??= invoke<WebPanePreset[]>("webpane_list_presets").catch((error) => {
    presetsPromise = null;
    throw error;
  });
  return presetsPromise;
}

export function createWebPane(
  tabId: string,
  presetId: string,
  bounds: WebPaneBounds,
  forwardedShortcuts: readonly string[],
): Promise<string> {
  return invoke<string>("webpane_create", { tabId, presetId, bounds, forwardedShortcuts });
}

export function updateWebPane(
  tabId: string,
  bounds: WebPaneBounds | null,
  visible: boolean,
  forwardedShortcuts: readonly string[],
): Promise<void> {
  return invoke<void>("webpane_update", { tabId, bounds, visible, forwardedShortcuts });
}

export function destroyWebPane(tabId: string): Promise<void> {
  return invoke<void>("webpane_destroy", { tabId });
}

/** Emitted on every navigation of a web pane, including the first load. */
export const WEB_PANE_URL_EVENT = "mycmux:web-pane-url";
/** Emitted around a sign-in window: the panes on that profile are gone meanwhile. */
export const WEB_PANE_SIGNIN_EVENT = "mycmux:web-pane-signin";

export interface WebPaneUrlEvent {
  tabId: string;
  presetId: string;
  url: string;
  signedOut: boolean;
}

export interface WebPaneSigninEvent {
  profileDir: string;
  tabIds: string[];
  state: "running" | "finished" | "failed";
  error: string | null;
}

export interface WebPaneSigninResult {
  profileDir: string;
  tabIds: string[];
  browserPath: string;
}

/**
 * Open a real browser window on this preset's own profile folder. Google
 * refuses OAuth from an embedded webview, so the one login that sticks is the
 * one performed in a real window against the folder the pane reads.
 */
export function startWebPaneSignin(presetId: string): Promise<WebPaneSigninResult> {
  return invoke<WebPaneSigninResult>("webpane_signin", { presetId });
}
