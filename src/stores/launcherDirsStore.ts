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
  launcherDirsScanNow,
  launcherDirsUpsertRule,
  launcherDirsDeleteRule,
  launcherDirsSetRuleEnabled,
  launcherDirsSetRuleMode,
  launcherDirsRegisterCandidate,
  type LauncherDirsView,
} from "../lib/ipc";

interface LauncherDirsState {
  view: LauncherDirsView | null;
  loading: boolean;
  scanning: boolean;
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
  scanNow: () => Promise<boolean>;
  upsertRule: (rule: unknown) => Promise<boolean>;
  deleteRule: (id: string) => Promise<boolean>;
  setRuleEnabled: (id: string, enabled: boolean) => Promise<boolean>;
  setRuleMode: (id: string, mode: "auto" | "suggest") => Promise<boolean>;
  registerCandidate: (sectionId: string, path: string) => Promise<boolean>;
}

export const useLauncherDirsStore = create<LauncherDirsState>((set) => {
  // Reads and writes share a queue: an event reload or another mounted pane
  // must not let a delayed snapshot replace a newer edit in this window.
  let queue: Promise<unknown> = Promise.resolve();
  let pending = 0;
  let scanPending: Promise<boolean> | null = null;
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
    scanning: false,
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
    scanNow: () => {
      if (scanPending) return scanPending;
      set({ scanning: true });
      scanPending = run(launcherDirsScanNow).finally(() => {
        scanPending = null;
        set({ scanning: false });
      });
      return scanPending;
    },
    upsertRule: (rule) => run(() => launcherDirsUpsertRule(rule)),
    deleteRule: (id) => run(() => launcherDirsDeleteRule(id)),
    setRuleEnabled: (id, enabled) => run(() => launcherDirsSetRuleEnabled(id, enabled)),
    setRuleMode: (id, mode) => run(() => launcherDirsSetRuleMode(id, mode)),
    registerCandidate: (sectionId, path) => run(() => launcherDirsRegisterCandidate(sectionId, path)),
  };
});

// One listener per module/window, shared by every pane and the settings tab.
const subscription = listen<void>("launcher-dirs://changed", () => {
  void useLauncherDirsStore.getState().load();
}).catch(() => undefined);

if (import.meta.hot) {
  import.meta.hot.dispose(() => { void subscription.then((unlisten) => unlisten?.()); });
}
