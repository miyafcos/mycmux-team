import { create } from "zustand";

export type DashboardStateFilter = "needsHuman" | "running" | "noUpdate" | "done";
export type DashboardDetailTab = "now" | "history" | "terminal";

interface DashboardViewState {
  open: boolean;
  query: string;
  workspaceFilter: string | null;
  agentFilter: string | null;
  stateFilter: DashboardStateFilter | null;
  completedExpanded: boolean;
  selectedTabId: string | null;
  detailTab: DashboardDetailTab;
  /** 常設コンポーザの下書き。セッションごとに分けて持ち、永続化しない。 */
  draftBySession: Record<string, string>;
  toggle: () => void;
  openView: () => void;
  close: () => void;
  setQuery: (query: string) => void;
  setWorkspaceFilter: (workspaceId: string | null) => void;
  setAgentFilter: (agentKind: string | null) => void;
  setStateFilter: (stateFilter: DashboardStateFilter | null) => void;
  setCompletedExpanded: (expanded: boolean) => void;
  setSelectedTabId: (tabId: string | null) => void;
  setDetailTab: (tab: DashboardDetailTab) => void;
  setDraft: (sessionId: string, text: string) => void;
}

export const useDashboardViewStore = create<DashboardViewState>((set) => ({
  open: false,
  query: "",
  workspaceFilter: null,
  agentFilter: null,
  stateFilter: null,
  completedExpanded: false,
  selectedTabId: null,
  detailTab: "now",
  draftBySession: {},
  toggle: () => set((state) => ({ open: !state.open })),
  openView: () => set({ open: true }),
  close: () => set({ open: false }),
  setQuery: (query) => set({ query }),
  setWorkspaceFilter: (workspaceFilter) => set({ workspaceFilter }),
  setAgentFilter: (agentFilter) => set({ agentFilter }),
  setStateFilter: (stateFilter) => set((state) => ({
    stateFilter,
    completedExpanded: stateFilter === "done" ? true : state.completedExpanded,
  })),
  setCompletedExpanded: (completedExpanded) => set({ completedExpanded }),
  setSelectedTabId: (selectedTabId) => set({ selectedTabId }),
  setDetailTab: (detailTab) => set({ detailTab }),
  setDraft: (sessionId, text) => set((state) => ({
    draftBySession: { ...state.draftBySession, [sessionId]: text },
  })),
}));
