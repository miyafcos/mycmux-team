import { create } from "zustand";
import { persist } from "zustand/middleware";

interface SettingsState {
  notificationsEnabled: boolean;
  notificationSoundEnabled: boolean;
  setNotificationsEnabled: (v: boolean) => void;
  setNotificationSoundEnabled: (v: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      notificationsEnabled: true,
      notificationSoundEnabled: true,
      setNotificationsEnabled: (v) => set({ notificationsEnabled: v }),
      setNotificationSoundEnabled: (v) => set({ notificationSoundEnabled: v }),
    }),
    { name: "mycmux-lite-settings" },
  ),
);
