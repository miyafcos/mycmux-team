import { create } from "zustand";
import {
  DEFAULT_KEYBINDINGS,
  KEYBINDING_DEFINITIONS,
  normalizeShortcut,
  shortcutFromKeyboardEvent,
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

function toLookup(map: KeybindingsMap): Record<string, KeybindingActionId[]> {
  const lookup: Record<string, KeybindingActionId[]> = {};
  for (const def of KEYBINDING_DEFINITIONS) {
    const shortcut = normalizeShortcut(map[def.action]);
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

  getActionsForShortcut: (shortcut) => get().lookup[normalizeShortcut(shortcut)] ?? [],
  getActionsForEvent: (event) => {
    const shortcut = shortcutFromKeyboardEvent(event);
    return get().lookup[shortcut] ?? [];
  },
  getShortcutForAction: (action) => get().keybindings[action],
  getConflicts: () => getConflictsFromLookup(get().lookup),
}));
