// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import { DEFAULT_KEYBINDINGS } from "../../src/lib/keybindings";
import type { KeybindingsMap } from "../../src/stores/keybindingStore";
import { useKeybindingStore } from "../../src/stores/keybindingStore";
import {
  deriveWebPaneForwardedShortcuts,
  dispatchWebPaneKeydown,
  shortcutFromWebPanePayload,
  type WebPaneForwardedKey,
} from "../../src/components/workspace/webPaneShortcuts";

function payload(overrides: Partial<WebPaneForwardedKey> = {}): WebPaneForwardedKey {
  return {
    tabId: "web-tab",
    key: "Tab",
    code: "Tab",
    location: 0,
    ctrlKey: true,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    repeat: false,
    isComposing: false,
    ...overrides,
  };
}

describe("web pane shortcut forwarding", () => {
  it("derives only routing shortcuts from the effective keybinding map", () => {
    const forwarded = deriveWebPaneForwardedShortcuts(DEFAULT_KEYBINDINGS);

    expect(forwarded).toEqual([
      "ctrl+1",
      "ctrl+2",
      "ctrl+3",
      "ctrl+4",
      "ctrl+5",
      "ctrl+6",
      "ctrl+7",
      "ctrl+8",
      "ctrl+9",
      "ctrl+alt+arrowdown",
      "ctrl+alt+arrowleft",
      "ctrl+alt+arrowright",
      "ctrl+alt+arrowup",
      "ctrl+alt+pagedown",
      "ctrl+alt+pageup",
      "ctrl+shift+tab",
      "ctrl+tab",
    ]);
    expect(forwarded).not.toEqual(expect.arrayContaining([
      "ctrl+c",
      "ctrl+v",
      "ctrl+a",
      "ctrl+p",
      "ctrl+shift+o",
      "ctrl+alt+i",
      "ctrl+shift+f",
    ]));
  });

  it("fails closed for protected overrides and shortcut conflicts", () => {
    const protectedOverride: KeybindingsMap = {
      ...DEFAULT_KEYBINDINGS,
      "workspace.next": "ctrl+c",
    };
    expect(deriveWebPaneForwardedShortcuts(protectedOverride)).not.toContain("ctrl+c");

    const conflictingOverride: KeybindingsMap = {
      ...DEFAULT_KEYBINDINGS,
      "workspace.next": "ctrl+alt+pagedown",
    };
    expect(deriveWebPaneForwardedShortcuts(conflictingOverride)).not.toContain("ctrl+alt+pagedown");
  });

  it("delivers a workspace shortcut to mycmux and leaves text and IME in the webview", () => {
    const listener = vi.fn();
    window.addEventListener("keydown", listener);
    const forwarded = new Set(deriveWebPaneForwardedShortcuts(DEFAULT_KEYBINDINGS));
    const tabs = new Set(["web-tab"]);

    expect(shortcutFromWebPanePayload(payload())).toBe("ctrl+tab");
    expect(dispatchWebPaneKeydown(payload(), forwarded, tabs)).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toMatchObject({ key: "Tab", ctrlKey: true });
    expect(useKeybindingStore.getState().getActionsForEvent(listener.mock.calls[0][0]))
      .toEqual(["workspace.next"]);

    expect(dispatchWebPaneKeydown(payload({ key: "a", code: "KeyA", ctrlKey: false }), forwarded, tabs)).toBe(false);
    expect(dispatchWebPaneKeydown(payload({ isComposing: true }), forwarded, tabs)).toBe(false);
    expect(dispatchWebPaneKeydown(payload({ tabId: "closed-tab" }), forwarded, tabs)).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener("keydown", listener);
  });
});
