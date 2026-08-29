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
