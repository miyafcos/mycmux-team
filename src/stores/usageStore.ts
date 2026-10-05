import { create } from "zustand";
import { getAccountUsage, type ProfileUsage } from "../lib/ipc";

// Re-exported so consumers keep working against the store's public surface
// without reaching into lib/ipc directly.
export type { WindowStat, ProfileUsage } from "../lib/ipc";

type UsageState = {
  accounts: ProfileUsage[];
  generatedAt: string | null;
  lastError: string | null;
  lastFetchedAt: number | null;
  loading: boolean;
  fetch: (refreshMetadata?: boolean) => Promise<void>;
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

// Monotonic sequence counter guards against out-of-order responses: if a
// slower, earlier fetch resolves after a newer one, its result is dropped.
let accountsSeq = 0;

export const useUsageStore = create<UsageState>((set) => ({
  accounts: [],
  generatedAt: null,
  lastError: null,
  lastFetchedAt: null,
  loading: false,

  fetch: async (refreshMetadata = false) => {
    const mySeq = ++accountsSeq;
    set({ loading: true });
    try {
      const report = await (refreshMetadata ? getAccountUsage(true) : getAccountUsage());
      if (mySeq !== accountsSeq) {
        return;
      }
      // The backend answers with every row each time, including per-row
      // failures, so the report replaces the list outright. Merging would keep
      // showing a stale number next to a row that is telling us why it has none.
      set({
        accounts: report.accounts,
        generatedAt: report.generated_at,
        lastError: null,
        lastFetchedAt: Date.now(),
        loading: false,
      });
    } catch (error) {
      if (mySeq !== accountsSeq) {
        return;
      }
      // Stale-while-error: the whole call failed, so keep the last known-good
      // rows on screen and surface only the error.
      set({ lastError: errorMessage(error), lastFetchedAt: Date.now(), loading: false });
    }
  },
}));

export function __resetUsageStoreForTests(): void {
  accountsSeq = 0;
  useUsageStore.setState({
    accounts: [],
    generatedAt: null,
    lastError: null,
    lastFetchedAt: null,
    loading: false,
  });
}
