import { create } from "zustand";
import {
  isCurrentSavepoint,
  isTrashedSavepoint,
  savepointEntryIdentityKey,
  type OnlineSavepointEntry,
} from "../components/online/onlineSavepoints";
import { listOnlineSavepoints } from "../lib/ipc";

interface OnlineSavepointState {
  publishedSessionIds: Record<string, true>;
  setFromEntries: (entries: OnlineSavepointEntry[]) => void;
  /** Resolves with the active savepoints, or null when the read failed. */
  refresh: () => Promise<OnlineSavepointEntry[] | null>;
}

// Callers that ask while a read is already running share its result instead of
// firing a second IPC round-trip. App startup and an open OnlinePanel both ask
// on mount, and they used to list the same directory twice.
let refreshInFlight: Promise<OnlineSavepointEntry[] | null> | null = null;

export const useOnlineSavepointStore = create<OnlineSavepointState>((set, get) => ({
  publishedSessionIds: {},
  setFromEntries: (entries) => {
    const publishedSessionIds: Record<string, true> = {};
    for (const entry of entries) {
      if (!isCurrentSavepoint(entry) || isTrashedSavepoint(entry)) continue;
      publishedSessionIds[savepointEntryIdentityKey(entry)] = true;
    }
    set({ publishedSessionIds });
  },
  refresh: () => {
    if (refreshInFlight) return refreshInFlight;
    const pending = (async () => {
      try {
        const entries = await listOnlineSavepoints();
        get().setFromEntries(entries);
        return entries;
      } catch (e) {
        console.warn("[mycmux] failed to refresh online savepoint index", e);
        return null;
      } finally {
        refreshInFlight = null;
      }
    })();
    refreshInFlight = pending;
    return pending;
  },
}));
