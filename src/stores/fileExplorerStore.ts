import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import {
  type FileEntry,
  type PinnedRoot,
  listDirectory,
  savePinnedRoots,
  unwatchRoot,
  walkTree,
  watchRoot,
} from "../lib/ipc";

type EntriesMap = Record<string, FileEntry[]>;
type ErrorsMap = Record<string, string>;
type SearchIndexMap = Record<string, FileEntry[]>;
type SearchIndexStatus = "idle" | "building" | "ready" | "error";
type SearchIndexStatusMap = Record<string, SearchIndexStatus>;

export interface DragState {
  paths: string[];
  primaryName: string;
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
  recentJumps: string[];
  searchIndex: SearchIndexMap;
  searchIndexStatus: SearchIndexStatusMap;
  creatingIn: CreatingInState | null;

  entries: EntriesMap;
  errors: ErrorsMap;
  loadingPaths: Set<string>;
  expanded: Set<string>;
  selectedPath: string | null;
  selectedPaths: Set<string>;
  selectionAnchorPath: string | null;
  dragging: DragState | null;
  contextMenu: ContextMenuState | null;

  setRoots: (roots: PinnedRoot[]) => void;
  addRoot: (root: PinnedRoot) => void;
  removeRoot: (id: string) => void;
  renameRoot: (id: string, name: string) => void;
  setActiveRootId: (id: string | null) => void;
  addRecentJump: (path: string) => void;
  buildSearchIndex: (rootPath: string) => Promise<void>;

  toggleExpand: (path: string) => Promise<void>;
  setExpanded: (path: string, expanded: boolean) => Promise<void>;
  ensureLoaded: (path: string) => Promise<void>;
  refresh: (path: string) => Promise<void>;
  invalidate: (path: string) => void;
  setSelectedPath: (path: string | null) => void;
  toggleSelectedPath: (path: string) => void;
  selectPathRange: (
    targetPath: string,
    orderedPaths: string[],
    additive: boolean,
  ) => void;
  clearSelection: () => void;
  setSortMode: (mode: SortMode) => void;
  startCreating: (parentPath: string, kind: "file" | "folder") => void;
  cancelCreating: () => void;

  startDrag: (paths: string[], primaryName: string, x: number, y: number) => void;
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
      recentJumps: [],
      searchIndex: {},
      searchIndexStatus: {},
      creatingIn: null,
      entries: {},
      errors: {},
      loadingPaths: new Set(),
      expanded: new Set(),
      selectedPath: null,
      selectedPaths: new Set(),
      selectionAnchorPath: null,
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
        void get().buildSearchIndex(normalized.path);
      },

      removeRoot: (id) => {
        const { roots, activeRootId } = get();
        const target = roots.find((r) => r.id === id);
        const next = roots.filter((r) => r.id !== id);
        set((state) => {
          if (!target) {
            return {
              roots: next,
              activeRootId: activeRootId === id ? next[0]?.id ?? null : activeRootId,
            };
          }

          const nextSearchIndex = { ...state.searchIndex };
          const nextSearchIndexStatus = { ...state.searchIndexStatus };
          const nextErrors = { ...state.errors };
          delete nextSearchIndex[target.path];
          delete nextSearchIndexStatus[target.path];
          delete nextErrors[target.path];

          return {
            roots: next,
            activeRootId: activeRootId === id ? next[0]?.id ?? null : activeRootId,
            errors: nextErrors,
            searchIndex: nextSearchIndex,
            searchIndexStatus: nextSearchIndexStatus,
          };
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

      setActiveRootId: (id) => {
        set({ activeRootId: id });
        const root = get().roots.find((entry) => entry.id === id);
        if (!root) {
          return;
        }

        const status = get().searchIndexStatus[root.path] ?? "idle";
        if (status !== "ready" && status !== "building") {
          void get().buildSearchIndex(root.path);
        }
      },
      addRecentJump: (path) =>
        set((state) => {
          const trimmed = path.trim();
          if (!trimmed) {
            return state;
          }

          return {
            recentJumps: [
              trimmed,
              ...state.recentJumps.filter((entry) => entry !== trimmed),
            ].slice(0, 20),
          };
        }),
      buildSearchIndex: async (rootPath) => {
        const status = get().searchIndexStatus[rootPath] ?? "idle";
        if (status === "building") {
          return;
        }

        set((state) => ({
          searchIndexStatus: { ...state.searchIndexStatus, [rootPath]: "building" },
        }));

        try {
          const result = await walkTree(rootPath, [], 10, 50_000, false);
          set((state) => {
            const rootStillExists = state.roots.some((root) => root.path === rootPath);
            const nextErrors = { ...state.errors };
            delete nextErrors[rootPath];

            if (!rootStillExists) {
              const nextSearchIndex = { ...state.searchIndex };
              const nextSearchIndexStatus = { ...state.searchIndexStatus };
              delete nextSearchIndex[rootPath];
              delete nextSearchIndexStatus[rootPath];
              return {
                errors: nextErrors,
                searchIndex: nextSearchIndex,
                searchIndexStatus: nextSearchIndexStatus,
              };
            }

            return {
              errors: nextErrors,
              searchIndex: { ...state.searchIndex, [rootPath]: result },
              searchIndexStatus: { ...state.searchIndexStatus, [rootPath]: "ready" },
            };
          });
        } catch (err) {
          const message = String(err);
          set((state) => {
            if (!state.roots.some((root) => root.path === rootPath)) {
              const nextSearchIndex = { ...state.searchIndex };
              const nextSearchIndexStatus = { ...state.searchIndexStatus };
              delete nextSearchIndex[rootPath];
              delete nextSearchIndexStatus[rootPath];
              return {
                searchIndex: nextSearchIndex,
                searchIndexStatus: nextSearchIndexStatus,
              };
            }

            return {
              errors: { ...state.errors, [rootPath]: message },
              searchIndexStatus: { ...state.searchIndexStatus, [rootPath]: "error" },
            };
          });
        }
      },
      setSelectedPath: (path) =>
        set({
          selectedPath: path,
          selectedPaths: path ? new Set([path]) : new Set(),
          selectionAnchorPath: path,
        }),
      toggleSelectedPath: (path) =>
        set((state) => {
          const selectedPaths = new Set(state.selectedPaths);
          if (selectedPaths.has(path)) {
            selectedPaths.delete(path);
          } else {
            selectedPaths.add(path);
          }
          const selectedPath = selectedPaths.has(path)
            ? path
            : state.selectedPath === path
              ? (() => {
                  const remaining = Array.from(selectedPaths);
                  return remaining.length > 0 ? remaining[remaining.length - 1] : null;
                })()
              : state.selectedPath;
          return {
            selectedPath,
            selectedPaths,
            selectionAnchorPath: path,
          };
        }),
      selectPathRange: (targetPath, orderedPaths, additive) =>
        set((state) => {
          const anchorPath = state.selectionAnchorPath ?? state.selectedPath ?? targetPath;
          const anchorIndex = orderedPaths.indexOf(anchorPath);
          const targetIndex = orderedPaths.indexOf(targetPath);
          const selectedPaths = additive ? new Set(state.selectedPaths) : new Set<string>();

          if (anchorIndex < 0 || targetIndex < 0) {
            selectedPaths.add(targetPath);
            return {
              selectedPath: targetPath,
              selectedPaths,
              selectionAnchorPath: anchorPath,
            };
          }

          const [start, end] =
            anchorIndex <= targetIndex
              ? [anchorIndex, targetIndex]
              : [targetIndex, anchorIndex];

          for (const path of orderedPaths.slice(start, end + 1)) {
            selectedPaths.add(path);
          }

          return {
            selectedPath: targetPath,
            selectedPaths,
            selectionAnchorPath: anchorPath,
          };
        }),
      clearSelection: () =>
        set({
          selectedPath: null,
          selectedPaths: new Set(),
          selectionAnchorPath: null,
        }),
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
        const isRoot = get().roots.some((root) => root.path === path);
        set((state) => {
          const nextEntries = { ...state.entries };
          delete nextEntries[path];
          return { entries: nextEntries };
        });
        await get().ensureLoaded(path);
        if (isRoot) {
          void get().buildSearchIndex(path);
        }
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

      startDrag: (paths, primaryName, x, y) =>
        set({ dragging: { paths, primaryName, x, y } }),
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
      partialize: (state) => ({
        sortMode: state.sortMode,
        recentJumps: state.recentJumps,
      }),
      version: 1,
    },
  ),
);
