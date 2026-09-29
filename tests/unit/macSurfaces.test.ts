import { describe, expect, it } from "vitest";

import {
  MACOS_SURFACE_CONTRAST,
  contrastRatio,
  lightnessLiftFor,
  macSurfaceOverrides,
  shiftLightness,
} from "../../src/lib/theme/macSurfaces";
import { hexToOklab } from "../../src/lib/theme/oklab";

// Measured on the Mac on 2026-09-10: macOS dark mode puts about 1.16:1 between
// a window and the panels on it, and that separation is what makes a panel edge
// readable without a hard border. 石墨, the theme the Mac was running, sat at
// 1.07 and its panels dissolved into the ground.

const GRAPHITE_BG = "#090b0d";
const GRAPHITE_SURFACE = "#111417";
// 極夜, the theme the Windows box uses, already sits at macOS proportions.
const KYOKUYA_BG = "#242933";
const KYOKUYA_SURFACE = "#2e3440";

describe("contrastRatio", () => {
  it("measures the flat pair that started this", () => {
    expect(contrastRatio(GRAPHITE_BG, GRAPHITE_SURFACE)).toBeCloseTo(1.07, 2);
  });

  it("is symmetric", () => {
    expect(contrastRatio(GRAPHITE_BG, GRAPHITE_SURFACE)).toBeCloseTo(
      contrastRatio(GRAPHITE_SURFACE, GRAPHITE_BG) ?? 0,
      6,
    );
  });

  it("returns null for anything that is not a hex colour", () => {
    expect(contrastRatio("rgba(0,0,0,0.5)", GRAPHITE_BG)).toBeNull();
  });
});

describe("shiftLightness", () => {
  it("raises perceptual lightness by the amount asked for", () => {
    const before = hexToOklab(GRAPHITE_SURFACE)?.L ?? 0;
    const after = hexToOklab(shiftLightness(GRAPHITE_SURFACE, 0.05))?.L ?? 0;
    expect(after - before).toBeCloseTo(0.05, 2);
  });

  it("leaves hue and chroma where they were", () => {
    // A warm theme has to stay warm. Mixing toward white would wash this out;
    // moving lightness in OKLab does not.
    const warm = "#2a1f18";
    const before = hexToOklab(warm);
    const after = hexToOklab(shiftLightness(warm, 0.06));
    expect(after?.a).toBeCloseTo(before?.a ?? 0, 2);
    expect(after?.b).toBeCloseTo(before?.b ?? 0, 2);
  });

  it("passes non-hex values straight through", () => {
    expect(shiftLightness("var(--something)", 0.05)).toBe("var(--something)");
  });
});

describe("lightnessLiftFor", () => {
  it("lifts a flat ladder to macOS separation", () => {
    const lift = lightnessLiftFor(GRAPHITE_BG, GRAPHITE_SURFACE);
    expect(lift).toBeGreaterThan(0);
    const reached = contrastRatio(GRAPHITE_BG, shiftLightness(GRAPHITE_SURFACE, lift)) ?? 0;
    expect(reached).toBeGreaterThanOrEqual(MACOS_SURFACE_CONTRAST);
  });

  it("leaves a theme already at those proportions alone", () => {
    expect(lightnessLiftFor(KYOKUYA_BG, KYOKUYA_SURFACE)).toBe(0);
  });

  it("does not touch a light theme, where the surface is the brighter ground", () => {
    // Panels darker than the window are a deliberate inversion, not flatness.
    expect(lightnessLiftFor("#f7f7f5", "#eceae6")).toBe(0);
  });

  it("gives up rather than overshooting when the target is unreachable", () => {
    // Pure black ground: no lift inside the cap clears 1.16, and the answer has
    // to stay bounded instead of running the surface to white.
    const lift = lightnessLiftFor("#000000", "#000000");
    expect(lift).toBeGreaterThan(0);
    expect(lift).toBeLessThanOrEqual(0.09);
  });

  it("returns nothing for non-hex input", () => {
    expect(lightnessLiftFor("rgba(0,0,0,0.4)", GRAPHITE_SURFACE)).toBe(0);
  });
});

describe("macSurfaceOverrides", () => {
  it("moves every hex tier by the same amount, keeping their order", () => {
    const overrides = macSurfaceOverrides({
      background: GRAPHITE_BG,
      surface: GRAPHITE_SURFACE,
      tokens: {
        "--cmux-surface": GRAPHITE_SURFACE,
        "--cmux-surface-raised": "#1f1f1f",
        "--cmux-popover": "#262626",
      },
    });

    const lightness = (hex: string) => hexToOklab(hex)?.L ?? 0;
    expect(lightness(overrides["--cmux-surface"])).toBeLessThan(
      lightness(overrides["--cmux-surface-raised"]),
    );
    expect(lightness(overrides["--cmux-surface-raised"])).toBeLessThan(
      lightness(overrides["--cmux-popover"]),
    );
  });

  it("brings the panel tier to macOS separation against the untouched ground", () => {
    const overrides = macSurfaceOverrides({
      background: GRAPHITE_BG,
      surface: GRAPHITE_SURFACE,
      tokens: { "--cmux-surface": GRAPHITE_SURFACE },
    });
    const reached = contrastRatio(GRAPHITE_BG, overrides["--cmux-surface"]) ?? 0;
    expect(reached).toBeGreaterThanOrEqual(MACOS_SURFACE_CONTRAST);
  });

  it("returns nothing when the theme already has the separation", () => {
    expect(
      macSurfaceOverrides({
        background: KYOKUYA_BG,
        surface: KYOKUYA_SURFACE,
        tokens: { "--cmux-surface": KYOKUYA_SURFACE },
      }),
    ).toEqual({});
  });

  it("lifts the pane tab bar, whose token drops the cmux prefix", () => {
    // Spelling it --cmux-pane-tabbar-bg left the pane headers behind while every
    // other tier moved, which showed up on screen as one surface out of step.
    const overrides = macSurfaceOverrides({
      background: GRAPHITE_BG,
      surface: GRAPHITE_SURFACE,
      tokens: { "--cmux-surface": GRAPHITE_SURFACE, "--pane-tabbar-bg": "#191c1f" },
    });
    expect(overrides["--pane-tabbar-bg"]).toBeDefined();
  });

  it("leaves the window ground and the terminal alone", () => {
    const overrides = macSurfaceOverrides({
      background: GRAPHITE_BG,
      surface: GRAPHITE_SURFACE,
      tokens: {
        "--cmux-surface": GRAPHITE_SURFACE,
      } as Record<string, string>,
    });
    expect(overrides["--cmux-bg"]).toBeUndefined();
    expect(overrides["--cmux-terminal-bg"]).toBeUndefined();
  });

  it("skips tiers carrying alpha, which get composited at paint time", () => {
    const overrides = macSurfaceOverrides({
      background: GRAPHITE_BG,
      surface: GRAPHITE_SURFACE,
      tokens: {
        "--cmux-surface": GRAPHITE_SURFACE,
        "--cmux-sidebar": "rgba(30, 30, 30, 0.7)",
      },
    });
    expect(overrides["--cmux-sidebar"]).toBeUndefined();
    expect(overrides["--cmux-surface"]).toBeDefined();
  });
});
