// OKLab conversions for the theme resolver.
//
// The light surface ladder interpolates between two authored colours and the
// derived text roles walk lightness down while holding hue and chroma. Doing
// either in sRGB skews hue (the classic blue-goes-purple problem) and makes the
// step size mean something different on every theme, so both go through OKLab.
//
// This lives in src/lib/theme/ on purpose: it is part of the authored ->
// resolved boundary, not a general-purpose colour library, and it must not add
// a dependency to the resolver. src/lib/oklch.ts is a separate, unrelated file
// being built for the ailog chart palette; the two deliberately do not share.
//
// Matrices: Bjorn Ottosson, "A perceptual color space for image processing".
//
// Design memo: docs/design/2026-08-20-light-theme-system.md sections 3 and 5.

import { parseHexChannels } from "./colorPrimitives";

export interface Oklab {
  /** Perceptual lightness, 0 (black) to 1 (white). */
  L: number;
  a: number;
  b: number;
}

export interface Rgb {
  red: number;
  green: number;
  blue: number;
}

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value: number): number {
  const c = value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
  return Math.min(255, Math.max(0, Math.round(c * 255)));
}

export function rgbToOklab({ red, green, blue }: Rgb): Oklab {
  const r = srgbToLinear(red);
  const g = srgbToLinear(green);
  const b = srgbToLinear(blue);

  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

export function oklabToRgb({ L, a, b }: Oklab): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return {
    red: linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    green: linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    blue: linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

export function rgbToHex({ red, green, blue }: Rgb): string {
  const part = (value: number) => Math.min(255, Math.max(0, Math.round(value))).toString(16).padStart(2, "0");
  return `#${part(red)}${part(green)}${part(blue)}`;
}

/** OKLab of a hex colour, or null when the value is not a parseable hex. */
export function hexToOklab(hex: string): Oklab | null {
  const channels = parseHexChannels(hex);
  return channels ? rgbToOklab(channels) : null;
}

/** Perceptual lightness of a hex colour, or null when it is not a hex. */
export function oklabLightness(hex: string): number | null {
  return hexToOklab(hex)?.L ?? null;
}

/**
 * Interpolates `from` toward `to` in OKLab. `amount` 0 returns `from`, 1
 * returns `to`. Non-hex input is returned unchanged (there is nothing to
 * interpolate and inventing a colour would be worse than leaving it alone).
 */
export function mixOklab(from: string, to: string, amount: number): string {
  const start = hexToOklab(from);
  const end = hexToOklab(to);
  if (!start || !end) {
    return from;
  }
  const t = Math.min(1, Math.max(0, amount));
  return rgbToHex(
    oklabToRgb({
      L: start.L + (end.L - start.L) * t,
      a: start.a + (end.a - start.a) * t,
      b: start.b + (end.b - start.b) * t,
    }),
  );
}


/**
 * Source-over composite of `color` at `alpha` onto an opaque `backdrop`,
 * both hex. This is the operation the browser performs when a translucent
 * panel is painted over the wallpaper, and it is why pure black is a strict
 * worst case: the result can never be darker than the backdrop.
 */
export function compositeOver(color: string, alpha: number, backdrop: string): string {
  const top = parseHexChannels(color);
  const under = parseHexChannels(backdrop);
  if (!top || !under) {
    return color;
  }
  const a = Math.min(1, Math.max(0, alpha));
  return rgbToHex({
    red: top.red * a + under.red * (1 - a),
    green: top.green * a + under.green * (1 - a),
    blue: top.blue * a + under.blue * (1 - a),
  });
}
