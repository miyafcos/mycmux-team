import type { CSSProperties } from "react";
import type { ThemeBackgroundSettings, ThemeDefinition } from "../../types";
import { UI_DENSITY_TOKENS, type UiDensity } from "../../stores/themeStore";
import { lightnessLiftFor, macQuietTextOverrides, macSurfaceOverrides } from "../../lib/theme/macSurfaces";
import { isMediaBackgroundActive, resolveTheme, resolvedThemeToCssVars, type ResolvedTheme } from "../../lib/theme/resolveTheme";
import { IS_MAC } from "../../lib/keybindings";

// Colour derivation no longer lives here. `resolveTheme()` in
// src/lib/theme/resolveTheme.ts owns every colour-mix, wallpaper alpha and
// light/dark branch that used to be inlined below, so the palette can be tested
// without rendering the app. This file only assembles the CSS custom property
// bag: typography and spacing from the density tokens, colours from the
// resolver.

export function dashboardTypographyVars(
  fontFamily: string,
  fontSize: number,
  lineHeight: number,
  uiFontScale: number,
) {
  return {
    "--cmux-dash-body-font": fontFamily,
    "--cmux-dash-font-size": `${Math.max(10, Math.round(fontSize * uiFontScale))}px`,
    "--cmux-dash-line-height": String(lineHeight),
  };
}

/** macOS only; the arithmetic and its reasons live in macSurfaces. */
function macQuietTextCompensation(
  resolved: ResolvedTheme,
  surfaceLift: number,
): Record<string, string> {
  return IS_MAC ? macQuietTextOverrides({ ...resolved, surfaceLift }) : {};
}

export interface ThemeVarsInput {
  theme: ThemeDefinition;
  background: ThemeBackgroundSettings;
  uiDensity: UiDensity;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  uiFontScale: number;
  /**
   * Whether a wallpaper is really being painted. Defaults to what the settings
   * ask for; the app passes the narrower answer, because a preset that has not
   * been downloaded yet must composite as if there were no wallpaper at all.
   */
  mediaActive?: boolean;
}

/**
 * The CSS custom property bag painted on the app root.
 *
 * Typography and spacing are derived here from the density tokens; every colour
 * comes from `resolveTheme()`. Exported (and pure) so the resolver's output can
 * be diffed against the pre-refactor derivation in tests — see
 * tests/unit/resolveTheme.test.ts.
 */
export function buildThemeVars(input: ThemeVarsInput): CSSProperties {
  const { theme, background, uiDensity, fontFamily, fontSize, lineHeight, uiFontScale } = input;
  const mediaActive = input.mediaActive ?? isMediaBackgroundActive(background);

  const densityTokens = UI_DENSITY_TOKENS[uiDensity];
  const densitySpace = (base: number) => `${Math.round(base * densityTokens.spaceScale)}px`;
  const scalePx = (value: string) => {
    if (uiFontScale === 1) return value;
    return `${Math.max(11, Math.round(Number.parseFloat(value) * uiFontScale))}px`;
  };

  const { resolved } = resolveTheme({ theme, background, mediaActive });

  // Named because the macOS surface pass reads the same map it writes into:
  // the lift is computed from the ground and panel tiers this theme resolved
  // to, not from the raw palette, so a wallpaper composite is accounted for.
  const themeVars = resolvedThemeToCssVars(resolved);

  const surfaceLift = lightnessLiftFor(themeVars["--cmux-bg"] ?? "", themeVars["--cmux-surface"] ?? "");
  const surfaceOverrides = macSurfaceOverrides({
    background: themeVars["--cmux-bg"] ?? "",
    surface: themeVars["--cmux-surface"] ?? "",
    tokens: themeVars,
  });

  return {
    "--cmux-font-size-xs": scalePx(densityTokens.fontXs),
    "--cmux-font-size-sm": scalePx(densityTokens.fontSm),
    "--cmux-font-size-md": scalePx(densityTokens.fontMd),
    "--cmux-line-height-ui": densityTokens.lineHeightUi,
    ...dashboardTypographyVars(fontFamily, fontSize, lineHeight, uiFontScale),
    "--cmux-space-1": densitySpace(2),
    "--cmux-space-2": densitySpace(4),
    "--cmux-space-3": densitySpace(6),
    "--cmux-space-4": densitySpace(8),
    "--cmux-space-5": densitySpace(10),
    "--cmux-space-6": densitySpace(12),
    "--cmux-space-7": densitySpace(16),
    ...themeVars,
    ...(IS_MAC ? surfaceOverrides : {}),
    // The same lift, so the quiet glyphs travel with the panels they sit on
    // rather than staying put while the ground under them brightens.
    ...macQuietTextCompensation(resolved, IS_MAC ? surfaceLift : 0),
    colorScheme: resolved.colorScheme,
  } as CSSProperties;
}
