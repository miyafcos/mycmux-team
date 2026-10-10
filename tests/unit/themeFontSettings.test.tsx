// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeFontPresetPicker } from "../../src/components/theme/ThemeFontSettings";
import { resetFontAvailabilityCache } from "../../src/lib/fontAvailability";
import { DEFAULT_TERMINAL_FONT_FAMILY } from "../../src/stores/themeStore";

const HACKGEN_STACK =
  "'HackGen Console NF', 'UDEV Gothic NF', 'BIZ UDGothic', ui-monospace, 'MS Gothic', monospace";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  resetFontAvailabilityCache();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetFontAvailabilityCache();
});

describe("HackGen font picker integration", () => {
  it("shows HackGen after bundled UDEV and applies its family and line height", () => {
    const setFontFamily = vi.fn();
    const setLineHeight = vi.fn();
    act(() => root.render(
      <ThemeFontPresetPicker
        fontSize={15}
        fontFamily={DEFAULT_TERMINAL_FONT_FAMILY}
        lineHeight={1.35}
        setFontSize={vi.fn()}
        setFontFamily={setFontFamily}
        setLineHeight={setLineHeight}
      />,
    ));

    const cards = [...container.querySelectorAll("button")];
    expect(cards[0].textContent).toContain("UDEV Gothic (同梱)");
    expect(cards[1].textContent).toContain("HackGen Console (同梱)");

    act(() => cards[1].click());

    expect(setFontFamily).toHaveBeenCalledExactlyOnceWith(HACKGEN_STACK);
    expect(setLineHeight).toHaveBeenCalledExactlyOnceWith(1.4);
  });

  it("marks a restored HackGen selection active", () => {
    act(() => root.render(
      <ThemeFontPresetPicker
        fontSize={15}
        fontFamily={HACKGEN_STACK}
        lineHeight={1.4}
        setFontSize={vi.fn()}
        setFontFamily={vi.fn()}
        setLineHeight={vi.fn()}
      />,
    ));

    const cards = [...container.querySelectorAll("button")];
    expect(cards[1].textContent).toContain("HackGen Console (同梱)");
    expect(cards[1].textContent).toContain("選択中");
    expect(cards[0].textContent).not.toContain("選択中");
  });
});
