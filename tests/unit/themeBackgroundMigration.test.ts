// The imageDim -> wallpaperTone migration
// (docs/design/2026-08-20-light-theme-system.md section 4).
//
// `imageDim` was a 0-0.85 black scrim painted as `rgba(0, 0, 0, imageDim)`.
// Stage 2 replaces it with a signed `wallpaperTone`: negative toward black,
// positive toward the theme's paper. Every existing install has `imageDim` in
// its data.json, so if the read path does not translate it, the wallpaper
// changes appearance for all of them — an 8% black veil silently becoming no
// veil, or worse, an 8% wash toward paper.
//
// These tests pin the translation and, more to the point, pin the *painted
// result*: AppBackgroundLayer paints `wallpaperToneColor` at
// `Math.abs(wallpaperTone)`, so a migrated setting has to come out as the same
// colour at the same opacity it always was.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_THEME_BACKGROUND,
  isDefaultThemeBackground,
  normalizeThemeBackground,
} from "../../src/lib/themeBackgrounds";
import { resolveCompositionPolicy } from "../../src/lib/theme/resolveTheme";
import { THEMES } from "../../src/components/theme/themeDefinitions";

const DARK_THEME = THEMES.find((theme) => theme.id === "mayonaka")!;
const LIGHT_THEME = THEMES.find((theme) => theme.id === "asanagi")!;

/** A data.json entry written by any build before stage 2. */
function legacySettings(imageDim: number): Record<string, unknown> {
  return {
    mode: "preset",
    presetId: "macos_monterey",
    imagePath: "",
    imageOpacity: 1,
    imageBlur: 0,
    imageDim,
    panelOpacity: 0.68,
    terminalOpacity: 0.62,
  };
}

/** What AppBackgroundLayer ends up painting over the wallpaper. */
function paintedToneLayer(
  imageDim: number | undefined,
  theme = DARK_THEME,
  storedTone?: number,
): { color: string; opacity: number } {
  const stored = legacySettings(imageDim ?? 0.08);
  const background = normalizeThemeBackground(
    storedTone === undefined ? stored : { ...stored, wallpaperTone: storedTone },
  );
  const policy = resolveCompositionPolicy(theme, background, true);
  return { color: policy.wallpaperToneColor, opacity: Math.abs(policy.wallpaperTone) };
}

describe("normalizeThemeBackground migrates imageDim", () => {
  it("reads the shipped default as the same 8% black scrim it always was", () => {
    expect(normalizeThemeBackground(legacySettings(0.08)).wallpaperTone).toBeCloseTo(-0.08, 10);
    expect(DEFAULT_THEME_BACKGROUND.wallpaperTone).toBeCloseTo(-0.08, 10);
  });

  it("reads a customised dim as the same scrim, not as a flipped one", () => {
    for (const dim of [0, 0.05, 0.2, 0.4, 0.85]) {
      expect(normalizeThemeBackground(legacySettings(dim)).wallpaperTone, `imageDim ${dim}`).toBeCloseTo(-dim, 10);
    }
  });

  it("keeps a deliberate zero at zero instead of snapping back to the default", () => {
    // A user who dragged the old slider to 0 wanted no veil. Falling through to
    // the default would put an 8% one back.
    expect(normalizeThemeBackground(legacySettings(0)).wallpaperTone).toBe(0);
  });

  it("clamps out-of-range legacy values into the signed range", () => {
    expect(normalizeThemeBackground(legacySettings(4)).wallpaperTone).toBeCloseTo(-0.85, 10);
    expect(normalizeThemeBackground(legacySettings(-3)).wallpaperTone).toBe(0);
  });

  it("prefers a stored wallpaperTone over a stale imageDim", () => {
    const record = { ...legacySettings(0.4), wallpaperTone: 0.25 };
    expect(normalizeThemeBackground(record).wallpaperTone).toBeCloseTo(0.25, 10);
  });

  it("clamps a stored wallpaperTone in both directions", () => {
    expect(normalizeThemeBackground({ wallpaperTone: 5 }).wallpaperTone).toBeCloseTo(0.85, 10);
    expect(normalizeThemeBackground({ wallpaperTone: -5 }).wallpaperTone).toBeCloseTo(-0.85, 10);
    expect(normalizeThemeBackground({ wallpaperTone: Number.NaN }).wallpaperTone).toBeCloseTo(-0.08, 10);
  });

  it("falls back to the default when neither field is present", () => {
    const { imageDim: _dropped, ...withoutDim } = legacySettings(0.5);
    expect(normalizeThemeBackground(withoutDim).wallpaperTone).toBeCloseTo(-0.08, 10);
    expect(normalizeThemeBackground({}).wallpaperTone).toBeCloseTo(-0.08, 10);
    expect(normalizeThemeBackground(null).wallpaperTone).toBeCloseTo(-0.08, 10);
  });

  it("is idempotent, so a migrated setting survives being saved and read again", () => {
    for (const dim of [0, 0.08, 0.33, 0.85]) {
      const once = normalizeThemeBackground(legacySettings(dim));
      const twice = normalizeThemeBackground({ ...once });
      expect(twice, `imageDim ${dim}`).toEqual(once);
    }
  });

  it("still recognises a migrated default install as untouched", () => {
    // The shipped default is now solid (wallpapers are downloaded on demand),
    // so "untouched" is measured against that. The migrated *tone* still has
    // to match the default, which is what this pins: a legacy 0.08 comes back
    // as the shipped tone, a legacy 0.4 does not.
    const asShipped = (dim: number) =>
      normalizeThemeBackground({ ...legacySettings(dim), mode: DEFAULT_THEME_BACKGROUND.mode });
    expect(isDefaultThemeBackground(asShipped(0.08))).toBe(true);
    expect(isDefaultThemeBackground(asShipped(0.4))).toBe(false);
  });
});

describe("a migrated setting paints the same wallpaper it did before", () => {
  it.each([0, 0.08, 0.2, 0.4, 0.85])(
    "dark theme with imageDim %s keeps painting rgba(0, 0, 0, imageDim)",
    (dim) => {
      const painted = paintedToneLayer(dim);
      expect(painted.color).toBe("#000000");
      expect(painted.opacity).toBeCloseTo(dim, 10);
    },
  );

  it("light themes on a customised dim also keep the black scrim", () => {
    const painted = paintedToneLayer(0.4, LIGHT_THEME);
    expect(painted.color).toBe("#000000");
    expect(painted.opacity).toBeCloseTo(0.4, 10);
  });

  it("light themes on the untouched default keep the black scrim too", () => {
    // Stage 2b read the stored default as a +0.25 wash toward the theme's
    // paper on light themes only. It bleached the wallpaper, and because it
    // keyed off the stored value being the default it also meant a light-theme
    // user could not move the tone slider back. One scrim, both schemes.
    const painted = paintedToneLayer(0.08, LIGHT_THEME);
    expect(painted.color).toBe("#000000");
    expect(painted.opacity).toBeCloseTo(0.08, 10);
  });

  it("still lets a light theme ask for a paper wash explicitly", () => {
    // The signed mechanism survives the revert; only the default moved back.
    const painted = paintedToneLayer(undefined, LIGHT_THEME, 0.3);
    expect(painted.color).toBe(LIGHT_THEME.chrome.surface);
    expect(painted.opacity).toBeCloseTo(0.3, 10);
  });
});
