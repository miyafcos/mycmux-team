import { useSettingsStore } from "../../stores/settingsStore";

export function isMacTearoutPlatform(platform = typeof navigator === "undefined" ? "" : navigator.platform): boolean {
  return /^Mac/i.test(platform);
}

export function supportsNativePaneTearout(platform = typeof navigator === "undefined" ? "" : navigator.platform): boolean {
  return /^Win/i.test(platform) || isMacTearoutPlatform(platform);
}

export function nativePaneTearoutEnabled(enabled: boolean, platform = typeof navigator === "undefined" ? "" : navigator.platform,
  macEnabled = useSettingsStore.getState().macNativePaneTearoutEnabled): boolean {
  return enabled === true && supportsNativePaneTearout(platform) && (!isMacTearoutPlatform(platform) || macEnabled === true);
}

/** Legacy detached windows need the common painted drop surface while opted in. */
export function usesNativePaneShell(nativeChild: boolean, legacyDetached: boolean, enabled: boolean,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
  macEnabled = useSettingsStore.getState().macNativePaneTearoutEnabled): boolean {
  return nativeChild || legacyDetached && nativePaneTearoutEnabled(enabled, platform, macEnabled);
}
