import { create } from "zustand";
import { persist } from "zustand/middleware";

interface SettingsState {
  notificationsEnabled: boolean;
  notificationSoundEnabled: boolean;
  useWebglRenderer: boolean;
  // CRSM Palette per-kind visibility (Ctrl+P session list).
  // When false the corresponding kind disappears from both the palette
  // list and the filter chips. Defaults true so existing users see no
  // change after upgrade.
  crsmShowClaude: boolean;
  crsmShowCodex: boolean;
  crsmShowClaudeCodex: boolean;
  setNotificationsEnabled: (v: boolean) => void;
  setNotificationSoundEnabled: (v: boolean) => void;
  setUseWebglRenderer: (v: boolean) => void;
  setCrsmShowClaude: (v: boolean) => void;
  setCrsmShowCodex: (v: boolean) => void;
  setCrsmShowClaudeCodex: (v: boolean) => void;
}

function getDefaultUseWebglRenderer(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform =
    (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ||
    navigator.platform ||
    "";
  return /Mac/i.test(platform);
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      notificationsEnabled: true,
      notificationSoundEnabled: true,
      useWebglRenderer: getDefaultUseWebglRenderer(),
      crsmShowClaude: true,
      crsmShowCodex: true,
      crsmShowClaudeCodex: true,
      setNotificationsEnabled: (v) => set({ notificationsEnabled: v }),
      setNotificationSoundEnabled: (v) => set({ notificationSoundEnabled: v }),
      setUseWebglRenderer: (v) => set({ useWebglRenderer: v }),
      setCrsmShowClaude: (v) => set({ crsmShowClaude: v }),
      setCrsmShowCodex: (v) => set({ crsmShowCodex: v }),
      setCrsmShowClaudeCodex: (v) => set({ crsmShowClaudeCodex: v }),
    }),
    { name: "mycmux-lite-settings" },
  ),
);
