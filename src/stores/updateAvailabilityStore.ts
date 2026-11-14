import { create } from "zustand";

export interface UpdateAvailability {
  state: "none" | "available" | "installing" | "error";
  version: string;
  currentVersion: string;
  message: string;
}

// Only display data belongs here; the updater resource stays in its module.
export const useUpdateAvailabilityStore = create<UpdateAvailability>(() => ({
  state: "none",
  version: "",
  currentVersion: "",
  message: "",
}));
