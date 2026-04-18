import { create } from "zustand";
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

interface FileExplorerState {
  roots: PinnedRoot[];
  activeRootId: string | null;

  entries: EntriesMap;
  errors: ErrorsMap;
  loadingPaths: Set<string>;
  expanded: Set<string>;
  selectedPath: string | null;

  // Root management
  setRoots: (roots: PinnedRoot[]) => void;
  addRoot: (root: PinnedRoot) => void;
  removeRoot: (id: string) => void;
  renameRoot: (id: string, name: string) => void;
  setActiveRootId: (id: string | null) => void;

  // Tree navigation
  toggleExpand: (path: string) => Promise<void>;
  setExpanded: (path: string, expanded: boolean) => Promise<void>;
  ensureLoaded: (path: string) => Promise<void>;
  refresh: (path: string) => Promise<void>;
  invalidate: (path: string) => void;
  setSelectedPath: (path: string | null) => void;
}

function basename(path: string): string {
  const cleaned = path.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
  return idx < 0 ? cleaned : cleaned.slice(idx + 1) || cleaned;
}

async function persistRoots(roots: PinnedRoot[]) {
  try {
    await savePinnedRoots(roots);
  } catch (err) {
    console.warn("[fileExplorer] Failed to persist pinned roots:", err);
  }
}

export const useFileExplorerStore = create<FileExplorerState>((set, get) => ({
  roots: [],
  activeRootId: null,
  entries: {},
  errors: {},
  loadingPaths: new Set(),
  expanded: new Set(),
  selectedPath: null,

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
      activeRootId:
        activeRootId === id ? next[0]?.id ?? null : activeRootId,
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

  ensureLoaded: async (path) => {
    const { entries, loadingPaths } = get();
    if (entries[path] || loadingPaths.has(path)) return;
    const nextLoading = new Set(loadingPaths);
    nextLoading.add(path);
    set({ loadingPaths: nextLoading });
    try {
      const result = await listDirectory(path);
      set((state) => {
        const ne = { ...state.entries, [path]: result };
        const nErrors = { ...state.errors };
        delete nErrors[path];
        const nLoading = new Set(state.loadingPaths);
        nLoading.delete(path);
        return { entries: ne, errors: nErrors, loadingPaths: nLoading };
      });
    } catch (err) {
      set((state) => {
        const nLoading = new Set(state.loadingPaths);
        nLoading.delete(path);
        return {
          loadingPaths: nLoading,
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
      const nEntries = { ...state.entries };
      delete nEntries[path];
      return { entries: nEntries };
    });
    await get().ensureLoaded(path);
  },

  invalidate: (path) => {
    set((state) => {
      if (!state.entries[path] && !state.errors[path]) return state;
      const nEntries = { ...state.entries };
      const nErrors = { ...state.errors };
      delete nEntries[path];
      delete nErrors[path];
      return { entries: nEntries, errors: nErrors };
    });
    if (get().expanded.has(path)) {
      void get().ensureLoaded(path);
    }
  },
}));
