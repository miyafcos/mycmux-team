import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ITheme } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "../../src/components/theme/colorContrast";
import { ANSI_KEYS, withAnsiContrastFloor } from "../../src/components/terminal/terminalThemeColors";
import {
  readLiveTerminalAppearance,
  resolveMinimumContrastRatio,
  resolveTerminalAppearance,
  setEffectiveMediaActive,
} from "../../src/stores/compositionStore";
import { useThemeStore } from "../../src/stores/themeStore";

const CONTRAST_TARGET = 4.5;

const xtermWrapper = readFileSync(
  fileURLToPath(new URL("../../src/components/terminal/XTermWrapper.tsx", import.meta.url)),
  "utf8",
);

// A light theme is the worst case: the authored ANSI palette is tuned for a
// dark ground, so most of it collapses into the background here.
const lightTheme: ITheme = {
  background: "#fbfbfb",
  foreground: "#1f2430",
  cursor: "#1f2430",
  selectionBackground: "#d7dce5",
  black: "#1f2430",
  red: "#ff8a8a",
  green: "#7ddba0",
  yellow: "#f6d365",
  blue: "#7fb2ff",
  magenta: "#d6a2ff",
  cyan: "#7fdbe6",
  white: "#f1f3f7",
  brightBlack: "#7a8394",
  brightRed: "#ffb3b3",
  brightGreen: "#a7e9c1",
  brightYellow: "#ffe08a",
  brightBlue: "#a9ccff",
  brightMagenta: "#e6c2ff",
  brightCyan: "#a7ecf3",
  brightWhite: "#ffffff",
};

const correctedKeys = ANSI_KEYS.filter((key) => key !== "black" && key !== "brightBlack");

describe("terminal ANSI contrast floor", () => {
  it("lifts the ANSI palette to the AA floor when a media background is active", () => {
    const corrected = withAnsiContrastFloor(lightTheme, true);
    for (const key of correctedKeys) {
      const color = corrected[key] as string;
      expect(
        contrastRatio(color, lightTheme.background as string),
        `${String(key)} -> ${color}`,
      ).toBeGreaterThanOrEqual(CONTRAST_TARGET);
    }
  });

  it("leaves the palette to xterm when no media background is active", () => {
    // minimumContrastRatio is live in that mode and corrects against the real
    // background, including the user's terminal opacity.
    expect(withAnsiContrastFloor(lightTheme, false)).toBe(lightTheme);
  });

  it("keeps the structural blacks and the non-ANSI entries untouched", () => {
    const corrected = withAnsiContrastFloor(lightTheme, true);
    expect(corrected.black).toBe(lightTheme.black);
    expect(corrected.brightBlack).toBe(lightTheme.brightBlack);
    expect(corrected.background).toBe(lightTheme.background);
    expect(corrected.foreground).toBe(lightTheme.foreground);
    expect(corrected.selectionBackground).toBe(lightTheme.selectionBackground);
  });

  it("passes through a theme whose colors cannot be measured", () => {
    const transparent: ITheme = { ...lightTheme, background: "rgba(0, 0, 0, 0)" };
    expect(withAnsiContrastFloor(transparent, true)).toBe(transparent);
  });

  it("keeps XTermWrapper free of hardcoded terminal colors", () => {
    for (const literal of ["#404040", "#89b4fa"]) {
      expect(xtermWrapper).not.toContain(literal);
    }
    expect(xtermWrapper).toContain("resolveTerminalTheme(");
    expect(xtermWrapper).not.toContain("options.theme = withTerminalOpacity(");
  });

});

// The policy, not the spelling of the function that carries it. Glass means
// xterm's own correction is off (the background it would correct against is
// transparent); opaque means the AA floor for light and the stricter dark
// floor. Live theme updates, cached reattach and cold init all read this.
describe("terminal minimum contrast policy", () => {
  it.each([
    ["glass, dark", { mediaActive: true, isLight: false }, 1],
    ["glass, light", { mediaActive: true, isLight: true }, 1],
    ["opaque, light", { mediaActive: false, isLight: true }, 4.5],
    ["opaque, dark", { mediaActive: false, isLight: false }, 7],
  ] as const)("%s -> %d", (_label, input, expected) => {
    expect(resolveMinimumContrastRatio(input)).toBe(expected);
  });

  it("hands the terminal a full-opacity background whenever it is not glass", () => {
    expect(
      resolveTerminalAppearance({ mediaActive: false, isLight: false, terminalOpacity: 0.45 }),
    ).toEqual({ mediaActive: false, isLight: false, terminalOpacity: 1, minimumContrastRatio: 7 });
    expect(
      resolveTerminalAppearance({ mediaActive: true, isLight: false, terminalOpacity: 0.45 }),
    ).toEqual({ mediaActive: true, isLight: false, terminalOpacity: 0.45, minimumContrastRatio: 1 });
  });

  it("resolves from the live stores, so an async terminal open cannot use a stale value", () => {
    useThemeStore.getState().hydrateSettings({ themeId: "mayonaka", themeTweaks: undefined });
    useThemeStore.getState().setThemeBackground({ terminalOpacity: 0.5 });

    setEffectiveMediaActive(false);
    expect(readLiveTerminalAppearance()).toMatchObject({
      mediaActive: false,
      terminalOpacity: 1,
      minimumContrastRatio: 7,
    });

    setEffectiveMediaActive(true);
    expect(readLiveTerminalAppearance()).toMatchObject({
      mediaActive: true,
      terminalOpacity: 0.5,
      minimumContrastRatio: 1,
    });
  });
});
