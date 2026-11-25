import { create } from "zustand";
import { getAccountUsage, getGeminiUsage, type AccountUsageReport, type ApiUsageCommand, type ProfileUsage } from "../lib/ipc";

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
let geminiRequest: Promise<AccountUsageReport> | null = null;
let refreshGeminiAgain = false;

function newerGeminiRow(report: AccountUsageReport, allowUnversioned: boolean): ProfileUsage | undefined {
  const row = report.accounts.find(account => account.provider === "gemini");
  if (!row) return;
  const revision = report.gemini_revision;
  if (revision === undefined) return allowUnversioned && geminiRevision === 0 ? row : undefined;
  if (revision <= geminiRevision) return;
  geminiRevision = revision;
  return row;
}

function pollGemini(explicit: boolean) {
  if (geminiRequest) {
    refreshGeminiAgain ||= explicit;
    return;
  }
  const request = Promise.resolve().then(() => getGeminiUsage(explicit));
  geminiRequest = request;
  void request.then(report => {
    if (geminiRequest !== request) return;
    const row = newerGeminiRow(report, true);
    if (row) useUsageStore.setState(state => ({
      accounts: [...state.accounts.filter(account => account.provider !== "gemini"), row],
    }));
  }).catch(() => {
    // Keep the latest row if transport fails.
  }).finally(() => {
    if (geminiRequest !== request) return;
    geminiRequest = null;
    if (refreshGeminiAgain) {
      refreshGeminiAgain = false;
      pollGemini(true);
    }
  });
}

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
    // Agy can take up to a minute. Keep the inventory controls responsive.
    if (!cacheOnly && !apiCommand) pollGemini(refreshMetadata);
    try {
      const report = await getAccountUsage(refreshMetadata, apiCommand, Boolean(options?.afterSwitch || !apiCommand));
      const currentInventory = mySeq === accountsSeq;
      const gemini = newerGeminiRow(report, currentInventory);
      if (!currentInventory && !gemini) return;

      set((state) => {
        const inventory = currentInventory && !report.inventory_error ? report.accounts : state.accounts;
        const geminiRow = gemini ?? state.accounts.find((row) => row.provider === "gemini");
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
  geminiRequest = null;
  refreshGeminiAgain = false;
  useUsageStore.setState({
    accounts: [],
    generatedAt: null,
    lastError: null,
    lastFetchedAt: null,
    loading: false,
  });
}
