export type KeybindingActionId =
  | "sidebar.toggle"
  | "workspace.new"
  | "workspace.new.advanced"
  | "workspace.next"
  | "workspace.prev"
  | "workspace.close"
  | "workspace.jump.1"
  | "workspace.jump.2"
  | "workspace.jump.3"
  | "workspace.jump.4"
  | "workspace.jump.5"
  | "workspace.jump.6"
  | "workspace.jump.7"
  | "workspace.jump.8"
  | "workspace.jump.9"
  | "pane.focus.left"
  | "pane.focus.right"
  | "pane.focus.up"
  | "pane.focus.down"
  | "pane.split.right"
  | "pane.split.down"
  | "pane.close"
  | "pane.reopen"
  | "pane.tab.next"
  | "pane.tab.prev"
  | "pane.tab.pin.toggle"
  | "pane.attention.next"
  | "settings.keybindings"
  | "tab.sweep"
  | "dashboard.open"
  | "dashboard.column.prev"
  | "dashboard.column.next"
  | "dashboard.column.close"
  | "dashboard.column.pin"
  | "pane.zoom.toggle"
  | "terminal.search"
  | "composer.focus"
  | "crsm.palette";

export interface KeybindingDefinition {
  action: KeybindingActionId;
  title: string;
  category: "Global" | "Workspace" | "Pane" | "Terminal";
  defaultShortcut: string;
}

export const KEYBINDING_DEFINITIONS: KeybindingDefinition[] = [
  { action: "sidebar.toggle", title: "Toggle sidebar", category: "Global", defaultShortcut: "ctrl+b" },
  { action: "settings.keybindings", title: "Open keyboard shortcuts", category: "Global", defaultShortcut: "ctrl+," },
  { action: "crsm.palette", title: "Open Resume", category: "Global", defaultShortcut: "ctrl+p" },
  { action: "tab.sweep", title: "タブ掃除を開く", category: "Global", defaultShortcut: "ctrl+shift+k" },
  { action: "dashboard.open", title: "Open dashboard", category: "Global", defaultShortcut: "ctrl+shift+g" },
  { action: "dashboard.column.prev", title: "ダッシュボードの左の列へ", category: "Global", defaultShortcut: "ctrl+shift+arrowleft" },
  { action: "dashboard.column.next", title: "ダッシュボードの右の列へ", category: "Global", defaultShortcut: "ctrl+shift+arrowright" },
  { action: "dashboard.column.close", title: "ダッシュボードの列を閉じる", category: "Global", defaultShortcut: "ctrl+shift+backspace" },
  { action: "dashboard.column.pin", title: "ダッシュボードの列を固定", category: "Global", defaultShortcut: "ctrl+shift+p" },

  { action: "workspace.new", title: "New workspace", category: "Workspace", defaultShortcut: "ctrl+shift+n" },
  { action: "workspace.new.advanced", title: "New workspace (choose agents)", category: "Workspace", defaultShortcut: "ctrl+shift+alt+n" },
  { action: "workspace.next", title: "Next workspace", category: "Workspace", defaultShortcut: "ctrl+tab" },
  { action: "workspace.prev", title: "Previous workspace", category: "Workspace", defaultShortcut: "ctrl+shift+tab" },
  { action: "workspace.close", title: "Close workspace", category: "Workspace", defaultShortcut: "ctrl+shift+w" },
  { action: "workspace.jump.1", title: "Jump to workspace 1", category: "Workspace", defaultShortcut: "ctrl+1" },
  { action: "workspace.jump.2", title: "Jump to workspace 2", category: "Workspace", defaultShortcut: "ctrl+2" },
  { action: "workspace.jump.3", title: "Jump to workspace 3", category: "Workspace", defaultShortcut: "ctrl+3" },
  { action: "workspace.jump.4", title: "Jump to workspace 4", category: "Workspace", defaultShortcut: "ctrl+4" },
  { action: "workspace.jump.5", title: "Jump to workspace 5", category: "Workspace", defaultShortcut: "ctrl+5" },
  { action: "workspace.jump.6", title: "Jump to workspace 6", category: "Workspace", defaultShortcut: "ctrl+6" },
  { action: "workspace.jump.7", title: "Jump to workspace 7", category: "Workspace", defaultShortcut: "ctrl+7" },
  { action: "workspace.jump.8", title: "Jump to workspace 8", category: "Workspace", defaultShortcut: "ctrl+8" },
  { action: "workspace.jump.9", title: "Jump to last workspace", category: "Workspace", defaultShortcut: "ctrl+9" },

  { action: "pane.focus.left", title: "Focus pane left", category: "Pane", defaultShortcut: "ctrl+alt+arrowleft" },
  { action: "pane.focus.right", title: "Focus pane right", category: "Pane", defaultShortcut: "ctrl+alt+arrowright" },
  { action: "pane.focus.up", title: "Focus pane up", category: "Pane", defaultShortcut: "ctrl+alt+arrowup" },
  { action: "pane.focus.down", title: "Focus pane down", category: "Pane", defaultShortcut: "ctrl+alt+arrowdown" },
  { action: "pane.split.right", title: "Split pane right", category: "Pane", defaultShortcut: "ctrl+alt+d" },
  { action: "pane.split.down", title: "Split pane down", category: "Pane", defaultShortcut: "ctrl+alt+shift+d" },
  { action: "pane.close", title: "Close active pane", category: "Pane", defaultShortcut: "ctrl+alt+w" },
  { action: "pane.reopen", title: "Reopen closed pane", category: "Pane", defaultShortcut: "ctrl+shift+t" },
  { action: "pane.zoom.toggle", title: "Toggle pane zoom", category: "Pane", defaultShortcut: "ctrl+shift+enter" },
  { action: "pane.tab.next", title: "Next tab in pane", category: "Pane", defaultShortcut: "ctrl+alt+pagedown" },
  { action: "pane.tab.prev", title: "Previous tab in pane", category: "Pane", defaultShortcut: "ctrl+alt+pageup" },
  { action: "pane.attention.next", title: "Next attention", category: "Pane", defaultShortcut: "ctrl+alt+a" },
  { action: "pane.tab.pin.toggle", title: "アクティブタブをピン留め", category: "Pane", defaultShortcut: "ctrl+alt+p" },

  { action: "terminal.search", title: "Find in terminal", category: "Terminal", defaultShortcut: "ctrl+shift+f" },
  // Not ctrl+shift+i: that is the WebView's own DevTools shortcut.
  { action: "composer.focus", title: "ペインの入力欄へ移動", category: "Terminal", defaultShortcut: "ctrl+alt+i" },

];

const MOD_ORDER = ["ctrl", "alt", "shift", "meta"];

export const DEFAULT_KEYBINDINGS: Record<KeybindingActionId, string> = {
  ...KEYBINDING_DEFINITIONS.reduce(
    (acc, def) => {
      acc[def.action] = normalizeShortcut(def.defaultShortcut);
      return acc;
    },
    {} as Record<KeybindingActionId, string>,
  ),
};

function normalizeKey(key: string): string {
  const k = key.toLowerCase();
  if (k === " ") return "space";
  if (k === "esc") return "escape";
  return k;
}

export function normalizeShortcut(shortcut: string): string {
  const rawParts = shortcut
    .split("+")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);

  const mods = new Set<string>();
  let key = "";

  for (const part of rawParts) {
    if (part === "cmd") {
      mods.add("meta");
      continue;
    }
    if (MOD_ORDER.includes(part)) {
      mods.add(part);
      continue;
    }
    key = normalizeKey(part);
  }

  const orderedMods = MOD_ORDER.filter((m) => mods.has(m));
  return key ? [...orderedMods, key].join("+") : orderedMods.join("+");
}

export function shortcutFromKeyboardEvent(e: KeyboardEvent): string {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("ctrl");
  if (e.altKey) mods.push("alt");
  if (e.shiftKey) mods.push("shift");
  if (e.metaKey) mods.push("meta");
  const key = normalizeKey(e.key);
  const isModifierOnly = ["control", "alt", "shift", "meta"].includes(key);
  if (!isModifierOnly) {
    mods.push(key);
  }
  return normalizeShortcut(mods.join("+"));
}

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  // Three sources, because each one is absent somewhere: userAgentData is
  // Chromium-only, `platform` is deprecated and can come back blank, and the
  // user agent string is the last field every engine still fills in. Reading
  // only the first is how a WebView without userAgentData reported "not a Mac"
  // and silently dropped every Command shortcut.
  const uaPlatform = nav.userAgentData?.platform;
  if (uaPlatform) return uaPlatform === "macOS";
  const legacy = nav.platform || "";
  if (legacy) return /mac/i.test(legacy);
  return /Macintosh|Mac OS X/i.test(nav.userAgent || "");
}

export const IS_MAC = isMacPlatform();

/**
 * The same shortcut with ctrl and meta traded, re-normalized.
 *
 * Shortcuts are authored Windows-first as `ctrl+...` and a Mac user reaches for
 * Command instead. Comparing prefixes cannot bridge the two: normalization
 * sorts modifiers ctrl, alt, shift, meta, so `ctrl+shift+n` becomes
 * `shift+meta+n` once Command replaces Control — the strings stop sharing a
 * prefix, which is why every multi-modifier shortcut did nothing under Cmd
 * while the single-modifier ones (Cmd+B, Cmd+P, Cmd+1) worked.
 */
function swapCtrlMeta(shortcut: string): string {
  const swapped = shortcut
    .split("+")
    .map((part) => {
      if (part === "ctrl") return "meta";
      if (part === "meta") return "ctrl";
      return part;
    })
    .join("+");
  return normalizeShortcut(swapped);
}

/**
 * Whether a normalized event shortcut activates a normalized binding.
 *
 * Split out of `eventMatchesShortcut` so the macOS bridge is testable without
 * stubbing a navigator.
 */
export function shortcutMatchesEvent(
  normalized: string,
  eventShortcut: string,
  isMac: boolean,
): boolean {
  if (!normalized) return false;
  if (eventShortcut === normalized) return true;
  if (!isMac) return false;
  return swapCtrlMeta(normalized) === eventShortcut;
}

export function eventMatchesShortcut(e: KeyboardEvent, shortcut?: string): boolean {
  if (!shortcut) return false;
  return shortcutMatchesEvent(normalizeShortcut(shortcut), shortcutFromKeyboardEvent(e), IS_MAC);
}

export function getActionDefinition(action: KeybindingActionId): KeybindingDefinition {
  return KEYBINDING_DEFINITIONS.find((d) => d.action === action)!;
}

export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select";
}

/** Keys macOS writes as a glyph rather than a word. */
const MAC_KEY_GLYPHS: Record<string, string> = {
  arrowleft: "←",
  arrowright: "→",
  arrowup: "↑",
  arrowdown: "↓",
  tab: "⇥",
  enter: "↩",
  backspace: "⌫",
  delete: "⌦",
  escape: "⎋",
  pageup: "⇞",
  pagedown: "⇟",
  home: "↖",
  end: "↘",
  space: "Space",
};

function formatKeyLabel(key: string): string {
  if (key.startsWith("arrow")) return `Arrow${key.slice(5)}`;
  if (key === "pageup") return "PageUp";
  if (key === "pagedown") return "PageDown";
  if (key === " ") return "Space";
  return key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * A binding written the way macOS writes one: glyphs in the order ⌃⌥⇧⌘, run
 * together with no separator.
 *
 * A `ctrl+...` default is shown as ⌘ because Command is the key a Mac user
 * presses for it (see `swapCtrlMeta`). Printing "Ctrl+Shift+N" next to a
 * shortcut that answers to ⌘⇧N is what made the shortcut list read as wrong.
 */
export function formatMacShortcutLabel(shortcut: string): string {
  const parts = normalizeShortcut(shortcut).split("+").filter(Boolean);
  let command = false;
  let option = false;
  let shift = false;
  let key = "";
  for (const part of parts) {
    if (part === "ctrl" || part === "meta") {
      command = true;
      continue;
    }
    if (part === "alt") {
      option = true;
      continue;
    }
    if (part === "shift") {
      shift = true;
      continue;
    }
    key = part;
  }
  const glyphs = `${option ? "⌥" : ""}${shift ? "⇧" : ""}${command ? "⌘" : ""}`;
  if (!key) return glyphs;
  return `${glyphs}${MAC_KEY_GLYPHS[key] ?? formatKeyLabel(key)}`;
}

export function formatShortcutLabel(shortcut: string): string {
  if (IS_MAC) return formatMacShortcutLabel(shortcut);
  const parts = normalizeShortcut(shortcut).split("+");
  return parts
    .map((p) => {
      if (p === "ctrl") return "Ctrl";
      if (p === "alt") return "Alt";
      if (p === "shift") return "Shift";
      if (p === "meta") return "Meta";
      return formatKeyLabel(p);
    })
    .join("+");
}
