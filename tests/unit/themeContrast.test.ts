import { describe, expect, it } from "vitest";
import { contrastRatio, isHexColor, relativeLuminance, resolveAccentTextColor } from "../../src/components/theme/colorContrast";
import { THEMES } from "../../src/components/theme/themeDefinitions";
import { compositeOver } from "../../src/lib/theme/oklab";
import {
  flattenOnto,
  resolveCompositionPolicy,
  resolveSurfaceLadder,
  resolveTheme,
  worstCaseBackdrop,
} from "../../src/lib/theme/resolveTheme";
import type { TerminalColors, ThemeBackgroundSettings, ThemeDefinition } from "../../src/types/theme";

// WCAG AA body-text floor. chrome.textDim/chrome.textMuted back real
// readable content (ErrorBoundary crash messages, notification/log lines)
// at small font sizes, so both must clear this against chrome.background.
const CONTRAST_TARGET = 4.5;

// The terminal viewport is the one surface that is nothing but small
// monospaced body text, so its default foreground is held to AAA (7:1)
// rather than the AA body floor.
const TERMINAL_FOREGROUND_TARGET = 7;

// Float/rounding slack applied when comparing against a frozen measurement.
const RATCHET_EPSILON = 0.01;

type ThemeCase = readonly [string, ThemeDefinition];

const THEME_CASES: ThemeCase[] = THEMES.map((theme) => [theme.id, theme] as const);
const LIGHT_THEME_CASES = THEME_CASES.filter(([, theme]) => theme.colorScheme === "light");

// ---------------------------------------------------------------------------
// The resolver's on-color derivation, replicated
// ---------------------------------------------------------------------------
// resolveTheme() derives --cmux-on-accent / --cmux-on-{working,waiting,done,error}
// with textOnColor(); the rule is mirrored here so this ratchet keeps measuring
// it independently. Keep in sync with src/lib/theme/resolveTheme.ts:
// keep white while it clears the 4.5 floor (preserves white-on-blue), switch
// to pure black otherwise, with white as the fallback for unmeasurable
// (non-hex) input.
//
// That rule is what turns the on-color checks below into a real floor rather
// than a frozen debt list: any fill where white measures < 4.5:1 is light
// enough that pure black measures >= ~4.67:1.
function textOnColor(color: string): string {
  if (!isHexColor(color)) {
    return "#ffffff";
  }
  return contrastRatio("#ffffff", color) >= 4.5 ? "#ffffff" : "#000000";
}

type OnColorKey = "accent" | "working" | "waiting" | "done" | "error" | "stall";

const ON_COLOR_KEYS: OnColorKey[] = ["accent", "working", "waiting", "done", "error", "stall"];

function onColorSource(theme: ThemeDefinition, key: OnColorKey): string {
  return key === "accent" ? theme.chrome.accent : theme.status[key];
}

// ---------------------------------------------------------------------------
// Assertion helper
// ---------------------------------------------------------------------------
function assertContrast(themeId: string, pair: string, measured: number, required: number): void {
  expect(
    measured,
    `${themeId}: ${pair} contrast is ${measured.toFixed(3)}:1, below the required ${required.toFixed(3)}:1`,
  ).toBeGreaterThanOrEqual(required);
}

/**
 * Ratchet floor: a frozen measurement can never be the *stricter* of the two,
 * so a pair that already clears the real floor is held at the real floor, and
 * a pair below it is held at wherever it stands today (minus float slack).
 */
function ratchetFloor(floor: number, baseline: number | undefined): number {
  return baseline === undefined ? floor : Math.min(floor, baseline - RATCHET_EPSILON);
}

// ---------------------------------------------------------------------------
// Pre-existing hard-floor debt (measured 2026-08-11)
// ---------------------------------------------------------------------------
// yoi-ai is the Solarized-dark palette: its authored terminal foreground and
// background sit 5.61:1 apart by design and cannot reach AAA without leaving
// Solarized, so that one pair is frozen at its measured value under the same
// ratchet rule as the ANSI table below - it can improve or hold, never
// degrade. The "no stale entries" test at the bottom fails the moment it is
// genuinely fixed, forcing the entry to be deleted rather than silently
// masking a now-passing pair.
//
// The on-color pairs used to be listed here too (25 of them, as low as
// 3.16:1). They were fixed for real instead: the resolver's textOnColor() now
// picks the higher-contrast of pure black/white, so they clear the hard 4.5
// floor without repainting a single theme preset.
const TERMINAL_FOREGROUND_DEBT: Record<string, number> = {
  "yoi-ai": 5.6142,
};

// ---------------------------------------------------------------------------
// ANSI ratchet (deliberately NOT a hard floor)
// ---------------------------------------------------------------------------
// 115 of the 420 (theme x ANSI color) pairs sit under the AA body floor today.
// The 16-color palettes are authored to match well-known terminal schemes and
// to keep hue relationships that users recognize; forcing 4.5:1 on all of them
// would repaint every theme. So instead of a floor they get a ratchet, frozen
// at the ratio each pair measures today:
//
//     required = min(4.5, ANSI_BASELINE[themeId][colorKey] - 0.01)
//
// A pair already at or above 4.5 is held at the real 4.5 floor. A pair below it
// is held at its current value (minus float slack), so a palette edit can only
// keep or improve it, never darken it further. IMPROVING a pair later means
// re-measuring and RAISING its number in this table - the ratchet only tightens.
// Regenerate a value with contrastRatio(theme.terminal[key], theme.terminal.background).
//
// black / brightBlack are excluded: they are structural (borders, dim fills,
// shadow glyphs) and are never expected to carry body text on the terminal
// background - on a dark theme black-on-background is ~1:1 by construction.
const ANSI_KEYS = [
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const satisfies ReadonlyArray<keyof TerminalColors>;

type AnsiKey = (typeof ANSI_KEYS)[number];

const LIGHT_NORMAL_ANSI_KEYS = ["red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const satisfies ReadonlyArray<AnsiKey>;
const LIGHT_BRIGHT_ANSI_KEYS = ["brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"] as const;
const LIGHT_STATUS_KEYS = ["working", "waiting", "done", "error", "stall"] as const;
const LIGHT_CONTRAST_PAIRS_PER_THEME = LIGHT_NORMAL_ANSI_KEYS.length + LIGHT_BRIGHT_ANSI_KEYS.length + 1 + (LIGHT_STATUS_KEYS.length * 2) + 2 + 2 + 1;

const ANSI_BASELINE: Record<string, Partial<Record<AnsiKey, number>>> = {
  "mayonaka": {
    red: 7.4034,
    green: 11.4348,
    yellow: 11.9360,
    blue: 7.8372,
    magenta: 7.5408,
    cyan: 13.7461,
    white: 13.4206,
    brightRed: 10.5375,
    brightGreen: 14.1908,
    brightYellow: 13.8188,
    brightBlue: 11.0497,
    brightMagenta: 11.2717,
    brightCyan: 15.9649,
    brightWhite: 19.0443,
  },
  "shinkai": {
    red: 7.5095,
    green: 11.9398,
    yellow: 11.4508,
    blue: 8.5177,
    magenta: 7.6462,
    cyan: 10.1682,
    white: 12.6415,
    brightRed: 9.2449,
    brightGreen: 13.5299,
    brightYellow: 13.3540,
    brightBlue: 11.5551,
    brightMagenta: 10.6061,
    brightCyan: 13.5926,
    brightWhite: 17.4327,
  },
  "walnut": {
    red: 5.9842,
    green: 8.0434,
    yellow: 7.1580,
    blue: 7.1709,
    magenta: 6.7452,
    cyan: 7.8609,
    white: 11.3486,
    brightRed: 8.0491,
    brightGreen: 10.6636,
    brightYellow: 9.5455,
    brightBlue: 9.6229,
    brightMagenta: 8.9957,
    brightCyan: 10.3847,
    brightWhite: 16.9061,
  },
  "chikurin": {
    red: 7.8493,
    green: 7.9981,
    yellow: 10.4893,
    blue: 8.0437,
    magenta: 7.9615,
    cyan: 9.6245,
    white: 12.3813,
    brightRed: 10.1718,
    brightGreen: 11.2176,
    brightYellow: 12.7484,
    brightBlue: 10.7543,
    brightMagenta: 10.6720,
    brightCyan: 12.3808,
    brightWhite: 16.3177,
  },
  "kyokuya": {
    red: 3.0530,
    green: 6.1267,
    yellow: 7.9979,
    blue: 4.6398,
    magenta: 4.4090,
    cyan: 6.2433,
    white: 10.2566,
    brightRed: 3.0530,
    brightGreen: 6.1267,
    brightYellow: 7.9979,
    brightBlue: 4.6398,
    brightMagenta: 4.4090,
    brightCyan: 5.9943,
    brightWhite: 10.8359,
  },
  "yoi-ai": {
    red: 3.2459,
    green: 4.6852,
    yellow: 4.6775,
    blue: 4.0792,
    magenta: 3.3026,
    cyan: 4.7539,
    white: 12.2524,
    brightRed: 3.2580,
    brightGreen: 2.7896,
    brightYellow: 3.3702,
    brightBlue: 4.7479,
    brightMagenta: 3.4292,
    brightCyan: 5.6142,
    brightWhite: 13.9175,
  },
  "lagoon": {
    red: 5.8592,
    green: 9.0792,
    yellow: 9.3366,
    blue: 7.5497,
    magenta: 7.3636,
    cyan: 10.0361,
    white: 12.7470,
    brightRed: 7.9483,
    brightGreen: 11.5705,
    brightYellow: 11.5224,
    brightBlue: 10.0954,
    brightMagenta: 9.5727,
    brightCyan: 12.7056,
    brightWhite: 17.0293,
  },
  "graphite": {
    red: 5.8084,
    green: 8.2249,
    yellow: 7.6431,
    blue: 7.1216,
    magenta: 6.7981,
    cyan: 8.2027,
    white: 12.1625,
    brightRed: 7.9473,
    brightGreen: 10.9583,
    brightYellow: 10.1547,
    brightBlue: 9.6016,
    brightMagenta: 8.9567,
    brightCyan: 10.7815,
    brightWhite: 16.9854,
  },
  "arctic-night": {
    red: 5.8372,
    green: 10.1946,
    yellow: 9.5170,
    blue: 8.8188,
    magenta: 8.2246,
    cyan: 10.9108,
    white: 12.8609,
    brightRed: 7.8593,
    brightGreen: 13.1071,
    brightYellow: 11.8711,
    brightBlue: 11.4355,
    brightMagenta: 10.4815,
    brightCyan: 13.3151,
    brightWhite: 17.4313,
  },
  "seijaku": {
    red: 3.9967,
    green: 5.5318,
    yellow: 5.8599,
    blue: 5.5403,
    magenta: 4.9271,
    cyan: 6.0719,
    white: 8.2715,
    brightRed: 6.1609,
    brightGreen: 8.8447,
    brightYellow: 8.7510,
    brightBlue: 9.0524,
    brightMagenta: 8.6970,
    brightCyan: 10.0663,
    brightWhite: 19.0820,
  },
  "carbon": {
    red: 5.9231,
    green: 7.3801,
    yellow: 7.6077,
    blue: 7.1343,
    magenta: 6.5229,
    cyan: 8.0489,
    white: 12.5070,
    brightRed: 8.1843,
    brightGreen: 9.8336,
    brightYellow: 10.2142,
    brightBlue: 9.9643,
    brightMagenta: 8.9334,
    brightCyan: 10.6658,
    brightWhite: 17.7285,
  },
  "yogiri": {
    red: 6.3008,
    green: 13.8400,
    yellow: 13.7011,
    blue: 6.8863,
    magenta: 7.3305,
    cyan: 12.7287,
    white: 14.3154,
    brightRed: 8.2792,
    brightGreen: 14.6918,
    brightYellow: 14.8696,
    brightBlue: 10.0349,
    brightMagenta: 10.1071,
    brightCyan: 14.5941,
    brightWhite: 17.1349,
  },
  "raimei": {
    red: 6.3420,
    green: 11.4541,
    yellow: 13.6128,
    blue: 8.1902,
    magenta: 9.0388,
    cyan: 14.1350,
    white: 12.1158,
    brightRed: 8.7275,
    brightGreen: 13.0946,
    brightYellow: 15.3581,
    brightBlue: 10.4257,
    brightMagenta: 11.2056,
    brightCyan: 15.5250,
    brightWhite: 17.5994,
  },
  "sango": {
    red: 6.9084,
    green: 11.1338,
    yellow: 11.7971,
    blue: 10.6719,
    magenta: 8.8669,
    cyan: 10.5327,
    white: 12.8246,
    brightRed: 8.5552,
    brightGreen: 12.8843,
    brightYellow: 13.4487,
    brightBlue: 12.7297,
    brightMagenta: 11.0542,
    brightCyan: 13.0544,
    brightWhite: 16.6819,
  },
  "aurora": {
    red: 7.1535,
    green: 14.1751,
    yellow: 13.2649,
    blue: 9.0299,
    magenta: 7.8688,
    cyan: 12.5963,
    white: 14.7995,
    brightRed: 8.9097,
    brightGreen: 15.9109,
    brightYellow: 15.1446,
    brightBlue: 11.1972,
    brightMagenta: 10.7884,
    brightCyan: 14.6704,
    brightWhite: 18.2421,
  },
  "yougan": {
    red: 7.0108,
    green: 11.3955,
    yellow: 11.0327,
    blue: 9.5271,
    magenta: 9.6066,
    cyan: 11.0437,
    white: 12.2524,
    brightRed: 9.5880,
    brightGreen: 14.4894,
    brightYellow: 13.8888,
    brightBlue: 12.7274,
    brightMagenta: 12.1701,
    brightCyan: 14.7419,
    brightWhite: 18.5965,
  },
  "synthwave": {
    red: 6.5704,
    green: 13.6977,
    yellow: 14.4571,
    blue: 9.5051,
    magenta: 7.3712,
    cyan: 14.4836,
    white: 14.2298,
    brightRed: 8.2299,
    brightGreen: 15.9174,
    brightYellow: 15.8635,
    brightBlue: 12.1941,
    brightMagenta: 9.5039,
    brightCyan: 15.6536,
    brightWhite: 18.3885,
  },
  "kogane": {
    red: 7.7824,
    green: 9.2201,
    yellow: 9.3937,
    blue: 8.7950,
    magenta: 9.4019,
    cyan: 11.1870,
    white: 11.9267,
    brightRed: 10.7769,
    brightGreen: 11.9976,
    brightYellow: 12.8327,
    brightBlue: 11.4765,
    brightMagenta: 12.3012,
    brightCyan: 14.0185,
    brightWhite: 17.9771,
  },
  "ember": {
    red: 6.8216,
    green: 10.5262,
    yellow: 10.6952,
    blue: 7.4952,
    magenta: 7.5853,
    cyan: 9.6473,
    white: 13.4759,
    brightRed: 8.3125,
    brightGreen: 13.3254,
    brightYellow: 13.3407,
    brightBlue: 10.2537,
    brightMagenta: 10.1588,
    brightCyan: 12.3348,
    brightWhite: 18.0397,
  },
  "signal": {
    red: 7.2229,
    green: 13.2935,
    yellow: 14.1557,
    blue: 9.5661,
    magenta: 9.6008,
    cyan: 11.6392,
    white: 12.9619,
    brightRed: 8.9549,
    brightGreen: 15.3426,
    brightYellow: 15.9555,
    brightBlue: 12.1038,
    brightMagenta: 11.8369,
    brightCyan: 14.2073,
    brightWhite: 18.8458,
  },
  "asanagi": {
    red: 4.5651,
    green: 4.5904,
    yellow: 4.5559,
    blue: 4.5730,
    magenta: 4.5738,
    cyan: 4.5919,
    white: 4.5569,
    brightRed: 4.5673,
    brightGreen: 4.5505,
    brightYellow: 4.5810,
    brightBlue: 4.5607,
    brightMagenta: 4.5798,
    brightCyan: 4.5770,
    brightWhite: 5.2377,
  },
  "kinari": {
    red: 4.5501,
    green: 4.5750,
    yellow: 4.5840,
    blue: 4.5597,
    magenta: 4.5546,
    cyan: 4.5952,
    white: 4.5632,
    brightRed: 4.5709,
    brightGreen: 4.5835,
    brightYellow: 4.5753,
    brightBlue: 4.5588,
    brightMagenta: 4.5661,
    brightCyan: 4.6007,
    brightWhite: 5.9439,
  },
  "wakaba": {
    red: 4.5504,
    green: 4.5624,
    yellow: 4.5675,
    blue: 4.5851,
    magenta: 4.5517,
    cyan: 4.5583,
    white: 4.5526,
    brightRed: 4.5766,
    brightGreen: 4.5724,
    brightYellow: 4.5569,
    brightBlue: 4.5559,
    brightMagenta: 4.5794,
    brightCyan: 4.5988,
    brightWhite: 4.6981,
  },
  "geppaku": {
    red: 4.5714,
    green: 4.6018,
    yellow: 4.5923,
    blue: 4.5976,
    magenta: 4.5565,
    cyan: 4.5872,
    white: 4.5562,
    brightRed: 4.5522,
    brightGreen: 4.5718,
    brightYellow: 4.5910,
    brightBlue: 4.5967,
    brightMagenta: 4.5696,
    brightCyan: 4.5544,
    brightWhite: 4.7010,
  },
  "sakura": {
    red: 4.5804,
    green: 4.5862,
    yellow: 4.5559,
    blue: 4.5528,
    magenta: 4.5594,
    cyan: 4.5677,
    white: 4.5705,
    brightRed: 4.5730,
    brightGreen: 4.5587,
    brightYellow: 4.5506,
    brightBlue: 4.5647,
    brightMagenta: 4.5652,
    brightCyan: 4.5920,
    brightWhite: 5.9886,
  },
  "paper": {
    red: 4.6365,
    green: 4.5771,
    yellow: 4.5591,
    blue: 4.8452,
    magenta: 4.5631,
    cyan: 4.5740,
    white: 4.5815,
    brightRed: 4.5543,
    brightGreen: 4.5943,
    brightYellow: 4.5560,
    brightBlue: 4.5892,
    brightMagenta: 4.5689,
    brightCyan: 4.5702,
    brightWhite: 7.8193,
  },
  "hakuchuumu": {
    red: 4.5601,
    green: 4.5897,
    yellow: 4.5563,
    blue: 4.5588,
    magenta: 4.5620,
    cyan: 4.5774,
    white: 4.5642,
    brightRed: 4.5604,
    brightGreen: 4.5986,
    brightYellow: 4.5578,
    brightBlue: 4.5770,
    brightMagenta: 4.5626,
    brightCyan: 4.5556,
    brightWhite: 5.8385,
  },
  "mist": {
    red: 4.5722,
    green: 4.5742,
    yellow: 4.5524,
    blue: 4.5587,
    magenta: 4.5512,
    cyan: 4.6002,
    white: 4.5707,
    brightRed: 4.5516,
    brightGreen: 4.5547,
    brightYellow: 4.5669,
    brightBlue: 4.5606,
    brightMagenta: 4.5830,
    brightCyan: 4.5516,
    brightWhite: 6.6708,
  },
  "ink-day": {
    red: 6.5628,
    green: 6.0576,
    yellow: 5.0268,
    blue: 5.0017,
    magenta: 6.5402,
    cyan: 5.0427,
    white: 4.5623,
    brightRed: 4.7914,
    brightGreen: 4.6030,
    brightYellow: 4.5548,
    brightBlue: 4.5904,
    brightMagenta: 4.6438,
    brightCyan: 4.5536,
    brightWhite: 11.4760,
  },
  "ginga": {
    red: 7.1797,
    green: 11.8128,
    yellow: 13.1459,
    blue: 8.2528,
    magenta: 8.7010,
    cyan: 13.1890,
    white: 14.8425,
    brightRed: 9.7426,
    brightGreen: 14.0936,
    brightYellow: 14.9932,
    brightBlue: 10.8353,
    brightMagenta: 11.4008,
    brightCyan: 14.8570,
    brightWhite: 18.9551,
  },
};

// ---------------------------------------------------------------------------
// Hard floors
// ---------------------------------------------------------------------------
describe("theme chrome text contrast", () => {
  it.each(THEME_CASES)("%s: chrome.text meets the AA body floor", (id, theme) => {
    assertContrast(id, "chrome.text / chrome.background", contrastRatio(theme.chrome.text, theme.chrome.background), CONTRAST_TARGET);
  });

  it.each(THEME_CASES)("%s: textMuted meets contrast floor against chrome.background", (id, theme) => {
    assertContrast(id, "chrome.textMuted / chrome.background", contrastRatio(theme.chrome.textMuted, theme.chrome.background), CONTRAST_TARGET);
  });

  it.each(THEME_CASES)("%s: textDim meets contrast floor against chrome.background", (id, theme) => {
    assertContrast(id, "chrome.textDim / chrome.background", contrastRatio(theme.chrome.textDim, theme.chrome.background), CONTRAST_TARGET);
  });

  it.each(THEME_CASES)("%s: stall text meets contrast floor against chrome.background", (id, theme) => {
    assertContrast(id, "status.stall / chrome.background", contrastRatio(theme.status.stall, theme.chrome.background), CONTRAST_TARGET);
  });

  // The authored accent is chosen to read as a fill/border color, so on several
  // themes it lands well under the floor once it is used for glyphs
  // (--cmux-accent-text is what those call sites get instead).
  it.each(THEME_CASES)("%s: accent text color meets contrast floor against chrome.background", (id, theme) => {
    const accentText = resolveAccentTextColor(theme.chrome.accent, theme.chrome.text, theme.chrome.background);
    assertContrast(id, "resolveAccentTextColor(accent) / chrome.background", contrastRatio(accentText, theme.chrome.background), CONTRAST_TARGET);
  });
});

describe("terminal viewport contrast", () => {
  it.each(THEME_CASES)("%s: terminal.foreground meets the AAA floor against terminal.background", (id, theme) => {
    const required = ratchetFloor(TERMINAL_FOREGROUND_TARGET, TERMINAL_FOREGROUND_DEBT[id]);
    assertContrast(id, "terminal.foreground / terminal.background", contrastRatio(theme.terminal.foreground, theme.terminal.background), required);
  });
});

describe("light-theme contrast floors", () => {
  it("covers the expected number of required light-theme pairs", () => {
    expect(LIGHT_THEME_CASES).toHaveLength(9);
    expect(LIGHT_CONTRAST_PAIRS_PER_THEME).toBe(31);
    expect(LIGHT_THEME_CASES.length * LIGHT_CONTRAST_PAIRS_PER_THEME).toBe(279);
  });

  it.each(LIGHT_THEME_CASES)("%s: normal ANSI colors meet the terminal floor", (id, theme) => {
    for (const key of LIGHT_NORMAL_ANSI_KEYS) {
      assertContrast(id, `terminal.${key} / terminal.background`, contrastRatio(theme.terminal[key], theme.terminal.background), CONTRAST_TARGET);
    }
  });

  it.each(LIGHT_THEME_CASES)("%s: bright ANSI colors meet the terminal floor", (id, theme) => {
    for (const key of LIGHT_BRIGHT_ANSI_KEYS) {
      assertContrast(id, `terminal.${key} / terminal.background`, contrastRatio(theme.terminal[key], theme.terminal.background), CONTRAST_TARGET);
    }
  });

  it.each(LIGHT_THEME_CASES)("%s: cursor meets the terminal floor", (id, theme) => {
    assertContrast(id, "terminal.cursor / terminal.background", contrastRatio(theme.terminal.cursor, theme.terminal.background), CONTRAST_TARGET);
  });

  it.each(LIGHT_THEME_CASES)("%s: status colors meet both chrome surfaces", (id, theme) => {
    for (const key of LIGHT_STATUS_KEYS) {
      assertContrast(id, `status.${key} / chrome.background`, contrastRatio(theme.status[key], theme.chrome.background), CONTRAST_TARGET);
      assertContrast(id, `status.${key} / chrome.surface`, contrastRatio(theme.status[key], theme.chrome.surface), CONTRAST_TARGET);
    }
  });

  it.each(LIGHT_THEME_CASES)("%s: border meets both chrome surfaces", (id, theme) => {
    assertContrast(id, "chrome.border / chrome.background", contrastRatio(theme.chrome.border, theme.chrome.background), 1.6);
    assertContrast(id, "chrome.border / chrome.surface", contrastRatio(theme.chrome.border, theme.chrome.surface), 1.6);
  });

  it.each(LIGHT_THEME_CASES)("%s: accent meets both chrome surfaces", (id, theme) => {
    assertContrast(id, "chrome.accent / chrome.background", contrastRatio(theme.chrome.accent, theme.chrome.background), 3);
    assertContrast(id, "chrome.accent / chrome.surface", contrastRatio(theme.chrome.accent, theme.chrome.surface), 3);
  });

  it.each(LIGHT_THEME_CASES)("%s: chrome background and surface stay distinct", (id, theme) => {
    assertContrast(id, "chrome.surface / chrome.background", contrastRatio(theme.chrome.surface, theme.chrome.background), 1.15);
  });
});

// --cmux-on-* are the glyph colors AppShell paints on top of the accent and the
// four status fills (tab badges, primary buttons, notification counters), so
// each derived pair has to clear the AA body floor on its own fill.
describe("derived on-color contrast", () => {
  const ON_COLOR_CASES: Array<readonly [string, OnColorKey, ThemeDefinition]> = THEMES.flatMap((theme) =>
    ON_COLOR_KEYS.map((key) => [theme.id, key, theme] as const),
  );

  it.each(ON_COLOR_CASES)("%s: --cmux-on-%s meets contrast floor against its own fill", (id, key, theme) => {
    const fill = onColorSource(theme, key);
    assertContrast(id, `--cmux-on-${key} (${textOnColor(fill)}) / ${key} fill (${fill})`, contrastRatio(textOnColor(fill), fill), CONTRAST_TARGET);
  });
});

// ---------------------------------------------------------------------------
// ANSI ratchet
// ---------------------------------------------------------------------------
describe("terminal ANSI ratchet", () => {
  it.each(THEME_CASES)("%s: no ANSI color regresses against terminal.background", (id, theme) => {
    const baseline = ANSI_BASELINE[id];
    expect(baseline, `${id}: missing from ANSI_BASELINE - measure it and add the row`).toBeDefined();

    const regressions: string[] = [];
    for (const key of ANSI_KEYS) {
      const measured = contrastRatio(theme.terminal[key], theme.terminal.background);
      const required = ratchetFloor(CONTRAST_TARGET, baseline?.[key]);
      if (measured < required) {
        regressions.push(
          `${id}: terminal.${key} / terminal.background is ${measured.toFixed(3)}:1, below the required ${required.toFixed(3)}:1`,
        );
      }
    }
    expect(regressions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Table integrity: the ratchet is only as good as its coverage
// ---------------------------------------------------------------------------
describe("contrast table integrity", () => {
  it("ANSI_BASELINE covers every theme exactly once", () => {
    expect(Object.keys(ANSI_BASELINE).sort()).toEqual(THEMES.map((theme) => theme.id).sort());
  });

  it.each(THEME_CASES)("%s: ANSI_BASELINE row lists all 14 measured colors", (id) => {
    expect(Object.keys(ANSI_BASELINE[id] ?? {}).sort()).toEqual([...ANSI_KEYS].sort());
  });

  it("debt table only names real themes", () => {
    const known = new Set(THEMES.map((theme) => theme.id));
    const unknown = Object.keys(TERMINAL_FOREGROUND_DEBT).filter((id) => !known.has(id));
    expect(unknown).toEqual([]);
  });

  // Debt can only shrink: once a theme is repainted so the pair clears its hard
  // floor, the frozen entry has to be deleted or this fails.
  it("TERMINAL_FOREGROUND_DEBT has no stale entries", () => {
    const stale: string[] = [];
    for (const theme of THEMES) {
      if (TERMINAL_FOREGROUND_DEBT[theme.id] === undefined) {
        continue;
      }
      const measured = contrastRatio(theme.terminal.foreground, theme.terminal.background);
      if (measured >= TERMINAL_FOREGROUND_TARGET) {
        stale.push(
          `${theme.id} now measures ${measured.toFixed(3)}:1 and clears ${TERMINAL_FOREGROUND_TARGET}:1 - remove it from TERMINAL_FOREGROUND_DEBT`,
        );
      }
    }
    expect(stale).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Composited light-theme floors (design memo sections 4 and 8)
// ---------------------------------------------------------------------------
// Everything above measures opaque authored hexes. That is exactly the gap the
// design memo opened with: the checked colours were not the painted colours,
// because the panels are painted over a wallpaper at partial alpha.
//
// Two things are measured below, and they are not the same thing.
//
// THE FLOOR is stated against the surfaces the theme authors - canvas,
// surface-low, surface, the terminal background, and the state washes
// flattened onto the band they tint. Every informational glyph clears 4.5:1
// there, on all nine light themes. That is what the app guarantees.
//
// THE COMPOSITED NUMBERS are what those same pairs measure once a panel is
// painted at 0.68 over a wallpaper, with pure black standing in for the
// wallpaper. They are reported and pinned, and deliberately NOT floored - see
// the comment on "records the composited ratios" for what was withdrawn and
// why.

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

interface CompositedSurfaces {
  /** Title bar, sidebar, pane tab strip. */
  surfaceLow: string;
  /** Main panels and the selected pane tab. */
  surface: string;
  /** App ground, and the full-screen setup/empty views painted on it. */
  canvas: string;
  /** Terminal viewport. */
  terminal: string;
  /** Inline raised surfaces, as translucent as the panel around them. */
  raised: string;
  /** A hovered row inside a chrome band. */
  hover: string;
  /** A selected row inside a chrome band - the darkest surface in the app. */
  selected: string;
}

function compositedSurfaces(theme: ThemeDefinition): CompositedSurfaces {
  const ladder = resolveSurfaceLadder(theme);
  const policy = resolveCompositionPolicy(theme, WALLPAPER_ON, true);
  const { resolved } = resolveTheme({ theme, background: WALLPAPER_ON, mediaActive: true });
  const backdrop = worstCaseBackdrop(policy);
  const chrome = (color: string) => compositeOver(color, policy.chromeBackdropAlpha, backdrop);
  const surfaceLow = chrome(ladder.surfaceLow);
  return {
    surfaceLow,
    surface: chrome(ladder.surface),
    canvas: chrome(ladder.canvas),
    terminal: compositeOver(theme.terminal.background, policy.terminalBackdropAlpha, backdrop),
    raised: compositeOver(ladder.surfaceRaised, policy.raisedAlpha, backdrop),
    // State washes are painted inside a band, so they tint the composited band
    // rather than the wallpaper.
    hover: flattenOnto(resolved.hover, surfaceLow),
    selected: flattenOnto(resolved.selected, surfaceLow),
  };
}

/** The five roles reported over the composited surfaces, per theme. */
function compositedRoleMinima(theme: ThemeDefinition): Record<string, number> {
  const panels = compositedSurfaces(theme);
  const { resolved } = resolveTheme({ theme, background: WALLPAPER_ON, mediaActive: true });
  // Every chrome surface a UI glyph can land on, including the state fills.
  const chromeHosts = [
    panels.canvas,
    panels.surfaceLow,
    panels.surface,
    panels.terminal,
    panels.raised,
    panels.hover,
    panels.selected,
  ];
  const worst = (colour: string) =>
    Math.min(...chromeHosts.map((host) => contrastRatio(colour, host)));
  return {
    text: worst(resolved.text),
    "text-secondary": worst(resolved.textSecondary),
    "text-tertiary": worst(resolved.textTertiary),
    "text-dim": worst(resolved.textDim),
    "terminal.foreground": contrastRatio(theme.terminal.foreground, panels.terminal),
  };
}

/** The surfaces a light theme authors, as text lands on them. */
function authoredHosts(theme: ThemeDefinition): Record<string, string> {
  const ladder = resolveSurfaceLadder(theme);
  const { resolved } = resolveTheme({ theme, background: WALLPAPER_ON, mediaActive: true });
  return {
    canvas: ladder.canvas,
    "surface-low": ladder.surfaceLow,
    surface: ladder.surface,
    raised: ladder.surfaceRaised,
    popover: ladder.popover,
    "terminal background": theme.terminal.background,
    "hover on surface-low": flattenOnto(resolved.hover, ladder.surfaceLow),
    "selected on surface-low": flattenOnto(resolved.selected, ladder.surfaceLow),
  };
}

/** The four derived levels, per theme. */
function textRoles(theme: ThemeDefinition): Record<string, string> {
  const { resolved } = resolveTheme({ theme, background: WALLPAPER_ON, mediaActive: true });
  return {
    text: resolved.text,
    "text-secondary": resolved.textSecondary,
    "text-tertiary": resolved.textTertiary,
    "text-dim": resolved.textDim,
  };
}

describe("light chrome contrast on the surfaces the theme authors", () => {
  // This is the floor the app guarantees, and it is stated where a guarantee
  // can hold: against the theme's own surfaces.
  it.each(LIGHT_THEME_CASES)(
    "%s: all four text levels clear the floor on every authored surface",
    (id, theme) => {
      const hosts = authoredHosts(theme);
      for (const [role, colour] of Object.entries(textRoles(theme))) {
        for (const [hostName, host] of Object.entries(hosts)) {
          assertContrast(
            id,
            `${role} (${colour}) / ${hostName} (${host})`,
            contrastRatio(colour, host),
            CONTRAST_TARGET,
          );
        }
      }
    },
  );

  it.each(LIGHT_THEME_CASES)(
    "%s: terminal body text clears the floor on the authored terminal background",
    (id, theme) => {
      assertContrast(
        id,
        `terminal.foreground (${theme.terminal.foreground}) / terminal.background (${theme.terminal.background})`,
        contrastRatio(theme.terminal.foreground, theme.terminal.background),
        CONTRAST_TARGET,
      );
    },
  );

  // The measured failure that started the light work: hover/selected stack a
  // second alpha on the band they tint, and with the pre-stage-2 text levels a
  // selected sidebar row dropped tertiary text to 2.15:1. The washes are the
  // authored ones again, so what fixes this is the derived ladder measuring
  // the flattened fill as a host - which is this test.
  it.each(LIGHT_THEME_CASES)(
    "%s: text clears the floor on the hover and selected fills",
    (id, theme) => {
      const ladder = resolveSurfaceLadder(theme);
      const { resolved } = resolveTheme({ theme, background: WALLPAPER_ON, mediaActive: true });
      const states = {
        hover: flattenOnto(resolved.hover, ladder.surfaceLow),
        selected: flattenOnto(resolved.selected, ladder.surfaceLow),
      };
      for (const [stateName, host] of Object.entries(states)) {
        for (const [role, colour] of Object.entries(textRoles(theme))) {
          assertContrast(
            id,
            `${role} / ${stateName} (${host})`,
            contrastRatio(colour, host),
            CONTRAST_TARGET,
          );
        }
      }
    },
  );
});

describe("light chrome contrast after wallpaper compositing", () => {
  // ---------------------------------------------------------------------
  // READ THIS BEFORE ADDING A FLOOR HERE.
  // ---------------------------------------------------------------------
  // These numbers are a MEASUREMENT, not a guarantee, and the guarantee was
  // removed on purpose.
  //
  // Stage 2 asserted 4.5:1 on these pairs and paid for it by raising the light
  // panels to 0.80 / 0.86, which hid the wallpaper. Stage 2b asserted it again
  // and paid with a +0.25 wash toward the theme's near-white paper, which
  // bleached the wallpaper instead: on the shipped asanagi/oppenheimer pairing
  // the image's mean luminance went from 58.6 to 109.6 and the picture went
  // flat. Both were rejected on sight by the person the app is built for.
  //
  // The bound itself is the problem. Pure black is a true upper bound on how
  // dark a wallpaper can be and a useless target: no shipped wallpaper is
  // anywhere near it, and users pick images they can read against. Holding a
  // palette to it costs either the wallpaper's visibility or its colour.
  //
  // SO: WHAT IS NO LONGER PROMISED is that light text clears 4.5:1 over an
  // arbitrarily dark wallpaper. Against a pure-black one, text-dim measures
  // about 2.2:1. The floor that IS promised is the one in the describe block
  // above, against the surfaces the theme authors.
  //
  // Restoring a real guarantee without paying in looks needs the wallpaper's
  // actual luminance - adaptive sampling, design memo section 12. Until that
  // exists, measure and report; do not assert.
  it("records the composited ratios over a pure-black wallpaper", () => {
    const FROZEN: Record<string, Record<string, number>> = {
      asanagi: { text: 4.37, "text-secondary": 3.54, "text-tertiary": 2.81, "text-dim": 2.19, "terminal.foreground": 4.68 },
      kinari: { text: 3.44, "text-secondary": 2.94, "text-tertiary": 2.51, "text-dim": 2.13, "terminal.foreground": 3.7 },
      wakaba: { text: 3.67, "text-secondary": 3.09, "text-tertiary": 2.56, "text-dim": 2.12, "terminal.foreground": 3.99 },
      geppaku: { text: 4.04, "text-secondary": 3.32, "text-tertiary": 2.67, "text-dim": 2.14, "terminal.foreground": 4.42 },
      sakura: { text: 3.94, "text-secondary": 3.26, "text-tertiary": 2.66, "text-dim": 2.13, "terminal.foreground": 4.26 },
      paper: { text: 4.36, "text-secondary": 3.53, "text-tertiary": 2.78, "text-dim": 2.17, "terminal.foreground": 4.71 },
      hakuchuumu: { text: 3.51, "text-secondary": 3.01, "text-tertiary": 2.55, "text-dim": 2.16, "terminal.foreground": 3.76 },
      mist: { text: 4.28, "text-secondary": 3.48, "text-tertiary": 2.75, "text-dim": 2.17, "terminal.foreground": 4.63 },
      "ink-day": { text: 6.04, "text-secondary": 4.66, "text-tertiary": 3.24, "text-dim": 2.18, "terminal.foreground": 6.52 },
    };

    const measured: Record<string, Record<string, number>> = {};
    for (const [id, theme] of LIGHT_THEME_CASES) {
      const minima = compositedRoleMinima(theme);
      measured[id] = Object.fromEntries(
        Object.entries(minima).map(([role, value]) => [role, Number(value.toFixed(2))]),
      );

      // The one thing that IS asserted: the hierarchy survives compositing.
      // A wallpaper erodes every level, but it must not reorder them - if it
      // did, the ladder would stop meaning anything the moment one is on.
      const order = ["text", "text-secondary", "text-tertiary", "text-dim"];
      for (let index = 1; index < order.length; index += 1) {
        expect(
          minima[order[index]],
          `${id}: composited ${order[index]} (${minima[order[index]].toFixed(2)}:1) outranks ${order[index - 1]} (${minima[order[index - 1]].toFixed(2)}:1)`,
        ).toBeLessThan(minima[order[index - 1]]);
      }
    }
    expect(measured).toEqual(FROZEN);
  });

  // The polarity condition from the memo. It still matters without a floor:
  // it is what makes "a darker wallpaper is worse, never better" true rather
  // than a guess, and so what lets the numbers recorded above be read as a
  // worst case at all. A light-on-light pair would reverse the direction.
  it.each(LIGHT_THEME_CASES)("%s: every light foreground is darker than its panel", (id, theme) => {
    const panels = compositedSurfaces(theme);
    const { resolved } = resolveTheme({ theme, background: WALLPAPER_ON, mediaActive: true });
    const darkest = Math.min(
      relativeLuminance(panels.surfaceLow),
      relativeLuminance(panels.surface),
      relativeLuminance(panels.canvas),
      relativeLuminance(panels.terminal),
      relativeLuminance(panels.raised),
      relativeLuminance(panels.hover),
      relativeLuminance(panels.selected),
    );
    const roles = {
      text: resolved.text,
      "text-secondary": resolved.textSecondary,
      "text-tertiary": resolved.textTertiary,
      "text-dim": resolved.textDim,
      "terminal.foreground": theme.terminal.foreground,
    };
    for (const [role, colour] of Object.entries(roles)) {
      expect(
        relativeLuminance(colour),
        `${id}: ${role} (${colour}) is not darker than the darkest composited panel`,
      ).toBeLessThan(darkest);
    }
  });
});
