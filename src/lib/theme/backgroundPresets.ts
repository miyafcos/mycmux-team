import type { ThemeBackgroundSettings } from "../../types";
import { DEFAULT_THEME_BACKGROUND } from "../themeBackgrounds";

export const NAMED_BACKGROUND_PRESETS = ["solid", "frosted", "clear"] as const;

export type NamedBackgroundPreset = (typeof NAMED_BACKGROUND_PRESETS)[number];
export type BackgroundPresetId = NamedBackgroundPreset | "custom";

export const CLEAR_PANEL_OPACITY = 0.25;
export const CLEAR_TERMINAL_OPACITY = 0.15;

const MATCH_EPSILON = 0.005;

const PRESET_PATCHES: Record<NamedBackgroundPreset, Partial<ThemeBackgroundSettings>> = {
  solid: { solidSurfaces: true },
  frosted: {
    solidSurfaces: false,
    panelOpacity: DEFAULT_THEME_BACKGROUND.panelOpacity,
    terminalOpacity: DEFAULT_THEME_BACKGROUND.terminalOpacity,
  },
  clear: {
    solidSurfaces: false,
    panelOpacity: CLEAR_PANEL_OPACITY,
    terminalOpacity: CLEAR_TERMINAL_OPACITY,
  },
};

function nearly(value: number, target: number): boolean {
  // 0.62 - 0.005 is 0.614999... in IEEE-754, so a raw <= 0.005 misses the edge.
  return Math.abs(value - target) <= MATCH_EPSILON + 1e-9;
}

export function resolveBackgroundPreset(background: ThemeBackgroundSettings): BackgroundPresetId {
  if (background.solidSurfaces) {
    return "solid";
  }
  if (
    nearly(background.panelOpacity, DEFAULT_THEME_BACKGROUND.panelOpacity) &&
    nearly(background.terminalOpacity, DEFAULT_THEME_BACKGROUND.terminalOpacity)
  ) {
    return "frosted";
  }
  if (
    nearly(background.panelOpacity, CLEAR_PANEL_OPACITY) &&
    nearly(background.terminalOpacity, CLEAR_TERMINAL_OPACITY)
  ) {
    return "clear";
  }
  return "custom";
}

export function applyBackgroundPreset(id: NamedBackgroundPreset): Partial<ThemeBackgroundSettings> {
  return { ...PRESET_PATCHES[id] };
}
