import { describe, expect, it } from "vitest";
import { fontStackWithFallback, MONO_FONT_FALLBACK, UI_FONT_FALLBACK } from "../../src/lib/fontAvailability";
import { buildThemeVars } from "../../src/components/layout/themeVars";
import { THEMES } from "../../src/components/theme/themeDefinitions";
import { DEFAULT_THEME_BACKGROUND } from "../../src/lib/themeBackgrounds";

// Independent, hand-written expectations: never obtain these through the helper.
const UI = '"Segoe UI", "Hiragino Sans", "Yu Gothic UI", "Meiryo", "Roboto", -apple-system, BlinkMacSystemFont, sans-serif';
const MONO = '"UDEV Gothic NF", "UDEV Gothic", "SFMono-Regular", "JetBrains Mono", "Consolas", ui-monospace, monospace';
const cases = [
  { name: "hex-escaped spaces", setting: String.raw`HackGen\20 Console\20 NF, monospace`, prefix: '"HackGen Console NF", ' },
  { name: "six-digit escapes without terminators", setting: String.raw`HackGen\000020Console\000020NF, monospace`, prefix: '"HackGen Console NF", ' },
  { name: "short escaped spaces", setting: String.raw`Fixture\ Font, monospace`, prefix: '"Fixture Font", ' },
  { name: "escaped comma", setting: String.raw`Fixture\, Font, serif`, prefix: '"Fixture, Font", ' },
  { name: "quoted generic-looking literals", setting: '"serif", serif, "monospace", monospace, "inherit"', prefix: '"serif", "monospace", "inherit", ' },
  { name: "escaped generic keyword", setting: String.raw`\73 erif, "serif"`, prefix: '"serif", ' },
  { name: "quoted comma", setting: '"Fixture, Font", monospace', prefix: '"Fixture, Font", ' },
  { name: "escaped double quote in a string", setting: String.raw`"Fixture \"Quoted\" Font", serif`, prefix: String.raw`"Fixture \"Quoted\" Font", ` },
  { name: "escaped single quote in a string", setting: String.raw`'Fixture \'Quoted\' Font', sans-serif`, prefix: String.raw`'Fixture \'Quoted\' Font', ` },
  { name: "apostrophe inside double quotes", setting: '"O\'Brien Font", monospace', prefix: '"O\'Brien Font", ' },
  { name: "escaped quote, backslash, and comma in an identifier", setting: String.raw`Fixture\"Font\\Face\,Alt, monospace`, prefix: String.raw`"Fixture\"Font\\Face,Alt", ` },
  { name: "escaped Japanese characters", setting: String.raw`BIZ\20 UD\660e \671d , monospace`, prefix: '"BIZ UD明朝", ' },
  { name: "literal NUL in an unquoted name", setting: "Fixture\u0000Face, monospace", prefix: '"Fixture�Face", ' },
  { name: "escaped NUL in an unquoted name", setting: String.raw`Fixture\0 Face, monospace`, prefix: '"Fixture�Face", ' },
  { name: "literal replacement character in an unquoted name", setting: "Fixture�Face, monospace", prefix: '"Fixture�Face", ' },
  { name: "empty setting", setting: "", prefix: "" },
  { name: "whitespace-only setting", setting: " \t\r\n ", prefix: "" },
  { name: "comma-only setting", setting: " ,,, , ", prefix: "" },
  { name: "unmatched quote", setting: '"Unfinished', prefix: "" },
  { name: "valid family before an unmatched quote", setting: '"Valid Font", "Unfinished', prefix: '"Valid Font", ' },
  { name: "quoted family followed by an identifier", setting: '"Fixture" extra, "Valid Font", monospace', prefix: '"Valid Font", ' },
  { name: "two strings in one component", setting: '"Fixture" "extra", "Valid Font", monospace', prefix: '"Valid Font", ' },
  { name: "invalid identifier punctuation and leading digit", setting: 'Bad(Font), 123face, -123face, "Valid Font", monospace', prefix: '"Valid Font", ' },
  { name: "CSS-wide keywords cannot join a family list", setting: 'inherit, initial, unset, revert, revert-layer, default, "inherit"', prefix: '"inherit", ' },
  { name: "identifier whitespace separates words once", setting: "  Fixture\t  Font\n NF, monospace", prefix: '"Fixture Font NF", ' },
  { name: "comments separate identifier tokens", setting: "Fixture/**/Font, monospace", prefix: '"Fixture Font", ' },
  { name: "escaped line break is invalid in an identifier", setting: 'Bad\\\nFont, "Valid Font", monospace', prefix: '"Valid Font", ' },
  { name: "raw line break is invalid in a quoted string", setting: '"Bad\nFont", "Valid Font", monospace', prefix: '"Valid Font", ' },
];

describe("R4: CSS family tokenization for derived font routes", () => {
  it.each(cases)("serializes $name without invalidating the fallback", ({ setting, prefix }) => {
    expect(fontStackWithFallback(setting, UI_FONT_FALLBACK)).toBe(prefix + UI);
    expect(fontStackWithFallback(setting, MONO_FONT_FALLBACK)).toBe(prefix + MONO);
  });

  it("drops malformed fallback components and puts their remaining generics last", () => {
    expect(fontStackWithFallback("Setting Face", 'serif, "Broken" extra, "Fallback Face", monospace'))
      .toBe('"Setting Face", "Fallback Face", serif, monospace');
  });

  it.each([
    { setting: String.raw`HackGen\20 Console\20 NF, monospace`, prefix: '"HackGen Console NF", ' },
    { setting: '"Fixture" extra, "Valid Font", monospace', prefix: '"Valid Font", ' },
    { setting: "Fixture\u0000Face, monospace", prefix: '"Fixture�Face", ' },
  ])("changes derived routes while retaining the raw dashboard body value: $setting", ({ setting, prefix }) => {
    const vars = buildThemeVars({ theme: THEMES[0], background: DEFAULT_THEME_BACKGROUND, uiDensity: "standard",
      fontFamily: setting, fontSize: 14, lineHeight: 1.35, uiFontScale: 1 }) as Record<string, string>;
    expect(vars["--cmux-font-ui"]).toBe(prefix + UI);
    expect(vars["--cmux-font-mono"]).toBe(prefix + MONO);
    expect(vars["--cmux-dash-body-font"]).toBe(setting);
  });
});
