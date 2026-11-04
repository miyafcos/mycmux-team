import type { ITerminalOptions, ITheme } from "@xterm/xterm";
import { colorWithOpacity } from "../../lib/theme/colorPrimitives";
import { withAnsiContrastFloor } from "./terminalThemeColors";

export function withTerminalOpacity(theme: ITheme, opacity: number, mediaActive: boolean): ITheme {
  return {
    ...theme,
    // Keep the RGB contrast reference even when CSS paints media underneath.
    background: colorWithOpacity(theme.background, mediaActive ? 0 : opacity),
  };
}

/** Every live/capture theme goes through the same contrast and opacity policy. */
export function resolveTerminalTheme(theme: ITheme, opacity: number, mediaActive: boolean): ITheme {
  return withTerminalOpacity(withAnsiContrastFloor(theme, mediaActive), opacity, mediaActive);
}

export interface TerminalOptionsInput {
  fontSize: number;
  fontFamily: string;
  lineHeight: number;
  theme: ITheme;
  minimumContrastRatio: number;
  cursorBlink: boolean;
  windowsBuildNumber?: number;
}

/** The live terminal's options, unchanged; captures override only interaction. */
export function buildTerminalOptions(input: TerminalOptionsInput): ITerminalOptions {
  return {
    cursorBlink: input.cursorBlink,
    cursorStyle: "block",
    fontSize: input.fontSize,
    fontFamily: input.fontFamily,
    fontWeight: 500,
    fontWeightBold: 700,
    letterSpacing: 0,
    lineHeight: input.lineHeight,
    rescaleOverlappingGlyphs: true,
    customGlyphs: true,
    theme: input.theme,
    allowTransparency: true,
    allowProposedApi: true,
    altClickMovesCursor: false,
    macOptionClickForcesSelection: true,
    scrollback: 5000,
    smoothScrollDuration: 0,
    rightClickSelectsWord: true,
    minimumContrastRatio: input.minimumContrastRatio,
    ...(input.windowsBuildNumber !== undefined
      ? { windowsPty: { backend: "conpty", buildNumber: input.windowsBuildNumber } }
      : {}),
  };
}
