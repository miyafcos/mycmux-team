import { create } from "zustand";

/**
 * UI Store - Manages UI-only state (sidebar, keybindings, zoom)
 * Isolated from workspace/pane data to prevent unnecessary re-renders
 */
interface UiState {
  sidebarCollapsed: boolean;
  isKeybindingsOpen: boolean;
  activePaneId: string | null;
  lastActivePaneId: string | null;
  zoomedPaneId: string | null;

  toggleSidebar: () => void;
  setIsKeybindingsOpen: (open: boolean) => void;
  setActivePaneId: (id: string | null) => void;
  setZoomedPaneId: (id: string | null) => void;
}

export const useUiStore = create<UiState>((set) => ({
  sidebarCollapsed: false,
  isKeybindingsOpen: false,
  activePaneId: null,
  lastActivePaneId: null,
  zoomedPaneId: null,

  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
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
      };
    }),
  setZoomedPaneId: (id) => set({ zoomedPaneId: id }),
}));
