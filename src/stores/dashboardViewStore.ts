import { create } from "zustand";

export type DashboardStateFilter = "needsHuman" | "running" | "noUpdate" | "done";

export const DASHBOARD_MINIMAP_DEFAULT_WIDTH = 336;
export const DASHBOARD_MINIMAP_MIN_WIDTH = 240;
export const DASHBOARD_MINIMAP_MAX_VIEWPORT_RATIO = 0.45;
export const DASHBOARD_SESSION_LIST_WIDTH = 256;
export const DASHBOARD_MINIMAP_RESIZER_WIDTH = 8;
export const DASHBOARD_CHAT_MIN_WIDTH = 360;
export const DASHBOARD_MINIMAP_STORAGE_KEY = "mycmux:dashboard-minimap-width";
export const DASHBOARD_CHAT_COLUMN_LIMIT = 3;

function viewportWidth(): number {
  return typeof window === "undefined" ? 0 : window.innerWidth;
}

export function dashboardMinimapMaxWidth(width = viewportWidth()): number {
  const ratioMaximum = Math.floor(width * DASHBOARD_MINIMAP_MAX_VIEWPORT_RATIO);
  const readableChatMaximum = Math.floor(width
    - DASHBOARD_SESSION_LIST_WIDTH
    - DASHBOARD_MINIMAP_RESIZER_WIDTH
    - DASHBOARD_CHAT_MIN_WIDTH);
  return Math.max(DASHBOARD_MINIMAP_MIN_WIDTH, Math.min(ratioMaximum, readableChatMaximum));
}

export function normalizeDashboardMinimapWidth(value: number): number {
  const safeValue = Number.isFinite(value) && value > 0 ? value : DASHBOARD_MINIMAP_DEFAULT_WIDTH;
  return Math.max(DASHBOARD_MINIMAP_MIN_WIDTH, Math.round(safeValue));
}

export function clampDashboardMinimapWidth(value: number, width = viewportWidth()): number {
  const safeValue = Number.isFinite(value) ? Math.round(value) : DASHBOARD_MINIMAP_DEFAULT_WIDTH;
  return Math.max(DASHBOARD_MINIMAP_MIN_WIDTH, Math.min(dashboardMinimapMaxWidth(width), safeValue));
}

function readStoredMinimapWidth(): number {
  try {
    const stored = window.localStorage.getItem(DASHBOARD_MINIMAP_STORAGE_KEY);
    return stored === null ? DASHBOARD_MINIMAP_DEFAULT_WIDTH : clampDashboardMinimapWidth(Number(stored));
  } catch {
    return DASHBOARD_MINIMAP_DEFAULT_WIDTH;
  }
}

function persistMinimapWidth(width: number): void {
  try {
    window.localStorage.setItem(DASHBOARD_MINIMAP_STORAGE_KEY, String(width));
  } catch {
    // Client-local dashboard preferences are best-effort in restricted WebViews.
  }
}

function normalizeChatColumns(tabIds: readonly string[]): string[] {
  const normalized: string[] = [];
  for (const tabId of tabIds) {
    if (tabId && !normalized.includes(tabId)) normalized.push(tabId);
    if (normalized.length === DASHBOARD_CHAT_COLUMN_LIMIT) break;
  }
  return normalized;
}

function activeChatColumnIndex(tabIds: readonly string[], activeColumn: number): number {
  if (!tabIds.length) return 0;
  if (!Number.isInteger(activeColumn)) return 0;
  return Math.max(0, Math.min(tabIds.length - 1, activeColumn));
}

interface DashboardViewState {
  open: boolean;
  query: string;
  workspaceFilter: string | null;
  agentFilter: string | null;
  stateFilter: DashboardStateFilter | null;
  selectedTabId: string | null;
  chatColumnTabIds: string[];
  activeChatColumn: number;
  reportInboxOpen: boolean;
  highlightedEventId: string | null;
  highlightedEventRequest: number;
  minimapWidth: number;
  toggle: () => void;
  openView: () => void;
  close: () => void;
  setQuery: (query: string) => void;
  setWorkspaceFilter: (workspaceId: string | null) => void;
  setAgentFilter: (agentKind: string | null) => void;
  setStateFilter: (stateFilter: DashboardStateFilter | null) => void;
  setSelectedTabId: (tabId: string | null) => void;
  addChatColumn: (tabId: string) => void;
  moveChatColumn: (from: number, to: number) => void;
  insertChatColumn: (tabId: string, index: number) => void;
  setActiveChatColumn: (index: number) => void;
  removeChatColumn: (index: number) => void;
  openReportInbox: () => void;
  closeReportInbox: () => void;
  setHighlightedEventId: (eventId: string | null) => void;
  setMinimapWidth: (width: number) => void;
}

export const useDashboardViewStore = create<DashboardViewState>((set) => ({
  open: false,
  query: "",
  workspaceFilter: null,
  agentFilter: null,
  stateFilter: null,
  selectedTabId: null,
  chatColumnTabIds: [],
  activeChatColumn: 0,
  reportInboxOpen: false,
  highlightedEventId: null,
  highlightedEventRequest: 0,
  minimapWidth: readStoredMinimapWidth(),
  toggle: () => set((state) => ({ open: !state.open })),
  openView: () => set({ open: true }),
  close: () => set({ open: false }),
  setQuery: (query) => set({ query }),
  setWorkspaceFilter: (workspaceFilter) => set({ workspaceFilter }),
  setAgentFilter: (agentFilter) => set({ agentFilter }),
  setStateFilter: (stateFilter) => set({ stateFilter }),
  setSelectedTabId: (selectedTabId) => set((state) => {
    if (!selectedTabId) {
      return {
        selectedTabId: null,
        chatColumnTabIds: [],
        activeChatColumn: 0,
        reportInboxOpen: false,
      };
    }
    const chatColumnTabIds = normalizeChatColumns(state.chatColumnTabIds);
    if (!chatColumnTabIds.length) {
      return { selectedTabId, chatColumnTabIds: [selectedTabId], activeChatColumn: 0, reportInboxOpen: false };
    }
    const existingIndex = chatColumnTabIds.indexOf(selectedTabId);
    if (existingIndex >= 0) {
      return { selectedTabId, chatColumnTabIds, activeChatColumn: existingIndex, reportInboxOpen: false };
    }
    const activeChatColumn = activeChatColumnIndex(chatColumnTabIds, state.activeChatColumn);
    chatColumnTabIds[activeChatColumn] = selectedTabId;
    return { selectedTabId, chatColumnTabIds, activeChatColumn, reportInboxOpen: false };
  }),
  addChatColumn: (tabId) => set((state) => {
    const chatColumnTabIds = normalizeChatColumns(state.chatColumnTabIds);
    const existingIndex = chatColumnTabIds.indexOf(tabId);
    if (existingIndex >= 0) {
      return { selectedTabId: tabId, chatColumnTabIds, activeChatColumn: existingIndex, reportInboxOpen: false };
    }
    // A full three-column view remains stable: a drop cannot silently replace
    // an active conversation. The user can close a column or use click-to-replace.
    if (chatColumnTabIds.length === DASHBOARD_CHAT_COLUMN_LIMIT) {
      return { chatColumnTabIds, activeChatColumn: activeChatColumnIndex(chatColumnTabIds, state.activeChatColumn), reportInboxOpen: false };
    }
    chatColumnTabIds.push(tabId);
    const activeChatColumn = chatColumnTabIds.length - 1;
    return { selectedTabId: tabId, chatColumnTabIds, activeChatColumn, reportInboxOpen: false };
  }),
  moveChatColumn: (from, to) => set((state) => {
    const chatColumnTabIds = normalizeChatColumns(state.chatColumnTabIds);
    if (from < 0 || from >= chatColumnTabIds.length || to < 0 || to > chatColumnTabIds.length || from === to) return state;
    // Slots are measured while the dragged column remains in the array.
    // Removing it first shifts every following slot one position to the left.
    const toIndex = to > from ? to - 1 : to;
    if (toIndex === from) return state;
    const activeTabId = chatColumnTabIds[activeChatColumnIndex(chatColumnTabIds, state.activeChatColumn)] ?? null;
    const [movedTabId] = chatColumnTabIds.splice(from, 1);
    chatColumnTabIds.splice(toIndex, 0, movedTabId!);
    const activeChatColumn = activeTabId ? chatColumnTabIds.indexOf(activeTabId) : 0;
    return {
      selectedTabId: activeTabId,
      chatColumnTabIds,
      activeChatColumn: Math.max(0, activeChatColumn),
    };
  }),
  insertChatColumn: (tabId, index) => set((state) => {
    const chatColumnTabIds = normalizeChatColumns(state.chatColumnTabIds);
    const slot = Math.min(Math.max(index, 0), chatColumnTabIds.length);
    const existingIndex = chatColumnTabIds.indexOf(tabId);
    if (existingIndex >= 0) {
      const toIndex = slot > existingIndex ? slot - 1 : slot;
      if (toIndex === existingIndex) return state;
      const activeTabId = chatColumnTabIds[activeChatColumnIndex(chatColumnTabIds, state.activeChatColumn)] ?? null;
      chatColumnTabIds.splice(existingIndex, 1);
      chatColumnTabIds.splice(toIndex, 0, tabId);
      const activeChatColumn = activeTabId ? chatColumnTabIds.indexOf(activeTabId) : 0;
      return {
        selectedTabId: activeTabId,
        chatColumnTabIds,
        activeChatColumn: Math.max(0, activeChatColumn),
      };
    }
    if (chatColumnTabIds.length === DASHBOARD_CHAT_COLUMN_LIMIT) return state;
    chatColumnTabIds.splice(slot, 0, tabId);
    return {
      selectedTabId: tabId,
      chatColumnTabIds,
      activeChatColumn: slot,
      reportInboxOpen: false,
    };
  }),
  setActiveChatColumn: (index) => set((state) => {
    const chatColumnTabIds = normalizeChatColumns(state.chatColumnTabIds);
    if (!chatColumnTabIds.length) return { selectedTabId: null, chatColumnTabIds, activeChatColumn: 0, reportInboxOpen: false };
    const activeChatColumn = activeChatColumnIndex(chatColumnTabIds, index);
    return {
      selectedTabId: chatColumnTabIds[activeChatColumn],
      chatColumnTabIds,
      activeChatColumn,
      reportInboxOpen: false,
    };
  }),
  removeChatColumn: (index) => set((state) => {
    const chatColumnTabIds = normalizeChatColumns(state.chatColumnTabIds);
    if (chatColumnTabIds.length <= 1) {
      const onlyTabId = chatColumnTabIds[0] ?? null;
      return { selectedTabId: onlyTabId, chatColumnTabIds, activeChatColumn: 0 };
    }
    const removedIndex = activeChatColumnIndex(chatColumnTabIds, index);
    chatColumnTabIds.splice(removedIndex, 1);
    const activeChatColumn = activeChatColumnIndex(
      chatColumnTabIds,
      state.activeChatColumn > removedIndex ? state.activeChatColumn - 1 : state.activeChatColumn,
    );
    return {
      selectedTabId: chatColumnTabIds[activeChatColumn],
      chatColumnTabIds,
      activeChatColumn,
      reportInboxOpen: false,
    };
  }),
  openReportInbox: () => set({ reportInboxOpen: true, highlightedEventId: null }),
  closeReportInbox: () => set({ reportInboxOpen: false }),
  setHighlightedEventId: (highlightedEventId) => set((state) => ({
    highlightedEventId,
    highlightedEventRequest: state.highlightedEventRequest + 1,
  })),
  setMinimapWidth: (width) => {
    const minimapWidth = clampDashboardMinimapWidth(width);
    persistMinimapWidth(minimapWidth);
    set({ minimapWidth });
  },
}));
