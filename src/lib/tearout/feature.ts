export function supportsNativePaneTearout(platform = typeof navigator === "undefined" ? "" : navigator.platform): boolean {
  return /^Win/i.test(platform);
}

export function nativePaneTearoutEnabled(enabled: boolean, platform = typeof navigator === "undefined" ? "" : navigator.platform): boolean {
  return enabled === true && supportsNativePaneTearout(platform);
}

/** Legacy detached windows need the common painted drop surface while opted in. */
export function usesNativePaneShell(nativeChild: boolean, legacyDetached: boolean, enabled: boolean,
  platform = typeof navigator === "undefined" ? "" : navigator.platform): boolean {
  return nativeChild || legacyDetached && nativePaneTearoutEnabled(enabled, platform);
}
