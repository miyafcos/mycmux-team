import { create } from "zustand";

export type DashboardStateFilter = "needsHuman" | "running" | "noUpdate" | "done";

interface DashboardViewState {
  open: boolean;
  query: string;
  workspaceFilter: string | null;
  agentFilter: string | null;
  stateFilter: DashboardStateFilter | null;
  selectedTabId: string | null;
  reportInboxOpen: boolean;
  highlightedEventId: string | null;
  highlightedEventRequest: number;
  toggle: () => void;
  openView: () => void;
  close: () => void;
  setQuery: (query: string) => void;
  setWorkspaceFilter: (workspaceId: string | null) => void;
  setAgentFilter: (agentKind: string | null) => void;
  setStateFilter: (stateFilter: DashboardStateFilter | null) => void;
  setSelectedTabId: (tabId: string | null) => void;
  openReportInbox: () => void;
  closeReportInbox: () => void;
  setHighlightedEventId: (eventId: string | null) => void;
}

export const useDashboardViewStore = create<DashboardViewState>((set) => ({
  open: false,
  query: "",
  workspaceFilter: null,
  agentFilter: null,
  stateFilter: null,
  selectedTabId: null,
  reportInboxOpen: false,
  highlightedEventId: null,
  highlightedEventRequest: 0,
  toggle: () => set((state) => ({ open: !state.open })),
  openView: () => set({ open: true }),
  close: () => set({ open: false }),
  setQuery: (query) => set({ query }),
  setWorkspaceFilter: (workspaceFilter) => set({ workspaceFilter }),
  setAgentFilter: (agentFilter) => set({ agentFilter }),
  setStateFilter: (stateFilter) => set({ stateFilter }),
  setSelectedTabId: (selectedTabId) => set({ selectedTabId, reportInboxOpen: false }),
  openReportInbox: () => set({ reportInboxOpen: true, highlightedEventId: null }),
  closeReportInbox: () => set({ reportInboxOpen: false }),
  setHighlightedEventId: (highlightedEventId) => set((state) => ({
    highlightedEventId,
    highlightedEventRequest: state.highlightedEventRequest + 1,
  })),
}));
