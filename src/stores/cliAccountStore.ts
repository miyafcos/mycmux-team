import { create } from "zustand";
import {
  captureCliAccount,
  listCliAccounts,
  removeCliAccount,
  renameCliAccount,
  switchCliAccount,
  type CliAccountProfile,
  type CliAccountsSnapshot,
  type CliLiveLogin,
  type CliProvider,
  type CliSwitchResult,
} from "../lib/ipc";
import { useUsageStore } from "./usageStore";

export interface CliAccountStoreState {
  profiles: CliAccountProfile[];
  live: CliLiveLogin[];
  lastError: string | null;
  loading: boolean;
  busyProfileId: string | null;
  lastSwitchResult: CliSwitchResult | null;
  fetch(): Promise<void>;
  capture(provider: CliProvider, label?: string): Promise<CliAccountProfile | null>;
  switchTo(provider: CliProvider, profileId: string): Promise<CliSwitchResult | null>;
  remove(profileId: string): Promise<boolean>;
  rename(profileId: string, label: string): Promise<boolean>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let fetchSeq = 0;

export const useCliAccountStore = create<CliAccountStoreState>((set, get) => ({
  profiles: [],
  live: [],
  lastError: null,
  loading: false,
  busyProfileId: null,
  lastSwitchResult: null,

  fetch: async () => {
    const sequence = ++fetchSeq;
    set({ loading: true });
    try {
      const snapshot: CliAccountsSnapshot = await listCliAccounts();
      if (sequence === fetchSeq) {
        set({ profiles: snapshot.profiles, live: snapshot.live, lastError: null, loading: false });
      }
    } catch (error) {
      if (sequence === fetchSeq) {
        set({ lastError: errorMessage(error), loading: false });
      }
    }
  },

  capture: async (provider, label) => {
    const busyProfileId = `capture:${provider}`;
    if (get().busyProfileId !== null) return null;
    set({ busyProfileId, lastError: null });
    try {
      const profile = await captureCliAccount(provider, label);
      await get().fetch();
      return profile;
    } catch (error) {
      set({ lastError: errorMessage(error) });
      return null;
    } finally {
      set({ busyProfileId: null });
    }
  },

  switchTo: async (provider, profileId) => {
    if (get().busyProfileId !== null) return null;
    set({ busyProfileId: profileId, lastError: null });
    try {
      const result = await switchCliAccount(provider, profileId);
      set({ lastSwitchResult: result });
      await Promise.all([get().fetch(), useUsageStore.getState().fetch()]);
      return result;
    } catch (error) {
      set({ lastError: errorMessage(error) });
      return null;
    } finally {
      set({ busyProfileId: null });
    }
  },

  remove: async (profileId) => {
    if (get().busyProfileId !== null) return false;
    set({ busyProfileId: profileId, lastError: null });
    try {
      await removeCliAccount(profileId);
      await get().fetch();
      return true;
    } catch (error) {
      set({ lastError: errorMessage(error) });
      return false;
    } finally {
      set({ busyProfileId: null });
    }
  },

  rename: async (profileId, label) => {
    if (get().busyProfileId !== null) return false;
    set({ busyProfileId: profileId, lastError: null });
    try {
      await renameCliAccount(profileId, label);
      await get().fetch();
      return true;
    } catch (error) {
      set({ lastError: errorMessage(error) });
      return false;
    } finally {
      set({ busyProfileId: null });
    }
  },
}));

export function __resetCliAccountStoreForTests(): void {
  fetchSeq = 0;
  useCliAccountStore.setState({
    profiles: [],
    live: [],
    lastError: null,
    loading: false,
    busyProfileId: null,
    lastSwitchResult: null,
  });
}
