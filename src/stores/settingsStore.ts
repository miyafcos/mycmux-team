import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  migratePersistedSettings,
  resolveDefaultTerminalRenderer,
  SETTINGS_STORE_VERSION,
  type TerminalRenderer,
} from "./settingsMigration";

interface SettingsState {
  notificationsEnabled: boolean;
  notificationSoundEnabled: boolean;
  terminalRenderer: TerminalRenderer;
  // CRSM Palette per-kind visibility (Ctrl+P session list).
  // When false the corresponding kind disappears from both the palette
  // list and the filter chips. Defaults true so existing users see no
  // change after upgrade.
  crsmShowClaude: boolean;
  crsmShowCodex: boolean;
  crsmShowClaudeCodex: boolean;
  hideSessionsWithoutUserMessages: boolean;
  // Pane tab bar "Split down" (add a row) button. Defaults false —
  // column splits are the common flow and the row-split button was
  // mostly a misclick target.
  showSplitDownButton: boolean;
  // Pane tab bar "Split right" (add a column) button. Defaults true —
  // column splits are the primary flow, but the button is toggleable
  // for symmetry with the split-down button.
  showSplitRightButton: boolean;
  setNotificationsEnabled: (v: boolean) => void;
  setNotificationSoundEnabled: (v: boolean) => void;
  setTerminalRenderer: (v: TerminalRenderer) => void;
  setCrsmShowClaude: (v: boolean) => void;
  setCrsmShowCodex: (v: boolean) => void;
  setCrsmShowClaudeCodex: (v: boolean) => void;
  setHideSessionsWithoutUserMessages: (v: boolean) => void;
  setShowSplitDownButton: (v: boolean) => void;
  setShowSplitRightButton: (v: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      notificationsEnabled: true,
      notificationSoundEnabled: true,
      terminalRenderer: resolveDefaultTerminalRenderer(),
      crsmShowClaude: true,
      crsmShowCodex: true,
      crsmShowClaudeCodex: true,
      hideSessionsWithoutUserMessages: true,
      showSplitDownButton: false,
      showSplitRightButton: true,
      setNotificationsEnabled: (v) => set({ notificationsEnabled: v }),
      setNotificationSoundEnabled: (v) => set({ notificationSoundEnabled: v }),
      setTerminalRenderer: (v) => set({ terminalRenderer: v }),
      setCrsmShowClaude: (v) => set({ crsmShowClaude: v }),
      setCrsmShowCodex: (v) => set({ crsmShowCodex: v }),
      setCrsmShowClaudeCodex: (v) => set({ crsmShowClaudeCodex: v }),
      setHideSessionsWithoutUserMessages: (v) => set({ hideSessionsWithoutUserMessages: v }),
      setShowSplitDownButton: (v) => set({ showSplitDownButton: v }),
      setShowSplitRightButton: (v) => set({ showSplitRightButton: v }),
    }),
    {
      name: "mycmux-settings",
      version: SETTINGS_STORE_VERSION,
      migrate: (persistedState, persistedVersion) => (
        migratePersistedSettings(persistedState, persistedVersion) as SettingsState
      ),
    },
  ),
);
