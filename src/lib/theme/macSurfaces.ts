import { hexToOklab, oklabToRgb, rgbToHex } from "./oklab";

/**
 * Opens the surface ladder to macOS proportions.
 *
 * macOS dark mode separates a window from the panels sitting on it by roughly
 * 1.16:1 in luminance, and that separation is what makes a panel edge readable
 * without leaning on a hard border. Measured across the themes here on
 * 2026-09-10 the same figure ranges from 1.03 to 1.17, and the one the Mac was
 * running — 石墨 — sat at 1.07. Flat enough that panels dissolved into the
 * ground, and worse on macOS than on Windows because CoreText also draws the
 * hairline borders lighter, so neither cue carried the edge.
 *
 * The ground never moves. Only the panel tiers are lifted, by a single shared
 * amount, so a theme keeps the darkness it was designed with and only its
 * internal structure gets louder — and the tiers keep their order, because they
 * all travel the same distance.
 *
 * Lightness moves in OKLab, so hue and chroma survive: a warm theme stays warm
 * and a near-neutral one does not pick up a cast the way mixing toward white
 * would give it.
 */

/** What macOS dark mode puts between a window and the panels on it. */
export const MACOS_SURFACE_CONTRAST = 1.16;

/** Never lift by more than this, whatever the arithmetic asks for. */
const MAX_LIGHTNESS_LIFT = 0.09;

/** Below this the lift is not worth the churn of recomputing every token. */
const MIN_WORTHWHILE_LIFT = 0.004;

function channelToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a hex colour, or null if it is not one. */
export function relativeLuminance(hex: string): number | null {
  const parsed = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!parsed) return null;
  const value = parsed[1];
  const [red, green, blue] = [0, 2, 4].map((offset) =>
    channelToLinear(Number.parseInt(value.slice(offset, offset + 2), 16)),
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** Contrast ratio between two hex colours, or null if either is not one. */
export function contrastRatio(a: string, b: string): number | null {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return null;
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Moves a colour's OKLab lightness, leaving hue and chroma alone. */
export function shiftLightness(hex: string, delta: number): string {
  const lab = hexToOklab(hex);
  if (!lab) return hex;
  return rgbToHex(oklabToRgb({ ...lab, L: Math.min(1, Math.max(0, lab.L + delta)) }));
}

/**
 * How far the panel tier has to rise to clear `target` against the ground.
 *
 * Solved by bisection rather than algebra: the trip from OKLab lightness to
 * WCAG luminance runs through a piecewise transfer function, so there is no
 * closed form worth trusting, and twenty halvings land well inside a colour
 * step. Returns 0 when the pair already clears the target, when either colour
 * is not hex, or when the surface is lighter ground than the background, which
 * is what a light theme looks like and is not this function's problem.
 */
export function lightnessLiftFor(
  background: string,
  surface: string,
  target: number = MACOS_SURFACE_CONTRAST,
): number {
  const groundLuminance = relativeLuminance(background);
  const surfaceLuminance = relativeLuminance(surface);
  if (groundLuminance === null || surfaceLuminance === null) return 0;
  // A surface darker than its ground is a design decision, not a flat ladder.
  if (surfaceLuminance < groundLuminance) return 0;

  const current = contrastRatio(background, surface);
  if (current === null || current >= target) return 0;

  let low = 0;
  let high = MAX_LIGHTNESS_LIFT;
  if ((contrastRatio(background, shiftLightness(surface, high)) ?? 0) < target) {
    return MAX_LIGHTNESS_LIFT;
  }

  for (let step = 0; step < 20; step += 1) {
    const mid = (low + high) / 2;
    const reached = contrastRatio(background, shiftLightness(surface, mid)) ?? 0;
    if (reached >= target) {
      high = mid;
    } else {
      low = mid;
    }
  }
  return high < MIN_WORTHWHILE_LIFT ? 0 : high;
}

/** The panel tiers, in the order a reader stacks them. */
export const LIFTED_SURFACE_TOKENS = [
  "--cmux-surface",
  "--cmux-surface-solid",
  "--cmux-sidebar",
  "--cmux-surface-raised",
  "--cmux-popover",
  "--cmux-title-bg",
  // Not --cmux-pane-tabbar-bg: the resolver emits this one without the prefix.
  "--pane-tabbar-bg",
] as const;

// Deliberately absent: --cmux-bg and --cmux-bg-solid are the window ground the
// lift is measured against, and --cmux-terminal-bg is content, not chrome —
// moving it would recolour output the theme was chosen for.

export interface SurfaceInput {
  background: string;
  surface: string;
  tokens: Partial<Record<(typeof LIFTED_SURFACE_TOKENS)[number], string>>;
}

/**
 * CSS variable overrides that bring the panel tiers to macOS separation.
 *
 * Empty when nothing needs moving, so a theme already built to these
 * proportions — 極夜 measures 1.17 — is passed through untouched.
 */
export function macSurfaceOverrides(input: SurfaceInput): Record<string, string> {
  const lift = lightnessLiftFor(input.background, input.surface);
  if (lift === 0) return {};

  const overrides: Record<string, string> = {};
  for (const token of LIFTED_SURFACE_TOKENS) {
    const value = input.tokens[token];
    // Only hex tiers move. A tier carrying alpha is composited over the
    // wallpaper at paint time, and shifting it here would double-count.
    if (value && /^#?[0-9a-f]{6}$/i.test(value.trim())) {
      overrides[token] = shiftLightness(value, lift);
    }
  }
  return overrides;
}
