import { create } from "zustand";
import { getAccountUsage, type ApiUsageCommand, type ProfileUsage } from "../lib/ipc";

// Re-exported so consumers keep working against the store's public surface
// without reaching into lib/ipc directly.
export type { WindowStat, ProfileUsage } from "../lib/ipc";

type UsageState = {
  accounts: ProfileUsage[];
  generatedAt: string | null;
  lastError: string | null;
  lastFetchedAt: number | null;
  loading: boolean;
  fetch: (refreshMetadata?: boolean, apiCommand?: ApiUsageCommand, options?: { afterSwitch: boolean }) => Promise<void>;
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

// Inventory follows request order. Gemini follows the snapshot actually
// sampled, since a later account mutation may only read an older cache entry.
let accountsSeq = 0;
let geminiRevision = 0;

export const useUsageStore = create<UsageState>((set) => ({
  accounts: [],
  generatedAt: null,
  lastError: null,
  lastFetchedAt: null,
  loading: false,

  fetch: async (refreshMetadata = false, apiCommand, options) => {
    const mySeq = ++accountsSeq;
    const cacheOnly = options?.afterSwitch || apiCommand === "account.switch";
    set({ loading: true });
    try {
      const request = options?.afterSwitch
        ? getAccountUsage(refreshMetadata, apiCommand, true)
        : apiCommand ? getAccountUsage(refreshMetadata, apiCommand)
        : refreshMetadata ? getAccountUsage(true) : getAccountUsage();
      const report = await request;
      const currentInventory = mySeq === accountsSeq;
      const gemini = report.accounts.find((row) => row.provider === "gemini");
      const revision = report.gemini_revision;
      const updateGemini = gemini !== undefined && (revision === undefined
        ? currentInventory && geminiRevision === 0
        : revision > geminiRevision);
      if (!currentInventory && !updateGemini) return;
      if (updateGemini && revision !== undefined) geminiRevision = revision;

      set((state) => {
        const inventory = currentInventory && !report.inventory_error ? report.accounts : state.accounts;
        const geminiRow = updateGemini ? gemini : state.accounts.find((row) => row.provider === "gemini");
        return {
          accounts: [...inventory.filter((row) => row.provider !== "gemini"), ...(geminiRow ? [geminiRow] : [])],
          ...(currentInventory && {
            generatedAt: report.generated_at,
            lastError: report.inventory_error ?? null,
            loading: false,
          }),
          // The regular poll tracks this timestamp. Cache-only reads must
          // leave the next Gemini poll due even during repeated mutations.
          ...(!cacheOnly && { lastFetchedAt: Date.now() }),
        };
      });
    } catch (error) {
      if (mySeq !== accountsSeq) {
        return;
      }
      // Stale-while-error: the whole call failed, so keep the last known-good
      // rows on screen and surface only the error.
      set({ lastError: errorMessage(error), loading: false, ...(!cacheOnly && { lastFetchedAt: Date.now() }) });
    }
  },
}));

export function __resetUsageStoreForTests(): void {
  accountsSeq = 0;
  geminiRevision = 0;
  useUsageStore.setState({
    accounts: [],
    generatedAt: null,
    lastError: null,
    lastFetchedAt: null,
    loading: false,
  });
}
