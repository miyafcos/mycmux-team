export const DEFAULT_SHELL = "/bin/bash";
export const DEFAULT_FONT_SIZE = 14;
export const MIN_FONT_SIZE = 10;
export const MAX_FONT_SIZE = 24;
export const PANE_HEADER_HEIGHT = 36;
export const TAB_BAR_HEIGHT = 36;
export const SIDEBAR_DEFAULT_WIDTH = 280;
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 560;
export const SESSION_ID_PREFIX = "pty";
export const RESIZE_DEBOUNCE_MS = 100;
export const INIT_DELAY_MS = 300;
export const USAGE_POLL_INTERVAL_MS = 180_000;

export function clampSidebarWidth(value: number): number {
  if (!Number.isFinite(value)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, value)));
}

export function makeSessionId(workspaceId: string, paneId: string): string {
  return `${SESSION_ID_PREFIX}-${workspaceId}-${paneId}`;
}
