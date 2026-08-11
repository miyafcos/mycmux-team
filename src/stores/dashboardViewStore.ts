import { create } from "zustand";

export type DashboardSortMode = "attention" | "workspace" | "agent";

export interface DashboardQuickFilters {
  attentionOnly: boolean;
  stalledOnly: boolean;
  backgroundOnly: boolean;
  unobservedOnly: boolean;
}

interface DashboardViewState {
  open: boolean;
  sortMode: DashboardSortMode;
  query: string;
  workspaceFilter: string | null;
  quickFilters: DashboardQuickFilters;
  agentFilter: string | null;
  selectedTabId: string | null;
  toggle: () => void;
  openView: () => void;
  close: () => void;
  setSortMode: (sortMode: DashboardSortMode) => void;
  setQuery: (query: string) => void;
  setWorkspaceFilter: (workspaceId: string | null) => void;
  setQuickFilter: (filter: keyof DashboardQuickFilters, enabled: boolean) => void;
  setAgentFilter: (agentKind: string | null) => void;
  setSelectedTabId: (tabId: string | null) => void;
}

const emptyQuickFilters: DashboardQuickFilters = {
  attentionOnly: false,
  stalledOnly: false,
  backgroundOnly: false,
  unobservedOnly: false,
};

export const useDashboardViewStore = create<DashboardViewState>((set) => ({
  open: false,
  sortMode: "attention",
  query: "",
  workspaceFilter: null,
  quickFilters: emptyQuickFilters,
  agentFilter: null,
  selectedTabId: null,
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
}));
