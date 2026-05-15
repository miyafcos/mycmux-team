import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

export type WindowStat = {
  pct: number;
  resets_at: string;
};

export type UsageSummary = {
  claude_5h: WindowStat | null;
  claude_7d: WindowStat | null;
  claude_7d_sonnet: WindowStat | null;
  claude_7d_opus: WindowStat | null;
  codex_5h: WindowStat | null;
  codex_7d: WindowStat | null;
  claude_available: boolean;
  codex_available: boolean;
  claude_error: string | null;
  codex_error: string | null;
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
