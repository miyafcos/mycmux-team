import { create } from "zustand";
import {
  captureCliAccount,
  listCliAccounts,
  removeCliAccount,
  renameCliAccount,
  resolveCliAccountOrphan,
  switchCliAccount,
  type CliAccountActivePointers,
  type CliAccountProfile,
  type CliAccountsSnapshot,
  type CliLiveLogin,
  type CliOrphanAction,
  type CliOrphanSnapshot,
  type CliProvider,
  type CliSwitchResult,
} from "../lib/ipc";
import { cliAccountMessage } from "../lib/cliAccounts";
import { useToastStore } from "./toastStore";
import { useUsageStore } from "./usageStore";

type BusyByProvider = Record<CliProvider, string | null>;

export interface CliAccountStoreState {
  profiles: CliAccountProfile[];
  live: CliLiveLogin[];
  active: CliAccountActivePointers;
  orphans: CliOrphanSnapshot[];
  backupRoot: string | null;
  fetchError: string | null;
  operationError: string | null;
  loading: boolean;
  busyByProvider: BusyByProvider;
  lastSwitchResult: CliSwitchResult | null;
  fetch(): Promise<void>;
  capture(provider: CliProvider, label?: string): Promise<CliAccountProfile | null>;
  switchTo(provider: CliProvider, profileId: string): Promise<CliSwitchResult | null>;
  remove(provider: CliProvider, profileId: string): Promise<boolean>;
  rename(provider: CliProvider, profileId: string, label: string): Promise<boolean>;
  resolveOrphan(orphan: CliOrphanSnapshot, action: CliOrphanAction, label?: string): Promise<boolean>;
  dismissOperationError(): void;
  dismissSwitchWarnings(): void;
}

const EMPTY_ACTIVE: CliAccountActivePointers = { claude: null, codex: null };
const EMPTY_BUSY: BusyByProvider = { claude: null, codex: null };

let fetchSeq = 0;
let mutationTail: Promise<void> = Promise.resolve();

function enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationTail.then(operation, operation);
  mutationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export const useCliAccountStore = create<CliAccountStoreState>((set, get) => {
  const setBusy = (provider: CliProvider, value: string | null) => {
    set((state) => ({ busyByProvider: { ...state.busyByProvider, [provider]: value } }));
  };

  return {
    profiles: [],
    live: [],
    active: EMPTY_ACTIVE,
    orphans: [],
    backupRoot: null,
    fetchError: null,
    operationError: null,
    loading: false,
    busyByProvider: EMPTY_BUSY,
    lastSwitchResult: null,

    fetch: async () => {
      const sequence = ++fetchSeq;
      set({ loading: true });
      try {
        const snapshot: CliAccountsSnapshot = await listCliAccounts();
        if (sequence === fetchSeq) {
          set({
            profiles: snapshot.profiles,
            live: snapshot.live,
            active: snapshot.active,
            orphans: snapshot.orphans,
            backupRoot: snapshot.backup_root,
            fetchError: null,
            loading: false,
          });
        }
      } catch (error) {
        if (sequence === fetchSeq) {
          set({ fetchError: cliAccountMessage(error), loading: false });
        }
      }
    },

    capture: async (provider, label) => {
      if (get().busyByProvider[provider] !== null) return null;
      setBusy(provider, `capture:${provider}`);
      try {
        const profile = await enqueueMutation(() => captureCliAccount(provider, label));
        await get().fetch();
        return profile;
      } catch (error) {
        set({ operationError: cliAccountMessage(error) });
        await get().fetch();
        return null;
      } finally {
        setBusy(provider, null);
      }
    },

    switchTo: async (provider, profileId) => {
      if (get().busyByProvider[provider] !== null) return null;
      setBusy(provider, profileId);
      try {
        const result = await enqueueMutation(() => switchCliAccount(provider, profileId));
        set({ lastSwitchResult: result });
        const identityMismatch = result.warnings.includes(
          "cli_account.warning.restored_identity_mismatch",
        );
        const metadataNotSaved = result.warnings.includes(
          "cli_account.warning.switch_metadata_not_saved",
        );
        useToastStore.getState().pushToast(
          identityMismatch
            ? `「${result.profile.label}」への切り替え処理は完了しましたが、ログインの一致を確認できません。警告とバックアップを確認してください。`
            : metadataNotSaved
              ? `「${result.profile.label}」のログイン情報は反映されましたが、選択履歴を保存できませんでした。警告とバックアップを確認してください。`
            : `「${result.profile.label}」に切り替えました。新しく起動するセッションから反映されます。`,
          identityMismatch || metadataNotSaved ? "warning" : "info",
        );
        await Promise.all([get().fetch(), useUsageStore.getState().fetch()]);
        return result;
      } catch (error) {
        set({ operationError: cliAccountMessage(error) });
        await get().fetch();
        return null;
      } finally {
        setBusy(provider, null);
      }
    },

    remove: async (provider, profileId) => {
      if (get().busyByProvider[provider] !== null) return false;
      setBusy(provider, profileId);
      try {
        await enqueueMutation(() => removeCliAccount(profileId));
        await get().fetch();
        return true;
      } catch (error) {
        set({ operationError: cliAccountMessage(error) });
        await get().fetch();
        return false;
      } finally {
        setBusy(provider, null);
      }
    },

    rename: async (provider, profileId, label) => {
      if (get().busyByProvider[provider] !== null) return false;
      setBusy(provider, profileId);
      try {
        await enqueueMutation(() => renameCliAccount(profileId, label));
        await get().fetch();
        return true;
      } catch (error) {
        set({ operationError: cliAccountMessage(error) });
        await get().fetch();
        return false;
      } finally {
        setBusy(provider, null);
      }
    },

    resolveOrphan: async (orphan, action, label) => {
      const provider = orphan.provider;
      if (!provider || get().busyByProvider[provider] !== null) return false;
      setBusy(provider, `orphan:${orphan.id}`);
      try {
        await enqueueMutation(() => resolveCliAccountOrphan(orphan.id, action, label));
        await get().fetch();
        return true;
      } catch (error) {
        set({ operationError: cliAccountMessage(error) });
        await get().fetch();
        return false;
      } finally {
        setBusy(provider, null);
      }
    },

    dismissOperationError: () => set({ operationError: null }),
    dismissSwitchWarnings: () =>
      set((state) => ({
        lastSwitchResult: state.lastSwitchResult
          ? { ...state.lastSwitchResult, warnings: [] }
          : null,
      })),
  };
});

export function __resetCliAccountStoreForTests(): void {
  fetchSeq = 0;
  mutationTail = Promise.resolve();
  useCliAccountStore.setState({
    profiles: [],
    live: [],
    active: EMPTY_ACTIVE,
    orphans: [],
    backupRoot: null,
    fetchError: null,
    operationError: null,
    loading: false,
    busyByProvider: EMPTY_BUSY,
    lastSwitchResult: null,
  });
}
