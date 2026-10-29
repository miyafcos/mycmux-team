import { describe, expect, it } from "vitest";
import { buildThemeVars } from "../../src/components/layout/themeVars";
import { getTheme } from "../../src/components/theme/themeDefinitions";
import { DEFAULT_THEME_BACKGROUND } from "../../src/lib/themeBackgrounds";
import type { UiDensity } from "../../src/stores/themeStore";

function tokens(uiDensity: UiDensity, uiFontScale: number, fontSize = 10, lineHeight = 1.1) {
  return buildThemeVars({
    theme: getTheme("kyokuya"), background: DEFAULT_THEME_BACKGROUND,
    fontFamily: "Consolas", fontSize, lineHeight, uiDensity, uiFontScale,
  }) as Record<string, string>;
}

describe("dashboard reading typography", () => {
  it.each([
    ["compact", .9, "13px"], ["standard", 1, "14px"],
    ["relaxed", 1, "15px"], ["relaxed", 1.5, "22px"],
    ["compact", 0, "12px"], ["relaxed", 4, "22px"],
  ] as const)("uses density %s and UI scale %s: %s", (density, scale, expected) => {
    const vars = tokens(density, scale);
    expect(vars["--cmux-read-font-size"]).toBe(expected);
    expect(vars["--cmux-read-line-height"]).toBe("1.7");
  });

  it("ignores terminal grid sizing while preserving the existing terminal-tail tokens", () => {
    const small = tokens("compact", .9);
    const large = tokens("compact", .9, 24, 2);
    expect(small["--cmux-read-font-size"]).toBe(large["--cmux-read-font-size"]);
    expect(small["--cmux-read-line-height"]).toBe(large["--cmux-read-line-height"]);
    expect(small["--cmux-dash-font-size"]).toBe("10px");
    expect(large["--cmux-dash-font-size"]).toBe("22px");
    expect(small["--cmux-dash-line-height"]).toBe("1.1");
    expect(large["--cmux-dash-line-height"]).toBe("2");
  });
});
