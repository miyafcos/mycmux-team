import { describe, expect, it } from "vitest";
import { buildLiveTailThemeVars } from "../../src/components/layout/themeVars";
import { THEMES } from "../../src/components/theme/themeDefinitions";
import { contrastRatio, isHexColor, mixHex } from "../../src/components/theme/colorContrast";
import { flattenOnto, resolveTheme } from "../../src/lib/theme/resolveTheme";
import { DEFAULT_THEME_BACKGROUND } from "../../src/lib/themeBackgrounds";

describe("live-tail fact theme colours", () => {
  it.each(THEMES.map(theme => [theme.id, theme] as const))("holds text and fact markers at 4.5:1 on the %s sidebar and popup", (_id, theme) => {
    const background = { ...DEFAULT_THEME_BACKGROUND, solidSurfaces: true };
    const { resolved, surfaces } = resolveTheme({ theme, background, mediaActive: false });
    const vars = buildLiveTailThemeVars(theme) as Record<string, string>;
    for (const kind of ["progress", "cmd", "stale", "frozen", "error", "unreadable", "alive"]) {
      for (const host of [surfaces.canvas, surfaces.surfaceLow, surfaces.surfaceRaised, surfaces.popover, flattenOnto(resolved.hover, surfaces.surfaceLow)]) {
        const opaque = isHexColor(host) ? host : mixHex(theme.chrome.surface, "#ffffff", host.includes("96%") ? 0.04 : 0.07);
        expect(contrastRatio(vars[`--cmux-live-tail-${kind}`], opaque), `${theme.id}/${kind}/${host}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(vars["--cmux-live-tail-unreadable"]).toBe(vars["--cmux-live-tail-alive"]);
    expect(vars["--cmux-live-tail-frozen"]).toBe(vars["--cmux-live-tail-error"]);
  });
});
