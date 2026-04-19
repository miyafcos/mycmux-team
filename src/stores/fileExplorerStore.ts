import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import {
  type FileEntry,
  type PinnedRoot,
  listDirectory,
  savePinnedRoots,
  unwatchRoot,
  watchRoot,
} from "../lib/ipc";

type EntriesMap = Record<string, FileEntry[]>;
type ErrorsMap = Record<string, string>;

export interface DragState {
  path: string;
  name: string;
  x: number;
  y: number;
}

export interface ContextMenuState {
  path: string;
  isDir: boolean;
  x: number;
  y: number;
}

export type SortMode = "name-asc" | "name-desc" | "mtime-desc" | "mtime-asc";

export interface CreatingInState {
  parentPath: string;
  kind: "file" | "folder";
}

interface FileExplorerState {
  roots: PinnedRoot[];
  activeRootId: string | null;
  sortMode: SortMode;
  creatingIn: CreatingInState | null;

  entries: EntriesMap;
  errors: ErrorsMap;
  loadingPaths: Set<string>;
  expanded: Set<string>;
  selectedPath: string | null;
  dragging: DragState | null;
  contextMenu: ContextMenuState | null;

  setRoots: (roots: PinnedRoot[]) => void;
  addRoot: (root: PinnedRoot) => void;
  removeRoot: (id: string) => void;
  renameRoot: (id: string, name: string) => void;
  setActiveRootId: (id: string | null) => void;

  toggleExpand: (path: string) => Promise<void>;
  setExpanded: (path: string, expanded: boolean) => Promise<void>;
  ensureLoaded: (path: string) => Promise<void>;
  refresh: (path: string) => Promise<void>;
  invalidate: (path: string) => void;
  setSelectedPath: (path: string | null) => void;
  setSortMode: (mode: SortMode) => void;
  startCreating: (parentPath: string, kind: "file" | "folder") => void;
  cancelCreating: () => void;

  startDrag: (path: string, name: string, x: number, y: number) => void;
  updateDrag: (x: number, y: number) => void;
  endDrag: () => void;

  openContextMenu: (state: ContextMenuState) => void;
  closeContextMenu: () => void;
}

function basename(path: string): string {
  const cleaned = path.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
  return idx < 0 ? cleaned : cleaned.slice(idx + 1) || cleaned;
}

async function persistRoots(roots: PinnedRoot[]): Promise<void> {
  try {
    await savePinnedRoots(roots);
  } catch (err) {
    console.warn("[fileExplorer] Failed to persist pinned roots:", err);
  }
}

export const useFileExplorerStore = create<FileExplorerState>()(
  persist(
    (set, get) => ({
      roots: [],
      activeRootId: null,
      sortMode: "name-asc",
      creatingIn: null,
      entries: {},
      errors: {},
      loadingPaths: new Set(),
      expanded: new Set(),
      selectedPath: null,
      dragging: null,
      contextMenu: null,

      setRoots: (roots) => {
        set((state) => ({
          roots,
          activeRootId:
            state.activeRootId && roots.some((r) => r.id === state.activeRootId)
              ? state.activeRootId
              : roots[0]?.id ?? null,
        }));
      },

      addRoot: (root) => {
        const normalized: PinnedRoot = {
          ...root,
          name: root.name?.trim() || basename(root.path) || root.path,
        };
        const roots = [...get().roots.filter((r) => r.path !== normalized.path), normalized];
        set({ roots, activeRootId: normalized.id });
        void persistRoots(roots);
        void watchRoot(normalized.path).catch((err) =>
          console.warn("[fileExplorer] watchRoot failed:", err),
        );
      },

      removeRoot: (id) => {
        const { roots, activeRootId } = get();
        const target = roots.find((r) => r.id === id);
        const next = roots.filter((r) => r.id !== id);
        set({
          roots: next,
          activeRootId: activeRootId === id ? next[0]?.id ?? null : activeRootId,
        });
        void persistRoots(next);
        if (target) {
          void unwatchRoot(target.path).catch((err) =>
            console.warn("[fileExplorer] unwatchRoot failed:", err),
          );
        }
      },

      renameRoot: (id, name) => {
        const roots = get().roots.map((r) => (r.id === id ? { ...r, name } : r));
        set({ roots });
        void persistRoots(roots);
      },

      setActiveRootId: (id) => set({ activeRootId: id }),
      setSelectedPath: (path) => set({ selectedPath: path }),
      setSortMode: (mode) => set({ sortMode: mode }),
      startCreating: (parentPath, kind) => set({ creatingIn: { parentPath, kind } }),
      cancelCreating: () => set({ creatingIn: null }),

      ensureLoaded: async (path) => {
        const { entries, loadingPaths } = get();
        if (entries[path] || loadingPaths.has(path)) return;
        const nextLoading = new Set(loadingPaths);
        nextLoading.add(path);
        set({ loadingPaths: nextLoading });
        try {
          const result = await listDirectory(path);
          set((state) => {
            const nextEntries = { ...state.entries, [path]: result };
            const nextErrors = { ...state.errors };
            delete nextErrors[path];
            const nextLoadingPaths = new Set(state.loadingPaths);
            nextLoadingPaths.delete(path);
            return {
              entries: nextEntries,
              errors: nextErrors,
              loadingPaths: nextLoadingPaths,
            };
          });
        } catch (err) {
          set((state) => {
            const nextLoadingPaths = new Set(state.loadingPaths);
            nextLoadingPaths.delete(path);
            return {
              loadingPaths: nextLoadingPaths,
              errors: { ...state.errors, [path]: String(err) },
            };
          });
        }
      },

      toggleExpand: async (path) => {
        const expanded = new Set(get().expanded);
        if (expanded.has(path)) {
          expanded.delete(path);
          set({ expanded });
          return;
        }
        expanded.add(path);
        set({ expanded });
        await get().ensureLoaded(path);
      },

      setExpanded: async (path, isExpanded) => {
        const expanded = new Set(get().expanded);
        if (isExpanded) {
          expanded.add(path);
          set({ expanded });
          await get().ensureLoaded(path);
        } else {
          expanded.delete(path);
          set({ expanded });
        }
      },

      refresh: async (path) => {
        set((state) => {
          const nextEntries = { ...state.entries };
          delete nextEntries[path];
          return { entries: nextEntries };
        });
        await get().ensureLoaded(path);
      },

      invalidate: (path) => {
        set((state) => {
          if (!state.entries[path] && !state.errors[path]) return state;
          const nextEntries = { ...state.entries };
          const nextErrors = { ...state.errors };
          delete nextEntries[path];
          delete nextErrors[path];
          return { entries: nextEntries, errors: nextErrors };
        });
        if (get().expanded.has(path)) {
          void get().ensureLoaded(path);
        }
      },

      startDrag: (path, name, x, y) => set({ dragging: { path, name, x, y } }),
      updateDrag: (x, y) =>
        set((state) =>
          state.dragging ? { dragging: { ...state.dragging, x, y } } : state,
        ),
      endDrag: () => set({ dragging: null }),

      openContextMenu: (state) => set({ contextMenu: state }),
      closeContextMenu: () => set({ contextMenu: null }),
    }),
    {
      name: "mycmux:fileExplorer",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ sortMode: state.sortMode }),
      version: 1,
    },
  ),
);
