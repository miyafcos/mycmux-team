import { create } from "zustand";
import type { SettingsTabId } from "../components/settings/SettingsDialog";
import { clampSidebarWidth, SIDEBAR_DEFAULT_WIDTH } from "../lib/constants";

/**
 * UI Store - Manages UI-only state (sidebar, keybindings, zoom)
 * Isolated from workspace/pane data to prevent unnecessary re-renders
 */
interface UiState {
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  isKeybindingsOpen: boolean;
  activePaneId: string | null;
  lastActivePaneId: string | null;
  focusRevision: number;
  zoomedPaneId: string | null;
  requestedSettingsTab: SettingsTabId | null;
  requestSettingsTab: (tab: SettingsTabId) => void;
  clearRequestedSettingsTab: () => void;

  toggleSidebar: () => void;
  setSidebarWidth: (width: number) => void;
  setIsKeybindingsOpen: (open: boolean) => void;
  setActivePaneId: (id: string | null) => void;
  bumpFocusRevision: () => void;
  setZoomedPaneId: (id: string | null) => void;
}

export const useUiStore = create<UiState>((set) => ({
  sidebarCollapsed: false,
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  isKeybindingsOpen: false,
  activePaneId: null,
  lastActivePaneId: null,
  focusRevision: 0,
  zoomedPaneId: null,
  requestedSettingsTab: null,
  requestSettingsTab: (tab) => set({ requestedSettingsTab: tab }),
  clearRequestedSettingsTab: () => set({ requestedSettingsTab: null }),

  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  setSidebarWidth: (width) => set({ sidebarWidth: clampSidebarWidth(width) }),
  setIsKeybindingsOpen: (open) => set({ isKeybindingsOpen: open }),
  setActivePaneId: (id) =>
    set((state) => {
      const nextLastActivePaneId = id ?? state.lastActivePaneId;
      if (state.activePaneId === id && state.lastActivePaneId === nextLastActivePaneId) {
        return state;
      }
      return {
        activePaneId: id,
        lastActivePaneId: nextLastActivePaneId,
        focusRevision: state.focusRevision + (state.activePaneId === id ? 0 : 1),
      };
    }),
  bumpFocusRevision: () => set((state) => ({ focusRevision: state.focusRevision + 1 })),
  setZoomedPaneId: (id) => set({ zoomedPaneId: id }),
}));
