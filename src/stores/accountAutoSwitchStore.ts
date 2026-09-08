import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { CliProvider } from "../lib/ipc";
import { AUTO_SWITCH_COOLDOWN_MS, chooseAutoSwitch } from "../lib/accountAutoSwitch";
import { PROVIDER_TITLE } from "../lib/cliAccounts";
import { useCliAccountStore } from "./cliAccountStore";
import { useUsageStore } from "./usageStore";
import { useToastStore } from "./toastStore";

type Attempt = { source: string; target: string; at: number };
interface AutoSwitchState {
  enabled: Record<CliProvider, boolean>;
  attempts: Partial<Record<CliProvider, Attempt>>;
  status: Partial<Record<CliProvider, string>>;
  setEnabled(provider: CliProvider, enabled: boolean): void;
  evaluate(): Promise<void>;
}
const running = new Set<CliProvider>();
export const useAccountAutoSwitchStore = create<AutoSwitchState>()(persist((set, get) => ({
  enabled: { claude: false, codex: false, grok: false },
  attempts: {},
  status: {},
  setEnabled: (provider, enabled) => set((state) => ({
    enabled: { ...state.enabled, [provider]: enabled },
    status: { ...state.status, [provider]: enabled ? "監視しています" : "オフ" },
  })),
  evaluate: async () => {
    for (const provider of ["claude", "codex", "grok"] as const) {
      if (get().enabled[provider] !== true || running.has(provider)) continue;
      const decision = () => {
        const cli = useCliAccountStore.getState();
        const usage = useUsageStore.getState();
        if (get().enabled[provider] !== true || cli.loading || cli.fetchError || usage.lastError
          || cli.busyByProvider[provider] !== null) return null;
        return chooseAutoSwitch(provider, usage.accounts, cli.profiles, cli.live, Date.now());
      };
      const planned = decision();
      if (!planned) continue;
      const previous = get().attempts[provider];
      // Persist the cooldown across app restarts and opt-out/opt-in cycles.
      if (previous && Date.now() - previous.at < AUTO_SWITCH_COOLDOWN_MS) continue;
      const report = (message: string, warning = false) => {
        if (get().status[provider] === message) return;
        set((state) => ({ status: { ...state.status, [provider]: message } }));
        useToastStore.getState().pushToast(`${PROVIDER_TITLE[provider]}: ${message}`, warning ? "warning" : "info");
      };
      if (previous?.source === planned.source.profile_id) {
        get().setEnabled(provider, false);
        report("切り替えたあとも同じアカウントが上限のままでした。自動切り替えをオフにします。", true);
        continue;
      }
      if (!planned.target) {
        report("上限に達しましたが、空きのあるアカウントがありません。", true);
        continue;
      }
      running.add(provider);
      try {
        // Refresh the live identity before touching the shared CLI login.
        await useCliAccountStore.getState().fetch();
        const current = decision();
        if (!current?.target || current.source.profile_id !== planned.source.profile_id) continue;
        const target = current.target;
        const at = Date.now();
        const result = await useCliAccountStore.getState().switchTo(provider, target.id, () => {
          // This guard runs inside the existing mutation queue, immediately before IPC.
          const cli = useCliAccountStore.getState();
          const usage = useUsageStore.getState();
          if (get().enabled[provider] !== true || cli.fetchError || usage.lastError) return false;
          const latest = chooseAutoSwitch(provider, usage.accounts, cli.profiles, cli.live, Date.now());
          if (latest?.source.profile_id !== current.source.profile_id || latest.target?.id !== target.id) return false;
          set((state) => ({ attempts: { ...state.attempts, [provider]: {
            source: current.source.profile_id, target: target.id, at,
          } } }));
          return true;
        });
        if (!get().enabled[provider]) continue;
        if (!result) {
          // A cancelled queued operation has no attempt timestamp.
          if (get().attempts[provider]?.at !== at) continue;
          get().setEnabled(provider, false);
          report("アカウントの切り替えに失敗しました。自動切り替えをオフにします。", true);
        } else if (result.warnings.length) {
          get().setEnabled(provider, false);
          report("切り替えは終わりましたが警告が出ました。自動切り替えをオフにします。", true);
        } else {
          report(`「${target.label}」に切り替えました。新しく起動するセッションから反映されます。`);
        }
      } finally {
        running.delete(provider);
      }
    }
  },
}), {
  name: "mycmux-account-auto-switch",
  partialize: (state) => ({ enabled: state.enabled, attempts: state.attempts }),
}));
