// Workspace colors — Chrome tab-group style visual grouping for the sidebar.
//
// Deliberately a fixed palette, not a free-form picker: the raw value is only
// ever painted as a small accent (a 3px bar, a 8px dot) while every background
// derived from it goes through color-mix() against the current chrome tokens.
// That keeps the theme's own contrast guarantees intact on both dark and light
// chrome, which a user-chosen arbitrary hex could not.
//
// Every value is a mid-luminance, mid-saturation hue so the 3px bar stays
// visible against both a near-black and a near-white sidebar.

export interface WorkspaceColorOption {
  /** Stable id used for test/debug attributes, never persisted. */
  id: string;
  /** Japanese label shown in the picker. */
  label: string;
  /** Persisted value: the raw hex written to Workspace.color. */
  value: string;
}

export const WORKSPACE_COLORS: readonly WorkspaceColorOption[] = [
  { id: "blue", label: "青", value: "#4C8DF6" },
  { id: "cyan", label: "水色", value: "#1FA2B8" },
  { id: "green", label: "緑", value: "#3EA55E" },
  { id: "amber", label: "黄", value: "#C9971C" },
  { id: "orange", label: "橙", value: "#E1703C" },
  { id: "red", label: "赤", value: "#E0524E" },
  { id: "pink", label: "桃", value: "#D95C9C" },
  { id: "purple", label: "紫", value: "#8A6DE0" },
] as const;

/** Label for the "clear the color" choice in the picker. */
export const WORKSPACE_COLOR_NONE_LABEL = "なし";

const BY_VALUE = new Map(
  WORKSPACE_COLORS.map((option) => [option.value.toLowerCase(), option] as const),
);

/**
 * Resolve a persisted value back to a palette entry.
 * Unknown values (hand-edited data.json, a palette entry retired in a later
 * release) resolve to undefined so the UI simply renders no color.
 */
export function resolveWorkspaceColor(
  value: string | null | undefined,
): WorkspaceColorOption | undefined {
  if (!value) return undefined;
  return BY_VALUE.get(value.toLowerCase());
}

/**
 * Canonical form of a color for storage: the palette's own casing, or
 * undefined when the value is empty or not in the palette. Applied on both the
 * setter and the restore path so data.json can never inject an arbitrary hex
 * into the chrome.
 */
export function normalizeWorkspaceColor(
  value: string | null | undefined,
): string | undefined {
  return resolveWorkspaceColor(value)?.value;
}

/** `color` mixed toward transparency — for tints layered over chrome surfaces. */
export function workspaceColorTint(color: string, percent: number): string {
  return `color-mix(in srgb, ${color} ${percent}%, transparent)`;
}

/**
 * Sidebar row background: the group tint layered over whatever the row would
 * otherwise paint, so an active colored row keeps its selected surface.
 */
export function workspaceRowBackground(
  color: string | undefined,
  active: boolean,
  base: string,
): string {
  if (!color) return base;
  return `color-mix(in srgb, ${color} ${active ? 16 : 9}%, ${base})`;
}
