import { describe, expect, it } from "vitest";
import { PANE_CLICK_IGNORED_TARGET_SELECTOR } from "../../src/components/workspace/TerminalPane";
import { DEFAULT_KEYBINDINGS } from "../../src/lib/keybindings";

// The composer lives inside the pane, so every pane-level pointer handler has to
// agree to leave it alone. These are contract checks: the unit suite runs on the
// node environment, so the DOM behaviour itself cannot be exercised here.
describe("pane composer contract", () => {
  it("keeps the composer out of the pane's click-to-activate handler", () => {
    // Without this the composer's padding and target badge hand focus back to
    // xterm mid-tap, which reads as the input box closing the moment it is hit.
    expect(PANE_CLICK_IGNORED_TARGET_SELECTOR).toContain("[data-composer-session]");
  });

  it("still lets a click on the terminal itself activate the pane", () => {
    expect(PANE_CLICK_IGNORED_TARGET_SELECTOR).not.toContain(".xterm-helper-textarea");
  });

  it("does not bind the composer to the WebView's DevTools shortcut", () => {
    expect(DEFAULT_KEYBINDINGS["composer.focus"]).not.toBe("ctrl+shift+i");
    expect(DEFAULT_KEYBINDINGS["composer.focus"]).toBe("ctrl+alt+i");
  });

  it("gives the composer a shortcut nothing else has claimed", () => {
    const shortcut = DEFAULT_KEYBINDINGS["composer.focus"];
    const clashes = Object.entries(DEFAULT_KEYBINDINGS)
      .filter(([action, binding]) => action !== "composer.focus" && binding === shortcut)
      .map(([action]) => action);
    expect(clashes).toEqual([]);
  });
});
