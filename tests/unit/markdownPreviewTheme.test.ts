import { describe, expect, it } from "vitest";
import { contrastRatio } from "../../src/components/theme/colorContrast";
import { getTheme, THEMES } from "../../src/components/theme/themeDefinitions";
import { isLightColor } from "../../src/lib/theme/colorPrimitives";
import { markdownPreviewMonoFont, markdownPreviewPalette } from "../../src/lib/markdownPreviewTheme";
import type { ThemeDefinition } from "../../src/types/theme";

// The Markdown preview is a page of small body text, so its text colour is held
// to AAA against the page, and everything that carries meaning (links, alert
// colours, secondary text) to the AA body floor. These run over every theme:
// the palette is derived, so a new theme must not be able to produce a preview
// that cannot be read.
const TEXT_TARGET = 7;
const BODY_TARGET = 4.5;
const FAINT_TARGET = 3;
/** Rounding slack when one derived colour is compared against another. */
const EPSILON = 0.01;

const HEX = /^#[0-9a-f]{6}$/;

const THEME_CASES = THEMES.map((theme) => [theme.id, theme] as const);

const ALERT_ROLES = ["--md-note", "--md-tip", "--md-important", "--md-warning", "--md-caution"];
const SURFACE_ROLES = ["--md-code-bg", "--md-pre-bg", "--md-table-head"];

describe("markdownPreviewPalette", () => {
  it.each(THEME_CASES)("%s reads at every role", (_id, theme) => {
    const { scheme, vars } = markdownPreviewPalette(theme);
    const bg = vars["--md-bg"];
    const text = vars["--md-text"];

    // A non-hex value would reach the frame as an invalid declaration and the
    // role would silently fall back to the stylesheet's own colour.
    expect(Object.entries(vars).filter(([, value]) => !HEX.test(value))).toEqual([]);
    expect(scheme).toBe(isLightColor(bg) ? "light" : "dark");

    expect(contrastRatio(text, bg)).toBeGreaterThanOrEqual(TEXT_TARGET);
    // A heading is never quieter than the body text under it.
    expect(contrastRatio(vars["--md-heading"], bg)).toBeGreaterThanOrEqual(
      contrastRatio(text, bg) - EPSILON,
    );
    expect(contrastRatio(vars["--md-muted"], bg)).toBeGreaterThanOrEqual(BODY_TARGET);
    expect(contrastRatio(vars["--md-faint"], bg)).toBeGreaterThanOrEqual(FAINT_TARGET);
    expect(contrastRatio(vars["--md-link"], bg)).toBeGreaterThanOrEqual(BODY_TARGET);
    for (const role of ALERT_ROLES) {
      expect(contrastRatio(vars[role], bg)).toBeGreaterThanOrEqual(BODY_TARGET);
    }
    // Code, code blocks and table headings are tinted panels the body text is
    // read on top of, so the text must clear the floor against each of them.
    for (const role of SURFACE_ROLES) {
      expect(contrastRatio(text, vars[role])).toBeGreaterThanOrEqual(BODY_TARGET);
    }
  });

  it("paints the reader's own theme", () => {
    const { scheme, vars } = markdownPreviewPalette(getTheme("kyokuya"));

    expect(scheme).toBe("dark");
    expect(vars["--md-bg"]).toBe("#2e3440");
  });

  it("still answers in hex when a theme carries colours it cannot measure", () => {
    const base = getTheme("kyokuya");
    const broken: ThemeDefinition = {
      ...base,
      terminal: {
        ...base.terminal,
        background: "red",
        foreground: "",
        blue: "rgb(1, 2, 3)",
        yellow: "",
      },
      chrome: { ...base.chrome, surface: "", text: "", accent: "color-mix(in srgb, red, blue)" },
    };

    const { vars } = markdownPreviewPalette(broken);

    expect(Object.entries(vars).filter(([, value]) => !HEX.test(value))).toEqual([]);
    // Nothing measurable was left, so the preview falls back to paper.
    expect(vars["--md-bg"]).toBe("#ffffff");
    expect(contrastRatio(vars["--md-text"], vars["--md-bg"])).toBeGreaterThanOrEqual(TEXT_TARGET);
  });
});

describe("markdownPreviewMonoFont", () => {
  it("hands the reader's terminal font to the preview with fallbacks behind it", () => {
    expect(markdownPreviewMonoFont("'UDEV Gothic NF', 'BIZ UDGothic', ui-monospace, monospace")).toBe(
      "'UDEV Gothic NF', 'BIZ UDGothic', ui-monospace, monospace,"
        + " \"Cascadia Mono\", Consolas, \"SF Mono\", Menlo, \"BIZ UDGothic\", monospace",
    );
    expect(markdownPreviewMonoFont("  Consolas  ")).toBe(
      "Consolas, \"Cascadia Mono\", Consolas, \"SF Mono\", Menlo, \"BIZ UDGothic\", monospace",
    );
  });

  it("refuses a value that could end the declaration it lands in", () => {
    for (const value of [
      "Consolas; color: red",
      "Consolas{}",
      "Consolas}",
      "<script>",
      "Consolas(1)",
      "url(evil.css)",
      "C:\\fonts\\x",
      "",
      "   ",
    ]) {
      expect(markdownPreviewMonoFont(value)).toBeNull();
    }
  });
});
