import type { ThemeBackgroundSettings } from "../types";

import asteroidCityBg from "../assets/warp-themes/asteroid_city_wallpaper.webp";
import barbieBg from "../assets/warp-themes/barbie_bg.webp";
import darkCityBg from "../assets/warp-themes/dark_city_bg.webp";
import grafbaseBg from "../assets/warp-themes/grafbase_bg.webp";
import jellyfishBg from "../assets/warp-themes/jellyfish_bg.webp";
import koiBg from "../assets/warp-themes/koi_bg.webp";
import leafyBg from "../assets/warp-themes/leafy_bg.webp";
import lumonBg from "../assets/warp-themes/lumon.webp";
import marbleBg from "../assets/warp-themes/marble_bg.webp";
import oppenheimerBg from "../assets/warp-themes/oppenheimer_bg.webp";
import pinkCityBg from "../assets/warp-themes/pink_city_bg.webp";
import prideBg from "../assets/warp-themes/pride_bg.webp";
import redRockBg from "../assets/warp-themes/red_rock_bg.webp";
import snowyBg from "../assets/warp-themes/snowy_bg.webp";
import thanksgivingBg from "../assets/warp-themes/thanksgiving_bg.webp";
import warpBg from "../assets/warp-themes/warp.webp";
import winterBg from "../assets/warp-themes/winter_bg.webp";

import macAntelope from "../assets/macos-wallpapers/antelope_canyon.webp";
import macBigSur from "../assets/macos-wallpapers/big_sur_night.webp";
import macEarth from "../assets/macos-wallpapers/earth_and_moon.webp";
import macElCapitan from "../assets/macos-wallpapers/el_capitan.webp";
import macHighSierra from "../assets/macos-wallpapers/high_sierra.webp";
import macMilkyWay from "../assets/macos-wallpapers/milky_way.webp";
import macMojave from "../assets/macos-wallpapers/mojave_night.webp";
import macMonterey from "../assets/macos-wallpapers/monterey_dark.webp";
import macSierra from "../assets/macos-wallpapers/sierra.webp";
import macSonoma from "../assets/macos-wallpapers/sonoma_dark.webp";
import macVentura from "../assets/macos-wallpapers/ventura_dark.webp";
import macYosemite from "../assets/macos-wallpapers/yosemite.webp";

import win11Bloom01 from "../assets/windows-wallpapers/win11_bloom_01.webp";
import win11Bloom02 from "../assets/windows-wallpapers/win11_bloom_02.webp";
import win11Bloom03 from "../assets/windows-wallpapers/win11_bloom_03.webp";
import win11Bloom04 from "../assets/windows-wallpapers/win11_bloom_04.webp";
import win11DefaultBloom from "../assets/windows-wallpapers/win11_default_bloom.webp";
import win11DefaultDark from "../assets/windows-wallpapers/win11_default_dark.webp";
import win11Flow01 from "../assets/windows-wallpapers/win11_flow_01.webp";
import win11Flow02 from "../assets/windows-wallpapers/win11_flow_02.webp";
import win11Flow03 from "../assets/windows-wallpapers/win11_flow_03.webp";
import win11Flow04 from "../assets/windows-wallpapers/win11_flow_04.webp";
import win11Motion01 from "../assets/windows-wallpapers/win11_motion_01.webp";
import win11Motion02 from "../assets/windows-wallpapers/win11_motion_02.webp";
import win11Motion03 from "../assets/windows-wallpapers/win11_motion_03.webp";
import win11Motion04 from "../assets/windows-wallpapers/win11_motion_04.webp";
import win11Spectrum01 from "../assets/windows-wallpapers/win11_spectrum_01.webp";
import win11Spectrum02 from "../assets/windows-wallpapers/win11_spectrum_02.webp";
import win11Spectrum03 from "../assets/windows-wallpapers/win11_spectrum_03.webp";
import win11Spectrum04 from "../assets/windows-wallpapers/win11_spectrum_04.webp";

import cat3dModel from "../assets/catppuccin-wallpapers/catppuccin_3d_model.webp";
import catAbandonedStation from "../assets/catppuccin-wallpapers/catppuccin_abandoned_station.webp";
import catAbstractSwirls from "../assets/catppuccin-wallpapers/catppuccin_abstract_swirls.webp";
import catAesthetic from "../assets/catppuccin-wallpapers/catppuccin_aesthetic.webp";
import catArtificialValley from "../assets/catppuccin-wallpapers/catppuccin_artificial_valley.webp";
import catAtlantis from "../assets/catppuccin-wallpapers/catppuccin_atlantis.webp";
import catBlackHole from "../assets/catppuccin-wallpapers/catppuccin_black_hole.webp";
import catBlueHour from "../assets/catppuccin-wallpapers/catppuccin_bluehour.webp";
import catBlueLandscape from "../assets/catppuccin-wallpapers/catppuccin_blue_landscape.webp";
import catBlueprint from "../assets/catppuccin-wallpapers/catppuccin_blueprint.webp";
import catBsod from "../assets/catppuccin-wallpapers/catppuccin_bsod.webp";
import catCabin from "../assets/catppuccin-wallpapers/catppuccin_cabin.webp";

export type ThemeBackgroundCategory = "macos" | "warp" | "win11" | "catppuccin";
export type ThemeBackgroundTone = "dark" | "mid" | "bright";

export interface ThemeBackgroundPreset {
  id: string;
  label: string;
  description: string;
  imageUrl: string;
  category: ThemeBackgroundCategory;
  tone: ThemeBackgroundTone;
}

export const DEFAULT_THEME_BACKGROUND: ThemeBackgroundSettings = {
  mode: "preset",
  presetId: "macos_monterey",
  imagePath: "",
  imageOpacity: 1,
  imageBlur: 0,
  imageDim: 0.08,
  panelOpacity: 0.68,
  terminalOpacity: 0.62,
};

export const THEME_BACKGROUND_PRESETS: ThemeBackgroundPreset[] = [
  { id: "macos_monterey", label: "macOS Monterey", description: "Monterey Dark", imageUrl: macMonterey, category: "macos", tone: "dark" },
  { id: "macos_ventura", label: "macOS Ventura", description: "Ventura Dark", imageUrl: macVentura, category: "macos", tone: "dark" },
  { id: "macos_big_sur", label: "macOS Big Sur", description: "Big Sur Night", imageUrl: macBigSur, category: "macos", tone: "dark" },
  { id: "macos_mojave", label: "macOS Mojave", description: "Mojave Night", imageUrl: macMojave, category: "macos", tone: "dark" },
  { id: "earth_and_moon", label: "Earth & Moon", description: "Earth and moon", imageUrl: macEarth, category: "macos", tone: "dark" },
  { id: "milky_way", label: "Milky Way", description: "Night sky and stars", imageUrl: macMilkyWay, category: "macos", tone: "dark" },
  { id: "win11_default_dark", label: "Win11 Dark", description: "Windows 11 Default Dark", imageUrl: win11DefaultDark, category: "win11", tone: "dark" },
  { id: "dark_city", label: "Dark City", description: "Night city distance", imageUrl: darkCityBg, category: "warp", tone: "dark" },
  { id: "catppuccin_black_hole", label: "Black Hole", description: "Deep space black hole", imageUrl: catBlackHole, category: "catppuccin", tone: "dark" },
  { id: "catppuccin_atlantis", label: "Atlantis", description: "Underwater ruins", imageUrl: catAtlantis, category: "catppuccin", tone: "dark" },
  { id: "catppuccin_blueprint", label: "Blueprint", description: "Technical blueprint", imageUrl: catBlueprint, category: "catppuccin", tone: "dark" },
  { id: "catppuccin_bsod", label: "BSOD", description: "Blue Screen of Death", imageUrl: catBsod, category: "catppuccin", tone: "dark" },
  { id: "catppuccin_abandoned_station", label: "Abandoned Station", description: "Deserted station", imageUrl: catAbandonedStation, category: "catppuccin", tone: "dark" },
  { id: "catppuccin_abstract_swirls", label: "Abstract Swirls", description: "Abstract swirls", imageUrl: catAbstractSwirls, category: "catppuccin", tone: "dark" },
  { id: "oppenheimer", label: "Oppenheimer", description: "High contrast cinematic", imageUrl: oppenheimerBg, category: "warp", tone: "dark" },
  { id: "jellyfish", label: "Jellyfish", description: "Deep sea jellyfish", imageUrl: jellyfishBg, category: "warp", tone: "dark" },
  { id: "koi", label: "Koi", description: "Water and koi", imageUrl: koiBg, category: "warp", tone: "dark" },
  { id: "leafy", label: "Leafy", description: "Layered leaves", imageUrl: leafyBg, category: "warp", tone: "dark" },

  { id: "macos_sonoma", label: "macOS Sonoma", description: "Sonoma Dark", imageUrl: macSonoma, category: "macos", tone: "mid" },
  { id: "macos_high_sierra", label: "macOS High Sierra", description: "High Sierra", imageUrl: macHighSierra, category: "macos", tone: "mid" },
  { id: "macos_sierra", label: "macOS Sierra", description: "Sierra", imageUrl: macSierra, category: "macos", tone: "mid" },
  { id: "macos_el_capitan", label: "macOS El Capitan", description: "El Capitan", imageUrl: macElCapitan, category: "macos", tone: "mid" },
  { id: "macos_yosemite", label: "macOS Yosemite", description: "Yosemite", imageUrl: macYosemite, category: "macos", tone: "mid" },
  { id: "antelope_canyon", label: "Antelope Canyon", description: "Antelope Canyon", imageUrl: macAntelope, category: "macos", tone: "mid" },
  { id: "red_rock", label: "Red Rock", description: "Red rock landscape", imageUrl: redRockBg, category: "warp", tone: "mid" },
  { id: "asteroid_city", label: "Asteroid City", description: "Desert motel palette", imageUrl: asteroidCityBg, category: "warp", tone: "mid" },
  { id: "thanksgiving", label: "Thanksgiving", description: "Autumn harvest tones", imageUrl: thanksgivingBg, category: "warp", tone: "mid" },
  { id: "warp", label: "Warp", description: "Warp original", imageUrl: warpBg, category: "warp", tone: "mid" },
  { id: "grafbase", label: "Grafbase", description: "Simple graph texture", imageUrl: grafbaseBg, category: "warp", tone: "mid" },
  { id: "win11_motion_01", label: "Win11 Motion 1", description: "Captured Motion", imageUrl: win11Motion01, category: "win11", tone: "mid" },
  { id: "win11_motion_02", label: "Win11 Motion 2", description: "Captured Motion", imageUrl: win11Motion02, category: "win11", tone: "mid" },
  { id: "win11_motion_03", label: "Win11 Motion 3", description: "Captured Motion", imageUrl: win11Motion03, category: "win11", tone: "mid" },
  { id: "win11_motion_04", label: "Win11 Motion 4", description: "Captured Motion", imageUrl: win11Motion04, category: "win11", tone: "mid" },
  { id: "win11_spectrum_01", label: "Win11 Spectrum 1", description: "Spectrum", imageUrl: win11Spectrum01, category: "win11", tone: "mid" },
  { id: "win11_spectrum_02", label: "Win11 Spectrum 2", description: "Spectrum", imageUrl: win11Spectrum02, category: "win11", tone: "mid" },
  { id: "win11_spectrum_03", label: "Win11 Spectrum 3", description: "Spectrum", imageUrl: win11Spectrum03, category: "win11", tone: "mid" },
  { id: "win11_spectrum_04", label: "Win11 Spectrum 4", description: "Spectrum", imageUrl: win11Spectrum04, category: "win11", tone: "mid" },
  { id: "win11_flow_01", label: "Win11 Flow 1", description: "Flow", imageUrl: win11Flow01, category: "win11", tone: "mid" },
  { id: "win11_flow_02", label: "Win11 Flow 2", description: "Flow", imageUrl: win11Flow02, category: "win11", tone: "mid" },
  { id: "win11_flow_03", label: "Win11 Flow 3", description: "Flow", imageUrl: win11Flow03, category: "win11", tone: "mid" },
  { id: "win11_flow_04", label: "Win11 Flow 4", description: "Flow", imageUrl: win11Flow04, category: "win11", tone: "mid" },
  { id: "catppuccin_bluehour", label: "Blue Hour", description: "Blue hour skyline", imageUrl: catBlueHour, category: "catppuccin", tone: "mid" },
  { id: "catppuccin_artificial_valley", label: "Artificial Valley", description: "Artificial valley", imageUrl: catArtificialValley, category: "catppuccin", tone: "mid" },
  { id: "catppuccin_blue_landscape", label: "Blue Landscape", description: "Blue landscape", imageUrl: catBlueLandscape, category: "catppuccin", tone: "mid" },
  { id: "catppuccin_3d_model", label: "3D Model", description: "3D wireframe model", imageUrl: cat3dModel, category: "catppuccin", tone: "mid" },
  { id: "catppuccin_cabin", label: "Cabin", description: "Mountain cabin", imageUrl: catCabin, category: "catppuccin", tone: "mid" },
  { id: "catppuccin_aesthetic", label: "Aesthetic", description: "Aesthetic room", imageUrl: catAesthetic, category: "catppuccin", tone: "mid" },

  { id: "marble", label: "Marble", description: "Marble texture", imageUrl: marbleBg, category: "warp", tone: "bright" },
  { id: "pink_city", label: "Pink City", description: "Pink city lights", imageUrl: pinkCityBg, category: "warp", tone: "bright" },
  { id: "snowy", label: "Snowy", description: "Snow mountain quiet", imageUrl: snowyBg, category: "warp", tone: "bright" },
  { id: "winter", label: "Winter", description: "Winter snow light", imageUrl: winterBg, category: "warp", tone: "bright" },
  { id: "barbie", label: "Barbie", description: "Bright pink theme", imageUrl: barbieBg, category: "warp", tone: "bright" },
  { id: "pride", label: "Pride", description: "Rainbow pride colors", imageUrl: prideBg, category: "warp", tone: "bright" },
  { id: "lumon", label: "Lumon", description: "Clean white workspace", imageUrl: lumonBg, category: "warp", tone: "bright" },
  { id: "win11_bloom_01", label: "Win11 Bloom 1", description: "Bloom", imageUrl: win11Bloom01, category: "win11", tone: "bright" },
  { id: "win11_bloom_02", label: "Win11 Bloom 2", description: "Bloom", imageUrl: win11Bloom02, category: "win11", tone: "bright" },
  { id: "win11_bloom_03", label: "Win11 Bloom 3", description: "Bloom", imageUrl: win11Bloom03, category: "win11", tone: "bright" },
  { id: "win11_bloom_04", label: "Win11 Bloom 4", description: "Bloom", imageUrl: win11Bloom04, category: "win11", tone: "bright" },
  { id: "win11_default_bloom", label: "Win11 Bloom", description: "Windows 11 Default", imageUrl: win11DefaultBloom, category: "win11", tone: "bright" },
];

export function normalizeThemeBackground(input: unknown): ThemeBackgroundSettings {
  const record = toRecord(input);
  if (!record) {
    return DEFAULT_THEME_BACKGROUND;
  }

  const rawMode =
    record.mode === "solid" || record.mode === "preset" || record.mode === "image"
      ? record.mode
      : "preset";
  const presetId =
    typeof record.presetId === "string" &&
    THEME_BACKGROUND_PRESETS.some((preset) => preset.id === record.presetId)
      ? record.presetId
      : DEFAULT_THEME_BACKGROUND.presetId;
  const imagePath =
    typeof record.imagePath === "string" && !/[\r\n]/.test(record.imagePath) && record.imagePath.length <= 2048
      ? record.imagePath
      : "";
  const mode = rawMode === "image" && !imagePath ? "preset" : rawMode;

  return {
    mode,
    presetId,
    imagePath,
    imageOpacity: normalizeNumber(record.imageOpacity, 0, 1, DEFAULT_THEME_BACKGROUND.imageOpacity),
    imageBlur: normalizeNumber(record.imageBlur, 0, 32, DEFAULT_THEME_BACKGROUND.imageBlur),
    imageDim: normalizeNumber(record.imageDim, 0, 0.85, DEFAULT_THEME_BACKGROUND.imageDim),
    panelOpacity: normalizeNumber(record.panelOpacity, 0.2, 1, DEFAULT_THEME_BACKGROUND.panelOpacity),
    terminalOpacity: normalizeNumber(record.terminalOpacity, 0.2, 1, DEFAULT_THEME_BACKGROUND.terminalOpacity),
  };
}

export function isDefaultThemeBackground(background: ThemeBackgroundSettings): boolean {
  return (
    background.mode === DEFAULT_THEME_BACKGROUND.mode &&
    background.presetId === DEFAULT_THEME_BACKGROUND.presetId &&
    background.imagePath === DEFAULT_THEME_BACKGROUND.imagePath &&
    background.imageOpacity === DEFAULT_THEME_BACKGROUND.imageOpacity &&
    background.imageBlur === DEFAULT_THEME_BACKGROUND.imageBlur &&
    background.imageDim === DEFAULT_THEME_BACKGROUND.imageDim &&
    background.panelOpacity === DEFAULT_THEME_BACKGROUND.panelOpacity &&
    background.terminalOpacity === DEFAULT_THEME_BACKGROUND.terminalOpacity
  );
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
