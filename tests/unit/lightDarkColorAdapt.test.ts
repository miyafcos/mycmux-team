import { describe, expect, it } from "vitest";
import { LightDarkColorAdapt, shouldAdaptLightColors } from "../../src/lib/lightDarkColorAdapt";

describe("LightDarkColorAdapt", () => {
  it("inverts truecolor lightness while retaining hue and saturation", () => {
    const adapter = new LightDarkColorAdapt();
    expect(adapter.transform("\u001b[38;2;32;33;36mtext")).toBe("\u001b[38;2;219;220;223mtext");
  });

  it("inverts the 256-color grayscale ramp without changing its representation", () => {
    const adapter = new LightDarkColorAdapt();
    expect(adapter.transform("\u001b[48;5;254m")).toBe("\u001b[48;5;233m");
  });

  it("rewrites only color fields in a compound SGR sequence", () => {
    const adapter = new LightDarkColorAdapt();
    expect(adapter.transform("\u001b[1;38;2;32;33;36;48;5;254m")).toBe(
      "\u001b[1;38;2;219;220;223;48;5;233m",
    );
  });

  it("converts 256-color cube values to inverted truecolor", () => {
    const adapter = new LightDarkColorAdapt();
    expect(adapter.transform("\u001b[38;5;110m")).toBe("\u001b[38;2;51;102;153m");
  });

  it("keeps a saturated blue recognizable after its lightness is inverted", () => {
    const adapter = new LightDarkColorAdapt();
    expect(adapter.transform("\u001b[38;2;66;133;244m")).toBe("\u001b[38;2;11;78;189m");
  });

  it("leaves ANSI, default, and non-color SGR parameters unchanged", () => {
    const adapter = new LightDarkColorAdapt();
    const source = "\u001b[1;30;37;90;97;39;49m";
    expect(adapter.transform(source)).toBe(source);
  });

  it("holds a split SGR sequence until the following chunk", () => {
    const adapter = new LightDarkColorAdapt();
    expect(adapter.transform("\u001b[38;2;3")).toBe("");
    expect(adapter.transform("2;33;36mテキスト")).toBe("\u001b[38;2;219;220;223mテキスト");
  });

  it("passes SGR-free chunks through unchanged", () => {
    const adapter = new LightDarkColorAdapt();
    const source = "plain テキスト\r\n";
    expect(adapter.transform(source)).toBe(source);
  });

  it("passes non-SGR escape sequences through unchanged across a boundary", () => {
    const adapter = new LightDarkColorAdapt();
    expect(adapter.transform("\u001b]0;title")).toBe("");
    expect(adapter.transform("\u0007text")).toBe("\u001b]0;title\u0007text");
  });

  it("handles a one-megabyte chunk", () => {
    const adapter = new LightDarkColorAdapt();
    const source = "x".repeat(1024 * 1024);
    expect(adapter.transform(source)).toBe(source);
  });
});

describe("shouldAdaptLightColors", () => {
  it("matches the configured command by executable name only", () => {
    expect(shouldAdaptLightColors("C:\\tools\\agy.exe", ["agy"])).toBe(true);
    expect(shouldAdaptLightColors("other", ["agy"])).toBe(false);
  });
});
