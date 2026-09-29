import { describe, expect, it } from "vitest";
import { THEMES } from "../../src/components/theme/themeDefinitions";
import { contrastRatio } from "../../src/components/theme/colorContrast";
import {
  QUIET_TEXT_MIX_PERCENT,
  lightnessLiftFor,
  macQuietTextOverrides,
  macSurfaceOverrides,
  shiftLightness,
} from "../../src/lib/theme/macSurfaces";
import { resolveTheme } from "../../src/lib/theme/resolveTheme";
import type { ThemeBackgroundSettings } from "../../src/types/theme";

// themeContrast.test.ts measures what the resolver produces, against the window
// ground. macOS paints something else, and on a panel rather than the ground:
// the panel tiers are lifted toward macOS separation, and the two quietest text
// tiers are mixed toward the tier above to survive CoreText's lack of hinting.
//
// Those two move the same pair of colours in opposite directions -- a lighter
// panel costs contrast, a brighter glyph buys it back -- and the composed result
// was going unmeasured on the only platform that renders it. Measured on
// 2026-09-10, the first version of the pass lost that trade on twelve of the
// twenty-one dark themes, worst at yougan (4.38 against its panel, down to
// 3.89), because the panels moved and the glyphs stayed put.
//
// So the quiet tiers ride the lift now, and this holds that: macOS may never
// leave a tier worse off than the resolver did.

const CONTRAST_TARGET = 4.5;

// The debt this does *not* fix, frozen so it can only shrink. Every dark theme
// puts its quiet tiers under the body floor on --cmux-surface before any of this
// runs -- 21 of the 30 themes, because the ratchet upstream only ever compared
// text against the window ground, and a panel is lighter than the ground. The
// macOS pass takes that to 9. Closing the rest means editing theme palettes,
// which is Windows' business too and a decision rather than a repair.
const STILL_BELOW_FLOOR = [
  "arctic-night",
  "chikurin",
  "kyokuya",
  "lagoon",
  "raimei",
  "sango",
  "walnut",
  "yogiri",
  "yoi-ai",
];

const NO_WALLPAPER: ThemeBackgroundSettings = {
  mode: "none",
  wallpaperId: null,
  wallpaperOpacity: 1,
  wallpaperBlur: 0,
  wallpaperTone: 0,
  panelOpacity: 1,
};

/** Resolve `color-mix(in srgb, A p%, B)` the way the engine does. */
function mixSrgb(from: string, percent: number, toward: string): string {
  const rgb = (hex: string): [number, number, number] | null => {
    const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
    return match
      ? [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)]
      : null;
  };
  const a = rgb(from);
  const b = rgb(toward);
  if (!a || !b) return from;
  const weight = percent / 100;
  const hex = (value: number) => Math.round(value).toString(16).padStart(2, "0");
  return `#${hex(a[0] * weight + b[0] * (1 - weight))}`
    + `${hex(a[1] * weight + b[1] * (1 - weight))}`
    + `${hex(a[2] * weight + b[2] * (1 - weight))}`;
}

function painted(themeIndex: number) {
  const theme = THEMES[themeIndex];
  const { resolved } = resolveTheme({
    theme,
    background: NO_WALLPAPER,
    mediaActive: false,
  });
  const panels: Record<string, string> = {
    "--cmux-surface": resolved.surface,
    "--cmux-surface-raised": resolved.surfaceRaised,
    "--cmux-surface-solid": resolved.surfaceSolid,
    "--cmux-sidebar": resolved.sidebar,
    "--pane-tabbar-bg": resolved.paneTabBarBg,
    "--cmux-popover": resolved.popover,
    "--cmux-title-bg": resolved.titleBg,
  };
  const lift = lightnessLiftFor(resolved.bg, resolved.surface);
  const ride = (color: string) => (lift > 0 ? shiftLightness(color, lift) : color);
  return {
    id: theme.id,
    lift,
    untouched: {
      panels,
      text: { tertiary: resolved.textTertiary, dim: resolved.textDim },
    },
    mac: {
      panels: {
        ...panels,
        ...macSurfaceOverrides({
          background: resolved.bg,
          surface: resolved.surface,
          tokens: panels,
        }),
      },
      text: {
        tertiary: mixSrgb(
          ride(resolved.textTertiary),
          QUIET_TEXT_MIX_PERCENT,
          ride(resolved.textSecondary),
        ),
        dim: mixSrgb(
          ride(resolved.textDim),
          QUIET_TEXT_MIX_PERCENT,
          ride(resolved.textTertiary),
        ),
      },
    },
    declarations: macQuietTextOverrides({ ...resolved, surfaceLift: lift }),
  };
}

/** The lowest contrast any quiet tier reaches on any opaque panel. */
function worstQuietContrast(
  panels: Record<string, string>,
  text: Record<string, string>,
): { ratio: number; where: string } {
  let ratio = Infinity;
  let where = "";
  for (const [token, panel] of Object.entries(panels)) {
    // Alpha tiers composite over the wallpaper at paint time and the lift leaves
    // them alone, so they are not this transform's to answer for.
    if (!/^#[0-9a-f]{6}$/i.test(panel)) continue;
    for (const [tier, color] of Object.entries(text)) {
      const measured = contrastRatio(color, panel);
      if (measured !== null && measured < ratio) {
        ratio = measured;
        where = `${tier} on ${token}`;
      }
    }
  }
  return { ratio, where };
}

const CASES = THEMES.map((theme, index) => [theme.id, index] as const);

describe("what macOS paints", () => {
  it.each(CASES)("%s is never left worse off than the resolver left it", (_id, index) => {
    const theme = painted(index);
    for (const [token, macPanel] of Object.entries(theme.mac.panels)) {
      if (!/^#[0-9a-f]{6}$/i.test(macPanel)) continue;
      const basePanel = theme.untouched.panels[token];
      for (const tier of ["tertiary", "dim"] as const) {
        const before = contrastRatio(theme.untouched.text[tier], basePanel);
        const after = contrastRatio(theme.mac.text[tier], macPanel);
        if (before === null || after === null) continue;
        expect(
          after,
          `${tier} on ${token}: ${before.toFixed(3)} before, ${after.toFixed(3)} after`,
        ).toBeGreaterThanOrEqual(before - 0.001);
      }
    }
  });

  it("leaves exactly the themes it cannot repair below the body floor", () => {
    const below = CASES
      .map(([, index]) => painted(index))
      .filter((theme) => worstQuietContrast(theme.mac.panels, theme.mac.text).ratio < CONTRAST_TARGET)
      .map((theme) => theme.id)
      .sort();
    expect(below).toEqual(STILL_BELOW_FLOOR);
  });

  it("declares exactly the two tiers it claims to move", () => {
    expect(Object.keys(painted(0).declarations).sort()).toEqual([
      "--cmux-text-dim",
      "--cmux-text-tertiary",
    ]);
  });

  it("takes the quiet tiers along when the panels move, and leaves them alone otherwise", () => {
    const lifted = CASES.map(([, index]) => painted(index)).filter((theme) => theme.lift > 0);
    expect(lifted.length).toBeGreaterThan(0);
    for (const theme of lifted) {
      // A tier that rides the lift is a different colour than one that does not.
      const parked = macQuietTextOverrides({
        textSecondary: "#ffffff",
        textTertiary: "#808080",
        textDim: "#606060",
      });
      const riding = macQuietTextOverrides({
        textSecondary: "#ffffff",
        textTertiary: "#808080",
        textDim: "#606060",
        surfaceLift: theme.lift,
      });
      expect(riding["--cmux-text-tertiary"]).not.toBe(parked["--cmux-text-tertiary"]);
    }
  });
});
