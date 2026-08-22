import type { ThemeBackgroundSettings } from "../types";

// Only the thumbnails are bundled. The full-resolution wallpapers are
// downloaded on demand into the runtime directory; see
// src/lib/wallpaperCache.ts and src-tauri/src/commands/wallpapers.rs.
import thumbAntelopeCanyon from "../assets/wallpaper-thumbs/antelope_canyon.webp";
import thumbAsteroidCity from "../assets/wallpaper-thumbs/asteroid_city.webp";
import thumbBarbie from "../assets/wallpaper-thumbs/barbie.webp";
import thumbCatppuccin3dModel from "../assets/wallpaper-thumbs/catppuccin_3d_model.webp";
import thumbCatppuccinAbandonedStation from "../assets/wallpaper-thumbs/catppuccin_abandoned_station.webp";
import thumbCatppuccinAbstractSwirls from "../assets/wallpaper-thumbs/catppuccin_abstract_swirls.webp";
import thumbCatppuccinAesthetic from "../assets/wallpaper-thumbs/catppuccin_aesthetic.webp";
import thumbCatppuccinArtificialValley from "../assets/wallpaper-thumbs/catppuccin_artificial_valley.webp";
import thumbCatppuccinAtlantis from "../assets/wallpaper-thumbs/catppuccin_atlantis.webp";
import thumbCatppuccinBlackHole from "../assets/wallpaper-thumbs/catppuccin_black_hole.webp";
import thumbCatppuccinBlueLandscape from "../assets/wallpaper-thumbs/catppuccin_blue_landscape.webp";
import thumbCatppuccinBluehour from "../assets/wallpaper-thumbs/catppuccin_bluehour.webp";
import thumbCatppuccinBlueprint from "../assets/wallpaper-thumbs/catppuccin_blueprint.webp";
import thumbCatppuccinBsod from "../assets/wallpaper-thumbs/catppuccin_bsod.webp";
import thumbCatppuccinCabin from "../assets/wallpaper-thumbs/catppuccin_cabin.webp";
import thumbDarkCity from "../assets/wallpaper-thumbs/dark_city.webp";
import thumbEarthAndMoon from "../assets/wallpaper-thumbs/earth_and_moon.webp";
import thumbGrafbase from "../assets/wallpaper-thumbs/grafbase.webp";
import thumbJellyfish from "../assets/wallpaper-thumbs/jellyfish.webp";
import thumbKoi from "../assets/wallpaper-thumbs/koi.webp";
import thumbLeafy from "../assets/wallpaper-thumbs/leafy.webp";
import thumbLumon from "../assets/wallpaper-thumbs/lumon.webp";
import thumbMacosBigSur from "../assets/wallpaper-thumbs/macos_big_sur.webp";
import thumbMacosElCapitan from "../assets/wallpaper-thumbs/macos_el_capitan.webp";
import thumbMacosHighSierra from "../assets/wallpaper-thumbs/macos_high_sierra.webp";
import thumbMacosMojave from "../assets/wallpaper-thumbs/macos_mojave.webp";
import thumbMacosMonterey from "../assets/wallpaper-thumbs/macos_monterey.webp";
import thumbMacosSierra from "../assets/wallpaper-thumbs/macos_sierra.webp";
import thumbMacosSonoma from "../assets/wallpaper-thumbs/macos_sonoma.webp";
import thumbMacosVentura from "../assets/wallpaper-thumbs/macos_ventura.webp";
import thumbMacosYosemite from "../assets/wallpaper-thumbs/macos_yosemite.webp";
import thumbMarble from "../assets/wallpaper-thumbs/marble.webp";
import thumbMilkyWay from "../assets/wallpaper-thumbs/milky_way.webp";
import thumbOppenheimer from "../assets/wallpaper-thumbs/oppenheimer.webp";
import thumbPinkCity from "../assets/wallpaper-thumbs/pink_city.webp";
import thumbPride from "../assets/wallpaper-thumbs/pride.webp";
import thumbRedRock from "../assets/wallpaper-thumbs/red_rock.webp";
import thumbSnowy from "../assets/wallpaper-thumbs/snowy.webp";
import thumbThanksgiving from "../assets/wallpaper-thumbs/thanksgiving.webp";
import thumbWarp from "../assets/wallpaper-thumbs/warp.webp";
import thumbWin11Bloom01 from "../assets/wallpaper-thumbs/win11_bloom_01.webp";
import thumbWin11Bloom02 from "../assets/wallpaper-thumbs/win11_bloom_02.webp";
import thumbWin11Bloom03 from "../assets/wallpaper-thumbs/win11_bloom_03.webp";
import thumbWin11Bloom04 from "../assets/wallpaper-thumbs/win11_bloom_04.webp";
import thumbWin11DefaultBloom from "../assets/wallpaper-thumbs/win11_default_bloom.webp";
import thumbWin11DefaultDark from "../assets/wallpaper-thumbs/win11_default_dark.webp";
import thumbWin11Flow01 from "../assets/wallpaper-thumbs/win11_flow_01.webp";
import thumbWin11Flow02 from "../assets/wallpaper-thumbs/win11_flow_02.webp";
import thumbWin11Flow03 from "../assets/wallpaper-thumbs/win11_flow_03.webp";
import thumbWin11Flow04 from "../assets/wallpaper-thumbs/win11_flow_04.webp";
import thumbWin11Motion01 from "../assets/wallpaper-thumbs/win11_motion_01.webp";
import thumbWin11Motion02 from "../assets/wallpaper-thumbs/win11_motion_02.webp";
import thumbWin11Motion03 from "../assets/wallpaper-thumbs/win11_motion_03.webp";
import thumbWin11Motion04 from "../assets/wallpaper-thumbs/win11_motion_04.webp";
import thumbWin11Spectrum01 from "../assets/wallpaper-thumbs/win11_spectrum_01.webp";
import thumbWin11Spectrum02 from "../assets/wallpaper-thumbs/win11_spectrum_02.webp";
import thumbWin11Spectrum03 from "../assets/wallpaper-thumbs/win11_spectrum_03.webp";
import thumbWin11Spectrum04 from "../assets/wallpaper-thumbs/win11_spectrum_04.webp";
import thumbWinter from "../assets/wallpaper-thumbs/winter.webp";

export type ThemeBackgroundCategory = "macos" | "warp" | "win11" | "catppuccin";
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
  presetId: "macos_monterey",
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
  { id: "macos_monterey", label: "macOS Monterey", description: "Monterey Dark", thumbnailUrl: thumbMacosMonterey, category: "macos", tone: "dark" },
  { id: "macos_ventura", label: "macOS Ventura", description: "Ventura Dark", thumbnailUrl: thumbMacosVentura, category: "macos", tone: "dark" },
  { id: "macos_big_sur", label: "macOS Big Sur", description: "Big Sur Night", thumbnailUrl: thumbMacosBigSur, category: "macos", tone: "dark" },
  { id: "macos_mojave", label: "macOS Mojave", description: "Mojave Night", thumbnailUrl: thumbMacosMojave, category: "macos", tone: "dark" },
  { id: "earth_and_moon", label: "Earth & Moon", description: "Earth and moon", thumbnailUrl: thumbEarthAndMoon, category: "macos", tone: "dark" },
  { id: "milky_way", label: "Milky Way", description: "Night sky and stars", thumbnailUrl: thumbMilkyWay, category: "macos", tone: "dark" },
  { id: "win11_default_dark", label: "Win11 Dark", description: "Windows 11 Default Dark", thumbnailUrl: thumbWin11DefaultDark, category: "win11", tone: "dark" },
  { id: "dark_city", label: "Dark City", description: "Night city distance", thumbnailUrl: thumbDarkCity, category: "warp", tone: "dark" },
  { id: "catppuccin_black_hole", label: "Black Hole", description: "Deep space black hole", thumbnailUrl: thumbCatppuccinBlackHole, category: "catppuccin", tone: "dark" },
  { id: "catppuccin_atlantis", label: "Atlantis", description: "Underwater ruins", thumbnailUrl: thumbCatppuccinAtlantis, category: "catppuccin", tone: "dark" },
  { id: "catppuccin_blueprint", label: "Blueprint", description: "Technical blueprint", thumbnailUrl: thumbCatppuccinBlueprint, category: "catppuccin", tone: "dark" },
  { id: "catppuccin_bsod", label: "BSOD", description: "Blue Screen of Death", thumbnailUrl: thumbCatppuccinBsod, category: "catppuccin", tone: "dark" },
  { id: "catppuccin_abandoned_station", label: "Abandoned Station", description: "Deserted station", thumbnailUrl: thumbCatppuccinAbandonedStation, category: "catppuccin", tone: "dark" },
  { id: "catppuccin_abstract_swirls", label: "Abstract Swirls", description: "Abstract swirls", thumbnailUrl: thumbCatppuccinAbstractSwirls, category: "catppuccin", tone: "dark" },
  { id: "oppenheimer", label: "Oppenheimer", description: "High contrast cinematic", thumbnailUrl: thumbOppenheimer, category: "warp", tone: "dark" },
  { id: "jellyfish", label: "Jellyfish", description: "Deep sea jellyfish", thumbnailUrl: thumbJellyfish, category: "warp", tone: "dark" },
  { id: "koi", label: "Koi", description: "Water and koi", thumbnailUrl: thumbKoi, category: "warp", tone: "dark" },
  { id: "leafy", label: "Leafy", description: "Layered leaves", thumbnailUrl: thumbLeafy, category: "warp", tone: "dark" },

  { id: "macos_sonoma", label: "macOS Sonoma", description: "Sonoma Dark", thumbnailUrl: thumbMacosSonoma, category: "macos", tone: "mid" },
  { id: "macos_high_sierra", label: "macOS High Sierra", description: "High Sierra", thumbnailUrl: thumbMacosHighSierra, category: "macos", tone: "mid" },
  { id: "macos_sierra", label: "macOS Sierra", description: "Sierra", thumbnailUrl: thumbMacosSierra, category: "macos", tone: "mid" },
  { id: "macos_el_capitan", label: "macOS El Capitan", description: "El Capitan", thumbnailUrl: thumbMacosElCapitan, category: "macos", tone: "mid" },
  { id: "macos_yosemite", label: "macOS Yosemite", description: "Yosemite", thumbnailUrl: thumbMacosYosemite, category: "macos", tone: "mid" },
  { id: "antelope_canyon", label: "Antelope Canyon", description: "Antelope Canyon", thumbnailUrl: thumbAntelopeCanyon, category: "macos", tone: "mid" },
  { id: "red_rock", label: "Red Rock", description: "Red rock landscape", thumbnailUrl: thumbRedRock, category: "warp", tone: "mid" },
  { id: "asteroid_city", label: "Asteroid City", description: "Desert motel palette", thumbnailUrl: thumbAsteroidCity, category: "warp", tone: "mid" },
  { id: "thanksgiving", label: "Thanksgiving", description: "Autumn harvest tones", thumbnailUrl: thumbThanksgiving, category: "warp", tone: "mid" },
  { id: "warp", label: "Warp", description: "Warp original", thumbnailUrl: thumbWarp, category: "warp", tone: "mid" },
  { id: "grafbase", label: "Grafbase", description: "Simple graph texture", thumbnailUrl: thumbGrafbase, category: "warp", tone: "mid" },
  { id: "win11_motion_01", label: "Win11 Motion 1", description: "Captured Motion", thumbnailUrl: thumbWin11Motion01, category: "win11", tone: "mid" },
  { id: "win11_motion_02", label: "Win11 Motion 2", description: "Captured Motion", thumbnailUrl: thumbWin11Motion02, category: "win11", tone: "mid" },
  { id: "win11_motion_03", label: "Win11 Motion 3", description: "Captured Motion", thumbnailUrl: thumbWin11Motion03, category: "win11", tone: "mid" },
  { id: "win11_motion_04", label: "Win11 Motion 4", description: "Captured Motion", thumbnailUrl: thumbWin11Motion04, category: "win11", tone: "mid" },
  { id: "win11_spectrum_01", label: "Win11 Spectrum 1", description: "Spectrum", thumbnailUrl: thumbWin11Spectrum01, category: "win11", tone: "mid" },
  { id: "win11_spectrum_02", label: "Win11 Spectrum 2", description: "Spectrum", thumbnailUrl: thumbWin11Spectrum02, category: "win11", tone: "mid" },
  { id: "win11_spectrum_03", label: "Win11 Spectrum 3", description: "Spectrum", thumbnailUrl: thumbWin11Spectrum03, category: "win11", tone: "mid" },
  { id: "win11_spectrum_04", label: "Win11 Spectrum 4", description: "Spectrum", thumbnailUrl: thumbWin11Spectrum04, category: "win11", tone: "mid" },
  { id: "win11_flow_01", label: "Win11 Flow 1", description: "Flow", thumbnailUrl: thumbWin11Flow01, category: "win11", tone: "mid" },
  { id: "win11_flow_02", label: "Win11 Flow 2", description: "Flow", thumbnailUrl: thumbWin11Flow02, category: "win11", tone: "mid" },
  { id: "win11_flow_03", label: "Win11 Flow 3", description: "Flow", thumbnailUrl: thumbWin11Flow03, category: "win11", tone: "mid" },
  { id: "win11_flow_04", label: "Win11 Flow 4", description: "Flow", thumbnailUrl: thumbWin11Flow04, category: "win11", tone: "mid" },
  { id: "catppuccin_bluehour", label: "Blue Hour", description: "Blue hour skyline", thumbnailUrl: thumbCatppuccinBluehour, category: "catppuccin", tone: "mid" },
  { id: "catppuccin_artificial_valley", label: "Artificial Valley", description: "Artificial valley", thumbnailUrl: thumbCatppuccinArtificialValley, category: "catppuccin", tone: "mid" },
  { id: "catppuccin_blue_landscape", label: "Blue Landscape", description: "Blue landscape", thumbnailUrl: thumbCatppuccinBlueLandscape, category: "catppuccin", tone: "mid" },
  { id: "catppuccin_3d_model", label: "3D Model", description: "3D wireframe model", thumbnailUrl: thumbCatppuccin3dModel, category: "catppuccin", tone: "mid" },
  { id: "catppuccin_cabin", label: "Cabin", description: "Mountain cabin", thumbnailUrl: thumbCatppuccinCabin, category: "catppuccin", tone: "mid" },
  { id: "catppuccin_aesthetic", label: "Aesthetic", description: "Aesthetic room", thumbnailUrl: thumbCatppuccinAesthetic, category: "catppuccin", tone: "mid" },

  { id: "marble", label: "Marble", description: "Marble texture", thumbnailUrl: thumbMarble, category: "warp", tone: "bright" },
  { id: "pink_city", label: "Pink City", description: "Pink city lights", thumbnailUrl: thumbPinkCity, category: "warp", tone: "bright" },
  { id: "snowy", label: "Snowy", description: "Snow mountain quiet", thumbnailUrl: thumbSnowy, category: "warp", tone: "bright" },
  { id: "winter", label: "Winter", description: "Winter snow light", thumbnailUrl: thumbWinter, category: "warp", tone: "bright" },
  { id: "barbie", label: "Barbie", description: "Bright pink theme", thumbnailUrl: thumbBarbie, category: "warp", tone: "bright" },
  { id: "pride", label: "Pride", description: "Rainbow pride colors", thumbnailUrl: thumbPride, category: "warp", tone: "bright" },
  { id: "lumon", label: "Lumon", description: "Clean white workspace", thumbnailUrl: thumbLumon, category: "warp", tone: "bright" },
  { id: "win11_bloom_01", label: "Win11 Bloom 1", description: "Bloom", thumbnailUrl: thumbWin11Bloom01, category: "win11", tone: "bright" },
  { id: "win11_bloom_02", label: "Win11 Bloom 2", description: "Bloom", thumbnailUrl: thumbWin11Bloom02, category: "win11", tone: "bright" },
  { id: "win11_bloom_03", label: "Win11 Bloom 3", description: "Bloom", thumbnailUrl: thumbWin11Bloom03, category: "win11", tone: "bright" },
  { id: "win11_bloom_04", label: "Win11 Bloom 4", description: "Bloom", thumbnailUrl: thumbWin11Bloom04, category: "win11", tone: "bright" },
  { id: "win11_default_bloom", label: "Win11 Bloom", description: "Windows 11 Default", thumbnailUrl: thumbWin11DefaultBloom, category: "win11", tone: "bright" },
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
