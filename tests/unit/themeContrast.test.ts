import { describe, expect, it } from "vitest";
import { contrastRatio, isHexColor, resolveAccentTextColor } from "../../src/components/theme/colorContrast";
import { THEMES } from "../../src/components/theme/themeDefinitions";
import type { TerminalColors, ThemeDefinition } from "../../src/types/theme";

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

// ---------------------------------------------------------------------------
// AppShell's on-color derivation, replicated
// ---------------------------------------------------------------------------
// AppShell.tsx derives --cmux-on-accent / --cmux-on-{working,waiting,done,error}
// with a module-private textOnColor(); it is not exported, so the rule is
// mirrored here. Keep this in sync with src/components/layout/AppShell.tsx:
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

type OnColorKey = "accent" | "working" | "waiting" | "done" | "error";

const ON_COLOR_KEYS: OnColorKey[] = ["accent", "working", "waiting", "done", "error"];

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
// 3.16:1). They were fixed for real instead: AppShell's textOnColor() now
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
    red: 3.9877,
    green: 3.6513,
    yellow: 3.0369,
    blue: 4.2326,
    magenta: 4.5396,
    cyan: 4.5322,
    white: 2.4412,
    brightRed: 3.0313,
    brightGreen: 2.9079,
    brightYellow: 2.3497,
    brightBlue: 2.9114,
    brightMagenta: 3.1360,
    brightCyan: 3.0904,
    brightWhite: 5.2377,
  },
  "kinari": {
    red: 4.0771,
    green: 3.3454,
    yellow: 3.3007,
    blue: 3.8144,
    magenta: 4.1724,
    cyan: 3.4649,
    white: 2.7624,
    brightRed: 3.0455,
    brightGreen: 2.4325,
    brightYellow: 2.2613,
    brightBlue: 2.7290,
    brightMagenta: 2.8784,
    brightCyan: 2.4655,
    brightWhite: 5.9439,
  },
  "wakaba": {
    red: 3.8885,
    green: 3.3532,
    yellow: 2.8477,
    blue: 3.4915,
    magenta: 3.8169,
    cyan: 3.0915,
    white: 2.4635,
    brightRed: 2.9691,
    brightGreen: 2.4525,
    brightYellow: 2.2150,
    brightBlue: 2.5475,
    brightMagenta: 2.6737,
    brightCyan: 2.2746,
    brightWhite: 4.6981,
  },
  "geppaku": {
    red: 4.0685,
    green: 3.4875,
    yellow: 3.1069,
    blue: 4.2402,
    magenta: 4.2360,
    cyan: 3.6853,
    white: 2.5701,
    brightRed: 3.0114,
    brightGreen: 2.5777,
    brightYellow: 2.3728,
    brightBlue: 2.9127,
    brightMagenta: 2.9264,
    brightCyan: 2.6816,
    brightWhite: 4.7010,
  },
  "sakura": {
    red: 4.5804,
    green: 2.9344,
    yellow: 2.7698,
    blue: 3.1213,
    magenta: 3.5835,
    cyan: 2.6826,
    white: 2.8397,
    brightRed: 3.0702,
    brightGreen: 2.2214,
    brightYellow: 2.1232,
    brightBlue: 2.3313,
    brightMagenta: 2.4194,
    brightCyan: 2.0464,
    brightWhite: 5.9886,
  },
  "paper": {
    red: 4.6365,
    green: 4.1872,
    yellow: 3.6839,
    blue: 4.8452,
    magenta: 4.5085,
    cyan: 4.2839,
    white: 3.1254,
    brightRed: 3.4421,
    brightGreen: 3.0190,
    brightYellow: 2.7421,
    brightBlue: 3.5366,
    brightMagenta: 3.2492,
    brightCyan: 3.0878,
    brightWhite: 7.8193,
  },
  "hakuchuumu": {
    red: 3.9039,
    green: 2.8726,
    yellow: 3.0058,
    blue: 3.5751,
    magenta: 3.7264,
    cyan: 2.5726,
    white: 2.7053,
    brightRed: 3.0589,
    brightGreen: 2.1696,
    brightYellow: 2.3142,
    brightBlue: 2.6397,
    brightMagenta: 2.3206,
    brightCyan: 1.9742,
    brightWhite: 5.8385,
  },
  "mist": {
    red: 4.0805,
    green: 3.8244,
    yellow: 3.2988,
    blue: 4.1436,
    magenta: 4.1417,
    cyan: 3.6905,
    white: 2.8436,
    brightRed: 3.0778,
    brightGreen: 2.7742,
    brightYellow: 2.4568,
    brightBlue: 3.0340,
    brightMagenta: 3.0222,
    brightCyan: 2.6666,
    brightWhite: 6.6708,
  },
  "ink-day": {
    red: 6.5628,
    green: 6.0576,
    yellow: 5.0268,
    blue: 5.0017,
    magenta: 6.5402,
    cyan: 5.0427,
    white: 4.2632,
    brightRed: 4.7914,
    brightGreen: 4.3210,
    brightYellow: 3.7195,
    brightBlue: 3.8194,
    brightMagenta: 4.6438,
    brightCyan: 3.6686,
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
