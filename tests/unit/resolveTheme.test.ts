// @vitest-environment jsdom
//
// The light-theme work, stages 1 and 2
// (docs/design/2026-08-20-light-theme-system.md).
//
// Stage 1 lifted the colour derivation out of AppShell.tsx into a pure resolver
// and was not allowed to change a single rendered pixel. The only way to say
// that with a straight face is to keep the pre-refactor derivation around and
// diff it, so `legacyThemeVars()` below is a verbatim copy of AppShell.tsx's
// `themeVars` as of commit 79fd79f — local helpers included, so it does not
// import any of the code under test.
//
// Stage 2 changes the light values on purpose, and is equally not allowed to
// move a dark theme. So the diff survives, narrowed to the 21 dark themes,
// while the nine light ones are held to the new invariants instead:
//
//   * the surface ladder (memo section 3),
//   * the composition policy (section 4),
//   * foregrounds, surfaces and borders resolving opaque (section 4),
//   * the imageDim -> wallpaperTone migration (section 4).
//
// Stages 2b and 2c withdrew stage 2's compositing changes. The light panels
// are translucent again at whatever the user set, the wallpaper scrim is the
// original 8% toward black on both schemes, and the light text is derived
// against the theme's own opaque surfaces rather than against a panel
// composited over a pure-black wallpaper. The assertions below follow that -
// what used to pin 0.80 / 0.86 now pins pass-through, and what used to pin a
// wallpaper-dependent palette now pins a wallpaper-independent one.
//
// The contrast floors, and the composited measurements that are reported but
// no longer guaranteed, live in themeContrast.test.ts.

import { describe, expect, it } from "vitest";

import { buildThemeVars } from "../../src/components/layout/AppShell";
import {
  colorAlpha,
  DEFAULT_WALLPAPER_TONE,
  isMediaBackgroundActive,
  LIGHT_TEXT_LEVEL_POSITIONS,
  MIN_TEXT_LEVEL_STEP_L,
  RESOLVED_THEME_TOKENS,
  resolveCompositionPolicy,
  resolveSurfaceLadder,
  resolveTheme,
  resolvedThemeToCssVars,
  textLadderLevels,
  textLadderStepsL,
  TEXT_CONTRAST_FLOOR,
  lightTextHosts,
  resolveLightTextLadder,
  WORST_CASE_BACKDROP,
  worstCaseBackdrop,
} from "../../src/lib/theme/resolveTheme";
import { compositeOver, oklabLightness } from "../../src/lib/theme/oklab";
import { DEFAULT_THEME_BACKGROUND } from "../../src/lib/themeBackgrounds";
import { contrastRatio as ratio, relativeLuminance } from "../../src/components/theme/colorContrast";
import { THEMES } from "../../src/components/theme/themeDefinitions";
import {
  contrastRatio,
  isHexColor,
  resolveAccentTextColor,
} from "../../src/components/theme/colorContrast";
import { UI_DENSITY_TOKENS, type UiDensity } from "../../src/stores/themeStore";
import type { ThemeBackgroundSettings, ThemeDefinition } from "../../src/types";

// ---------------------------------------------------------------------------
// The pre-refactor derivation, frozen.
// ---------------------------------------------------------------------------

function legacyColorWithOpacity(color: string, opacity: number): string {
  if (opacity >= 0.995) {
    return color;
  }

  const shortHex = /^#([0-9a-f]{3})$/i.exec(color);
  const fullHex = /^#([0-9a-f]{6})$/i.exec(color);
  const hex = fullHex?.[1] ?? shortHex?.[1].split("").map((char) => `${char}${char}`).join("");
  if (!hex) {
    return color;
  }

  const red = parseInt(hex.slice(0, 2), 16);
  const green = parseInt(hex.slice(2, 4), 16);
  const blue = parseInt(hex.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${opacity})`;
}

const LEGACY_LIGHT_COLOR_LUMINANCE_THRESHOLD = 140;

function legacyIsLightColor(color: string): boolean {
  const shortHex = /^#([0-9a-f]{3})$/i.exec(color);
  const fullHex = /^#([0-9a-f]{6})$/i.exec(color);
  const hex = fullHex?.[1] ?? shortHex?.[1].split("").map((char) => `${char}${char}`).join("");
  if (!hex) {
    return false;
  }
  const red = parseInt(hex.slice(0, 2), 16);
  const green = parseInt(hex.slice(2, 4), 16);
  const blue = parseInt(hex.slice(4, 6), 16);
  return (red * 299 + green * 587 + blue * 114) / 1000 > LEGACY_LIGHT_COLOR_LUMINANCE_THRESHOLD;
}

function legacyTextOnColor(color: string): string {
  if (!isHexColor(color)) {
    return "#ffffff";
  }
  return contrastRatio("#ffffff", color) >= 4.5 ? "#ffffff" : "#000000";
}

function legacyDashboardTypographyVars(
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

interface ThemeVarsCase {
  theme: ThemeDefinition;
  background: ThemeBackgroundSettings;
  uiDensity: UiDensity;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  uiFontScale: number;
}

function legacyThemeVars(input: ThemeVarsCase): Record<string, string> {
  const currentTheme = input.theme;
  const themeBackground = input.background;
  const { uiDensity, fontFamily, fontSize, lineHeight, uiFontScale } = input;

  const isLightChrome = legacyIsLightColor(currentTheme.chrome.background);
  const mediaBackgroundActive = themeBackground.mode === "preset" || (
    themeBackground.mode === "image" && themeBackground.imagePath.length > 0
  );
  const panelOpacity = mediaBackgroundActive ? themeBackground.panelOpacity : 1;
  const withPanelOpacity = (color: string) =>
    panelOpacity >= 0.995
      ? color
      : `color-mix(in srgb, ${color} ${(panelOpacity * 100).toFixed(2)}%, transparent)`;

  const densityTokens = UI_DENSITY_TOKENS[uiDensity];
  const densitySpace = (base: number) => `${Math.round(base * densityTokens.spaceScale)}px`;
  const scalePx = (value: string) => {
    if (uiFontScale === 1) return value;
    return `${Math.max(11, Math.round(Number.parseFloat(value) * uiFontScale))}px`;
  };

  return {
    "--cmux-font-size-xs": scalePx(densityTokens.fontXs),
    "--cmux-font-size-sm": scalePx(densityTokens.fontSm),
    "--cmux-font-size-md": scalePx(densityTokens.fontMd),
    "--cmux-line-height-ui": densityTokens.lineHeightUi,
    ...legacyDashboardTypographyVars(fontFamily, fontSize, lineHeight, uiFontScale),
    "--cmux-space-1": densitySpace(2),
    "--cmux-space-2": densitySpace(4),
    "--cmux-space-3": densitySpace(6),
    "--cmux-space-4": densitySpace(8),
    "--cmux-space-5": densitySpace(10),
    "--cmux-space-6": densitySpace(12),
    "--cmux-space-7": densitySpace(16),
    "--cmux-bg-solid": currentTheme.chrome.background,
    "--cmux-surface-solid": currentTheme.chrome.surface,
    "--cmux-bg": legacyColorWithOpacity(currentTheme.chrome.background, panelOpacity),
    "--cmux-sidebar": legacyColorWithOpacity(currentTheme.chrome.surface, panelOpacity),
    "--cmux-surface-raised": withPanelOpacity(
      isLightChrome
        ? `color-mix(in srgb, ${currentTheme.chrome.surface} 97%, black)`
        : `color-mix(in srgb, ${currentTheme.chrome.surface} 96%, white)`,
    ),
    "--cmux-popover": isLightChrome
      ? `color-mix(in srgb, ${currentTheme.chrome.surface} 95%, black)`
      : `color-mix(in srgb, ${currentTheme.chrome.surface} 93%, white)`,
    "--cmux-title-bg": legacyColorWithOpacity(currentTheme.chrome.background, panelOpacity),
    "--cmux-surface": legacyColorWithOpacity(currentTheme.chrome.surface, panelOpacity),
    "--cmux-terminal-bg": legacyColorWithOpacity(
      currentTheme.terminal.background,
      mediaBackgroundActive ? themeBackground.terminalOpacity : 1,
    ),
    "--cmux-accent": currentTheme.chrome.accent,
    "--cmux-accent-text": resolveAccentTextColor(
      currentTheme.chrome.accent,
      currentTheme.chrome.text,
      currentTheme.chrome.background,
    ),
    "--cmux-border": currentTheme.chrome.border,
    "--cmux-border-hairline": isLightChrome
      ? `color-mix(in srgb, ${currentTheme.chrome.border} 70%, transparent)`
      : "rgba(255, 255, 255, 0.07)",
    "--cmux-text": currentTheme.chrome.text,
    "--cmux-text-secondary": currentTheme.chrome.textMuted,
    "--cmux-text-tertiary": currentTheme.chrome.textDim,
    "--cmux-text-dim": currentTheme.chrome.textDim,
    "--cmux-hover": currentTheme.chrome.hover,
    "--cmux-selected": currentTheme.chrome.selected,
    "--cmux-red": currentTheme.chrome.danger,
    "--cmux-yellow": currentTheme.status.waiting,
    "--cmux-on-accent": legacyTextOnColor(currentTheme.chrome.accent),
    "--cmux-on-working": legacyTextOnColor(currentTheme.status.working),
    "--cmux-on-waiting": legacyTextOnColor(currentTheme.status.waiting),
    "--cmux-on-done": legacyTextOnColor(currentTheme.status.done),
    "--cmux-on-error": legacyTextOnColor(currentTheme.status.error),
    "--cmux-status-stall": currentTheme.status.stall,
    "--cmux-on-stall": legacyTextOnColor(currentTheme.status.stall),
    "--cmux-backdrop": isLightChrome ? "rgba(15, 23, 42, 0.22)" : "rgba(0, 0, 0, 0.55)",
    "--cmux-edge-highlight": isLightChrome
      ? "inset 0 1px 0 rgba(255, 255, 255, 0.6)"
      : "inset 0 1px 0 rgba(255, 255, 255, 0.05)",
    "--cmux-focus-ring": "color-mix(in srgb, var(--cmux-accent) 45%, transparent)",
    "--cmux-dnd-tab": isLightChrome ? currentTheme.status.working : "#38bdf8",
    "--cmux-dnd-pane": isLightChrome ? currentTheme.status.waiting : "#f59e0b",
    "--cmux-usage-ok": isLightChrome ? currentTheme.status.done : "#3eb86b",
    "--cmux-usage-warn": isLightChrome ? currentTheme.status.waiting : "#f5a623",
    "--cmux-usage-danger": isLightChrome ? currentTheme.status.error : "#ff3b30",
    "--cmux-shadow-menu": isLightChrome ? "var(--cmux-edge-highlight), 0 8px 20px rgba(15, 23, 42, 0.16)" : "var(--cmux-edge-highlight), 0 4px 12px rgba(0, 0, 0, 0.5)",
    "--cmux-shadow-popover": isLightChrome ? "var(--cmux-edge-highlight), 0 8px 26px rgba(15, 23, 42, 0.16)" : "var(--cmux-edge-highlight), 0 4px 16px rgba(0,0,0,0.4)",
    "--cmux-shadow-dropdown": isLightChrome ? "var(--cmux-edge-highlight), 0 12px 28px rgba(15, 23, 42, 0.16)" : "var(--cmux-edge-highlight), 0 10px 24px rgba(0, 0, 0, 0.32)",
    "--cmux-shadow-dialog": isLightChrome ? "var(--cmux-edge-highlight), 0 20px 60px rgba(15, 23, 42, 0.18)" : "var(--cmux-edge-highlight), 0 18px 60px rgba(0,0,0,0.45)",
    "--cmux-shadow-palette": isLightChrome ? "var(--cmux-edge-highlight), 0 24px 70px rgba(15, 23, 42, 0.18)" : "var(--cmux-edge-highlight), 0 24px 70px rgba(0,0,0,0.45)",
    "--cmux-shadow-pane-menu": isLightChrome ? "var(--cmux-edge-highlight), 0 8px 18px rgba(15, 23, 42, 0.14)" : "var(--cmux-edge-highlight), 0 4px 12px rgba(0,0,0,0.2)",
    "--cmux-shadow-dnd": isLightChrome
      ? "0 14px 34px rgba(15, 23, 42, 0.18), inset 0 0 0 1px color-mix(in srgb, var(--cmux-text) 8%, transparent)"
      : "0 14px 34px rgba(0, 0, 0, 0.36), inset 0 0 0 1px rgba(255, 255, 255, 0.05)",
    "--cmux-shadow-dnd-strong": isLightChrome
      ? "0 16px 38px rgba(15, 23, 42, 0.22), 0 0 24px color-mix(in srgb, var(--pane-dnd-color) 18%, transparent)"
      : "0 16px 38px rgba(0, 0, 0, 0.42), 0 0 24px color-mix(in srgb, var(--pane-dnd-color) 22%, transparent)",
    "--cmux-shadow-dnd-label": isLightChrome ? "0 8px 20px rgba(15, 23, 42, 0.16)" : "0 6px 18px rgba(0, 0, 0, 0.34)",
    "--status-working": currentTheme.status.working,
    "--status-waiting": currentTheme.status.waiting,
    "--status-done": currentTheme.status.done,
    "--status-error": currentTheme.status.error,
    "--notification-color": currentTheme.notification,
    "--cmux-chrome-text-shadow": "none",
    "--cmux-chrome-icon-shadow": "none",
    colorScheme: currentTheme.colorScheme,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// The shipped defaults (src/lib/themeBackgrounds.ts DEFAULT_THEME_BACKGROUND),
// written out rather than spread so the numbers this file reasons about are
// visible in it. `mirrors the shipped background defaults` below proves the
// copy has not drifted, which is what makes the 0.68 / 0.62 assertions claims
// about the product rather than about a fixture.
const WALLPAPER_ON: ThemeBackgroundSettings = {
  mode: "preset",
  presetId: "macos_monterey",
  imagePath: "",
  imageOpacity: 1,
  imageBlur: 0,
  wallpaperTone: -0.08,
  panelOpacity: 0.68,
  terminalOpacity: 0.62,
};

/** The light chrome alpha the app actually ships with. */
const SHIPPED_CHROME_ALPHA = 0.68;
/** The light terminal alpha the app actually ships with. */
const SHIPPED_TERMINAL_ALPHA = 0.62;

const WALLPAPER_OFF: ThemeBackgroundSettings = { ...WALLPAPER_ON, mode: "solid" };

const WALLPAPER_STATES: ReadonlyArray<{ label: string; background: ThemeBackgroundSettings }> = [
  { label: "wallpaper on", background: WALLPAPER_ON },
  { label: "wallpaper off", background: WALLPAPER_OFF },
];

const BASE_TYPOGRAPHY = {
  uiDensity: "standard" as UiDensity,
  fontFamily: "UDEV Gothic NF",
  fontSize: 14,
  lineHeight: 1.35,
  uiFontScale: 1,
};

const DARK_THEMES = THEMES.filter((theme) => theme.colorScheme === "dark");
const LIGHT_THEMES = THEMES.filter((theme) => theme.colorScheme === "light");

// The one variable stage 2 adds. The pane tab strip has always painted
// --cmux-surface-raised through `var(--pane-tabbar-bg, var(--cmux-surface-raised))`
// in global.css; naming the variable lets the light branch put the strip on
// surface-low without touching PaneTabBar. On dark it resolves to exactly the
// colour the strip already had, which is asserted below rather than assumed.
const STAGE_2_ADDED_VAR = "--pane-tabbar-bg";

function compareVars(actual: Record<string, unknown>, expected: Record<string, unknown>, label: string): number {
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])]
    .filter((key) => key !== STAGE_2_ADDED_VAR)
    .sort();
  for (const key of keys) {
    expect(actual[key], `${label} / ${key}`).toBe(expected[key]);
  }
  return keys.length;
}

// ---------------------------------------------------------------------------
// 1. The equivalence proof — dark only, and still every variable
// ---------------------------------------------------------------------------

describe("resolveTheme leaves every dark theme byte-identical", () => {
  it("ships the 30 themes this proof claims to cover", () => {
    expect(THEMES).toHaveLength(30);
    expect(LIGHT_THEMES).toHaveLength(9);
    expect(DARK_THEMES).toHaveLength(21);
  });

  it("emits 53 colour variables plus 11 typography/spacing plus 3 dashboard plus colorScheme", () => {
    expect(RESOLVED_THEME_TOKENS).toHaveLength(53);
    expect(new Set(RESOLVED_THEME_TOKENS.map((token) => token.cssVar)).size).toBe(53);
    expect(RESOLVED_THEME_TOKENS.map((token) => token.cssVar)).toContain(STAGE_2_ADDED_VAR);

    const vars = buildThemeVars({ theme: THEMES[0], background: WALLPAPER_ON, ...BASE_TYPOGRAPHY });
    const keys = Object.keys(vars);
    expect(keys).toHaveLength(68);
    expect(keys.filter((key) => key.startsWith("--"))).toHaveLength(67);
    expect(keys).toContain("colorScheme");
  });

  it("matches for every dark theme under both wallpaper states, variable by variable", () => {
    let comparisons = 0;

    for (const theme of DARK_THEMES) {
      for (const state of WALLPAPER_STATES) {
        const label = `${theme.id} / ${state.label}`;
        const actual = buildThemeVars({
          theme,
          background: state.background,
          ...BASE_TYPOGRAPHY,
        }) as unknown as Record<string, unknown>;
        const expected = legacyThemeVars({
          theme,
          background: state.background,
          ...BASE_TYPOGRAPHY,
        }) as unknown as Record<string, unknown>;

        comparisons += compareVars(actual, expected, label);

        // The new variable is not an escape hatch: on dark it has to reproduce
        // the colour the strip was already painting.
        expect(actual[STAGE_2_ADDED_VAR], `${label} / ${STAGE_2_ADDED_VAR}`).toBe(
          expected["--cmux-surface-raised"],
        );
      }
    }

    // 21 dark themes x 2 wallpaper states x 67 pre-existing variables.
    expect(comparisons).toBe(2814);
  });
});

// ---------------------------------------------------------------------------
// 2. Branch coverage beyond the two required states
// ---------------------------------------------------------------------------

const EDGE_CASES: ReadonlyArray<{ label: string } & Omit<ThemeVarsCase, "theme">> = [
  {
    // A user image at full opacity: media active, but every opacity short-
    // circuits through the >= 0.995 branch.
    label: "user image, fully opaque panels, scaled-up UI font",
    background: {
      ...WALLPAPER_ON,
      mode: "image",
      imagePath: "C:/Users/miyaz/Pictures/wall.png",
      panelOpacity: 1,
      terminalOpacity: 1,
    },
    uiDensity: "compact",
    fontFamily: "Consolas",
    fontSize: 13,
    lineHeight: 1.2,
    uiFontScale: 1.25,
  },
  {
    // Exactly on the 0.995 boundary for the panels, translucent terminal.
    label: "panel opacity on the 0.995 boundary",
    background: { ...WALLPAPER_ON, panelOpacity: 0.995, terminalOpacity: 0.5 },
    uiDensity: "relaxed",
    fontFamily: "JetBrains Mono",
    fontSize: 16,
    lineHeight: 1.6,
    uiFontScale: 0.9,
  },
  {
    // mode: "image" with no path is NOT an active wallpaper — the opacities
    // must be ignored entirely.
    label: "image mode with an empty path stays opaque",
    background: { ...WALLPAPER_ON, mode: "image", imagePath: "", panelOpacity: 0.3, terminalOpacity: 0.3 },
    uiDensity: "standard",
    fontFamily: "UDEV Gothic",
    fontSize: 12,
    lineHeight: 1.0,
    uiFontScale: 1.5,
  },
];

describe("dark edge cases stay identical too", () => {
  it("matches for every dark theme across the opacity and density edge cases", () => {
    let comparisons = 0;

    for (const theme of DARK_THEMES) {
      for (const edge of EDGE_CASES) {
        const { label, ...rest } = edge;
        const actual = buildThemeVars({ theme, ...rest }) as unknown as Record<string, unknown>;
        const expected = legacyThemeVars({ theme, ...rest }) as unknown as Record<string, unknown>;
        comparisons += compareVars(actual, expected, `${theme.id} / ${label}`);
        expect(actual[STAGE_2_ADDED_VAR], `${theme.id} / ${label} / ${STAGE_2_ADDED_VAR}`).toBe(
          expected["--cmux-surface-raised"],
        );
      }
    }

    // 21 dark themes x 3 edge cases x 67 pre-existing variables.
    expect(comparisons).toBe(4221);
  });

  it("reads an empty image path as no wallpaper", () => {
    expect(isMediaBackgroundActive({ ...WALLPAPER_ON, mode: "image", imagePath: "" })).toBe(false);
    expect(isMediaBackgroundActive({ ...WALLPAPER_ON, mode: "image", imagePath: "x.png" })).toBe(true);
    expect(isMediaBackgroundActive({ ...WALLPAPER_ON, mode: "solid" })).toBe(false);
    expect(isMediaBackgroundActive(WALLPAPER_ON)).toBe(true);
  });

  it("is pure: the same input yields the same output object contents", () => {
    const once = resolveTheme({ theme: THEMES[0], background: WALLPAPER_ON, mediaActive: true }).resolved;
    const twice = resolveTheme({ theme: THEMES[0], background: WALLPAPER_ON, mediaActive: true }).resolved;
    expect(once).toEqual(twice);
    expect(once).not.toBe(twice);
  });
});

// ---------------------------------------------------------------------------
// 3. The light surface ladder (design memo section 3)
// ---------------------------------------------------------------------------

describe("light surface ladder", () => {
  it.each(LIGHT_THEMES.map((theme) => [theme.id, theme] as const))(
    "%s: L(canvas) < L(surface-low) < L(surface) <= L(raised) <= L(popover)",
    (id, theme) => {
      const ladder = resolveSurfaceLadder(theme);
      const lightness = (color: string) => {
        const value = oklabLightness(color);
        expect(value, `${id}: ${color} is not a measurable opaque colour`).not.toBeNull();
        return value as number;
      };

      const canvas = lightness(ladder.canvas);
      const surfaceLow = lightness(ladder.surfaceLow);
      const surface = lightness(ladder.surface);
      const raised = lightness(ladder.surfaceRaised);
      const popover = lightness(ladder.popover);

      expect(canvas, `${id}: canvas ${canvas} must sit below surface-low ${surfaceLow}`).toBeLessThan(surfaceLow);
      expect(surfaceLow, `${id}: surface-low ${surfaceLow} must sit below surface ${surface}`).toBeLessThan(surface);
      expect(surface, `${id}: surface ${surface} must not sit above raised ${raised}`).toBeLessThanOrEqual(raised);
      expect(raised, `${id}: raised ${raised} must not sit above popover ${popover}`).toBeLessThanOrEqual(popover);
    },
  );

  it("puts surface-low 40% of the way from paper to canvas on all nine", () => {
    for (const theme of LIGHT_THEMES) {
      const ladder = resolveSurfaceLadder(theme);
      const canvas = oklabLightness(ladder.canvas) as number;
      const paper = oklabLightness(ladder.surface) as number;
      const surfaceLow = oklabLightness(ladder.surfaceLow) as number;
      const fraction = (paper - surfaceLow) / (paper - canvas);
      // Not exactly 0.40: the mix is exact in OKLab and then quantised to 8-bit
      // sRGB, which moves the measured fraction by well under a percent.
      expect(fraction, `${theme.id}: surface-low sits at ${fraction} of the gap`).toBeGreaterThan(0.37);
      expect(fraction, `${theme.id}: surface-low sits at ${fraction} of the gap`).toBeLessThan(0.43);
    }
  });

  it("keeps raised and popover on the paper anchor instead of darkening them", () => {
    for (const theme of LIGHT_THEMES) {
      const ladder = resolveSurfaceLadder(theme);
      expect(ladder.surface, theme.id).toBe(theme.chrome.surface);
      expect(ladder.surfaceRaised, theme.id).toBe(theme.chrome.surface);
      expect(ladder.popover, theme.id).toBe(theme.chrome.surface);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. The composition policy (design memo section 4)
// ---------------------------------------------------------------------------

describe("composition policy", () => {
  it("mirrors the shipped background defaults", () => {
    // The fixture is a copy; this is the line that keeps it honest.
    expect(WALLPAPER_ON.panelOpacity).toBe(DEFAULT_THEME_BACKGROUND.panelOpacity);
    expect(WALLPAPER_ON.terminalOpacity).toBe(DEFAULT_THEME_BACKGROUND.terminalOpacity);
    expect(WALLPAPER_ON.wallpaperTone).toBe(DEFAULT_THEME_BACKGROUND.wallpaperTone);
    expect(WALLPAPER_ON.imageOpacity).toBe(DEFAULT_THEME_BACKGROUND.imageOpacity);
    expect(DEFAULT_THEME_BACKGROUND.panelOpacity).toBe(SHIPPED_CHROME_ALPHA);
    expect(DEFAULT_THEME_BACKGROUND.terminalOpacity).toBe(SHIPPED_TERMINAL_ALPHA);
  });

  it("leaves the light chrome at 0.68 and the light terminal at 0.62", () => {
    // Stage 2 raised these to 0.80 / 0.86 to buy a contrast floor over a
    // pure-black wallpaper, and the wallpaper stopped showing through. Both
    // the floor and the raise are withdrawn: the sliders mean what they say.
    for (const theme of LIGHT_THEMES) {
      const policy = resolveCompositionPolicy(theme, WALLPAPER_ON, true);
      expect(policy.chromeBackdropAlpha, theme.id).toBe(SHIPPED_CHROME_ALPHA);
      expect(policy.terminalBackdropAlpha, theme.id).toBe(SHIPPED_TERMINAL_ALPHA);
      // Raised surfaces are as translucent as the panel they sit in again.
      expect(policy.raisedAlpha, theme.id).toBe(SHIPPED_CHROME_ALPHA);
      // Popovers were opaque before stage 2 and stay opaque.
      expect(policy.popoverAlpha, theme.id).toBe(1);
    }
  });

  it("imposes no alpha floor on light themes in either direction", () => {
    const theme = LIGHT_THEMES[0];
    const opaquer = resolveCompositionPolicy(
      theme,
      { ...WALLPAPER_ON, panelOpacity: 0.95, terminalOpacity: 0.99 },
      true,
    );
    expect(opaquer.chromeBackdropAlpha).toBe(0.95);
    expect(opaquer.terminalBackdropAlpha).toBe(0.99);

    // Stage 2 clamped this pair back up to 0.80 / 0.86. It does not any more:
    // a user who wants thinner glass gets thinner glass, and the derived text
    // follows (see "the derived text follows the live composition" below).
    const thinner = resolveCompositionPolicy(
      theme,
      { ...WALLPAPER_ON, panelOpacity: 0.3, terminalOpacity: 0.3 },
      true,
    );
    expect(thinner.chromeBackdropAlpha).toBe(0.3);
    expect(thinner.terminalBackdropAlpha).toBe(0.3);
    expect(thinner.raisedAlpha).toBe(0.3);
  });

  it("hands dark themes the stored opacities unchanged", () => {
    for (const theme of DARK_THEMES) {
      const policy = resolveCompositionPolicy(theme, WALLPAPER_ON, true);
      expect(policy.chromeBackdropAlpha, theme.id).toBe(WALLPAPER_ON.panelOpacity);
      expect(policy.terminalBackdropAlpha, theme.id).toBe(WALLPAPER_ON.terminalOpacity);
      expect(policy.raisedAlpha, theme.id).toBe(WALLPAPER_ON.panelOpacity);
    }
  });

  it("drops every alpha to 1 when no wallpaper is painted", () => {
    for (const theme of THEMES) {
      const policy = resolveCompositionPolicy(theme, WALLPAPER_OFF, false);
      expect(policy.chromeBackdropAlpha, theme.id).toBe(1);
      expect(policy.terminalBackdropAlpha, theme.id).toBe(1);
      expect(policy.raisedAlpha, theme.id).toBe(1);
      expect(policy.popoverAlpha, theme.id).toBe(1);
    }
  });

  it("uses the stored wallpaper tone on both schemes", () => {
    // Stage 2b substituted a light-only +0.25 wash toward paper here. It
    // bleached the wallpaper, and it did so by *discarding* the stored value
    // on light themes - so a light-theme user could drag the tone slider and
    // watch nothing happen. One slider, one value, both schemes.
    for (const theme of THEMES) {
      expect(
        resolveCompositionPolicy(theme, WALLPAPER_ON, true).wallpaperTone,
        theme.id,
      ).toBe(DEFAULT_WALLPAPER_TONE);

      for (const stored of [-0.3, 0, 0.42, 0.85]) {
        expect(
          resolveCompositionPolicy(theme, { ...WALLPAPER_ON, wallpaperTone: stored }, true)
            .wallpaperTone,
          `${theme.id} @ ${stored}`,
        ).toBe(stored);
      }
    }
  });

  it("keeps the signed tone mechanism: black by default, paper when asked for", () => {
    for (const theme of THEMES) {
      // The shipped default is the 8% black scrim, on light exactly as on dark.
      expect(
        resolveCompositionPolicy(theme, WALLPAPER_ON, true).wallpaperToneColor,
        theme.id,
      ).toBe(WORST_CASE_BACKDROP);

      // A positive tone still means "toward this theme's paper" - the
      // mechanism survives, only the default went back to the black side.
      expect(
        resolveCompositionPolicy(theme, { ...WALLPAPER_ON, wallpaperTone: 0.3 }, true)
          .wallpaperToneColor,
        theme.id,
      ).toBe(theme.chrome.surface);
    }
  });

  it("reports the backdrop bound the tone implies, for measurement only", () => {
    // Nothing in the resolved palette is derived from this any more - it is
    // the helper themeContrast.test.ts uses to measure the composited ratios
    // it reports. It still has to be right about what the app paints.
    const theme = LIGHT_THEMES[0];

    // Default: an 8% black scrim over the image, so the bound stays black.
    expect(worstCaseBackdrop(resolveCompositionPolicy(theme, WALLPAPER_ON, true))).toBe(
      WORST_CASE_BACKDROP,
    );
    expect(
      worstCaseBackdrop(resolveCompositionPolicy(theme, { ...WALLPAPER_ON, wallpaperTone: 0 }, true)),
    ).toBe(WORST_CASE_BACKDROP);

    // A paper wash the user asked for does lift the bound.
    expect(
      worstCaseBackdrop(
        resolveCompositionPolicy(theme, { ...WALLPAPER_ON, wallpaperTone: 0.25 }, true),
      ),
    ).toBe(compositeOver(theme.chrome.surface, 0.25, WORST_CASE_BACKDROP));
  });

  it("keeps the dark tone layer painting exactly the old imageDim scrim", () => {
    // AppBackgroundLayer paints `toneColor` at `Math.abs(tone)`. The old layer
    // was `rgba(0, 0, 0, imageDim)`, so black at 0.08 is the same paint.
    const policy = resolveCompositionPolicy(DARK_THEMES[0], WALLPAPER_ON, true);
    expect(policy.wallpaperToneColor).toBe("#000000");
    expect(Math.abs(policy.wallpaperTone)).toBeCloseTo(0.08, 10);
  });
});

// ---------------------------------------------------------------------------
// 5. Alpha lives only in the backdrop roles (design memo section 4)
// ---------------------------------------------------------------------------

describe("light themes keep alpha where it belongs", () => {
  it.each(LIGHT_THEMES.map((theme) => [theme.id, theme] as const))(
    "%s: no translucent foreground, surface or border under a wallpaper",
    (id, theme) => {
      const { resolved, diagnostics } = resolveTheme({
        theme,
        background: WALLPAPER_ON,
        mediaActive: true,
      });

      expect(
        diagnostics.filter((entry) => entry.code === "translucent-semantic-color"),
        id,
      ).toEqual([]);

      // The two stage 2 fixed and the revert keeps opaque: a translucent
      // hairline lets the wallpaper through a 1px line, and a translucent
      // focus ring has no defined contrast.
      expect(colorAlpha(resolved.borderHairline), `${id} border-hairline`).toBe(1);
      expect(colorAlpha(resolved.focusRing), `${id} focus-ring`).toBe(1);
    },
  );

  // Stage 2 flattened hover/selected into opaque fills and stage 2b re-thinned
  // them by the panel alpha. Both were bookkeeping for a contrast bound that
  // no longer exists, and both changed how a hovered row looks on glass. The
  // washes are the authored ones again, on both schemes, exactly as they
  // shipped.
  it("leaves the authored state washes exactly as written", () => {
    for (const theme of LIGHT_THEMES) {
      expect(colorAlpha(theme.chrome.hover), `${theme.id} authors an opaque hover`).toBeLessThan(1);

      for (const background of [WALLPAPER_ON, WALLPAPER_OFF]) {
        const { resolved } = resolveTheme({
          theme,
          background,
          mediaActive: isMediaBackgroundActive(background),
        });
        expect(resolved.hover, `${theme.id} hover`).toBe(theme.chrome.hover);
        expect(resolved.selected, `${theme.id} selected`).toBe(theme.chrome.selected);
      }
    }
  });

  // The revert's headline claim, checked against the frozen pre-refactor
  // derivation rather than against a number someone typed. Stage 2 moved which
  // surface each band paints (the ladder, kept) *and* how transparent it is
  // (withdrawn). This asserts the second half went back: every light token
  // carries exactly the alpha it carried before the light rebuild, in both
  // wallpaper states, even though several of them are now a different colour.
  it("composites light themes with exactly the alphas that shipped before stage 2", () => {
    // Shadows are excluded because colorAlpha() reports 1 for a box-shadow
    // string on both sides, so comparing them would prove nothing. The
    // hairline and the focus ring are excluded because stage 2 deliberately
    // made them opaque and that change is kept: a translucent 1px rule lets
    // the wallpaper through the line itself, and a translucent ring has no
    // measurable contrast. Everything else has to match.
    const DELIBERATELY_OPAQUE = ["--cmux-border-hairline", "--cmux-focus-ring"];
    const measurable = RESOLVED_THEME_TOKENS.filter(
      (token) => token.role !== "shadow" && !DELIBERATELY_OPAQUE.includes(token.cssVar),
    );
    let comparisons = 0;

    for (const theme of LIGHT_THEMES) {
      for (const state of WALLPAPER_STATES) {
        const actual = buildThemeVars({
          theme,
          background: state.background,
          ...BASE_TYPOGRAPHY,
        }) as unknown as Record<string, string>;
        const legacy = legacyThemeVars({
          theme,
          background: state.background,
          ...BASE_TYPOGRAPHY,
        }) as unknown as Record<string, string>;

        for (const token of measurable) {
          const before = legacy[token.cssVar];
          if (before === undefined) {
            // --pane-tabbar-bg is the one variable stage 2 added; it inherits
            // the strip's old value, which is asserted for dark above.
            expect(token.cssVar).toBe(STAGE_2_ADDED_VAR);
            continue;
          }
          expect(
            colorAlpha(actual[token.cssVar]),
            `${theme.id} / ${state.label} / ${token.cssVar}: ${actual[token.cssVar]} vs ${before}`,
          ).toBeCloseTo(colorAlpha(before), 6);
          comparisons += 1;
        }
      }
    }

    // 9 light themes x 2 wallpaper states x 38 comparable variables.
    expect(comparisons).toBe(684);
  });

  it("keeps the top-level containers translucent so the wallpaper still shows", () => {
    for (const theme of LIGHT_THEMES) {
      const { resolved } = resolveTheme({ theme, background: WALLPAPER_ON, mediaActive: true });
      expect(colorAlpha(resolved.bg), `${theme.id} bg`).toBeCloseTo(SHIPPED_CHROME_ALPHA, 6);
      expect(colorAlpha(resolved.sidebar), `${theme.id} sidebar`).toBeCloseTo(SHIPPED_CHROME_ALPHA, 6);
      expect(colorAlpha(resolved.titleBg), `${theme.id} title`).toBeCloseTo(SHIPPED_CHROME_ALPHA, 6);
      expect(colorAlpha(resolved.paneTabBarBg), `${theme.id} pane tab bar`).toBeCloseTo(SHIPPED_CHROME_ALPHA, 6);
      expect(colorAlpha(resolved.surface), `${theme.id} surface`).toBeCloseTo(SHIPPED_CHROME_ALPHA, 6);
      expect(colorAlpha(resolved.terminalBg), `${theme.id} terminal`).toBeCloseTo(SHIPPED_TERMINAL_ALPHA, 6);
      // Stage 2 made raised opaque; it is back on the panel alpha, which is
      // what it had before the light rebuild.
      expect(colorAlpha(resolved.surfaceRaised), `${theme.id} raised`).toBeCloseTo(SHIPPED_CHROME_ALPHA, 6);
      // Popovers were opaque before stage 2 as well, and stay opaque.
      expect(colorAlpha(resolved.popover), `${theme.id} popover`).toBe(1);
    }
  });

  it("puts the chrome bands on surface-low and the terminal on paper", () => {
    for (const theme of LIGHT_THEMES) {
      const ladder = resolveSurfaceLadder(theme);
      const { resolved } = resolveTheme({ theme, background: WALLPAPER_OFF, mediaActive: false });
      expect(resolved.sidebar, theme.id).toBe(ladder.surfaceLow);
      expect(resolved.titleBg, theme.id).toBe(ladder.surfaceLow);
      expect(resolved.paneTabBarBg, theme.id).toBe(ladder.surfaceLow);
      expect(resolved.surface, theme.id).toBe(ladder.surface);
      expect(resolved.terminalBg, theme.id).toBe(theme.terminal.background);
      expect(resolved.surfaceRaised, theme.id).toBe(ladder.surfaceRaised);
      expect(resolved.popover, theme.id).toBe(ladder.popover);
    }
  });

  it("never rewrites the authored anchors", () => {
    for (const theme of LIGHT_THEMES) {
      const { resolved } = resolveTheme({ theme, background: WALLPAPER_ON, mediaActive: true });
      expect(resolved.text, theme.id).toBe(theme.chrome.text);
      expect(resolved.accent, theme.id).toBe(theme.chrome.accent);
      expect(resolved.border, theme.id).toBe(theme.chrome.border);
      expect(resolved.surfaceSolid, theme.id).toBe(theme.chrome.surface);
      expect(resolved.bgSolid, theme.id).toBe(theme.chrome.background);
      expect(resolved.statusWorking, theme.id).toBe(theme.status.working);
      expect(resolved.statusError, theme.id).toBe(theme.status.error);
    }
  });

});

// ---------------------------------------------------------------------------
// 5b. The light text hierarchy (design memo section 5, migration steps 3-4)
// ---------------------------------------------------------------------------
// The first cut of stage 2 derived each level on its own and clamped it to
// the contrast floor. Every ratio passed and the hierarchy was gone: on
// kinari secondary and tertiary came out as the same hex, and on asanagi,
// wakaba and geppaku tertiary landed darker than secondary. Passing the floor
// is necessary, not sufficient - so the ordering and the size of each step
// are pinned here, not just the ratios.

function levelsFor(theme: ThemeDefinition, background: ThemeBackgroundSettings = WALLPAPER_ON) {
  const { resolved } = resolveTheme({
    theme,
    background,
    mediaActive: isMediaBackgroundActive(background),
  });
  return {
    text: resolved.text,
    secondary: resolved.textSecondary,
    tertiary: resolved.textTertiary,
    dim: resolved.textDim,
  };
}

function ladderFor(theme: ThemeDefinition, background: ThemeBackgroundSettings = WALLPAPER_ON) {
  const mediaActive = isMediaBackgroundActive(background);
  const surfaces = resolveSurfaceLadder(theme);
  const { resolved } = resolveTheme({ theme, background, mediaActive });
  const hosts = lightTextHosts(theme, surfaces, resolved.hover, resolved.selected);
  return resolveLightTextLadder(theme.chrome.text, surfaces.surface, hosts, TEXT_CONTRAST_FLOOR);
}

describe("light text hierarchy", () => {
  it.each(LIGHT_THEMES.map((theme) => [theme.id, theme] as const))(
    "%s: text < secondary < tertiary < dim, strictly, by luminance and by OKLab lightness",
    (id, theme) => {
      const levels = levelsFor(theme);
      const order = ["text", "secondary", "tertiary", "dim"] as const;

      for (let index = 1; index < order.length; index += 1) {
        const lower = levels[order[index - 1]];
        const upper = levels[order[index]];
        expect(
          relativeLuminance(upper),
          `${id}: ${order[index]} (${upper}) must be lighter than ${order[index - 1]} (${lower})`,
        ).toBeGreaterThan(relativeLuminance(lower));
        expect(
          oklabLightness(upper) as number,
          `${id}: ${order[index]} (${upper}) must sit above ${order[index - 1]} (${lower}) in OKLab`,
        ).toBeGreaterThan(oklabLightness(lower) as number);
        expect(upper, `${id}: ${order[index]} and ${order[index - 1]} resolved to the same colour`).not.toBe(lower);
      }
    },
  );

  // Derived against the theme's own surfaces, the run is long on all nine and
  // every step is comfortably perceptible. Stage 2b derived against a panel
  // composited over a pure-black wallpaper instead, which shortened the run so
  // far that kinari collapsed to one colour and hakuchuumu to two. The room is
  // pinned so that a change which quietly shortens it again shows up here.
  const MEASURED_ROOM_L: Record<string, number> = {
    asanagi: 0.1768,
    kinari: 0.1169,
    wakaba: 0.1364,
    geppaku: 0.1601,
    sakura: 0.1508,
    paper: 0.1779,
    hakuchuumu: 0.1186,
    mist: 0.1732,
    "ink-day": 0.2837,
  };

  it("pins the room each light theme has", () => {
    const measured = Object.fromEntries(
      LIGHT_THEMES.map((theme) => [theme.id, Number(ladderFor(theme).roomL.toFixed(4))]),
    );
    expect(measured).toEqual(MEASURED_ROOM_L);
  });

  it.each(LIGHT_THEMES.map((theme) => [theme.id, theme] as const))(
    "%s: every step is a perceptual gap, not a rounding difference",
    (id, theme) => {
      const steps = textLadderStepsL(ladderFor(theme));
      steps.forEach((step, index) => {
        expect(
          step,
          `${id}: step ${index + 1} is ${step.toFixed(4)} in OKLab lightness, under the ${MIN_TEXT_LEVEL_STEP_L} minimum`,
        ).toBeGreaterThanOrEqual(MIN_TEXT_LEVEL_STEP_L);
      });
    },
  );

  it("gives all nine themes four distinct levels", () => {
    for (const theme of LIGHT_THEMES) {
      const levels = levelsFor(theme);
      expect(new Set(Object.values(levels)).size, `${theme.id} distinct levels`).toBe(4);
    }
  });

  it("shapes the steps so they widen toward the dim end when the room allows", () => {
    const { SHAPED } = LIGHT_TEXT_LEVEL_POSITIONS;
    const shapedGaps = [SHAPED.secondary, SHAPED.tertiary - SHAPED.secondary, SHAPED.dim - SHAPED.tertiary];
    // Strictly increasing nominal gaps: the jump out of body text is the
    // smallest, the tail is the loosest.
    expect(shapedGaps[0]).toBeLessThan(shapedGaps[1]);
    expect(shapedGaps[1]).toBeLessThan(shapedGaps[2]);
    expect(SHAPED.dim).toBeLessThan(1);
  });

  it("has the room for the shaped spread on all nine", () => {
    const spacing = Object.fromEntries(
      LIGHT_THEMES.map((theme) => [theme.id, ladderFor(theme).spacing]),
    );

    // PROPORTIONAL is the fallback for a run too short to seat the shaped
    // gaps. Derived against the theme's own surfaces no light theme needs it -
    // three did while the run was cut by a pure-black composite. The map is
    // pinned rather than asserted uniformly so a theme that starts falling
    // back names itself.
    expect(spacing).toEqual({
      asanagi: "SHAPED",
      kinari: "SHAPED",
      wakaba: "SHAPED",
      geppaku: "SHAPED",
      sakura: "SHAPED",
      paper: "SHAPED",
      hakuchuumu: "SHAPED",
      mist: "SHAPED",
      "ink-day": "SHAPED",
    });
  });

  it("does not change the light palette when a wallpaper is switched on", () => {
    // This is the property the revert restores, and the one worth guarding.
    // Stage 2b made the derived levels a function of the wallpaper settings so
    // they could chase a pure-black bound; the visible result was that turning
    // a wallpaper on darkened every label in the app. Before any of this, the
    // light foregrounds were wallpaper-independent, and they are again: only
    // the backdrop alphas move.
    for (const theme of LIGHT_THEMES) {
      const on = resolveTheme({ theme, background: WALLPAPER_ON, mediaActive: true }).resolved;
      const off = resolveTheme({ theme, background: WALLPAPER_OFF, mediaActive: false }).resolved;

      for (const key of [
        "text",
        "textSecondary",
        "textTertiary",
        "textDim",
        "hover",
        "selected",
        "borderHairline",
        "focusRing",
      ] as const) {
        expect(on[key], `${theme.id} / ${key}`).toBe(off[key]);
      }

      // ...and the tone slider does not move them either, on either scheme.
      const washed = resolveTheme({
        theme,
        background: { ...WALLPAPER_ON, wallpaperTone: 0.4 },
        mediaActive: true,
      }).resolved;
      expect(washed.textDim, `${theme.id} / tone-independent`).toBe(off.textDim);
    }
  });

  it("demotes the authored textMuted/textDim to hints that decide nothing", () => {
    // Design memo section 5, migration step 4: the quiet levels come from
    // `text` and the host surface. Repainting the hints must not move them.
    for (const theme of LIGHT_THEMES) {
      const repainted: ThemeDefinition = {
        ...theme,
        chrome: { ...theme.chrome, textMuted: "#ff00ff", textDim: "#00ff00" },
      };
      expect(levelsFor(repainted), theme.id).toEqual(levelsFor(theme));
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Diagnostics
// ---------------------------------------------------------------------------

describe("resolveTheme diagnostics", () => {
  it("reads alpha out of the colour syntaxes the resolver actually emits", () => {
    expect(colorAlpha("#f4f7fb")).toBe(1);
    expect(colorAlpha("none")).toBe(1);
    expect(colorAlpha("rgba(255, 255, 255, 0.07)")).toBeCloseTo(0.07, 6);
    expect(colorAlpha("rgba(15, 23, 42, 0.22)")).toBeCloseTo(0.22, 6);
    expect(colorAlpha("#11223344")).toBeCloseTo(0x44 / 255, 6);
    expect(colorAlpha("color-mix(in srgb, #d9e3f1 70%, transparent)")).toBeCloseTo(0.7, 6);
    // Nested mix (the dark raised surface): the outer alpha is the one that counts.
    expect(
      colorAlpha("color-mix(in srgb, color-mix(in srgb, #07090d 96%, white) 68.00%, transparent)"),
    ).toBeCloseTo(0.68, 6);
  });

  it("still flags the translucent semantic colours dark themes carry", () => {
    const dark = THEMES.find((theme) => theme.id === "mayonaka");
    expect(dark).toBeDefined();

    const { diagnostics } = resolveTheme({
      theme: dark as ThemeDefinition,
      background: WALLPAPER_ON,
      mediaActive: true,
    });
    const flagged = diagnostics
      .filter((entry) => entry.code === "translucent-semantic-color")
      .map((entry) => entry.token);

    // The hairline border and the focus ring are color-mix()es toward
    // transparent on dark; stage 2 fixed both on the light branch and left
    // dark alone, which is what this records.
    expect(flagged).toContain("--cmux-border-hairline");
    expect(flagged).toContain("--cmux-focus-ring");

    // hover/selected are authored as rgba() on both schemes. Stage 2 called
    // that a finding and made the light pair opaque; a state wash is now a
    // legitimate use of alpha - what keeps it safe is that the flattened fill
    // is measured as a text host, not that it is opaque - so neither scheme
    // reports them any more.
    expect(flagged).not.toContain("--cmux-hover");
    expect(flagged).not.toContain("--cmux-selected");
  });

  it("reports a theme whose body colour fails on its own surface, and does not rewrite it", () => {
    // No built-in trips this, in either wallpaper state.
    for (const theme of LIGHT_THEMES) {
      for (const background of [WALLPAPER_ON, WALLPAPER_OFF]) {
        const { diagnostics } = resolveTheme({
          theme,
          background,
          mediaActive: isMediaBackgroundActive(background),
        });
        expect(
          diagnostics.filter((entry) => entry.code === "text-contrast-floor"),
          theme.id,
        ).toEqual([]);
      }
    }

    // A theme that authors a body colour too light for its own paper is a
    // theme defect, and the resolver says so with the measurement rather than
    // silently darkening the anchor (design memo section 6).
    const base = LIGHT_THEMES.find((theme) => theme.id === "kinari") as ThemeDefinition;
    const tooLight: ThemeDefinition = {
      ...base,
      chrome: { ...base.chrome, text: "#a8a094" },
    };
    const { resolved, diagnostics } = resolveTheme({
      theme: tooLight,
      background: WALLPAPER_OFF,
      mediaActive: false,
    });
    const floorFindings = diagnostics.filter((entry) => entry.code === "text-contrast-floor");
    expect(floorFindings.map((entry) => entry.token)).toEqual([
      "--cmux-text",
      "--cmux-text-secondary",
      "--cmux-text-tertiary",
      "--cmux-text-dim",
    ]);
    expect(floorFindings[0].message).toContain(":1 on the theme's own ");
    expect(resolved.text).toBe("#a8a094");
  });

  it("reports tokens the app consumes that the resolver cannot supply", () => {
    const { diagnostics } = resolveTheme({
      theme: THEMES[0],
      background: WALLPAPER_OFF,
      mediaActive: false,
      consumedTokens: ["--cmux-text", "--status-warning"],
    });

    const missing = diagnostics.filter((entry) => entry.code === "missing-token").map((entry) => entry.token);
    expect(missing).toEqual(["--status-warning"]);
  });

  it("emits a value for every declared token, for every theme and wallpaper state", () => {
    for (const theme of THEMES) {
      for (const state of WALLPAPER_STATES) {
        const { resolved, diagnostics } = resolveTheme({
          theme,
          background: state.background,
          mediaActive: isMediaBackgroundActive(state.background),
        });
        const vars = resolvedThemeToCssVars(resolved);
        for (const token of RESOLVED_THEME_TOKENS) {
          expect(vars[token.cssVar], `${theme.id} / ${token.cssVar}`).toBeTypeOf("string");
          expect(vars[token.cssVar]?.length, `${theme.id} / ${token.cssVar}`).toBeGreaterThan(0);
        }
        expect(
          diagnostics.filter((entry) => entry.code === "missing-token"),
          `${theme.id} / ${state.label}`,
        ).toEqual([]);
      }
    }
  });

  it("lists the themes whose declared scheme disagrees with the BT.601 luma branch", () => {
    const mismatched = THEMES.filter((theme) =>
      resolveTheme({ theme, background: WALLPAPER_OFF, mediaActive: false }).diagnostics.some(
        (entry) => entry.code === "scheme-luminance-mismatch",
      ),
    ).map((theme) => theme.id);

    // Stage 3 makes the declared scheme authoritative. Recording the current
    // (empty) disagreement set here means that switch is provably a no-op for
    // the built-ins, and that a newly added theme that disagrees shows up as a
    // failure here rather than as 19 tokens quietly flipping.
    expect(mismatched).toEqual([]);
  });
});
