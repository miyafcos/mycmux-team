// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BackgroundPresetSegment } from "../../src/components/theme/BackgroundPresetSegment";
import { appearanceStrings } from "../../src/lib/appearanceStrings";
import {
  CLEAR_PANEL_OPACITY,
  CLEAR_TERMINAL_OPACITY,
} from "../../src/lib/theme/backgroundPresets";
import { DEFAULT_THEME_BACKGROUND } from "../../src/lib/themeBackgrounds";
import { useThemeStore } from "../../src/stores/themeStore";

function Harness() {
  const background = useThemeStore((s) => s.themeTweaks.background);
  const setThemeBackground = useThemeStore((s) => s.setThemeBackground);
  return <BackgroundPresetSegment background={background} onChange={setThemeBackground} />;
}

describe("BackgroundPresetSegment writes the theme store", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    useThemeStore.getState().hydrateSettings({ themeId: "mayonaka", themeTweaks: undefined });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root.render(<Harness />);
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
  });

  function radios(): HTMLButtonElement[] {
    return [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  }

  function radio(label: string): HTMLButtonElement {
    const match = radios().find((button) => button.textContent === label);
    if (!match) {
      throw new Error(`radio "${label}" missing`);
    }
    return match;
  }

  it("exposes a labelled radiogroup", () => {
    const group = host.querySelector('[role="radiogroup"]');
    expect(group?.getAttribute("aria-label")).toBe(appearanceStrings.backgroundPresetAriaLabel);
    expect(radios().map((button) => button.textContent)).toEqual([
      appearanceStrings.backgroundPresetSolid,
      appearanceStrings.backgroundPresetFrosted,
      appearanceStrings.backgroundPresetClear,
    ]);
    expect(radio(appearanceStrings.backgroundPresetFrosted).getAttribute("aria-checked")).toBe("true");
  });

  it("applies clear to the store on click", () => {
    act(() => {
      radio(appearanceStrings.backgroundPresetClear).click();
    });
    const background = useThemeStore.getState().themeTweaks.background;
    expect(background.solidSurfaces).toBe(false);
    expect(background.panelOpacity).toBe(CLEAR_PANEL_OPACITY);
    expect(background.terminalOpacity).toBe(CLEAR_TERMINAL_OPACITY);
    expect(radio(appearanceStrings.backgroundPresetClear).getAttribute("aria-checked")).toBe("true");
  });

  it("applies solid without rewriting opacities", () => {
    act(() => {
      radio(appearanceStrings.backgroundPresetClear).click();
    });
    act(() => {
      radio(appearanceStrings.backgroundPresetSolid).click();
    });
    const background = useThemeStore.getState().themeTweaks.background;
    expect(background.solidSurfaces).toBe(true);
    expect(background.panelOpacity).toBe(CLEAR_PANEL_OPACITY);
    expect(background.terminalOpacity).toBe(CLEAR_TERMINAL_OPACITY);
  });

  it("shows custom and restores the last named preset when it is pressed", () => {
    act(() => {
      radio(appearanceStrings.backgroundPresetClear).click();
    });
    act(() => {
      useThemeStore.getState().setThemeBackground({ panelOpacity: 0.4, terminalOpacity: 0.3 });
    });
    expect(radio(appearanceStrings.backgroundPresetCustom).getAttribute("aria-checked")).toBe("true");
    expect(host.textContent).toContain(appearanceStrings.backgroundPresetCustomHint);

    act(() => {
      radio(appearanceStrings.backgroundPresetCustom).click();
    });
    const background = useThemeStore.getState().themeTweaks.background;
    expect(background.panelOpacity).toBe(CLEAR_PANEL_OPACITY);
    expect(background.terminalOpacity).toBe(CLEAR_TERMINAL_OPACITY);
    expect(background.solidSurfaces).toBe(false);
    expect(radios().map((button) => button.textContent)).not.toContain(
      appearanceStrings.backgroundPresetCustom,
    );
  });

  it("moves with arrow keys", () => {
    const group = host.querySelector('[role="radiogroup"]');
    const frosted = radio(appearanceStrings.backgroundPresetFrosted);
    act(() => {
      frosted.focus();
      group?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    const background = useThemeStore.getState().themeTweaks.background;
    expect(background.panelOpacity).toBe(CLEAR_PANEL_OPACITY);
    expect(background.terminalOpacity).toBe(CLEAR_TERMINAL_OPACITY);
    expect(radio(appearanceStrings.backgroundPresetClear).getAttribute("aria-checked")).toBe("true");
  });

  it("starts from the shipped frosted default", () => {
    const background = useThemeStore.getState().themeTweaks.background;
    expect(background).toMatchObject({
      panelOpacity: DEFAULT_THEME_BACKGROUND.panelOpacity,
      terminalOpacity: DEFAULT_THEME_BACKGROUND.terminalOpacity,
      solidSurfaces: false,
    });
  });
});
