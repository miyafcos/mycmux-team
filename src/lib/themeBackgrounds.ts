import type { ThemeBackgroundSettings } from "../types";

// Only the thumbnails are bundled. The full-resolution wallpapers are
// downloaded on demand into the runtime directory; see
// src/lib/wallpaperCache.ts and src-tauri/src/commands/wallpapers.rs.
import thumbDarkCity from "../assets/wallpaper-thumbs/dark_city.webp";
import thumbJellyfish from "../assets/wallpaper-thumbs/jellyfish.webp";
import thumbKoi from "../assets/wallpaper-thumbs/koi.webp";
import thumbLeafy from "../assets/wallpaper-thumbs/leafy.webp";
import thumbMarble from "../assets/wallpaper-thumbs/marble.webp";
import thumbPinkCity from "../assets/wallpaper-thumbs/pink_city.webp";
import thumbPride from "../assets/wallpaper-thumbs/pride.webp";
import thumbRedRock from "../assets/wallpaper-thumbs/red_rock.webp";
import thumbSnowy from "../assets/wallpaper-thumbs/snowy.webp";
import thumbThanksgiving from "../assets/wallpaper-thumbs/thanksgiving.webp";
import thumbWinter from "../assets/wallpaper-thumbs/winter.webp";

export type ThemeBackgroundCategory = "warp";
export type ThemeBackgroundTone = "dark" | "mid" | "bright";

export interface ThemeBackgroundPreset {
  id: string;
  label: string;
  description: string;
  /**
   * The bundled 320px thumbnail. This is the only image of a preset that
   * exists before it is downloaded, so the picker draws from it and the
   * wallpaper itself comes from the cache (see src/lib/wallpaperCache.ts).
   */
  thumbnailUrl: string;
  category: ThemeBackgroundCategory;
  tone: ThemeBackgroundTone;
}

export const DEFAULT_THEME_BACKGROUND: ThemeBackgroundSettings = {
  // Nothing is downloaded on a fresh install, so the shipped background is the
  // theme's own colour. `presetId` still names the wallpaper a first switch to
  // preset mode lands on.
  mode: "solid",
  presetId: "dark_city",
  imagePath: "",
  imageOpacity: 1,
  imageBlur: 0,
  // The old `imageDim: 0.08` black scrim, read through the signed tone scale.
  // Dark themes must keep painting exactly this; the light branch substitutes
  // its own default in the resolver (see resolveWallpaperTone).
  wallpaperTone: -0.08,
  panelOpacity: 0.68,
  terminalOpacity: 0.62,
  solidSurfaces: false,
};

/** Floor for panel/terminal glass sliders. Clear preset lands at 0.15. */
export const SURFACE_OPACITY_MIN = 0.1;

export const THEME_BACKGROUND_PRESETS: ThemeBackgroundPreset[] = [
  { id: "dark_city", label: "Dark City", description: "Night city distance", thumbnailUrl: thumbDarkCity, category: "warp", tone: "dark" },
  { id: "jellyfish", label: "Jellyfish", description: "Deep sea jellyfish", thumbnailUrl: thumbJellyfish, category: "warp", tone: "dark" },
  { id: "koi", label: "Koi", description: "Water and koi", thumbnailUrl: thumbKoi, category: "warp", tone: "dark" },
  { id: "leafy", label: "Leafy", description: "Layered leaves", thumbnailUrl: thumbLeafy, category: "warp", tone: "dark" },

  { id: "red_rock", label: "Red Rock", description: "Red rock landscape", thumbnailUrl: thumbRedRock, category: "warp", tone: "mid" },
  { id: "thanksgiving", label: "Thanksgiving", description: "Autumn harvest tones", thumbnailUrl: thumbThanksgiving, category: "warp", tone: "mid" },

  { id: "marble", label: "Marble", description: "Marble texture", thumbnailUrl: thumbMarble, category: "warp", tone: "bright" },
  { id: "pink_city", label: "Pink City", description: "Pink city lights", thumbnailUrl: thumbPinkCity, category: "warp", tone: "bright" },
  { id: "snowy", label: "Snowy", description: "Snow mountain quiet", thumbnailUrl: thumbSnowy, category: "warp", tone: "bright" },
  { id: "winter", label: "Winter", description: "Winter snow light", thumbnailUrl: thumbWinter, category: "warp", tone: "bright" },
  { id: "pride", label: "Pride", description: "Rainbow pride colors", thumbnailUrl: thumbPride, category: "warp", tone: "bright" },
];

export function normalizeThemeBackground(input: unknown): ThemeBackgroundSettings {
  const record = toRecord(input);
  if (!record) {
    return DEFAULT_THEME_BACKGROUND;
  }

  const rawMode =
    record.mode === "solid" || record.mode === "preset" || record.mode === "image"
      ? record.mode
      : DEFAULT_THEME_BACKGROUND.mode;
  const presetId =
    typeof record.presetId === "string" &&
    THEME_BACKGROUND_PRESETS.some((preset) => preset.id === record.presetId)
      ? record.presetId
      : DEFAULT_THEME_BACKGROUND.presetId;
  const imagePath =
    typeof record.imagePath === "string" && !/[\r\n]/.test(record.imagePath) && record.imagePath.length <= 2048
      ? record.imagePath
      : "";
  // A stored image path that no longer parses leaves nothing to paint. Landing
  // on the default preset would start downloading a wallpaper nobody chose, so
  // this falls through to the shipped background instead.
  const mode = rawMode === "image" && !imagePath ? DEFAULT_THEME_BACKGROUND.mode : rawMode;

  return {
    mode,
    presetId,
    imagePath,
    imageOpacity: normalizeNumber(record.imageOpacity, 0, 1, DEFAULT_THEME_BACKGROUND.imageOpacity),
    imageBlur: normalizeNumber(record.imageBlur, 0, 32, DEFAULT_THEME_BACKGROUND.imageBlur),
    wallpaperTone: normalizeWallpaperTone(record),
    panelOpacity: normalizeNumber(record.panelOpacity, SURFACE_OPACITY_MIN, 1, DEFAULT_THEME_BACKGROUND.panelOpacity),
    terminalOpacity: normalizeNumber(
      record.terminalOpacity,
      SURFACE_OPACITY_MIN,
      1,
      DEFAULT_THEME_BACKGROUND.terminalOpacity,
    ),
    solidSurfaces: record.solidSurfaces === true,
  };
}

export function isDefaultThemeBackground(background: ThemeBackgroundSettings): boolean {
  return (
    background.mode === DEFAULT_THEME_BACKGROUND.mode &&
    background.presetId === DEFAULT_THEME_BACKGROUND.presetId &&
    background.imagePath === DEFAULT_THEME_BACKGROUND.imagePath &&
    background.imageOpacity === DEFAULT_THEME_BACKGROUND.imageOpacity &&
    background.imageBlur === DEFAULT_THEME_BACKGROUND.imageBlur &&
    background.wallpaperTone === DEFAULT_THEME_BACKGROUND.wallpaperTone &&
    background.panelOpacity === DEFAULT_THEME_BACKGROUND.panelOpacity &&
    background.terminalOpacity === DEFAULT_THEME_BACKGROUND.terminalOpacity &&
    background.solidSurfaces === DEFAULT_THEME_BACKGROUND.solidSurfaces
  );
}

/** Widest tone in either direction. Mirrors the old `imageDim` 0-0.85 range. */
export const WALLPAPER_TONE_LIMIT = 0.85;

/**
 * Reads the wallpaper tone, migrating settings written before the field
 * existed.
 *
 * `imageDim` was a 0-0.85 black scrim; the signed scale expresses the same
 * thing as `-imageDim`, so an install that has been running with
 * `imageDim: 0.30` keeps painting a 30% black scrim instead of silently
 * flipping to a 30% wash toward paper. Skipping this migration would change
 * how the wallpaper looks on every existing install, which is why it is read
 * here rather than at a call site.
 */
function normalizeWallpaperTone(record: Record<string, unknown>): number {
  if (typeof record.wallpaperTone === "number" && Number.isFinite(record.wallpaperTone)) {
    return clamp(record.wallpaperTone, -WALLPAPER_TONE_LIMIT, WALLPAPER_TONE_LIMIT);
  }
  if (typeof record.imageDim === "number" && Number.isFinite(record.imageDim)) {
    const dim = clamp(record.imageDim, 0, WALLPAPER_TONE_LIMIT);
    // `-0` would compare equal to 0 but serialise as "-0"; normalise it away.
    return dim === 0 ? 0 : -dim;
  }
  return DEFAULT_THEME_BACKGROUND.wallpaperTone;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
