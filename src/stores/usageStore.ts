import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

export type WindowStat = {
  tokens: number;
  messages: number;
  limit: number;
  pct: number;
  reset_at: string;
};

export type UsageSummary = {
  claude_5h: WindowStat;
  claude_7d: WindowStat;
  codex_5h: WindowStat;
  codex_7d: WindowStat;
  tier: string;
  generated_at: string;
};

type UsageState = {
  summary: UsageSummary | null;
  lastError: string | null;
  lastFetchedAt: number | null;
  fetch: () => Promise<void>;
};

export const useUsageStore = create<UsageState>((set) => ({
  summary: null,
  lastError: null,
  lastFetchedAt: null,
  fetch: async () => {
    try {
      const summary = await invoke<UsageSummary>("get_usage_summary");
      set({
        summary,
        lastError: null,
        lastFetchedAt: Date.now(),
      });
    } catch (error) {
      set({
        lastError: error instanceof Error ? error.message : String(error),
        lastFetchedAt: Date.now(),
      });
    }
  },
}));
