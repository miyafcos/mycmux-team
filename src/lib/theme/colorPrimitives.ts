// Low-level colour primitives shared by the theme resolver and the terminal.
//
// These two helpers used to exist twice — once in AppShell.tsx and once in
// XTermWrapper.tsx — with the same body and slightly different signatures. Two
// copies of a colour rule is one copy too many: the wallpaper-mode terminal and
// the chrome panels have to agree on what "0.68 opacity" means down to the
// string, or the composited result stops being reproducible. Single source now.

/**
 * Parses `#rgb` / `#rrggbb` into 0-255 channels. Returns null for anything
 * else (named colours, `rgb()`, `color-mix()`, user tweaks stored as `rgba()`).
 */
export function parseHexChannels(color: string): { red: number; green: number; blue: number } | null {
  const shortHex = /^#([0-9a-f]{3})$/i.exec(color);
  const fullHex = /^#([0-9a-f]{6})$/i.exec(color);
  const hex = fullHex?.[1] ?? shortHex?.[1].split("").map((char) => `${char}${char}`).join("");
  if (!hex) {
    return null;
  }
  return {
    red: parseInt(hex.slice(0, 2), 16),
    green: parseInt(hex.slice(2, 4), 16),
    blue: parseInt(hex.slice(4, 6), 16),
  };
}

/**
 * Re-emits an opaque hex colour as `rgba(...)` at the requested opacity.
 *
 * Opacities at or above 0.995 are returned untouched (rounding to `rgba(...,
 * 1)` would only add noise), and non-hex input is returned untouched because
 * there is nothing to splice an alpha into — callers that need translucency on
 * a derived colour use a `color-mix()` toward `transparent` instead.
 */
export function colorWithOpacity(color: string, opacity: number): string;
export function colorWithOpacity(color: string | undefined, opacity: number): string | undefined;
export function colorWithOpacity(color: string | undefined, opacity: number): string | undefined {
  if (!color || opacity >= 0.995) {
    return color;
  }

  const channels = parseHexChannels(color);
  if (!channels) {
    return color;
  }

  return `rgba(${channels.red}, ${channels.green}, ${channels.blue}, ${opacity})`;
}

export const LIGHT_COLOR_LUMINANCE_THRESHOLD = 140;

/**
 * Whether a hex colour reads as "light". Used to pick chrome shadows from the
 * effective chrome background — which includes user colour overrides — rather
 * than the theme's declared colorScheme. The threshold is BT.601 luma on a
 * 0-255 scale; 140 keeps mid amber/blue accents on the safer contrast side.
 * Non-hex input falls back to dark.
 */
export function isLightColor(color: string): boolean {
  const channels = parseHexChannels(color);
  if (!channels) {
    return false;
  }
  // Perceived luminance (ITU-R BT.601).
  return (
    (channels.red * 299 + channels.green * 587 + channels.blue * 114) / 1000 >
    LIGHT_COLOR_LUMINANCE_THRESHOLD
  );
}
