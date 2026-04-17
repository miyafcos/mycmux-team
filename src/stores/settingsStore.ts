import { create } from "zustand";
import { persist } from "zustand/middleware";

interface SettingsState {
  notificationsEnabled: boolean;
  notificationSoundEnabled: boolean;
  buddyEnabled: boolean;
  buddyCollapsed: boolean;
  setNotificationsEnabled: (v: boolean) => void;
  setNotificationSoundEnabled: (v: boolean) => void;
  setBuddyEnabled: (v: boolean) => void;
  setBuddyCollapsed: (v: boolean) => void;
  toggleBuddy: () => void;
  toggleBuddyCollapsed: () => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      notificationsEnabled: true,
      notificationSoundEnabled: true,
      buddyEnabled: true,
      buddyCollapsed: false,
      setNotificationsEnabled: (v) => set({ notificationsEnabled: v }),
      setNotificationSoundEnabled: (v) => set({ notificationSoundEnabled: v }),
      setBuddyEnabled: (v) => set({ buddyEnabled: v }),
      setBuddyCollapsed: (v) => set({ buddyCollapsed: v }),
      toggleBuddy: () => set((s) => ({ buddyEnabled: !s.buddyEnabled })),
      toggleBuddyCollapsed: () => set((s) => ({ buddyCollapsed: !s.buddyCollapsed })),
    }),
    { name: "mycmux-settings" },
  ),
);
