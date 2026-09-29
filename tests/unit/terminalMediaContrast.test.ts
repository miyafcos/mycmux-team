import { describe, expect, it } from "vitest";
import { withTerminalOpacity } from "../../src/components/terminal/XTermWrapper";
import { THEMES } from "../../src/components/theme/themeDefinitions";
import { applyContrastFloor, contrastRatio } from "../../src/components/theme/colorContrast";
import { parseHexChannels } from "../../src/lib/theme/colorPrimitives";
import { resolveMinimumContrastRatio } from "../../src/stores/compositionStore";

const lightThemes = THEMES.filter((theme) => theme.colorScheme === "light");

describe("media terminal background and truecolor contrast", () => {
  it("covers all nine bundled light themes", () => {
    expect(lightThemes).toHaveLength(9);
  });

  it.each(THEMES)("retains $id background RGB with zero alpha under media", (theme) => {
    const channels = parseHexChannels(theme.terminal.background)!;
    for (const opacity of [0, 0.45, 1]) {
      const result = withTerminalOpacity(theme.terminal, opacity, true);
      expect(result.background).toBe(
        `rgba(${channels.red}, ${channels.green}, ${channels.blue}, 0)`,
      );
      expect(result.foreground).toBe(theme.terminal.foreground);
      expect(theme.terminal.background).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it.each(lightThemes)("corrects pale truecolor gray to 5.5:1 against $id media RGB", (theme) => {
    const background = withTerminalOpacity(theme.terminal, 0.45, true).background!;
    const channels = /^rgba\((\d+), (\d+), (\d+), 0\)$/.exec(background)!;
    const rgb = `#${channels.slice(1).map((value) => Number(value).toString(16).padStart(2, "0")).join("")}`;
    expect(rgb).toBe(theme.terminal.background);
    const target = resolveMinimumContrastRatio({ mediaActive: true, isLight: true });
    expect(target).toBe(5.5);
    for (const gray of ["#8a8a8a", "#d0d0d0"]) {
      expect(contrastRatio(gray, rgb)).toBeLessThan(target);
      const corrected = applyContrastFloor(gray, theme.terminal.foreground, rgb, target);
      expect(contrastRatio(corrected, rgb)).toBeGreaterThanOrEqual(target);
    }
  });

  it("preserves opaque backgrounds and expands short hex without losing RGB", () => {
    expect(withTerminalOpacity({ background: "#abc" }, 1, true).background)
      .toBe("rgba(170, 187, 204, 0)");
    expect(withTerminalOpacity({ background: "#abcdef" }, 1, false).background)
      .toBe("#abcdef");
    expect(withTerminalOpacity({ background: "#abcdef" }, 0.45, false).background)
      .toBe("rgba(171, 205, 239, 0.45)");
  });
});
