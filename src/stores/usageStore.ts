import { create } from "zustand";
import { getUsageSummary, getMultiUsage, type AccountUsage, type UsageSummary } from "../lib/ipc";
import { mergeAccounts } from "../lib/usageAccounts";

// Re-exported so existing consumers (UsageMeter, UsagePopover) keep working
// against the store's public surface without reaching into lib/ipc directly.
export type { WindowStat, UsageSummary } from "../lib/ipc";

type UsageState = {
  summary: UsageSummary | null;
  lastError: string | null;
  lastFetchedAt: number | null;
  accounts: AccountUsage[];
  accountsError: string | null;
  accountsDialogOpen: boolean;
  reauthTargetId: string | null;
  fetch: () => Promise<void>;
  fetchAccounts: () => Promise<void>;
  openAccountsDialog: (reauthTargetId?: string) => void;
  closeAccountsDialog: () => void;
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

// Monotonic sequence counters guard against out-of-order responses: if a
// slower, earlier fetch resolves after a newer one, its result is dropped.
let summarySeq = 0;
let accountsSeq = 0;

export const useUsageStore = create<UsageState>((set) => ({
  summary: null,
  lastError: null,
  lastFetchedAt: null,
  accounts: [],
  accountsError: null,
  accountsDialogOpen: false,
  reauthTargetId: null,

  fetch: async () => {
    const mySummarySeq = ++summarySeq;
    const myAccountsSeq = ++accountsSeq;

    const [summaryResult, accountsResult] = await Promise.allSettled([
      getUsageSummary(),
      getMultiUsage(),
    ]);

    if (mySummarySeq === summarySeq) {
      if (summaryResult.status === "fulfilled") {
        set({
          summary: summaryResult.value,
          lastError: null,
          lastFetchedAt: Date.now(),
        });
      } else {
        // Stale-while-error: keep the last known-good summary, only surface the error.
        set({
          lastError: errorMessage(summaryResult.reason),
          lastFetchedAt: Date.now(),
        });
      }
    }

    if (myAccountsSeq === accountsSeq) {
      if (accountsResult.status === "fulfilled") {
        set((state) => ({
          accounts: mergeAccounts(state.accounts, accountsResult.value),
          accountsError: null,
        }));
      } else {
        // Stale-while-error: keep the last known-good accounts list.
        set({ accountsError: errorMessage(accountsResult.reason) });
      }
    }
  },

  fetchAccounts: async () => {
    const myAccountsSeq = ++accountsSeq;
    try {
      const next = await getMultiUsage();
      if (myAccountsSeq === accountsSeq) {
        set((state) => ({
          accounts: mergeAccounts(state.accounts, next),
          accountsError: null,
        }));
      }
    } catch (error) {
      if (myAccountsSeq === accountsSeq) {
        set({ accountsError: errorMessage(error) });
      }
    }
  },

  openAccountsDialog: (reauthTargetId) => {
    set({ accountsDialogOpen: true, reauthTargetId: reauthTargetId ?? null });
  },

  closeAccountsDialog: () => {
    set({ accountsDialogOpen: false, reauthTargetId: null });
  },
}));

export function __resetUsageStoreForTests(): void {
  summarySeq = 0;
  accountsSeq = 0;
  useUsageStore.setState({
    summary: null,
    lastError: null,
    lastFetchedAt: null,
    accounts: [],
    accountsError: null,
    accountsDialogOpen: false,
    reauthTargetId: null,
  });
}
