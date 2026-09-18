import { create } from "zustand";
import {
  DEFAULT_KEYBINDINGS,
  effectiveShortcut,
  KEYBINDING_DEFINITIONS,
  normalizeShortcut,
  shortcutCandidatesFromKeyboardEvent,
  type KeybindingActionId,
} from "../lib/keybindings";

export type KeybindingsMap = Record<KeybindingActionId, string>;
export interface KeybindingConflict {
  shortcut: string;
  actions: KeybindingActionId[];
}

function buildEffective(overrides: Partial<KeybindingsMap>): KeybindingsMap {
  return {
    ...DEFAULT_KEYBINDINGS,
    ...overrides,
  };
}

// Keyed by the shortcut the binding answers to on this platform, not by the
// shortcut it is written as. On macOS that is what turns a `ctrl+...` default
// into the ⌘ key the user presses, and it is also what keeps physical Control
// out of the lookup entirely so the shell still gets ⌃C, ⌃P and ⌃W.
function toLookup(map: KeybindingsMap): Record<string, KeybindingActionId[]> {
  const lookup: Record<string, KeybindingActionId[]> = {};
  for (const def of KEYBINDING_DEFINITIONS) {
    const shortcut = effectiveShortcut(map[def.action]);
    if (!shortcut) continue;
    if (!lookup[shortcut]) lookup[shortcut] = [];
    lookup[shortcut].push(def.action);
  }
  return lookup;
}

function getConflictsFromLookup(lookup: Record<string, KeybindingActionId[]>): KeybindingConflict[] {
  return Object.entries(lookup)
    .filter(([, actions]) => actions.length > 1)
    .map(([shortcut, actions]) => ({ shortcut, actions }));
}

interface KeybindingState {
  overrides: Partial<KeybindingsMap>;
  keybindings: KeybindingsMap;
  lookup: Record<string, KeybindingActionId[]>;
  setOverride: (action: KeybindingActionId, shortcut: string) => void;
  clearOverride: (action: KeybindingActionId) => void;
  resetAll: () => void;
  hydrateOverrides: (overrides: Partial<KeybindingsMap>) => void;
  getActionsForShortcut: (shortcut: string) => KeybindingActionId[];
  getActionsForEvent: (event: KeyboardEvent) => KeybindingActionId[];
  getShortcutForAction: (action: KeybindingActionId) => string;
  getConflicts: () => KeybindingConflict[];
}

export const useKeybindingStore = create<KeybindingState>((set, get) => ({
  overrides: {},
  keybindings: DEFAULT_KEYBINDINGS,
  lookup: toLookup(DEFAULT_KEYBINDINGS),

  setOverride: (action, shortcut) => {
    const normalized = normalizeShortcut(shortcut);
    const nextOverrides = {
      ...get().overrides,
      [action]: normalized,
    };
    const keybindings = buildEffective(nextOverrides);
    set({
      overrides: nextOverrides,
      keybindings,
      lookup: toLookup(keybindings),
    });
  },

  clearOverride: (action) => {
    const nextOverrides = { ...get().overrides };
    delete nextOverrides[action];
    const keybindings = buildEffective(nextOverrides);
    set({
      overrides: nextOverrides,
      keybindings,
      lookup: toLookup(keybindings),
    });
  },

  resetAll: () => {
    set({
      overrides: {},
      keybindings: DEFAULT_KEYBINDINGS,
      lookup: toLookup(DEFAULT_KEYBINDINGS),
    });
  },

  hydrateOverrides: (overrides) => {
    const normalizedOverrides: Partial<KeybindingsMap> = {};
    for (const def of KEYBINDING_DEFINITIONS) {
      const value = overrides[def.action];
      if (typeof value === "string" && value.trim()) {
        normalizedOverrides[def.action] = normalizeShortcut(value);
      }
    }
    const keybindings = buildEffective(normalizedOverrides);
    set({
      overrides: normalizedOverrides,
      keybindings,
      lookup: toLookup(keybindings),
    });
  },

  getActionsForShortcut: (shortcut) => get().lookup[effectiveShortcut(shortcut)] ?? [],
  getActionsForEvent: (event) => {
    const lookup = get().lookup;
    // More than one candidate only on macOS with Option held, where `e.key` is
    // a composed glyph ("∂", "Dead") and the physical `e.code` is the reading
    // that can still be matched.
    for (const shortcut of shortcutCandidatesFromKeyboardEvent(event)) {
      const actions = lookup[shortcut];
      if (actions?.length) return actions;
    }
    return [];
  },
  getShortcutForAction: (action) => get().keybindings[action],
  getConflicts: () => getConflictsFromLookup(get().lookup),
}));
