import { create } from "zustand";

import {
  type FileEntry,
  type PinnedRoot,
  listDirectory,
  walkTree,
} from "../lib/ipc";

type EntriesMap = Record<string, FileEntry[]>;
type ErrorsMap = Record<string, string>;
type SearchIndexMap = Record<string, FileEntry[]>;
type SearchIndexStatus = "idle" | "building" | "ready" | "error";
type SearchIndexStatusMap = Record<string, SearchIndexStatus>;

interface FileExplorerState {
  roots: PinnedRoot[];
  activeRootId: string | null;
  searchIndex: SearchIndexMap;
  searchIndexStatus: SearchIndexStatusMap;

  entries: EntriesMap;
  errors: ErrorsMap;
  loadingPaths: Set<string>;
  expanded: Set<string>;

  setRoots: (roots: PinnedRoot[]) => void;
  buildSearchIndex: (rootPath: string) => Promise<void>;

  setExpanded: (path: string, expanded: boolean) => Promise<void>;
  ensureLoaded: (path: string) => Promise<void>;
  invalidate: (path: string) => void;
}

export const useFileExplorerStore = create<FileExplorerState>((set, get) => ({
  roots: [],
  activeRootId: null,
  searchIndex: {},
  searchIndexStatus: {},
  entries: {},
  errors: {},
  loadingPaths: new Set(),
  expanded: new Set(),

  setRoots: (roots) => {
    set((state) => ({
      roots,
      activeRootId:
        state.activeRootId && roots.some((r) => r.id === state.activeRootId)
          ? state.activeRootId
          : roots[0]?.id ?? null,
    }));
  },

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
}));
