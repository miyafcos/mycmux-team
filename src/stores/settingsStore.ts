import { create } from "zustand";
import { persist } from "zustand/middleware";

interface SettingsState {
  notificationSoundEnabled: boolean;
  setNotificationSoundEnabled: (v: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      notificationSoundEnabled: true,
      setNotificationSoundEnabled: (v) => set({ notificationSoundEnabled: v }),
    }),
    { name: "mycmux-settings" },
  ),
);
