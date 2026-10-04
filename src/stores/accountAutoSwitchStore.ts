import { create } from "zustand";
import { applyAutomaticStoreUpdate, syncedPersist } from "./syncedPersist";
import type { CliProvider } from "../lib/ipc";
import { AUTO_SWITCH_COOLDOWN_MS, chooseAutoSwitch } from "../lib/accountAutoSwitch";
import { PROVIDER_ORDER, PROVIDER_TITLE } from "../lib/cliAccounts";
import { useCliAccountStore } from "./cliAccountStore";
import { useUsageStore } from "./usageStore";
import { useToastStore } from "./toastStore";

type Attempt = { source: string; target: string; at: number };
interface AutoSwitchState {
  enabled: Record<CliProvider, boolean>;
  /**
   * Profiles the user took out of the running as switch targets. Stored as the
   * exclusions so an account registered later starts out as a candidate, which
   * is how every registered account behaved before the choice existed.
   */
  excludedTargets: Record<CliProvider, string[]>;
  attempts: Partial<Record<CliProvider, Attempt>>;
  status: Partial<Record<CliProvider, string>>;
  setEnabled(provider: CliProvider, enabled: boolean): void;
  setTargetIncluded(provider: CliProvider, profileId: string, included: boolean): void;
  evaluate(): Promise<void>;
}
const running = new Set<CliProvider>();
// Evaluations asked for while the provider's own one was still running, e.g.
// a candidate unticked while its switch waited in the queue. Replayed when the
// run ends; otherwise the next candidate would wait for the next poll.
const rerun = new Set<CliProvider>();

/** Tolerates a state saved before the field existed, or edited by hand. */
export function excludedTargetsFor(state: Pick<AutoSwitchState, "excludedTargets">, provider: CliProvider): string[] {
  const list = state.excludedTargets?.[provider];
  return Array.isArray(list) ? list.filter((id): id is string => typeof id === "string") : [];
}

export const useAccountAutoSwitchStore = create<AutoSwitchState>()(syncedPersist((set, get, api) => ({
  enabled: { claude: false, codex: false, grok: false },
  excludedTargets: { claude: [], codex: [], grok: [] },
  attempts: {},
  status: {},
  setEnabled: (provider, enabled) => set((state) => ({
    enabled: { ...state.enabled, [provider]: enabled },
    status: { ...state.status, [provider]: enabled ? "監視しています" : "オフ" },
  })),
  setTargetIncluded: (provider, profileId, included) => set((state) => {
    const current = excludedTargetsFor(state, provider);
    const next = included
      ? current.filter((id) => id !== profileId)
      : current.includes(profileId) ? current : [...current, profileId];
    return { excludedTargets: { ...state.excludedTargets, [provider]: next } };
  }),
  evaluate: async () => {
    for (const provider of PROVIDER_ORDER) {
      if (get().enabled[provider] !== true) continue;
      if (running.has(provider)) {
        rerun.add(provider);
        continue;
      }
      const decision = () => {
        const cli = useCliAccountStore.getState();
        const usage = useUsageStore.getState();
        if (get().enabled[provider] !== true || cli.loading || cli.fetchError || usage.lastError
          || cli.busyByProvider[provider] !== null) return null;
        return chooseAutoSwitch(provider, usage.accounts, cli.profiles, cli.live, Date.now(),
          excludedTargetsFor(get(), provider));
      };
      const planned = decision();
      if (!planned) continue;
      const previous = get().attempts[provider];
      // Persist the cooldown across app restarts and opt-out/opt-in cycles.
      if (previous && Date.now() - previous.at < AUTO_SWITCH_COOLDOWN_MS) continue;
      const report = (message: string, warning = false) => {
        if (get().status[provider] === message) return;
        applyAutomaticStoreUpdate(api, (state) => ({ status: { ...state.status, [provider]: message } }));
        useToastStore.getState().pushToast(`${PROVIDER_TITLE[provider]}: ${message}`, warning ? "warning" : "info");
      };
      if (previous?.source === planned.source.profile_id) {
        applyAutomaticStoreUpdate(api, (state) => ({ enabled: { ...state.enabled, [provider]: false } }));
        report("切り替えたあとも同じアカウントが上限のままでした。自動切り替えをオフにします。", true);
        continue;
      }
      if (!planned.target) {
        report("上限に達しましたが、切り替え先の候補に空きのあるアカウントがありません。", true);
        continue;
      }
      running.add(provider);
      try {
        // Refresh the live identity before touching the shared CLI login.
        await useCliAccountStore.getState().fetch();
        const current = decision();
        if (!current?.target || current.source.profile_id !== planned.source.profile_id) continue;
        const target = current.target;
        let started = false;
        const result = await useCliAccountStore.getState().switchTo(provider, target.id, () => {
          // This guard runs inside the existing mutation queue, immediately before IPC.
          const cli = useCliAccountStore.getState();
          const usage = useUsageStore.getState();
          if (get().enabled[provider] !== true || cli.fetchError || usage.lastError) return false;
          // Re-reads the picks too: unticking the target while the switch waits cancels it.
          const latest = chooseAutoSwitch(provider, usage.accounts, cli.profiles, cli.live, Date.now(),
            excludedTargetsFor(get(), provider));
          if (latest?.source.profile_id !== current.source.profile_id || latest.target?.id !== target.id) return false;
          // Recorded before the IPC call so an interrupted switch still counts as
          // an attempt; a finished one restamps it. Time queued never counts.
          applyAutomaticStoreUpdate(api, (state) => ({ attempts: { ...state.attempts, [provider]: {
            source: current.source.profile_id, target: target.id, at: Date.now(),
          } } }));
          started = true;
          return true;
        });
        if (!get().enabled[provider]) continue;
        if (!result) {
          // Cancelled in the queue before it started: nothing failed.
          if (!started) continue;
          applyAutomaticStoreUpdate(api, (state) => ({ enabled: { ...state.enabled, [provider]: false } }));
          report("アカウントの切り替えに失敗しました。自動切り替えをオフにします。", true);
        } else if (result.warnings.length) {
          applyAutomaticStoreUpdate(api, (state) => ({ enabled: { ...state.enabled, [provider]: false } }));
          report("切り替えは終わりましたが警告が出ました。自動切り替えをオフにします。", true);
        } else {
          // Restart the cooldown from the finished switch: the IPC call and the
          // refresh after it take time too, and none of it may shorten the rest.
          applyAutomaticStoreUpdate(api, (state) => ({ attempts: { ...state.attempts, [provider]: {
            source: current.source.profile_id, target: target.id, at: Date.now(),
          } } }));
          report(`「${target.label}」に切り替えました。新しく起動するセッションから反映されます。`);
        }
      } finally {
        running.delete(provider);
        if (rerun.delete(provider)) queueMicrotask(() => void get().evaluate());
      }
    }
  },
}), {
  name: "mycmux-account-auto-switch",
  partialize: (state) => ({ enabled: state.enabled, excludedTargets: state.excludedTargets, attempts: state.attempts }),
  merge: (persisted, current) => {
    const saved = (typeof persisted === "object" && persisted !== null ? persisted : {}) as Partial<AutoSwitchState>;
    // Saved before the picks existed, or damaged: every account is a candidate.
    const excludedTargets = { ...current.excludedTargets };
    for (const provider of PROVIDER_ORDER) {
      excludedTargets[provider] = excludedTargetsFor(saved as Pick<AutoSwitchState, "excludedTargets">, provider);
    }
    return { ...current, ...saved, excludedTargets };
  },
}));
