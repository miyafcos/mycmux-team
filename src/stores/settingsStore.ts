import { create } from "zustand";
import { persist } from "zustand/middleware";
import { invoke } from "@tauri-apps/api/core";

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
  hideSessionsWithoutUserMessages: boolean;
  setNotificationsEnabled: (v: boolean) => void;
  setNotificationSoundEnabled: (v: boolean) => void;
  setUseWebglRenderer: (v: boolean) => void;
  setCrsmShowClaude: (v: boolean) => void;
  setCrsmShowCodex: (v: boolean) => void;
  setCrsmShowClaudeCodex: (v: boolean) => void;
  setHideSessionsWithoutUserMessages: (v: boolean) => void;
}

function getDefaultUseWebglRenderer(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform =
    (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ||
    navigator.platform ||
    "";
  return /Mac/i.test(platform);
}

export function syncBuddyEnabledToBackend(enabled: boolean): void {
  void invoke("set_buddy_enabled", { enabled }).catch((error) => {
    console.warn("[settings] Failed to sync buddy enabled state:", error);
  });
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
      hideSessionsWithoutUserMessages: true,
      setNotificationsEnabled: (v) => set({ notificationsEnabled: v }),
      setNotificationSoundEnabled: (v) => set({ notificationSoundEnabled: v }),
      setUseWebglRenderer: (v) => set({ useWebglRenderer: v }),
      setCrsmShowClaude: (v) => set({ crsmShowClaude: v }),
      setCrsmShowCodex: (v) => set({ crsmShowCodex: v }),
      setCrsmShowClaudeCodex: (v) => set({ crsmShowClaudeCodex: v }),
      setHideSessionsWithoutUserMessages: (v) => set({ hideSessionsWithoutUserMessages: v }),
    }),
    { name: "mycmux-settings" },
  ),
);
