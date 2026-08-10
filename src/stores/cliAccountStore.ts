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
import {
  SWITCH_REVERT_CHECK_MS,
  switchRevertMessage,
  switchWasReverted,
} from "../lib/switchRevertWatch";
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
  /**
   * Reserve a provider for an isolated CLI login. Logins can take minutes, so
   * they must not go through `enqueueMutation` — that queue would block every
   * switch and capture for the whole wait. They borrow `busyByProvider`
   * instead, which is what actually excludes concurrent work per provider.
   */
  setLoginBusy(provider: CliProvider, key: string | null): void;
  dismissOperationError(): void;
  dismissSwitchWarnings(): void;
}

const EMPTY_ACTIVE: CliAccountActivePointers = { claude: null, codex: null };
const EMPTY_BUSY: BusyByProvider = { claude: null, codex: null };

let fetchSeq = 0;
let mutationTail: Promise<void> = Promise.resolve();

/** Bumped by every switch so a pending revert check for an older one is dropped. */
let switchSeq = 0;

/**
 * Verify once, a few seconds later, that the switch is still in effect.
 *
 * A session still running under the previous account rewrites the credential
 * file on its next token refresh, which silently undoes the switch. Nothing in
 * the switch path can prevent that, so the least the app can do is say so
 * instead of leaving the user to discover it from a failing agent.
 */
function scheduleSwitchRevertCheck(
  get: () => CliAccountStoreState,
  provider: CliProvider,
  targetIdentityKey: string | null | undefined,
  label: string,
): void {
  if (!targetIdentityKey) return;
  const sequence = ++switchSeq;
  setTimeout(() => {
    if (sequence !== switchSeq) return;
    void get()
      .fetch()
      .then(() => {
        if (sequence !== switchSeq) return;
        if (switchWasReverted(provider, targetIdentityKey, get().live)) {
          useToastStore.getState().pushToast(switchRevertMessage(label), "warning");
        }
      });
  }, SWITCH_REVERT_CHECK_MS);
}

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
        // Refresh usage too: a capture retitles the row (live:* -> profile id),
        // and leaving the usage list on the old ids for up to one poll interval
        // reads as the panel "losing" the account it just registered.
        await Promise.all([get().fetch(), useUsageStore.getState().fetch()]);
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
        scheduleSwitchRevertCheck(get, provider, result.profile.identity_key, result.profile.label);
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

    setLoginBusy: (provider, key) => setBusy(provider, key),

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
