import { describe, expect, it } from "vitest";
import {
  formatMacShortcutLabel,
  getActionDefinition,
  KEYBINDING_DEFINITIONS,
  normalizeShortcut,
  shortcutMatchesEvent,
} from "../../src/lib/keybindings";

describe("global keybindings", () => {
  it("registers a non-conflicting global command", () => {
    const definition = getActionDefinition("tab.sweep");
    expect(definition).toMatchObject({
      title: "タブ掃除を開く",
      category: "Global",
      defaultShortcut: "ctrl+shift+k",
    });

    const shortcuts = KEYBINDING_DEFINITIONS.map((item) => normalizeShortcut(item.defaultShortcut));
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
  });

  it("registers the dashboard command without a shortcut conflict", () => {
    expect(getActionDefinition("dashboard.open")).toMatchObject({
      title: "Open dashboard",
      category: "Global",
      defaultShortcut: "ctrl+shift+g",
    });
  });

  it("registers dashboard column commands without a shortcut conflict", () => {
    expect(getActionDefinition("dashboard.column.prev").defaultShortcut).toBe("ctrl+shift+arrowleft");
    expect(getActionDefinition("dashboard.column.next").defaultShortcut).toBe("ctrl+shift+arrowright");
    expect(getActionDefinition("dashboard.column.close").defaultShortcut).toBe("ctrl+shift+backspace");
    expect(getActionDefinition("dashboard.column.pin").defaultShortcut).toBe("ctrl+shift+p");
    const shortcuts = KEYBINDING_DEFINITIONS.map((item) => normalizeShortcut(item.defaultShortcut));
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
  });
});

describe("macOS Command bridge", () => {
  const asMac = (binding: string, pressed: string) =>
    shortcutMatchesEvent(normalizeShortcut(binding), normalizeShortcut(pressed), true);
  const asWindows = (binding: string, pressed: string) =>
    shortcutMatchesEvent(normalizeShortcut(binding), normalizeShortcut(pressed), false);

  it("fires a multi-modifier binding from Command, not just the single-modifier ones", () => {
    // These four were the whole bug: only the first used to match, because the
    // bridge compared string prefixes and normalization reorders the modifiers.
    expect(asMac("ctrl+b", "meta+b")).toBe(true);
    expect(asMac("ctrl+shift+n", "meta+shift+n")).toBe(true);
    expect(asMac("ctrl+alt+d", "meta+alt+d")).toBe(true);
    expect(asMac("ctrl+alt+shift+d", "meta+alt+shift+d")).toBe(true);
  });

  it("still fires the literal binding, and bridges a meta binding back to Control", () => {
    expect(asMac("ctrl+shift+n", "ctrl+shift+n")).toBe(true);
    expect(asMac("meta+shift+n", "ctrl+shift+n")).toBe(true);
  });

  it("does not fire on a different key or a missing modifier", () => {
    expect(asMac("ctrl+shift+n", "meta+n")).toBe(false);
    expect(asMac("ctrl+shift+n", "meta+shift+m")).toBe(false);
    expect(asMac("ctrl+alt+d", "meta+d")).toBe(false);
  });

  it("leaves Windows alone: the Windows key must not stand in for Control", () => {
    expect(asWindows("ctrl+shift+n", "meta+shift+n")).toBe(false);
    expect(asWindows("ctrl+b", "meta+b")).toBe(false);
    expect(asWindows("ctrl+shift+n", "ctrl+shift+n")).toBe(true);
  });

  it("writes a binding the way macOS writes one", () => {
    expect(formatMacShortcutLabel("ctrl+shift+n")).toBe("⇧⌘N");
    expect(formatMacShortcutLabel("ctrl+alt+d")).toBe("⌥⌘D");
    expect(formatMacShortcutLabel("ctrl+alt+shift+d")).toBe("⌥⇧⌘D");
    expect(formatMacShortcutLabel("ctrl+b")).toBe("⌘B");
    expect(formatMacShortcutLabel("ctrl+alt+arrowleft")).toBe("⌥⌘←");
    expect(formatMacShortcutLabel("ctrl+shift+backspace")).toBe("⇧⌘⌫");
    expect(formatMacShortcutLabel("ctrl+tab")).toBe("⌘⇥");
    expect(formatMacShortcutLabel("ctrl+shift+enter")).toBe("⇧⌘↩");
    expect(formatMacShortcutLabel("ctrl+,")).toBe("⌘,");
  });
});
