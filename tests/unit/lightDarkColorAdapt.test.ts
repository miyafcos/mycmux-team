import { describe, expect, it } from "vitest";
import {
  LightDarkColorAdapt,
  LightDarkColorAdaptController,
  shouldAdaptLightColors,
  shouldAdaptLightColorsForPane,
} from "../../src/lib/lightDarkColorAdapt";
import { VT_SCAN_VECTORS } from "./vtScanVectors";

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

  it("drops a pending escape sequence when reset", () => {
    const adapter = new LightDarkColorAdapt();
    expect(adapter.transform("\u001b[38;2;3")).toBe("");
    adapter.reset();
    expect(adapter.transform("2;33;36m")).toBe("2;33;36m");
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

  it("enables process-title matches alongside the launch command", () => {
    expect(shouldAdaptLightColorsForPane("bash", "agy", ["agy"])).toBe(true);
    expect(shouldAdaptLightColorsForPane("bash", "bash", ["agy"])).toBe(false);
    expect(shouldAdaptLightColorsForPane("agy", "bash", ["agy"])).toBe(true);
  });
});

describe("sequence boundary agreement with vtScanVectors", () => {
  it("holds each shared-vector sequence until its terminator", () => {
    for (const vector of VT_SCAN_VECTORS) {
      for (const [start, end] of vector.sequences) {
        const adapter = new LightDarkColorAdapt();
        const held = adapter.transform(vector.input.slice(0, end - 1));
        expect(held, vector.name).toBe(vector.input.slice(0, start));
        const rest = adapter.transform(vector.input.slice(end - 1));
        const full = new LightDarkColorAdapt().transform(vector.input);
        expect(held + rest, vector.name).toBe(full);
      }
    }
  });
});

describe("LightDarkColorAdaptController", () => {
  it("resets pending output when process-title eligibility changes from agy to bash", () => {
    const adapter = new LightDarkColorAdaptController();
    const configuredCommands = ["agy"];
    expect(adapter.transform("\u001b[38;2;3", shouldAdaptLightColorsForPane("bash", "agy", configuredCommands))).toBe("");
    expect(adapter.transform("2;33;36m", shouldAdaptLightColorsForPane("bash", "bash", configuredCommands))).toBe("2;33;36m");
    expect(adapter.transform("\u001b[38;2;32;33;36m", shouldAdaptLightColorsForPane("bash", "agy", configuredCommands))).toBe("\u001b[38;2;219;220;223m");
  });
});
