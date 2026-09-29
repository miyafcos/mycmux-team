// WCAG contrast helpers used to derive/validate theme chrome colors.
//
// Every function here works exclusively in literal #rrggbb hex — the
// resolved theme colors flow into <input type="color"> in ThemeTweakPanel,
// which rejects anything else (e.g. a CSS color-mix() string).

const HEX6_RE = /^#[0-9a-f]{6}$/i;
const HEX3_RE = /^#[0-9a-f]{3}$/i;

function normalizeHex(hex: string): string {
  if (HEX6_RE.test(hex)) {
    return hex.toLowerCase();
  }
  const short = HEX3_RE.exec(hex);
  if (short) {
    return `#${hex
      .slice(1)
      .split("")
      .map((ch) => ch + ch)
      .join("")}`.toLowerCase();
  }
  throw new Error(`colorContrast: expected a #rrggbb hex color, got "${hex}"`);
}

/** Whether `value` is a literal #rgb/#rrggbb color these helpers can measure. */
export function isHexColor(value: string): boolean {
  return HEX6_RE.test(value) || HEX3_RE.test(value);
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = normalizeHex(hex);
  return [
    parseInt(normalized.slice(1, 3), 16),
    parseInt(normalized.slice(3, 5), 16),
    parseInt(normalized.slice(5, 7), 16),
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  const clampByte = (v: number) => Math.min(255, Math.max(0, Math.round(v)));
  const toHex = (v: number) => clampByte(v).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function srgbChannelToLinear(channel255: number): number {
  const c = channel255 / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance (0..1) of a #rrggbb color. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return (
    0.2126 * srgbChannelToLinear(r) +
    0.7152 * srgbChannelToLinear(g) +
    0.0722 * srgbChannelToLinear(b)
  );
}

/** WCAG contrast ratio (1..21) between two #rrggbb colors. */
export function contrastRatio(hexA: string, hexB: string): number {
  const lA = relativeLuminance(hexA);
  const lB = relativeLuminance(hexB);
  const lighter = Math.max(lA, lB);
  const darker = Math.min(lA, lB);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Linearly mixes two #rrggbb colors in sRGB space and returns a literal
 * #rrggbb hex. `t=0` returns `from`, `t=1` returns `to`.
 */
export function mixHex(from: string, to: string, t: number): string {
  const clampedT = Math.min(1, Math.max(0, t));
  const [r1, g1, b1] = hexToRgb(from);
  const [r2, g2, b2] = hexToRgb(to);
  return rgbToHex(
    r1 + (r2 - r1) * clampedT,
    g1 + (g2 - g1) * clampedT,
    b1 + (b2 - b1) * clampedT,
  );
}

const DEFAULT_CONTRAST_TARGET = 4.5;
const BISECTION_STEPS = 40;

/**
 * Finds the dimmest tint of `from` mixed toward `toward` that still keeps
 * contrast(result, against) >= target. Used to derive a de-emphasized
 * ("dim") text color from the theme's main text color: we search from the
 * dimmest acceptable value upward (i.e. as close to `toward`/background as
 * legibility allows) rather than just returning `from` unmixed, so the
 * result still reads as visually lower-emphasis than `from`.
 *
 * If `from` itself doesn't meet `target` against `against`, there is no
 * legible dim variant to derive — `from` is returned unchanged.
 */
export function resolveDimColor(
  from: string,
  toward: string,
  against: string,
  target: number = DEFAULT_CONTRAST_TARGET,
): string {
  if (contrastRatio(from, against) < target) {
    return normalizeHex(from);
  }

  // Invariant: mixHex(from, toward, lo) always meets `target`;
  // mixHex(from, toward, hi) may not. Converge lo upward (dimmer) toward hi.
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < BISECTION_STEPS; i++) {
    const mid = (lo + hi) / 2;
    const candidate = mixHex(from, toward, mid);
    if (contrastRatio(candidate, against) >= target) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  const result = mixHex(from, toward, lo);
  // Bisection with a fixed step count can leave a hair under target after
  // hex-rounding; fall back to the unmixed color rather than ship a color
  // that fails its own contract.
  return contrastRatio(result, against) >= target ? result : normalizeHex(from);
}

/**
 * Applies a contrast floor to an authored color: if it already meets
 * `target` against `against`, it is returned untouched. Otherwise it is
 * mixed toward `toward` (typically the theme's main text color) by just
 * enough to reach `target`.
 */
export function applyContrastFloor(
  color: string,
  toward: string,
  against: string,
  target: number = DEFAULT_CONTRAST_TARGET,
): string {
  if (contrastRatio(color, against) >= target) {
    return normalizeHex(color);
  }
  if (contrastRatio(toward, against) < target) {
    // Can't reach target even at full strength — best effort is `toward`.
    return normalizeHex(toward);
  }

  // Invariant: mixHex(color, toward, lo) does not meet `target`;
  // mixHex(color, toward, hi) does. Converge hi downward toward lo.
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < BISECTION_STEPS; i++) {
    const mid = (lo + hi) / 2;
    const candidate = mixHex(color, toward, mid);
    if (contrastRatio(candidate, against) >= target) {
      hi = mid;
    } else {
      lo = mid;
    }
  }

  const result = mixHex(color, toward, hi);
  return contrastRatio(result, against) >= target ? result : normalizeHex(toward);
}

/**
 * The accent color as it must look when used for *text*: lifted toward the
 * theme's main text color only as far as the AA body floor needs. Fills,
 * borders and carets keep the authored accent — only glyphs need the floor.
 *
 * A user color tweak can store a non-hex value (rgba() is accepted there), so
 * unmeasurable input is returned untouched rather than thrown on: this runs
 * during render of the app chrome.
 */
export function resolveAccentTextColor(
  accent: string,
  text: string,
  background: string,
  target: number = DEFAULT_CONTRAST_TARGET,
): string {
  if (!isHexColor(accent) || !isHexColor(text) || !isHexColor(background)) {
    return accent;
  }
  return applyContrastFloor(accent, text, background, target);
}
