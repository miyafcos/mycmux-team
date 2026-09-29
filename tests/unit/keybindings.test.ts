import { describe, expect, it } from "vitest";
import {
  defaultShortcutFor,
  effectiveShortcut,
  formatMacShortcutLabel,
  getActionDefinition,
  KEYBINDING_DEFINITIONS,
  keyFromEventCode,
  normalizeShortcut,
  shortcutMatchesEvent,
} from "../../src/lib/keybindings";

describe("global keybindings", () => {
  it("registers a non-conflicting global command", () => {
    const definition = getActionDefinition("tab.sweep");
    expect(definition).toMatchObject({
      title: "ペイン掃除を開く",
      category: "Global",
      defaultShortcut: "ctrl+shift+k",
    });

    const shortcuts = KEYBINDING_DEFINITIONS.map((item) => normalizeShortcut(item.defaultShortcut));
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
  });

  it("registers the dashboard command without a shortcut conflict", () => {
    expect(getActionDefinition("dashboard.open")).toMatchObject({
      title: "ダッシュボードを開く",
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

  it("hands the physical Control key to the shell instead of the app", () => {
    // ⌃P is history, ⌃W deletes a word, ⌃C interrupts. A binding that also
    // answered to Control would take all three away from the terminal.
    expect(asMac("ctrl+p", "ctrl+p")).toBe(false);
    expect(asMac("ctrl+shift+n", "ctrl+shift+n")).toBe(false);
    expect(asMac("ctrl+b", "ctrl+b")).toBe(false);
  });

  it("keeps Tab on Control, because macOS never delivers ⌘⇥ to an app", () => {
    expect(asMac("ctrl+tab", "ctrl+tab")).toBe(true);
    expect(asMac("ctrl+tab", "meta+tab")).toBe(false);
    expect(asMac("ctrl+shift+tab", "ctrl+shift+tab")).toBe(true);
    expect(asMac("ctrl+shift+tab", "meta+shift+tab")).toBe(false);
  });

  it("leaves a binding written with meta on Command", () => {
    expect(asMac("meta+d", "meta+d")).toBe(true);
    expect(asMac("meta+shift+n", "ctrl+shift+n")).toBe(false);
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
    expect(asWindows("ctrl+tab", "ctrl+tab")).toBe(true);
  });

  it("writes a binding the way macOS writes one", () => {
    expect(formatMacShortcutLabel("ctrl+shift+n")).toBe("⇧⌘N");
    expect(formatMacShortcutLabel("ctrl+alt+d")).toBe("⌥⌘D");
    expect(formatMacShortcutLabel("ctrl+alt+shift+d")).toBe("⌥⇧⌘D");
    expect(formatMacShortcutLabel("ctrl+b")).toBe("⌘B");
    expect(formatMacShortcutLabel("ctrl+alt+arrowleft")).toBe("⌥⌘←");
    expect(formatMacShortcutLabel("ctrl+shift+backspace")).toBe("⇧⌘⌫");
    expect(formatMacShortcutLabel("ctrl+shift+enter")).toBe("⇧⌘↩");
    expect(formatMacShortcutLabel("ctrl+,")).toBe("⌘,");
  });

  it("prints ⌃ for the bindings that really are Control, and ⌘ for the rest", () => {
    expect(formatMacShortcutLabel("ctrl+tab")).toBe("⌃⇥");
    expect(formatMacShortcutLabel("ctrl+shift+tab")).toBe("⌃⇧⇥");
    expect(formatMacShortcutLabel("ctrl+p")).toBe("⌘P");
    expect(formatMacShortcutLabel("meta+d")).toBe("⌘D");
    expect(formatMacShortcutLabel("meta+shift+d")).toBe("⇧⌘D");
  });
});

describe("macOS defaults", () => {
  it("splits with ⌘D / ⇧⌘D, because ⌥⌘D is the system's Dock shortcut", () => {
    const right = getActionDefinition("pane.split.right");
    const down = getActionDefinition("pane.split.down");
    expect(defaultShortcutFor(right, false)).toBe("ctrl+alt+d");
    expect(defaultShortcutFor(down, false)).toBe("ctrl+alt+shift+d");
    expect(formatMacShortcutLabel(defaultShortcutFor(right, true))).toBe("⌘D");
    expect(formatMacShortcutLabel(defaultShortcutFor(down, true))).toBe("⇧⌘D");
  });

  it("keeps every default distinct once macOS has traded Control for Command", () => {
    // Windows uniqueness is checked above; the trade can collapse two bindings
    // onto one key, and a collision there is invisible until a shortcut is dead.
    const effective = KEYBINDING_DEFINITIONS.map((def) => effectiveShortcut(defaultShortcutFor(def, true), true));
    expect(new Set(effective).size).toBe(effective.length);
  });

  it("does not hand macOS a default that collides with a system shortcut", () => {
    // The ones macOS answers itself before an app ever sees the key.
    const systemOwned = new Set(["alt+meta+d", "meta+q", "meta+h", "meta+m", "meta+space", "alt+meta+escape"]);
    const collisions = KEYBINDING_DEFINITIONS
      .map((def) => ({ action: def.action, shortcut: effectiveShortcut(defaultShortcutFor(def, true), true) }))
      .filter((entry) => systemOwned.has(entry.shortcut));
    expect(collisions).toEqual([]);
  });
});

describe("event codes", () => {
  it("names the keys macOS rewrites once Option is held", () => {
    expect(keyFromEventCode("KeyD")).toBe("d");
    expect(keyFromEventCode("KeyI")).toBe("i");
    expect(keyFromEventCode("Digit1")).toBe("1");
    expect(keyFromEventCode("Numpad1")).toBe("1");
    expect(keyFromEventCode("ArrowLeft")).toBe("arrowleft");
    expect(keyFromEventCode("Comma")).toBe(",");
    expect(keyFromEventCode("PageDown")).toBe("pagedown");
    expect(keyFromEventCode("F12")).toBe("f12");
  });

  it("says nothing rather than guessing for a key it cannot name", () => {
    expect(keyFromEventCode("AltLeft")).toBeNull();
    expect(keyFromEventCode("IntlBackslash")).toBeNull();
    expect(keyFromEventCode("")).toBeNull();
    expect(keyFromEventCode(undefined)).toBeNull();
  });
});
