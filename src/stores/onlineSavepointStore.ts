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
  refresh: () => Promise<void>;
}

let refreshInFlight = false;

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
  refresh: async () => {
    if (refreshInFlight) return;
    refreshInFlight = true;
    try {
      const entries = await listOnlineSavepoints();
      get().setFromEntries(entries);
    } catch (e) {
      console.warn("[mycmux] failed to refresh online savepoint index", e);
    } finally {
      refreshInFlight = false;
    }
  },
}));
