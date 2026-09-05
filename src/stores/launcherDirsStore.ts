import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import {
  launcherDirsGet,
  launcherDirsSetSectionLabel,
  launcherDirsAddEntry,
  launcherDirsUpdateEntry,
  launcherDirsRemoveEntry,
  launcherDirsMoveEntry,
  launcherDirsPinEntry,
  launcherDirsIgnorePath,
  launcherDirsUnignorePath,
  launcherDirsExportRoots,
  type LauncherDirsView,
} from "../lib/ipc";

interface LauncherDirsState {
  view: LauncherDirsView | null;
  loading: boolean;
  error: string | null;
  load: () => Promise<boolean>;
  setSectionLabel: (sectionId: string, label: string) => Promise<boolean>;
  addEntry: (sectionId: string, path: string, label?: string) => Promise<boolean>;
  updateEntry: (id: string, label: string) => Promise<boolean>;
  removeEntry: (id: string) => Promise<boolean>;
  moveEntry: (id: string, direction: "up" | "down") => Promise<boolean>;
  pinEntry: (id: string) => Promise<boolean>;
  ignorePath: (path: string) => Promise<boolean>;
  unignorePath: (path: string) => Promise<boolean>;
  exportRoots: () => Promise<boolean>;
}

export const useLauncherDirsStore = create<LauncherDirsState>((set) => {
  // Reads and writes share a queue: an event reload or another mounted pane
  // must not let a delayed snapshot replace a newer edit in this window.
  let queue: Promise<unknown> = Promise.resolve();
  let pending = 0;
  const run = (operation: () => Promise<LauncherDirsView>, clearError = true): Promise<boolean> => {
    pending += 1;
    set({ loading: true });
    const result = queue.then(async () => {
      if (clearError) set({ error: null });
      try {
        const view = await operation();
        set({ view });
        return true;
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error) });
        return false;
      } finally {
        pending -= 1;
        set({ loading: pending > 0 });
      }
    });
    queue = result;
    return result;
  };

  return {
    view: null,
    loading: false,
    error: null,
    load: () => run(launcherDirsGet, false),
    setSectionLabel: (sectionId, label) => run(() => launcherDirsSetSectionLabel(sectionId, label)),
    addEntry: (sectionId, path, label) => run(() => launcherDirsAddEntry(sectionId, path, label)),
    updateEntry: (id, label) => run(() => launcherDirsUpdateEntry(id, label)),
    removeEntry: (id) => run(() => launcherDirsRemoveEntry(id)),
    moveEntry: (id, direction) => run(() => launcherDirsMoveEntry(id, direction)),
    pinEntry: (id) => run(() => launcherDirsPinEntry(id)),
    ignorePath: (path) => run(() => launcherDirsIgnorePath(path)),
    unignorePath: (path) => run(() => launcherDirsUnignorePath(path)),
    exportRoots: () => run(launcherDirsExportRoots),
  };
});

// One listener per module/window, shared by every pane and the settings tab.
const subscription = listen<void>("launcher-dirs://changed", () => {
  void useLauncherDirsStore.getState().load();
}).catch(() => undefined);

if (import.meta.hot) {
  import.meta.hot.dispose(() => { void subscription.then((unlisten) => unlisten?.()); });
}
