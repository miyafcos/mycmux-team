// ANSI palette correction for the terminal theme handed to xterm.
//
// xterm's own minimumContrastRatio is disabled under a media (wallpaper)
// background, because the terminal background is transparent there and xterm
// would correct against a phantom black one. That leaves the ANSI palette
// completely uncorrected exactly where the background is least predictable, so
// the floor has to be baked into the ITheme before it is handed over.

import type { ITheme } from "@xterm/xterm";
import { applyContrastFloor, isHexColor } from "../theme/colorContrast";

export const ANSI_KEYS: (keyof ITheme)[] = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow",
  "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
];

// black/brightBlack are structural: they are what dim/box-drawing output is
// supposed to recede into, and lifting them to 4.5:1 turns every terminal
// border into a foreground-bright line.
const UNCORRECTED_ANSI_KEYS = new Set<keyof ITheme>(["black", "brightBlack"]);

const ANSI_CONTRAST_TARGET = 4.5;

/**
 * Returns `theme` with its ANSI colors lifted to the WCAG AA floor against the
 * terminal background. `mediaActive` false returns the theme untouched — xterm
 * applies its own (stricter) correction then.
 *
 * Must run before the background is swapped for the transparent media one,
 * since the authored opaque background is what the floor measures against.
 */
export function withAnsiContrastFloor(theme: ITheme, mediaActive: boolean): ITheme {
  if (!mediaActive) {
    return theme;
  }
  const foreground = theme.foreground;
  const background = theme.background;
  if (!foreground || !background || !isHexColor(foreground) || !isHexColor(background)) {
    return theme;
  }

  const corrected: Record<string, string> = {};
  for (const key of ANSI_KEYS) {
    if (UNCORRECTED_ANSI_KEYS.has(key)) {
      continue;
    }
    const color = (theme as Record<string, unknown>)[key as string];
    if (typeof color !== "string" || !isHexColor(color)) {
      continue;
    }
    corrected[key as string] = applyContrastFloor(
      color,
      foreground,
      background,
      ANSI_CONTRAST_TARGET,
    );
  }

  return { ...theme, ...corrected };
}
