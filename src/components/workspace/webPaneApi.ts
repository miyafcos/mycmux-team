import { invoke } from "@tauri-apps/api/core";
import { cancelWebPaneCommandWaiters } from "./webPaneCommandQueue";

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
  options?: { visible?: boolean; url?: string },
): Promise<string> {
  return invoke<string>("webpane_create", {
    tabId, presetId, bounds, forwardedShortcuts,
    visible: options?.visible, initialUrl: options?.url,
  });
}

export function updateWebPane(
  tabId: string,
  bounds: WebPaneBounds | null,
  visible: boolean,
  forwardedShortcuts: readonly string[],
  options?: { park?: boolean },
): Promise<void> {
  return invoke<void>("webpane_update", { tabId, bounds, visible, forwardedShortcuts, park: options?.park });
}

export function destroyWebPane(tabId: string): Promise<void> {
  cancelWebPaneCommandWaiters(tabId);
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

export interface WebPaneReadResult {
  tabId: string;
  presetId: string;
  url: string;
  title: string;
  signedOut: boolean;
  composerPresent: boolean;
  generating: boolean;
  turns: { role: "user" | "assistant"; text: string }[];
  lastAssistant: string;
  lastAssistantLinks: string[];
  /** Unicode code points in retained turn text. */
  chars: number;
  truncated: boolean;
}

export function readWebPane(tabId: string): Promise<WebPaneReadResult> {
  return invoke<WebPaneReadResult>("webpane_read", { tabId });
}

export interface WebPaneNode {
  ref: string;
  role: string;
  name: string;
  tag: string;
  text?: string;
  value?: string;
  href?: string;
  checked?: boolean;
  disabled?: boolean;
  level?: number;
  rect: WebPaneBounds;
  inViewport: boolean;
}
export type WebPaneTarget = { ref: string } | { selector: string } | { x: number; y: number };
export interface WebPaneTargetInfo { ref?: string; rect: WebPaneBounds; generation: number; appendWithEndKey?: boolean }
export interface WebPaneNavigateResult { tabId: string; accepted: true }
export interface WebPaneEvalResult<T = unknown> { tabId: string; value: T }
export interface WebPaneWaitResult {
  tabId: string; state: "load" | "idle" | "selector"; ready: boolean; url: string; elapsedMs: number;
}
export type WebPaneSnapshotResult = {
  tabId: string; url: string; title: string; truncated: boolean;
} & ({ nodes: WebPaneNode[]; viewport: { width: number; height: number; dpr: number } } | { text: string });
export interface WebPaneFindQuery { text?: string; role?: string; selector?: string; exact?: boolean; limit?: number }
export interface WebPaneFindResult { tabId: string; nodes: WebPaneNode[] }
export interface WebPaneClickOptions { button?: "left" | "right" | "middle"; clickCount?: number }
export interface WebPaneClickResult { tabId: string; target: WebPaneTargetInfo; trusted: boolean }
export interface WebPaneTypeResult { tabId: string; target: WebPaneTargetInfo; chars: number; submitted: boolean }
export type WebPaneModifier = "ctrl" | "shift" | "alt" | "meta";
export interface WebPaneKeyOptions { key: string; code?: string; modifiers?: WebPaneModifier[]; target?: { ref: string } }
export interface WebPaneKeyResult { tabId: string; key: string; trusted: boolean }
export interface WebPaneScrollResult { tabId: string; scrollX: number; scrollY: number }
export interface WebPaneFile { name: string; size: number }
export interface WebPaneUploadResult { tabId: string; files: WebPaneFile[]; mode: "input" | "drop"; trusted: boolean }
export interface WebPaneScreenshotResult { tabId: string; path: string; width: number; height: number; dpr: number }
export interface WebPaneDownloadsResult {
  tabId: string; downloads: { url: string; path: string | null; success: boolean; finishedAt: string }[];
}
export interface WebPaneDialogsResult {
  tabId: string; dialogs: { kind: "alert" | "confirm" | "prompt"; message: string; at: string }[];
}
export type WebPaneTrustedAction = (
  | ({ kind: "click"; x: number; y: number } & WebPaneClickOptions)
  | { kind: "key"; key: string; code?: string; text?: string; modifiers?: WebPaneModifier[] }
  | { kind: "insertText"; text: string }
  | { kind: "wheel"; x: number; y: number; deltaX: number; deltaY: number }
) & { expectedGeneration: number };

export function navigateWebPane(tabId: string, options: { url?: string; action?: "back" | "forward" | "reload" }) {
  return invoke<WebPaneNavigateResult>("webpane_navigate", { tabId, ...options });
}
export function evalWebPane<T = unknown>(tabId: string, script: string, timeoutMs?: number, direct = false) {
  return invoke<WebPaneEvalResult<T>>("webpane_eval", { tabId, script, ...(timeoutMs === undefined ? {} : { timeoutMs }), ...(direct ? { direct: true } : {}) });
}
export function snapshotWebPane(tabId: string, options: { mode?: "ax" | "text"; maxBytes?: number }) {
  return invoke<WebPaneSnapshotResult>("webpane_snapshot", { tabId, ...options });
}
export function findWebPane(tabId: string, query: WebPaneFindQuery) {
  return invoke<WebPaneFindResult>("webpane_find", { tabId, query });
}
export function clickWebPane(tabId: string, target: WebPaneTarget, options: WebPaneClickOptions) {
  return invoke<WebPaneClickResult>("webpane_click", { tabId, target, options });
}
export function typeWebPane(tabId: string, target: WebPaneTarget, options: { text: string; mode: "replace" | "append"; submit: boolean }) {
  return invoke<WebPaneTypeResult>("webpane_type", { tabId, target, ...options });
}
export function keyWebPane(tabId: string, options: WebPaneKeyOptions) {
  return invoke<WebPaneKeyResult>("webpane_key", { tabId, ...options });
}
export function scrollWebPane(tabId: string, options: { target?: WebPaneTarget; deltaX: number; deltaY: number }) {
  return invoke<WebPaneScrollResult>("webpane_scroll", { tabId, ...options });
}
export function uploadWebPane(tabId: string, target: WebPaneTarget, paths: string[], mode: "input" | "drop") {
  return invoke<WebPaneUploadResult>("webpane_upload", { tabId, target, paths, mode });
}
export interface WebPaneNativeBudget { budgetMs: number; command: string }

export function screenshotWebPane(tabId: string, options: { path?: string; clip?: WebPaneBounds }, budget?: WebPaneNativeBudget) {
  return invoke<WebPaneScreenshotResult>("webpane_screenshot", { tabId, ...options, ...budget });
}
export function inputTrustedWebPane(tabId: string, action: WebPaneTrustedAction, budget?: WebPaneNativeBudget) {
  return invoke<unknown>("webpane_input_trusted", { tabId, action, ...budget });
}
export function setWebPaneFileInput(tabId: string, selector: string, paths: string[], expectedGeneration: number, budget?: WebPaneNativeBudget) {
  return invoke<{ tabId: string; files: WebPaneFile[] }>("webpane_set_file_input", { tabId, selector, paths, expectedGeneration, ...budget });
}
export function downloadsWebPane(tabId: string) {
  return invoke<WebPaneDownloadsResult>("webpane_downloads", { tabId });
}
export function dialogsWebPane(tabId: string, clear: boolean) {
  return invoke<WebPaneDialogsResult>("webpane_dialogs", { tabId, clear });
}
