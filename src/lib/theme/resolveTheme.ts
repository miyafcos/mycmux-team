// The authored -> resolved boundary.
//
// `ThemeDefinition` is what a theme author wrote. `ResolvedTheme` is what the
// components actually consume. Until stage 1 the conversion between the two
// lived inline in AppShell.tsx, which meant the only way to know what colour
// would be painted was to render the app: the contrast tests could check the
// authored hexes and still miss every colour-mix, every wallpaper alpha and
// every light/dark branch layered on top. This module is that conversion, as a
// pure function so it can be tested directly.
//
// Stage 1 was a pure refactor. Stage 2 (this file, now) is where the light
// values actually change:
//
//   * a surface ladder anchored on paper instead of a "raised means darker"
//     rule (`resolveSurfaceLadder`, design memo section 3),
//   * a composition policy that isolates alpha in the backdrop roles and
//     replaces the black-only `imageDim` with a signed `wallpaperTone`
//     (`resolveCompositionPolicy`, section 4),
//   * a light text hierarchy built from `text` and the surfaces it lands on,
//     spaced across the room a theme actually has (section 5, migration steps
//     3 and 4).
//
// Stages 2b and 2c withdrew stage 2's compositing changes, in two goes,
// because both of the ways it tried to guarantee contrast over a pure-black
// wallpaper destroyed the look the app was built around.
//
// Stage 2 bought the floor with opacity (light chrome 0.80, terminal 0.86,
// opaque raised surfaces and state fills) and the wallpaper stopped showing
// through. Stage 2b bought it with tone instead - a +0.25 wash toward the
// theme's near-white paper - which kept the wallpaper visible but bleached it:
// on the shipped asanagi/oppenheimer pairing the image's mean luminance went
// from 58.6 to 109.6, the blacks turned grey-pink and the picture went flat.
//
// So stage 2c drops the guarantee rather than the look. The pure-black bound
// was never asked for; it is an upper bound on a wallpaper nobody picks, and
// users choose images they can read against. What ships now is the original
// compositing - 0.68 / 0.62, raised on the panel alpha, an 8% black scrim on
// both schemes - with the light text derived against the authored opaque
// surfaces, which is where the four-level hierarchy has the room to exist.
//
// What survives from stage 2 is the part that fixed real defects: the surface
// ladder and its elevation order, the signed `wallpaperTone` mechanism and the
// `imageDim` migration, the four-level text ladder, and dark invariance.
//
// The contrast the app can promise is therefore stated against the authored
// surfaces, not against an arbitrary backdrop. tests/unit/themeContrast.test.ts
// still measures the composited numbers and prints them; it no longer asserts
// a floor the shipped configuration does not reach. Recovering a real
// guarantee needs adaptive wallpaper sampling, which is a future option and
// not implemented (design memo section 12).
//
// Dark themes are deliberately untouched: every dark branch below is the
// expression stage 1 froze, and tests/unit/resolveTheme.test.ts still diffs all
// 21 of them against the pre-refactor derivation.
//
// Design memo: docs/design/2026-08-20-light-theme-system.md

import type {
  ThemeBackgroundSettings,
  ThemeColorScheme,
  ThemeDefinition,
} from "../../types";
import { contrastRatio, isHexColor, resolveAccentTextColor } from "../../components/theme/colorContrast";
import { colorWithOpacity, isLightColor, parseHexChannels } from "./colorPrimitives";
import { compositeOver, hexToOklab, mixOklab, rgbToHex } from "./oklab";

export { colorWithOpacity, isLightColor } from "./colorPrimitives";

/**
 * The final semantic palette a component tree consumes. One field per CSS
 * custom property AppShell paints on the app root — see
 * `RESOLVED_THEME_TOKENS` for the field <-> variable mapping.
 */
export interface ResolvedTheme {
  colorScheme: ThemeColorScheme;

  bgSolid: string;
  surfaceSolid: string;
  bg: string;
  sidebar: string;
  paneTabBarBg: string;
  surfaceRaised: string;
  popover: string;
  titleBg: string;
  surface: string;
  terminalBg: string;

  accent: string;
  accentText: string;
  border: string;
  borderHairline: string;

  text: string;
  textSecondary: string;
  textTertiary: string;
  textDim: string;

  hover: string;
  selected: string;
  red: string;
  yellow: string;

  onAccent: string;
  onWorking: string;
  onWaiting: string;
  onDone: string;
  onError: string;
  statusStall: string;
  onStall: string;

  backdrop: string;
  edgeHighlight: string;
  focusRing: string;
  dndTab: string;
  dndPane: string;
  usageOk: string;
  usageWarn: string;
  usageDanger: string;

  shadowMenu: string;
  shadowPopover: string;
  shadowDropdown: string;
  shadowDialog: string;
  shadowPalette: string;
  shadowPaneMenu: string;
  shadowDnd: string;
  shadowDndStrong: string;
  shadowDndLabel: string;

  statusWorking: string;
  statusWaiting: string;
  statusDone: string;
  statusError: string;
  notificationColor: string;

  chromeTextShadow: string;
  chromeIconShadow: string;
}

export type ResolvedThemeColorKey = Exclude<keyof ResolvedTheme, "colorScheme">;

/**
 * What a token is *for*. The composition policy only gets to make backdrop and
 * shadow roles translucent; every other role resolves to an opaque colour
 * (design memo section 4, "what guarantees contrast").
 */
export type ThemeTokenRole =
  | "surface"
  | "backdrop"
  | "foreground"
  | "border"
  | "state"
  | "effect"
  | "shadow";

export interface ThemeTokenSpec {
  key: ResolvedThemeColorKey;
  cssVar: string;
  role: ThemeTokenRole;
}

export const RESOLVED_THEME_TOKENS: readonly ThemeTokenSpec[] = [
  { key: "bgSolid", cssVar: "--cmux-bg-solid", role: "surface" },
  { key: "surfaceSolid", cssVar: "--cmux-surface-solid", role: "surface" },
  { key: "bg", cssVar: "--cmux-bg", role: "backdrop" },
  { key: "sidebar", cssVar: "--cmux-sidebar", role: "backdrop" },
  { key: "paneTabBarBg", cssVar: "--pane-tabbar-bg", role: "backdrop" },
  { key: "surfaceRaised", cssVar: "--cmux-surface-raised", role: "backdrop" },
  { key: "popover", cssVar: "--cmux-popover", role: "surface" },
  { key: "titleBg", cssVar: "--cmux-title-bg", role: "backdrop" },
  { key: "surface", cssVar: "--cmux-surface", role: "backdrop" },
  { key: "terminalBg", cssVar: "--cmux-terminal-bg", role: "backdrop" },
  { key: "accent", cssVar: "--cmux-accent", role: "foreground" },
  { key: "accentText", cssVar: "--cmux-accent-text", role: "foreground" },
  { key: "border", cssVar: "--cmux-border", role: "border" },
  { key: "borderHairline", cssVar: "--cmux-border-hairline", role: "border" },
  { key: "text", cssVar: "--cmux-text", role: "foreground" },
  { key: "textSecondary", cssVar: "--cmux-text-secondary", role: "foreground" },
  { key: "textTertiary", cssVar: "--cmux-text-tertiary", role: "foreground" },
  { key: "textDim", cssVar: "--cmux-text-dim", role: "foreground" },
  { key: "hover", cssVar: "--cmux-hover", role: "state" },
  { key: "selected", cssVar: "--cmux-selected", role: "state" },
  { key: "red", cssVar: "--cmux-red", role: "foreground" },
  { key: "yellow", cssVar: "--cmux-yellow", role: "foreground" },
  { key: "onAccent", cssVar: "--cmux-on-accent", role: "foreground" },
  { key: "onWorking", cssVar: "--cmux-on-working", role: "foreground" },
  { key: "onWaiting", cssVar: "--cmux-on-waiting", role: "foreground" },
  { key: "onDone", cssVar: "--cmux-on-done", role: "foreground" },
  { key: "onError", cssVar: "--cmux-on-error", role: "foreground" },
  { key: "statusStall", cssVar: "--cmux-status-stall", role: "foreground" },
  { key: "onStall", cssVar: "--cmux-on-stall", role: "foreground" },
  { key: "backdrop", cssVar: "--cmux-backdrop", role: "backdrop" },
  { key: "edgeHighlight", cssVar: "--cmux-edge-highlight", role: "shadow" },
  { key: "focusRing", cssVar: "--cmux-focus-ring", role: "effect" },
  { key: "dndTab", cssVar: "--cmux-dnd-tab", role: "foreground" },
  { key: "dndPane", cssVar: "--cmux-dnd-pane", role: "foreground" },
  { key: "usageOk", cssVar: "--cmux-usage-ok", role: "foreground" },
  { key: "usageWarn", cssVar: "--cmux-usage-warn", role: "foreground" },
  { key: "usageDanger", cssVar: "--cmux-usage-danger", role: "foreground" },
  { key: "shadowMenu", cssVar: "--cmux-shadow-menu", role: "shadow" },
  { key: "shadowPopover", cssVar: "--cmux-shadow-popover", role: "shadow" },
  { key: "shadowDropdown", cssVar: "--cmux-shadow-dropdown", role: "shadow" },
  { key: "shadowDialog", cssVar: "--cmux-shadow-dialog", role: "shadow" },
  { key: "shadowPalette", cssVar: "--cmux-shadow-palette", role: "shadow" },
  { key: "shadowPaneMenu", cssVar: "--cmux-shadow-pane-menu", role: "shadow" },
  { key: "shadowDnd", cssVar: "--cmux-shadow-dnd", role: "shadow" },
  { key: "shadowDndStrong", cssVar: "--cmux-shadow-dnd-strong", role: "shadow" },
  { key: "shadowDndLabel", cssVar: "--cmux-shadow-dnd-label", role: "shadow" },
  { key: "statusWorking", cssVar: "--status-working", role: "foreground" },
  { key: "statusWaiting", cssVar: "--status-waiting", role: "foreground" },
  { key: "statusDone", cssVar: "--status-done", role: "foreground" },
  { key: "statusError", cssVar: "--status-error", role: "foreground" },
  { key: "notificationColor", cssVar: "--notification-color", role: "foreground" },
  { key: "chromeTextShadow", cssVar: "--cmux-chrome-text-shadow", role: "shadow" },
  { key: "chromeIconShadow", cssVar: "--cmux-chrome-icon-shadow", role: "shadow" },
];

export type ThemeDiagnosticCode =
  | "missing-token"
  | "translucent-semantic-color"
  | "scheme-luminance-mismatch"
  | "text-contrast-floor";

export interface ThemeDiagnostic {
  code: ThemeDiagnosticCode;
  severity: "error" | "warning";
  /** CSS custom property the finding is about, when it is about one. */
  token?: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Surface ladder (design memo section 3)
// ---------------------------------------------------------------------------

/**
 * The five surface roles, opaque. `canvas` is the ground the wallpaper sits
 * on; everything above it is derived from the paper anchor
 * (`theme.chrome.surface`).
 *
 * Invariant for light themes:
 *   L(canvas) < L(surfaceLow) < L(surface) <= L(surfaceRaised) <= L(popover)
 *
 * The top three being equal is deliberate: paper is already near white, so a
 * positive offset would clip by a different amount on every theme. Elevation is
 * carried by the hairline and the shadow tokens instead.
 *
 * For dark themes the fields keep the stage-1 expressions verbatim, which means
 * `surfaceRaised` / `popover` are `color-mix()` strings rather than hexes. That
 * is why the ladder invariant is only asserted for light.
 */
export interface SurfaceLadder {
  canvas: string;
  surfaceLow: string;
  surface: string;
  surfaceRaised: string;
  popover: string;
}

/**
 * How far `surfaceLow` travels from paper toward canvas, in OKLab. The nine
 * built-in light themes all place paper 0.0597-0.0654 OKLab lightness above
 * canvas, so one fraction produces the same perceived step on all of them.
 */
export const SURFACE_LOW_MIX = 0.4;

export function resolveSurfaceLadder(theme: ThemeDefinition): SurfaceLadder {
  const canvas = theme.chrome.background;
  const paper = theme.chrome.surface;

  if (!isLightColor(canvas)) {
    // Dark: stage-1 expressions, unchanged.
    return {
      canvas,
      surfaceLow: paper,
      surface: paper,
      surfaceRaised: `color-mix(in srgb, ${paper} 96%, white)`,
      popover: `color-mix(in srgb, ${paper} 93%, white)`,
    };
  }

  return {
    canvas,
    surfaceLow: mixOklab(paper, canvas, SURFACE_LOW_MIX),
    surface: paper,
    surfaceRaised: paper,
    popover: paper,
  };
}

// ---------------------------------------------------------------------------
// Composition policy (design memo section 4)
// ---------------------------------------------------------------------------

/**
 * The stored default. Negative because it is the old `imageDim: 0.08` (a black
 * scrim) read through the signed scale, which is what keeps every theme
 * painting exactly as before.
 *
 * Both schemes use it. Stage 2b substituted a light-only +0.25 wash toward
 * paper here, which bleached the wallpaper (design memo section 12) and, worse,
 * did it by discarding the stored value on light themes - so the tone slider
 * did nothing at all on a light theme. The signed scale is still there for a
 * user who wants a paper wash; it is now theirs to ask for.
 */
export const DEFAULT_WALLPAPER_TONE = -0.08;

/**
 * The darkest image a wallpaper can hold. Source-over compositing cannot
 * produce a channel below the backdrop's, so no wallpaper a user picks is
 * darker than this.
 *
 * It is a true bound and a useless target: real wallpapers are nowhere near
 * it, and holding the palette to it costs either the wallpaper's visibility or
 * its colour (both were tried; see the module header). It is kept because the
 * composited numbers are still worth measuring and reporting - it just no
 * longer decides any colour.
 */
export const WORST_CASE_BACKDROP = "#000000";

export interface CompositionPolicy {
  /** Alpha for the top-level chrome containers. */
  chromeBackdropAlpha: number;
  /** Alpha for the terminal pane. */
  terminalBackdropAlpha: number;
  /** Alpha for inline raised surfaces. */
  raisedAlpha: number;
  /** Alpha for popovers and menus. */
  popoverAlpha: number;
  /** Signed wallpaper tone: negative toward black, positive toward `toneColor`. */
  wallpaperTone: number;
  /** What a positive tone moves the wallpaper toward. */
  wallpaperToneColor: string;
}

export function resolveCompositionPolicy(
  theme: ThemeDefinition,
  background: ThemeBackgroundSettings,
  mediaActive: boolean,
): CompositionPolicy {
  // The stored tone is the tone, on both schemes. There is no scheme-dependent
  // substitution: one slider, one value, and moving it does what it says.
  const wallpaperTone = background.wallpaperTone;
  // A zero or negative tone paints black (or nothing), so the paper colour is
  // only reported when the user has actually asked for a paper wash.
  const wallpaperToneColor = wallpaperTone > 0 ? theme.chrome.surface : WORST_CASE_BACKDROP;

  if (!mediaActive) {
    return {
      chromeBackdropAlpha: 1,
      terminalBackdropAlpha: 1,
      raisedAlpha: 1,
      popoverAlpha: 1,
      wallpaperTone,
      wallpaperToneColor,
    };
  }

  // One branch for both schemes: the opacity sliders mean what they say. Stage
  // 2 imposed 0.80 / 0.86 floors on light here to guarantee contrast over a
  // pure-black wallpaper; that guarantee, and both attempts to pay for it, are
  // withdrawn (module header).
  return {
    chromeBackdropAlpha: background.panelOpacity,
    terminalBackdropAlpha: background.terminalOpacity,
    raisedAlpha: background.panelOpacity,
    popoverAlpha: 1,
    wallpaperTone,
    wallpaperToneColor,
  };
}

/**
 * The darkest surface the wallpaper stack can put behind a translucent panel,
 * for the tone the policy resolved.
 *
 * The stack the app paints is: the theme's own canvas, the wallpaper image at
 * `imageOpacity` on top of it, then a flat `wallpaperToneColor` layer at
 * `|wallpaperTone|` on top of that (AppShell's `AppBackgroundLayer`). The
 * image is bounded below by pure black and a sub-1 `imageOpacity` only mixes
 * the light canvas back in, so the worst the first two layers can produce is
 * black — and the tone layer then composites over it by exactly this
 * expression.
 *
 * Reporting only. No resolved colour is derived from this: it describes a
 * wallpaper nobody picks, and holding the palette to it costs the look
 * (module header). themeContrast.test.ts uses it to measure and print the
 * composited ratios, which is the honest use of an upper bound.
 */
export function worstCaseBackdrop(composition: CompositionPolicy): string {
  if (composition.wallpaperTone <= 0) {
    // A negative tone paints black over the image; black over black is black.
    return WORST_CASE_BACKDROP;
  }
  return compositeOver(
    composition.wallpaperToneColor,
    composition.wallpaperTone,
    WORST_CASE_BACKDROP,
  );
}

// ---------------------------------------------------------------------------
// Light text hierarchy (design memo section 5)
// ---------------------------------------------------------------------------

/** WCAG AA body floor. Every informational glyph has to clear this. */
export const TEXT_CONTRAST_FLOOR = 4.5;

/**
 * Where each derived level sits on the run between `text` and the point where
 * the contrast floor is reached, as a fraction of the available room.
 *
 * The first version of stage 2 derived each level independently from its
 * authored hint and darkened it until it cleared the floor. Every number
 * passed and the design intent was gone: all three levels piled up on the
 * floor, secondary and tertiary came out identical on kinari, and on asanagi,
 * wakaba and geppaku tertiary landed *darker* than secondary. A floor is not a
 * hierarchy.
 *
 * So the levels are built instead of clamped. The run starts at the authored
 * `text` and ends at the lightest colour that still clears the floor on every
 * surface the text can land on, and each level is a fixed fraction of that
 * run. Ordering holds by construction rather than by luck, and the floor holds
 * because the far end of the run *is* the floor.
 *
 * Positions are fractions of OKLab lightness, not of contrast: OKLab lightness
 * is linear along the run, so a fraction of the parameter is exactly that
 * fraction of the perceptual room.
 *
 * `SHAPED` widens the steps toward the dim end (0.31 / 0.32 / 0.33 of the run)
 * so the jump out of body text is the smallest and the tail is the loosest.
 * `PROPORTIONAL` spreads the run evenly, which is the arrangement that
 * maximises the *smallest* step, and is what a theme with barely any room
 * falls back to. See `resolveLightTextLadder` for when each applies.
 */
export const LIGHT_TEXT_LEVEL_POSITIONS = {
  SHAPED: { secondary: 0.31, tertiary: 0.63, dim: 0.96 },
  PROPORTIONAL: { secondary: 1 / 3, tertiary: 2 / 3, dim: 0.99 },
} as const;

export type LightTextSpacing = keyof typeof LIGHT_TEXT_LEVEL_POSITIONS;

/**
 * Smallest OKLab lightness step that counts as a level rather than as rounding.
 *
 * One 8-bit sRGB step along these rays is about 0.004 in OKLab lightness, so
 * this is two steps of the lattice the colours are quantised onto. It is a
 * measured floor, not a nominal one: the nominal spacing is larger everywhere
 * (0.010 even on the tightest theme), but quantising to 8-bit sRGB moves each
 * level by up to half a lattice step in either direction, and on a short run
 * that wobble is a real part of the result.
 */
export const MIN_TEXT_LEVEL_STEP_L = 0.008;

/** Sampling step for the search that finds the end of the run. */
const TEXT_RUN_SCAN_STEP = 0.002;

// resolveTheme() runs on every theme-var rebuild and the search below is a
// scan. It is a pure function of its arguments, so results are cached.
const textLadderCache = new Map<string, LightTextLadder>();

export interface LightTextLadder {
  /** The authored anchor, never rewritten. */
  text: string;
  secondary: string;
  tertiary: string;
  dim: string;
  /**
   * OKLab lightness between `text` and the far end of the run. This is the
   * room the theme actually has for a hierarchy; the report quotes it.
   */
  roomL: number;
  /** Which placement the room allowed. */
  spacing: LightTextSpacing;
}

/**
 * Builds the light text hierarchy by walking from `text` toward `target` in
 * OKLab.
 *
 * `target` is the paper anchor rather than the composited panel: fading a
 * foreground toward its own surface keeps the theme's hue family (sakura stays
 * plum, kinari stays warm), whereas walking toward the wallpaper-composited
 * panel would drag all nine toward the same grey. Which ray is walked does not
 * affect safety — the floor is enforced against every host in `hosts`,
 * whatever direction the run takes.
 *
 * The run is cut at the last sampled point that still clears `floor`
 * everywhere, scanning upward and stopping at the first failure, so every
 * point below the cut is known to pass rather than assumed to.
 *
 * Spacing is chosen by measurement, not by a guessed threshold: the shaped
 * positions are tried first, and if the room is so short that quantising the
 * result puts two levels within `MIN_TEXT_LEVEL_STEP_L` of each other, the run
 * is re-spread evenly instead. Even spread is the arrangement with the largest
 * possible smallest step, so it is what "the room genuinely cannot fit the
 * shaped gaps" resolves to — levels move closer together, never onto each
 * other.
 */
export function resolveLightTextLadder(
  text: string,
  target: string,
  hosts: readonly string[],
  floor: number,
): LightTextLadder {
  const start = hexToOklab(text);
  const end = hexToOklab(target);
  if (!start || !end || hosts.length === 0) {
    return {
      text,
      secondary: text,
      tertiary: text,
      dim: text,
      roomL: 0,
      spacing: "SHAPED",
    };
  }

  const cacheKey = `${text}|${target}|${floor}|${hosts.join(",")}`;
  const cached = textLadderCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const at = (t: number) => mixOklab(text, target, t);
  const passes = (color: string) => hosts.every((host) => contrastRatio(color, host) >= floor);

  let runEnd = 0;
  for (let t = TEXT_RUN_SCAN_STEP; t <= 1; t += TEXT_RUN_SCAN_STEP) {
    if (!passes(at(t))) {
      break;
    }
    runEnd = t;
  }

  const place = (spacing: LightTextSpacing): LightTextLadder => {
    const positions = LIGHT_TEXT_LEVEL_POSITIONS[spacing];
    return {
      text,
      secondary: at(runEnd * positions.secondary),
      tertiary: at(runEnd * positions.tertiary),
      dim: at(runEnd * positions.dim),
      roomL: (end.L - start.L) * runEnd,
      spacing,
    };
  };

  const shaped = place("SHAPED");
  const ladder =
    smallestStepL(shaped) >= MIN_TEXT_LEVEL_STEP_L ? shaped : place("PROPORTIONAL");

  textLadderCache.set(cacheKey, ladder);
  return ladder;
}

/** The four levels, darkest first. */
export function textLadderLevels(ladder: LightTextLadder): string[] {
  return [ladder.text, ladder.secondary, ladder.tertiary, ladder.dim];
}

/** Measured OKLab lightness gaps between consecutive levels. */
export function textLadderStepsL(ladder: LightTextLadder): number[] {
  const lightness = textLadderLevels(ladder).map((level) => hexToOklab(level)?.L ?? 0);
  return [
    lightness[1] - lightness[0],
    lightness[2] - lightness[1],
    lightness[3] - lightness[2],
  ];
}

function smallestStepL(ladder: LightTextLadder): number {
  return Math.min(...textLadderStepsL(ladder));
}

/**
 * Flattens a possibly-translucent CSS colour onto an opaque host, so a state
 * wash becomes an opaque fill. `rgb()` / `rgba()` / `#rgb` / `#rrggbb` /
 * `#rrggbbaa` are understood; anything else is returned untouched rather than
 * guessed at.
 */
export function flattenOnto(color: string, host: string): string {
  const parsed = parseColorWithAlpha(color);
  const hostChannels = parseHexChannels(host);
  if (!parsed || !hostChannels) {
    return color;
  }
  return rgbToHex({
    red: parsed.red * parsed.alpha + hostChannels.red * (1 - parsed.alpha),
    green: parsed.green * parsed.alpha + hostChannels.green * (1 - parsed.alpha),
    blue: parsed.blue * parsed.alpha + hostChannels.blue * (1 - parsed.alpha),
  });
}

function parseColorWithAlpha(
  value: string,
): { red: number; green: number; blue: number; alpha: number } | null {
  const trimmed = value.trim();

  const hexChannels = parseHexChannels(trimmed);
  if (hexChannels) {
    return { ...hexChannels, alpha: 1 };
  }

  const hexAlpha = /^#([0-9a-f]{4}|[0-9a-f]{8})$/i.exec(trimmed);
  if (hexAlpha) {
    const digits = hexAlpha[1];
    const wide = digits.length === 8;
    const pick = (index: number) =>
      wide
        ? parseInt(digits.slice(index * 2, index * 2 + 2), 16)
        : parseInt(digits[index].repeat(2), 16);
    return { red: pick(0), green: pick(1), blue: pick(2), alpha: pick(3) / 255 };
  }

  const functional = /^rgba?\(([^)]*)\)$/i.exec(trimmed);
  if (!functional) {
    return null;
  }
  const parts = functional[1].split(/[,/]/).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 3) {
    return null;
  }
  const channel = (raw: string) =>
    raw.endsWith("%") ? (Number(raw.slice(0, -1)) / 100) * 255 : Number(raw);
  const red = channel(parts[0]);
  const green = channel(parts[1]);
  const blue = channel(parts[2]);
  if (![red, green, blue].every((component) => Number.isFinite(component))) {
    return null;
  }
  let alpha = 1;
  if (parts.length >= 4) {
    const raw = parts[3];
    const value = raw.endsWith("%") ? Number(raw.slice(0, -1)) / 100 : Number(raw);
    alpha = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
  }
  return { red, green, blue, alpha };
}

export interface ResolveThemeInput {
  /** The authored theme, user tweaks already composited in. */
  theme: ThemeDefinition;
  background: ThemeBackgroundSettings;
  /** Whether a wallpaper is actually painted behind the chrome. */
  mediaActive: boolean;
  /**
   * Optional: CSS variable names the app is known to consume. Any name in here
   * that the resolver does not emit is reported as `missing-token`. Stage 3
   * will feed this from a static scan; until then the resolver self-checks when
   * the list is omitted.
   */
  consumedTokens?: readonly string[];
}

export interface ResolveThemeResult {
  resolved: ResolvedTheme;
  /** The opaque surface roles the tokens were built from. */
  surfaces: SurfaceLadder;
  /** The alpha and wallpaper-tone policy applied on top of them. */
  composition: CompositionPolicy;
  diagnostics: ThemeDiagnostic[];
}

/** Whether the background settings actually paint a wallpaper. */
export function isMediaBackgroundActive(background: ThemeBackgroundSettings): boolean {
  return (
    background.mode === "preset" ||
    (background.mode === "image" && background.imagePath.length > 0)
  );
}

// Glyph color for text painted on top of a filled swatch (accent buttons,
// status badges, notification counters) — i.e. every --cmux-on-* token.
// White is kept whenever it clears the WCAG AA floor (preserves the
// conventional white-on-blue look); otherwise pure black takes over, which is
// mathematically safe: any fill where white measures < 4.5:1 is light enough
// that black measures >= ~4.67:1. The previous luma-140 threshold paired with
// #0a0a0a carried no such guarantee — mid-tone light fills (the light themes'
// status.done/error, several light accents) landed as low as 3.16:1. Non-hex
// input (a user color tweak may store rgba()) keeps the white fallback.
export function textOnColor(color: string): string {
  if (!isHexColor(color)) {
    return "#ffffff";
  }
  return contrastRatio("#ffffff", color) >= 4.5 ? "#ffffff" : "#000000";
}

/**
 * Every surface a light theme's text is allowed to land on, as the theme
 * authored them. This is the set the text ladder has to satisfy and the set
 * the contrast floor is stated against.
 *
 * These are the opaque colours, not the wallpaper-composited ones. Stage 2 and
 * 2b measured against a panel composited over a pure-black wallpaper, and the
 * text had to darken so far to clear that bound that the hierarchy collapsed
 * on the themes with the lightest body colour - all to survive a backdrop no
 * user has. What the resolver can honestly promise is the floor against the
 * surfaces the theme defines; how much a given wallpaper erodes that is the
 * user's choice, made with the wallpaper in front of them.
 *
 * The state fills are still flattened, because a wash is not a surface until
 * it has one underneath it.
 */
export function lightTextHosts(
  theme: ThemeDefinition,
  surfaces: SurfaceLadder,
  hover: string,
  selected: string,
): string[] {
  return [
    surfaces.canvas,
    surfaces.surfaceLow,
    surfaces.surface,
    theme.terminal.background,
    surfaces.surfaceRaised,
    surfaces.popover,
    flattenOnto(hover, surfaces.surfaceLow),
    flattenOnto(selected, surfaces.surfaceLow),
  ];
}

/**
 * Turns a `ThemeDefinition` plus the wallpaper composition state into the final
 * palette the components consume.
 *
 * Pure: no React, no DOM, no store access. Same input, same output.
 */
export function resolveTheme(input: ResolveThemeInput): ResolveThemeResult {
  const { theme, background, mediaActive } = input;

  // Chrome shadows and the light/dark split key off the effective chrome
  // background (color overrides included), not colorScheme — a dark theme
  // recolored light needs this too. Making the declared scheme authoritative is
  // stage 3; stage 1 measured the built-ins and found zero disagreement.
  const isLightChrome = isLightColor(theme.chrome.background);
  const surfaces = resolveSurfaceLadder(theme);
  const composition = resolveCompositionPolicy(theme, background, mediaActive);

  const resolved = isLightChrome
    ? resolveLightTheme(theme, surfaces, composition)
    : resolveDarkTheme(theme, surfaces, composition);

  return {
    resolved,
    surfaces,
    composition,
    diagnostics: collectDiagnostics(
      theme,
      resolved,
      isLightChrome,
      input.consumedTokens,
      isLightChrome
        ? lightTextHosts(theme, surfaces, resolved.hover, resolved.selected)
        : [],
    ),
  };
}

/**
 * The dark branch, frozen. Every expression here is the one AppShell.tsx used
 * before stage 1; tests/unit/resolveTheme.test.ts diffs all 21 dark themes
 * against that original derivation, variable by variable.
 */
function resolveDarkTheme(
  theme: ThemeDefinition,
  surfaces: SurfaceLadder,
  composition: CompositionPolicy,
): ResolvedTheme {
  const panelOpacity = composition.chromeBackdropAlpha;
  // Ladder steps derived with color-mix() cannot be fed back through
  // colorWithOpacity() (which only parses hex), so translucency is applied as a
  // second color-mix toward transparent. Without this the pane tab bar renders
  // as an opaque slab over a media background instead of letting it through.
  const withPanelOpacity = (color: string) =>
    panelOpacity >= 0.995
      ? color
      : `color-mix(in srgb, ${color} ${(panelOpacity * 100).toFixed(2)}%, transparent)`;
  const surfaceRaised = withPanelOpacity(surfaces.surfaceRaised);

  return {
    ...sharedTokens(theme),
    colorScheme: theme.colorScheme,

    bgSolid: theme.chrome.background,
    surfaceSolid: theme.chrome.surface,
    bg: colorWithOpacity(theme.chrome.background, panelOpacity),
    sidebar: colorWithOpacity(theme.chrome.surface, panelOpacity),
    // The pane tab strip has always painted --cmux-surface-raised through this
    // fallback; naming it explicitly changes nothing for dark and lets the
    // light branch put the strip on surface-low where the memo wants it.
    paneTabBarBg: surfaceRaised,
    surfaceRaised,
    popover: surfaces.popover,
    titleBg: colorWithOpacity(theme.chrome.background, panelOpacity),
    surface: colorWithOpacity(theme.chrome.surface, panelOpacity),
    terminalBg: colorWithOpacity(theme.terminal.background, composition.terminalBackdropAlpha),

    borderHairline: "rgba(255, 255, 255, 0.07)",

    text: theme.chrome.text,
    textSecondary: theme.chrome.textMuted,
    textTertiary: theme.chrome.textDim,
    textDim: theme.chrome.textDim,

    hover: theme.chrome.hover,
    selected: theme.chrome.selected,

    backdrop: "rgba(0, 0, 0, 0.55)",
    edgeHighlight: "inset 0 1px 0 rgba(255, 255, 255, 0.05)",
    focusRing: "color-mix(in srgb, var(--cmux-accent) 45%, transparent)",
    dndTab: "#38bdf8",
    dndPane: "#f59e0b",
    usageOk: "#3eb86b",
    usageWarn: "#f5a623",
    usageDanger: "#ff3b30",

    shadowMenu: "var(--cmux-edge-highlight), 0 4px 12px rgba(0, 0, 0, 0.5)",
    shadowPopover: "var(--cmux-edge-highlight), 0 4px 16px rgba(0,0,0,0.4)",
    shadowDropdown: "var(--cmux-edge-highlight), 0 10px 24px rgba(0, 0, 0, 0.32)",
    shadowDialog: "var(--cmux-edge-highlight), 0 18px 60px rgba(0,0,0,0.45)",
    shadowPalette: "var(--cmux-edge-highlight), 0 24px 70px rgba(0,0,0,0.45)",
    shadowPaneMenu: "var(--cmux-edge-highlight), 0 4px 12px rgba(0,0,0,0.2)",
    shadowDnd:
      "0 14px 34px rgba(0, 0, 0, 0.36), inset 0 0 0 1px rgba(255, 255, 255, 0.05)",
    shadowDndStrong:
      "0 16px 38px rgba(0, 0, 0, 0.42), 0 0 24px color-mix(in srgb, var(--pane-dnd-color) 22%, transparent)",
    shadowDndLabel: "0 6px 18px rgba(0, 0, 0, 0.34)",
  };
}

/**
 * The light branch, rebuilt on the surface ladder and the composition policy.
 *
 * Two rules run through all of it:
 *   - only the backdrop roles carry alpha; every other colour is flattened onto
 *     the surface it is painted on,
 *   - anything the resolver derives is darkened until it clears its floor
 *     against every surface it can land on, wallpaper composited in.
 */
function resolveLightTheme(
  theme: ThemeDefinition,
  surfaces: SurfaceLadder,
  composition: CompositionPolicy,
): ResolvedTheme {
  const chromeAlpha = composition.chromeBackdropAlpha;

  // hover / selected are washes, and they stay the washes the theme authored.
  //
  // Stage 2 flattened them into opaque fills, and stage 2b re-thinned them by
  // the panel alpha; both were bookkeeping for the pure-black bound, and both
  // changed what a hovered row looks like on glass (an opaque fill is a solid
  // chip with 0% of the wallpaper showing through, against 32% around it).
  // With the bound gone the wash needs no correction: it tints whatever it
  // lands on, which is what a state wash is for.
  const hover = theme.chrome.hover;
  const selected = theme.chrome.selected;

  // The fine rule that, together with the shadows, carries the elevation the
  // ladder no longer expresses as lightness. Same appearance as the old
  // 70%-toward-transparent border, resolved to an opaque colour so it stops
  // letting the wallpaper through a 1px line.
  const borderHairline = flattenOnto(withAlpha(theme.chrome.border, 0.7), surfaces.surface);

  const hosts = lightTextHosts(theme, surfaces, hover, selected);
  const textLadder = resolveLightTextLadder(
    theme.chrome.text,
    surfaces.surface,
    hosts,
    TEXT_CONTRAST_FLOOR,
  );

  return {
    ...sharedTokens(theme),
    colorScheme: theme.colorScheme,

    bgSolid: surfaces.canvas,
    surfaceSolid: surfaces.surface,
    bg: colorWithOpacity(surfaces.canvas, chromeAlpha),
    sidebar: colorWithOpacity(surfaces.surfaceLow, chromeAlpha),
    paneTabBarBg: colorWithOpacity(surfaces.surfaceLow, chromeAlpha),
    surfaceRaised: colorWithOpacity(surfaces.surfaceRaised, composition.raisedAlpha),
    popover: colorWithOpacity(surfaces.popover, composition.popoverAlpha),
    titleBg: colorWithOpacity(surfaces.surfaceLow, chromeAlpha),
    surface: colorWithOpacity(surfaces.surface, chromeAlpha),
    terminalBg: colorWithOpacity(theme.terminal.background, composition.terminalBackdropAlpha),

    borderHairline,

    // chrome.text is an explicit anchor: the resolver reports on it, it does not
    // rewrite it (design memo section 6). The three quieter levels are derived
    // from it and from the host surface, which is the endpoint the memo's
    // migration note (section 5, step 4) names: the authored textMuted/textDim
    // are demoted to optional hints and no longer decide anything.
    text: theme.chrome.text,
    textSecondary: textLadder.secondary,
    textTertiary: textLadder.tertiary,
    textDim: textLadder.dim,

    hover,
    selected,

    backdrop: "rgba(15, 23, 42, 0.22)",
    // On a paper-over-paper stack a white top highlight says nothing, so the
    // light edge is a full hairline ring instead.
    edgeHighlight: `inset 0 0 0 1px ${borderHairline}`,
    focusRing: flattenOnto(withAlpha(theme.chrome.accent, 0.45), surfaces.surface),
    dndTab: theme.status.working,
    dndPane: theme.status.waiting,
    usageOk: theme.status.done,
    usageWarn: theme.status.waiting,
    usageDanger: theme.status.error,

    // Raised and popover are now the same colour as the surface underneath, so
    // the shadows carry the step: a tight contact layer plus the ambient one.
    shadowMenu: "var(--cmux-edge-highlight), 0 1px 2px rgba(15, 23, 42, 0.10), 0 8px 20px rgba(15, 23, 42, 0.16)",
    shadowPopover: "var(--cmux-edge-highlight), 0 1px 2px rgba(15, 23, 42, 0.10), 0 8px 26px rgba(15, 23, 42, 0.16)",
    shadowDropdown: "var(--cmux-edge-highlight), 0 1px 2px rgba(15, 23, 42, 0.10), 0 12px 28px rgba(15, 23, 42, 0.16)",
    shadowDialog: "var(--cmux-edge-highlight), 0 2px 4px rgba(15, 23, 42, 0.10), 0 20px 60px rgba(15, 23, 42, 0.18)",
    shadowPalette: "var(--cmux-edge-highlight), 0 2px 4px rgba(15, 23, 42, 0.10), 0 24px 70px rgba(15, 23, 42, 0.18)",
    shadowPaneMenu: "var(--cmux-edge-highlight), 0 1px 2px rgba(15, 23, 42, 0.10), 0 8px 18px rgba(15, 23, 42, 0.14)",
    shadowDnd: `0 14px 34px rgba(15, 23, 42, 0.18), inset 0 0 0 1px ${borderHairline}`,
    shadowDndStrong:
      "0 16px 38px rgba(15, 23, 42, 0.22), 0 0 24px color-mix(in srgb, var(--pane-dnd-color) 18%, transparent)",
    shadowDndLabel: "0 8px 20px rgba(15, 23, 42, 0.16)",
  };
}

/** Re-emits an opaque hex at a given alpha as `rgba(...)`. */
function withAlpha(color: string, alpha: number): string {
  const channels = parseHexChannels(color);
  if (!channels) {
    return color;
  }
  return `rgba(${channels.red}, ${channels.green}, ${channels.blue}, ${alpha})`;
}

/** Tokens that do not branch on the scheme. */
function sharedTokens(
  theme: ThemeDefinition,
): Omit<
  ResolvedTheme,
  | "colorScheme"
  | "bgSolid"
  | "surfaceSolid"
  | "bg"
  | "sidebar"
  | "paneTabBarBg"
  | "surfaceRaised"
  | "popover"
  | "titleBg"
  | "surface"
  | "terminalBg"
  | "borderHairline"
  | "text"
  | "textSecondary"
  | "textTertiary"
  | "textDim"
  | "hover"
  | "selected"
  | "backdrop"
  | "edgeHighlight"
  | "focusRing"
  | "dndTab"
  | "dndPane"
  | "usageOk"
  | "usageWarn"
  | "usageDanger"
  | "shadowMenu"
  | "shadowPopover"
  | "shadowDropdown"
  | "shadowDialog"
  | "shadowPalette"
  | "shadowPaneMenu"
  | "shadowDnd"
  | "shadowDndStrong"
  | "shadowDndLabel"
> {
  return {
    accent: theme.chrome.accent,
    accentText: resolveAccentTextColor(
      theme.chrome.accent,
      theme.chrome.text,
      theme.chrome.background,
    ),
    border: theme.chrome.border,

    red: theme.chrome.danger,
    yellow: theme.status.waiting,

    onAccent: textOnColor(theme.chrome.accent),
    onWorking: textOnColor(theme.status.working),
    onWaiting: textOnColor(theme.status.waiting),
    onDone: textOnColor(theme.status.done),
    onError: textOnColor(theme.status.error),
    statusStall: theme.status.stall,
    onStall: textOnColor(theme.status.stall),

    statusWorking: theme.status.working,
    statusWaiting: theme.status.waiting,
    statusDone: theme.status.done,
    statusError: theme.status.error,
    notificationColor: theme.notification,

    chromeTextShadow: "none",
    chromeIconShadow: "none",
  };
}

/** Projects a `ResolvedTheme` onto the CSS custom properties components read. */
export function resolvedThemeToCssVars(resolved: ResolvedTheme): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const token of RESOLVED_THEME_TOKENS) {
    vars[token.cssVar] = resolved[token.key];
  }
  return vars;
}

/**
 * Best-effort alpha of a CSS colour value. Returns 1 when the value carries no
 * alpha or cannot be read — a diagnostic must not invent a problem out of a
 * syntax it does not understand.
 */
export function colorAlpha(value: string): number {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "none") {
    return 1;
  }

  // color-mix() toward `transparent`: the surviving percentage is the alpha.
  // Matches the innermost/last "<pct>%, transparent)" so a nested mix (the
  // raised surface is a mix of a mix) still reports the outer alpha.
  if (/,\s*transparent\s*\)/.test(trimmed)) {
    const matches = [...trimmed.matchAll(/(\d+(?:\.\d+)?)%\s*,\s*transparent\s*\)/g)];
    const last = matches[matches.length - 1];
    return last ? Number(last[1]) / 100 : 0;
  }

  const functional = /^(?:rgba?|hsla?)\(([^)]*)\)$/i.exec(trimmed);
  if (functional) {
    const parts = functional[1].split(/[,/]/).map((part) => part.trim()).filter(Boolean);
    if (parts.length < 4) {
      return 1;
    }
    const raw = parts[3];
    const alpha = raw.endsWith("%") ? Number(raw.slice(0, -1)) / 100 : Number(raw);
    return Number.isFinite(alpha) ? alpha : 1;
  }

  const hex8 = /^#([0-9a-f]{4}|[0-9a-f]{8})$/i.exec(trimmed);
  if (hex8) {
    const digits = hex8[1];
    const raw = digits.length === 4 ? digits.slice(3).repeat(2) : digits.slice(6);
    return parseInt(raw, 16) / 255;
  }

  return 1;
}

/**
 * Roles that are allowed to carry alpha.
 *
 * Backdrops and shadows by definition. `state` joined them when the light
 * washes went back to being washes: a hover or selection tint is meant to take
 * the colour of whatever it lands on, and forcing it opaque paints a solid
 * chip over the wallpaper instead. What keeps it safe is not opacity but
 * measurement — `lightTextHosts` flattens the wash onto its surface and the
 * text ladder clears the floor against the result.
 *
 * Foregrounds, surfaces and borders stay opaque, because those are the ones
 * that decide legibility (a translucent hairline lets the wallpaper through a
 * 1px line; a translucent foreground has no defined contrast at all).
 */
const TRANSLUCENCY_ALLOWED_ROLES: ReadonlySet<ThemeTokenRole> = new Set<ThemeTokenRole>([
  "backdrop",
  "shadow",
  "state",
]);

/** The four levels the light branch derives, in ladder order. */
const LIGHT_TEXT_TOKENS: readonly ThemeTokenSpec[] = RESOLVED_THEME_TOKENS.filter((token) =>
  ["text", "textSecondary", "textTertiary", "textDim"].includes(token.key),
);

function collectDiagnostics(
  theme: ThemeDefinition,
  resolved: ResolvedTheme,
  isLightChrome: boolean,
  consumedTokens: readonly string[] | undefined,
  lightHosts: readonly string[],
): ThemeDiagnostic[] {
  const diagnostics: ThemeDiagnostic[] = [];
  const emitted = new Set<string>();

  for (const token of RESOLVED_THEME_TOKENS) {
    const value = resolved[token.key];
    emitted.add(token.cssVar);

    if (typeof value !== "string" || value.trim() === "") {
      diagnostics.push({
        code: "missing-token",
        severity: "error",
        token: token.cssVar,
        message: `${token.cssVar} resolved to an empty value.`,
      });
      continue;
    }

    if (TRANSLUCENCY_ALLOWED_ROLES.has(token.role)) {
      continue;
    }

    const alpha = colorAlpha(value);
    if (alpha < 1) {
      diagnostics.push({
        code: "translucent-semantic-color",
        severity: "warning",
        token: token.cssVar,
        message: `${token.cssVar} (${token.role}) resolves to alpha ${alpha}; only backdrop and shadow roles may be translucent.`,
      });
    }
  }

  for (const consumed of consumedTokens ?? []) {
    if (!emitted.has(consumed)) {
      diagnostics.push({
        code: "missing-token",
        severity: "error",
        token: consumed,
        message: `${consumed} is consumed by the app but the resolver emits no value for it.`,
      });
    }
  }

  // The text ladder walks as far toward the floor as it can and no further, so
  // a derived level can only fail here when the anchor it descends from
  // already fails: the theme authors a `chrome.text` that cannot clear 4.5:1
  // on one of its own surfaces. Rewriting the anchor to fix that is exactly
  // what the design memo (section 6) forbids, so the resolver reports it with
  // the measurement attached and leaves the colour alone. This is the check
  // that catches a bad *theme*; what a wallpaper does on top of it is the
  // user's call and is measured, not enforced (module header).
  //
  // All nine built-ins are clear, which themeContrast.test.ts pins. Dark
  // themes pass no hosts: their text is still stage 1's and this check is not
  // yet defined for them (design memo section 7, item 3).
  for (const token of lightHosts.length > 0 ? LIGHT_TEXT_TOKENS : []) {
    const color = resolved[token.key];
    let worst = Infinity;
    let worstHost = "";
    for (const host of lightHosts) {
      const measured = contrastRatio(color, host);
      if (measured < worst) {
        worst = measured;
        worstHost = host;
      }
    }
    if (worst < TEXT_CONTRAST_FLOOR) {
      diagnostics.push({
        code: "text-contrast-floor",
        severity: "warning",
        token: token.cssVar,
        message: `${token.cssVar} (${color}) measures ${worst.toFixed(3)}:1 on the theme's own ${worstHost}, under the ${TEXT_CONTRAST_FLOOR}:1 floor. Darken chrome.text or lighten that surface.`,
      });
    }
  }

  // Stage 3 makes the declared scheme authoritative; until then the resolver
  // reports where the two disagree, so the switch can be made with the list in
  // hand.
  const luminanceScheme: ThemeColorScheme = isLightChrome ? "light" : "dark";
  if (luminanceScheme !== theme.colorScheme) {
    diagnostics.push({
      code: "scheme-luminance-mismatch",
      severity: "warning",
      message: `Theme "${theme.id}" declares colorScheme "${theme.colorScheme}" but chrome.background (${theme.chrome.background}) reads as "${luminanceScheme}" by BT.601 luma; 19 tokens branch on the luma result.`,
    });
  }

  return diagnostics;
}
