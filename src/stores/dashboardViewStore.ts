import { create } from "zustand";

export type DashboardSortMode = "attention" | "workspace";
export type DashboardDetailTab = "now" | "history" | "terminal";

export interface DashboardQuickFilters {
  /** 「要対応のみ」。旧 attentionOnly / backgroundOnly / unobservedOnly をここへ統合した。 */
  needsHumanOnly: boolean;
}

interface DashboardViewState {
  open: boolean;
  sortMode: DashboardSortMode;
  query: string;
  workspaceFilter: string | null;
  quickFilters: DashboardQuickFilters;
  agentFilter: string | null;
  selectedTabId: string | null;
  detailTab: DashboardDetailTab;
  toggle: () => void;
  openView: () => void;
  close: () => void;
  setSortMode: (sortMode: DashboardSortMode) => void;
  setQuery: (query: string) => void;
  setWorkspaceFilter: (workspaceId: string | null) => void;
  setQuickFilter: (filter: keyof DashboardQuickFilters, enabled: boolean) => void;
  setAgentFilter: (agentKind: string | null) => void;
  setSelectedTabId: (tabId: string | null) => void;
  setDetailTab: (tab: DashboardDetailTab) => void;
}

const emptyQuickFilters: DashboardQuickFilters = {
  needsHumanOnly: false,
};

export const useDashboardViewStore = create<DashboardViewState>((set) => ({
  open: false,
  sortMode: "attention",
  query: "",
  workspaceFilter: null,
  quickFilters: emptyQuickFilters,
  agentFilter: null,
  selectedTabId: null,
  detailTab: "now",
  toggle: () => set((state) => ({ open: !state.open })),
  openView: () => set({ open: true }),
  close: () => set({ open: false }),
  setSortMode: (sortMode) => set({ sortMode }),
  setQuery: (query) => set({ query }),
  setWorkspaceFilter: (workspaceFilter) => set({ workspaceFilter }),
  setQuickFilter: (filter, enabled) => set((state) => ({
    quickFilters: { ...state.quickFilters, [filter]: enabled },
  })),
  setAgentFilter: (agentFilter) => set({ agentFilter }),
  setSelectedTabId: (selectedTabId) => set({ selectedTabId }),
  setDetailTab: (detailTab) => set({ detailTab }),
}));
