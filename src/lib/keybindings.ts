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

export type KeybindingCategory = "Global" | "Workspace" | "Pane" | "Terminal";

export interface KeybindingDefinition {
  action: KeybindingActionId;
  title: string;
  category: KeybindingCategory;
  defaultShortcut: string;
  /**
   * Used instead of `defaultShortcut` on macOS, where the Windows default maps
   * onto a shortcut macOS has already spoken for. Only set this for a real
   * collision: every other default reaches the Mac user as Command through
   * `effectiveShortcut`, and a second spelling of the same binding is one more
   * thing to keep in step.
   */
  macDefaultShortcut?: string;
}

/** The category stays an English key; only its printed name is translated. */
export const KEYBINDING_CATEGORY_LABEL: Record<KeybindingCategory, string> = {
  Global: "全体",
  Workspace: "ワークスペース",
  Pane: "タブ",
  Terminal: "ターミナル",
};

export const KEYBINDING_DEFINITIONS: KeybindingDefinition[] = [
  { action: "sidebar.toggle", title: "サイドバーの表示切り替え", category: "Global", defaultShortcut: "ctrl+b" },
  { action: "settings.keybindings", title: "キーボードショートカットを開く", category: "Global", defaultShortcut: "ctrl+," },
  { action: "crsm.palette", title: "セッションを続きから開く", category: "Global", defaultShortcut: "ctrl+p" },
  { action: "tab.sweep", title: "ペイン掃除を開く", category: "Global", defaultShortcut: "ctrl+shift+k" },
  { action: "dashboard.open", title: "ダッシュボードを開く", category: "Global", defaultShortcut: "ctrl+shift+g" },
  { action: "dashboard.column.prev", title: "ダッシュボードの左の列へ", category: "Global", defaultShortcut: "ctrl+shift+arrowleft" },
  { action: "dashboard.column.next", title: "ダッシュボードの右の列へ", category: "Global", defaultShortcut: "ctrl+shift+arrowright" },
  { action: "dashboard.column.close", title: "ダッシュボードの列を閉じる", category: "Global", defaultShortcut: "ctrl+shift+backspace" },
  { action: "dashboard.column.pin", title: "ダッシュボードの列を固定", category: "Global", defaultShortcut: "ctrl+shift+p" },

  { action: "workspace.new", title: "新しいワークスペース", category: "Workspace", defaultShortcut: "ctrl+shift+n" },
  { action: "workspace.new.advanced", title: "新しいワークスペース (エージェントを選ぶ)", category: "Workspace", defaultShortcut: "ctrl+shift+alt+n" },
  { action: "workspace.next", title: "次のワークスペース", category: "Workspace", defaultShortcut: "ctrl+tab" },
  { action: "workspace.prev", title: "前のワークスペース", category: "Workspace", defaultShortcut: "ctrl+shift+tab" },
  { action: "workspace.close", title: "ワークスペースを閉じる", category: "Workspace", defaultShortcut: "ctrl+shift+w" },
  { action: "workspace.jump.1", title: "ワークスペース 1 へ", category: "Workspace", defaultShortcut: "ctrl+1" },
  { action: "workspace.jump.2", title: "ワークスペース 2 へ", category: "Workspace", defaultShortcut: "ctrl+2" },
  { action: "workspace.jump.3", title: "ワークスペース 3 へ", category: "Workspace", defaultShortcut: "ctrl+3" },
  { action: "workspace.jump.4", title: "ワークスペース 4 へ", category: "Workspace", defaultShortcut: "ctrl+4" },
  { action: "workspace.jump.5", title: "ワークスペース 5 へ", category: "Workspace", defaultShortcut: "ctrl+5" },
  { action: "workspace.jump.6", title: "ワークスペース 6 へ", category: "Workspace", defaultShortcut: "ctrl+6" },
  { action: "workspace.jump.7", title: "ワークスペース 7 へ", category: "Workspace", defaultShortcut: "ctrl+7" },
  { action: "workspace.jump.8", title: "ワークスペース 8 へ", category: "Workspace", defaultShortcut: "ctrl+8" },
  { action: "workspace.jump.9", title: "最後のワークスペースへ", category: "Workspace", defaultShortcut: "ctrl+9" },

  { action: "pane.focus.left", title: "左のタブへ", category: "Pane", defaultShortcut: "ctrl+alt+arrowleft" },
  { action: "pane.focus.right", title: "右のタブへ", category: "Pane", defaultShortcut: "ctrl+alt+arrowright" },
  { action: "pane.focus.up", title: "上のタブへ", category: "Pane", defaultShortcut: "ctrl+alt+arrowup" },
  { action: "pane.focus.down", title: "下のタブへ", category: "Pane", defaultShortcut: "ctrl+alt+arrowdown" },
  // ⌥⌘D is the system shortcut for hiding the Dock, so macOS never lets the
  // split shortcuts through. Drop Option there and split on ⌘D / ⇧⌘D.
  { action: "pane.split.right", title: "タブを右に分割", category: "Pane", defaultShortcut: "ctrl+alt+d", macDefaultShortcut: "meta+d" },
  { action: "pane.split.down", title: "タブを下に分割", category: "Pane", defaultShortcut: "ctrl+alt+shift+d", macDefaultShortcut: "meta+shift+d" },
  { action: "pane.close", title: "アクティブなタブを閉じる", category: "Pane", defaultShortcut: "ctrl+alt+w" },
  { action: "pane.reopen", title: "閉じたペインを開き直す", category: "Pane", defaultShortcut: "ctrl+shift+t" },
  { action: "pane.zoom.toggle", title: "タブの最大化を切り替え", category: "Pane", defaultShortcut: "ctrl+shift+enter" },
  { action: "pane.tab.next", title: "タブ内の次のペイン", category: "Pane", defaultShortcut: "ctrl+alt+pagedown" },
  { action: "pane.tab.prev", title: "タブ内の前のペイン", category: "Pane", defaultShortcut: "ctrl+alt+pageup" },
  { action: "pane.attention.next", title: "次の要対応へ", category: "Pane", defaultShortcut: "ctrl+alt+a" },
  { action: "pane.tab.pin.toggle", title: "アクティブペインを固定", category: "Pane", defaultShortcut: "ctrl+alt+p" },

  { action: "terminal.search", title: "端末内を検索", category: "Terminal", defaultShortcut: "ctrl+shift+f" },
  // Not ctrl+shift+i: that is the WebView's own DevTools shortcut.
  { action: "composer.focus", title: "ペインの入力欄へ移動", category: "Terminal", defaultShortcut: "ctrl+alt+i" },

];

const MOD_ORDER = ["ctrl", "alt", "shift", "meta"];

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

/** The shipped binding for an action on this platform, normalized. */
export function defaultShortcutFor(def: KeybindingDefinition, isMac: boolean = IS_MAC): string {
  return normalizeShortcut(isMac && def.macDefaultShortcut ? def.macDefaultShortcut : def.defaultShortcut);
}

export const DEFAULT_KEYBINDINGS: Record<KeybindingActionId, string> = {
  ...KEYBINDING_DEFINITIONS.reduce(
    (acc, def) => {
      acc[def.action] = defaultShortcutFor(def);
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

/** `e.code` values that stand for a key our shortcut strings spell by name. */
const NAMED_EVENT_CODES: Record<string, string> = {
  ArrowLeft: "arrowleft",
  ArrowRight: "arrowright",
  ArrowUp: "arrowup",
  ArrowDown: "arrowdown",
  Backquote: "`",
  Backslash: "\\",
  Backspace: "backspace",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Delete: "delete",
  End: "end",
  Enter: "enter",
  Equal: "=",
  Escape: "escape",
  Home: "home",
  Insert: "insert",
  Minus: "-",
  NumpadEnter: "enter",
  PageDown: "pagedown",
  PageUp: "pageup",
  Period: ".",
  Quote: "'",
  Semicolon: ";",
  Slash: "/",
  Space: "space",
  Tab: "tab",
};

/**
 * The key a physical `e.code` stands for, or null when we cannot say.
 *
 * macOS rewrites `e.key` while Option is held — ⌥D arrives as "∂", ⌥I as
 * "Dead", ⌥A as "å" — so an Option binding can never be recognised from
 * `e.key`. The physical code survives Option untouched, which is why it is the
 * only readable source for those. It is a US-layout reading, so we only reach
 * for it where `e.key` has already stopped being usable.
 */
export function keyFromEventCode(code: string | undefined | null): string | null {
  if (!code) return null;
  const named = NAMED_EVENT_CODES[code];
  if (named) return named;
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1]!.toLowerCase();
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (digit) return digit[1]!;
  const fn = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code);
  if (fn) return `f${fn[1]}`;
  return null;
}

/**
 * Every normalized shortcut a key event could stand for, best reading first.
 *
 * There is more than one only on macOS with Option held, where `e.key` is a
 * composed glyph and `e.code` is the honest answer; we keep the `e.key`
 * reading behind it so a layout the code table cannot name still has a chance.
 */
export function shortcutCandidatesFromKeyboardEvent(
  e: KeyboardEvent,
  isMac: boolean = IS_MAC,
): string[] {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("ctrl");
  if (e.altKey) mods.push("alt");
  if (e.shiftKey) mods.push("shift");
  if (e.metaKey) mods.push("meta");
  const key = normalizeKey(e.key);
  const isModifierOnly = ["control", "alt", "shift", "meta"].includes(key);
  if (isModifierOnly) return [normalizeShortcut(mods.join("+"))];

  const fromKey = normalizeShortcut([...mods, key].join("+"));
  if (!isMac || !e.altKey) return [fromKey];
  const fromCode = keyFromEventCode(e.code);
  if (!fromCode || fromCode === key) return [fromKey];
  return [normalizeShortcut([...mods, fromCode].join("+")), fromKey];
}

export function shortcutFromKeyboardEvent(e: KeyboardEvent): string {
  return shortcutCandidatesFromKeyboardEvent(e)[0]!;
}

/**
 * The same shortcut with ctrl and meta traded, re-normalized.
 *
 * Re-normalizing is the point: the modifier order is ctrl, alt, shift, meta, so
 * `ctrl+shift+n` has to come back as `shift+meta+n` rather than `meta+shift+n`.
 * Comparing the two strings any other way — by prefix, by substring — lines up
 * only for the single-modifier bindings and quietly drops the rest.
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
 * The keys a binding actually answers to on this platform, normalized.
 *
 * Bindings are authored Windows-first as `ctrl+...`, and on macOS the key a
 * user reaches for is Command. The trade has to be exclusive, not additive:
 * the physical Control key belongs to the shell there (⌃C, ⌃P, ⌃W, ⌃V), so an
 * app that also answers to Control eats the terminal's own keys.
 *
 * Two things stay as written. A binding whose key is Tab keeps Control,
 * because ⌘⇥ never reaches an app — macOS switches applications with it. And a
 * binding spelled with `meta` was asked for as Command on purpose, whether it
 * is a macOS default or something the user typed into the shortcut list.
 */
export function effectiveShortcut(shortcut: string, isMac: boolean = IS_MAC): string {
  const normalized = normalizeShortcut(shortcut);
  if (!isMac || !normalized) return normalized;
  const parts = normalized.split("+");
  if (parts[parts.length - 1] === "tab") return normalized;
  if (!parts.includes("ctrl") || parts.includes("meta")) return normalized;
  return swapCtrlMeta(normalized);
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
  return effectiveShortcut(normalized, isMac) === eventShortcut;
}

export function eventMatchesShortcut(e: KeyboardEvent, shortcut?: string): boolean {
  if (!shortcut) return false;
  const candidates = shortcutCandidatesFromKeyboardEvent(e, IS_MAC);
  return candidates.some((candidate) => shortcutMatchesEvent(normalizeShortcut(shortcut), candidate, IS_MAC));
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
 * The label is built from `effectiveShortcut`, so what it prints is the key
 * that actually fires: ⌘ for a `ctrl+...` default, and ⌃ for the two Tab
 * bindings that keep the physical Control key. Printing "Ctrl+Shift+N" next to
 * a shortcut that answers to ⌘⇧N is what made the shortcut list read as wrong,
 * and printing ⌘⇥ next to one that only answers to ⌃⇥ is the same mistake.
 */
export function formatMacShortcutLabel(shortcut: string): string {
  const parts = effectiveShortcut(shortcut, true).split("+").filter(Boolean);
  let control = false;
  let command = false;
  let option = false;
  let shift = false;
  let key = "";
  for (const part of parts) {
    if (part === "ctrl") {
      control = true;
      continue;
    }
    if (part === "meta") {
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
  const glyphs = `${control ? "⌃" : ""}${option ? "⌥" : ""}${shift ? "⇧" : ""}${command ? "⌘" : ""}`;
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
