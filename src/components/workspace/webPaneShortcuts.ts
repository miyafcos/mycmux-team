import {
  KEYBINDING_DEFINITIONS,
  normalizeShortcut,
  type KeybindingActionId,
} from "../../lib/keybindings";
import type { KeybindingsMap } from "../../stores/keybindingStore";

export const WEB_PANE_KEYDOWN_EVENT = "mycmux:web-pane-keydown";

const FORWARDED_ACTIONS = new Set<KeybindingActionId>([
  "workspace.next",
  "workspace.prev",
  "workspace.jump.1",
  "workspace.jump.2",
  "workspace.jump.3",
  "workspace.jump.4",
  "workspace.jump.5",
  "workspace.jump.6",
  "workspace.jump.7",
  "workspace.jump.8",
  "workspace.jump.9",
  "pane.tab.next",
  "pane.tab.prev",
  "pane.focus.left",
  "pane.focus.right",
  "pane.focus.up",
  "pane.focus.down",
]);

const WEB_OWNED_SHORTCUTS = new Set([
  "alt+arrowleft",
  "alt+arrowright",
  "ctrl+a",
  "ctrl+c",
  "ctrl+p",
  "ctrl+r",
  "ctrl+v",
  "ctrl+x",
  "ctrl+y",
  "ctrl+z",
  "ctrl+0",
  "ctrl+-",
  "ctrl+=",
  "ctrl++",
  "ctrl+shift+o",
  "ctrl+shift+z",
  "meta+a",
  "meta+c",
  "meta+p",
  "meta+r",
  "meta+v",
  "meta+x",
  "meta+y",
  "meta+z",
  "meta+0",
  "meta+-",
  "meta+=",
  "meta++",
  "meta+shift+o",
  "meta+shift+z",
  "f5",
]);

function webPaneMayOwnShortcut(shortcut: string): boolean {
  if (!shortcut || WEB_OWNED_SHORTCUTS.has(shortcut)) return false;
  const parts = shortcut.split("+");
  const key = parts[parts.length - 1];
  const hasRoutingModifier = parts.includes("ctrl") || parts.includes("alt") || parts.includes("meta");
  if (!hasRoutingModifier) return false;
  if (key === "enter" || key === "escape") return false;
  return true;
}

export function deriveWebPaneForwardedShortcuts(keybindings: KeybindingsMap): string[] {
  const actionsByShortcut = new Map<string, KeybindingActionId[]>();
  for (const definition of KEYBINDING_DEFINITIONS) {
    const shortcut = normalizeShortcut(keybindings[definition.action]);
    if (!shortcut) continue;
    const actions = actionsByShortcut.get(shortcut) ?? [];
    actions.push(definition.action);
    actionsByShortcut.set(shortcut, actions);
  }

  const forwarded: string[] = [];
  for (const [shortcut, actions] of actionsByShortcut) {
    if (actions.length !== 1 || !FORWARDED_ACTIONS.has(actions[0])) continue;
    if (!webPaneMayOwnShortcut(shortcut)) continue;
    forwarded.push(shortcut);
  }
  return forwarded.sort();
}

export interface WebPaneForwardedKey {
  tabId: string;
  key: string;
  code: string;
  location: number;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  repeat: boolean;
  isComposing: boolean;
}

function isForwardedKey(value: unknown): value is WebPaneForwardedKey {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<WebPaneForwardedKey>;
  return typeof payload.tabId === "string"
    && payload.tabId.length > 0
    && payload.tabId.length <= 128
    && typeof payload.key === "string"
    && payload.key.length <= 32
    && typeof payload.code === "string"
    && payload.code.length <= 64
    && Number.isInteger(payload.location)
    && payload.location! >= 0
    && payload.location! <= 3
    && typeof payload.ctrlKey === "boolean"
    && typeof payload.altKey === "boolean"
    && typeof payload.shiftKey === "boolean"
    && typeof payload.metaKey === "boolean"
    && typeof payload.repeat === "boolean"
    && typeof payload.isComposing === "boolean";
}

export function shortcutFromWebPanePayload(payload: WebPaneForwardedKey): string {
  const parts: string[] = [];
  if (payload.ctrlKey) parts.push("ctrl");
  if (payload.altKey) parts.push("alt");
  if (payload.shiftKey) parts.push("shift");
  if (payload.metaKey) parts.push("meta");
  parts.push(payload.key);
  return normalizeShortcut(parts.join("+"));
}

export function dispatchWebPaneKeydown(
  value: unknown,
  forwardedShortcuts: ReadonlySet<string>,
  expectedTabIds: ReadonlySet<string>,
): boolean {
  if (!isForwardedKey(value) || value.isComposing || !expectedTabIds.has(value.tabId)) return false;
  if (!forwardedShortcuts.has(shortcutFromWebPanePayload(value))) return false;
  return window.dispatchEvent(new KeyboardEvent("keydown", {
    key: value.key,
    code: value.code,
    location: value.location,
    ctrlKey: value.ctrlKey,
    altKey: value.altKey,
    shiftKey: value.shiftKey,
    metaKey: value.metaKey,
    repeat: value.repeat,
    bubbles: true,
    cancelable: true,
  }));
}
