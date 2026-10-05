import { nativePaneTearoutEnabled } from "./feature";

export function windowsNativeBand(enabled: boolean, platform = navigator.platform): boolean {
  return /^Win/i.test(platform) && nativePaneTearoutEnabled(enabled, platform);
}

export interface LogicalExtent { width: number; height: number }

/** CSS coordinates already express the source window's logical pixels. */
export function sourceLogicalExtent(kind: "tab" | "pane" | "workspace", pane: LogicalExtent | null,
  window: LogicalExtent): LogicalExtent {
  const size = kind === "workspace" ? window : pane;
  return size && Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0
    ? { width: size.width, height: size.height } : { width: 720, height: 520 };
}
