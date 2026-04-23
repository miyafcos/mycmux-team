import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  File as FileIcon,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  MoreHorizontal,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import { v4 as uuidv4 } from "uuid";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import PathJumper from "./PathJumper";

import {
  useFileExplorerStore,
  type SortMode,
} from "../../stores/fileExplorerStore";
import { useWorkspaceListStore } from "../../stores/workspaceListStore";
import {
  createFile,
  createFolder,
  normalizePath,
  openWithDefault,
  revealInExplorer,
  writeToSession,
  type FileEntry,
  type PinnedRoot,
} from "../../lib/ipc";
import {
  basename,
  pathSegmentsUnder,
  quoteShellPath,
  splitExtension,
} from "../../lib/paths";

const SORT_CYCLE: SortMode[] = ["name-asc", "name-desc", "mtime-desc", "mtime-asc"];

const SORT_LABEL_BASE: Record<SortMode, string> = {
  "name-asc": "名前",
  "name-desc": "名前",
  "mtime-desc": "更新",
  "mtime-asc": "更新",
};

const NAME_COLLATOR = new Intl.Collator(undefined, {
  sensitivity: "base",
  numeric: true,
});

function sortEntries(
  entries: FileEntry[] | undefined,
  mode: SortMode,
): FileEntry[] | undefined {
  if (!entries) return entries;
  const cmp = (a: FileEntry, b: FileEntry): number => {
    switch (mode) {
      case "name-asc":
        return NAME_COLLATOR.compare(a.name, b.name);
      case "name-desc":
        return NAME_COLLATOR.compare(b.name, a.name);
      case "mtime-desc": {
        const am = a.modified ?? 0;
        const bm = b.modified ?? 0;
        if (am === bm) return NAME_COLLATOR.compare(a.name, b.name);
        return bm - am;
      }
      case "mtime-asc": {
        const am = a.modified ?? Number.MAX_SAFE_INTEGER;
        const bm = b.modified ?? Number.MAX_SAFE_INTEGER;
        if (am === bm) return NAME_COLLATOR.compare(a.name, b.name);
        return am - bm;
      }
    }
  };
  const dirs = entries.filter((entry) => entry.is_dir);
  const files = entries.filter((entry) => !entry.is_dir);
  return [...dirs.sort(cmp), ...files.sort(cmp)];
}

function truncateErrorForUi(msg: string, max = 80): string {
  if (msg.length <= max) return msg;
  return `${msg.slice(0, max - 1)}…`;
}

type FileExplorerSnapshot = ReturnType<typeof useFileExplorerStore.getState>;

function collectVisiblePaths(
  parentPath: string,
  state: FileExplorerSnapshot,
  acc: string[],
): void {
  const children = sortEntries(state.entries[parentPath], state.sortMode);
  if (!children) return;
  for (const entry of children) {
    acc.push(entry.path);
    if (entry.is_dir && state.expanded.has(entry.path)) {
      collectVisiblePaths(entry.path, state, acc);
    }
  }
}

function getVisibleOrderedPaths(state: FileExplorerSnapshot): string[] {
  const activeRoot = state.roots.find((root) => root.id === state.activeRootId) ?? null;
  if (!activeRoot) return [];
  const orderedPaths: string[] = [];
  collectVisiblePaths(activeRoot.path, state, orderedPaths);
  return orderedPaths;
}

function getOrderedDragPaths(
  state: FileExplorerSnapshot,
  originPath: string,
): string[] {
  if (!state.selectedPaths.has(originPath)) {
    return [originPath];
  }
  const ordered = getVisibleOrderedPaths(state).filter((path) =>
    state.selectedPaths.has(path),
  );
  return ordered.length > 0 ? ordered : [originPath];
}

function clampMenuPosition(
  preferredLeft: number,
  preferredTop: number,
  width: number,
  height: number,
): { left: number; top: number } {
  const pad = 8;
  let left = preferredLeft;
  let top = preferredTop;

  if (left + width + pad > window.innerWidth) {
    left = Math.max(pad, preferredLeft - width);
  }
  if (top + height + pad > window.innerHeight) {
    top = Math.max(pad, window.innerHeight - height - pad);
  }

  left = Math.max(pad, Math.min(left, window.innerWidth - width - pad));
  top = Math.max(pad, Math.min(top, window.innerHeight - height - pad));

  return { left, top };
}

const ROW_HEIGHT = 24;
const INDENT_PX = 14;

export default memo(function FileExplorerSidebar() {
  const roots = useFileExplorerStore((s) => s.roots);
  const activeRootId = useFileExplorerStore((s) => s.activeRootId);
  const setActiveRootId = useFileExplorerStore((s) => s.setActiveRootId);
  const addRoot = useFileExplorerStore((s) => s.addRoot);
  const removeRoot = useFileExplorerStore((s) => s.removeRoot);
  const refresh = useFileExplorerStore((s) => s.refresh);
  const ensureLoaded = useFileExplorerStore((s) => s.ensureLoaded);
  const setExpanded = useFileExplorerStore((s) => s.setExpanded);
  const addRecentJump = useFileExplorerStore((s) => s.addRecentJump);
  const clearSelection = useFileExplorerStore((s) => s.clearSelection);
  const closeContextMenu = useFileExplorerStore((s) => s.closeContextMenu);

  const activeRoot = roots.find((r) => r.id === activeRootId) ?? null;

  useEffect(() => {
    if (activeRoot) {
      void ensureLoaded(activeRoot.path);
    }
  }, [activeRoot?.path, ensureLoaded]);

  const handleAddRoot = useCallback(async () => {
    try {
      const result = await openDialog({ directory: true, multiple: false });
      if (!result || typeof result !== "string") return;
      const normalized = await normalizePath(result);
      const newRoot: PinnedRoot = {
        id: uuidv4(),
        path: normalized,
        name: basename(normalized) || normalized,
      };
      addRoot(newRoot);
    } catch (err) {
      console.warn("[fileExplorer] Failed to add root:", err);
    }
  }, [addRoot]);

  const handleRemoveRoot = useCallback(() => {
    if (activeRoot) removeRoot(activeRoot.id);
  }, [activeRoot, removeRoot]);

  const handleRefresh = useCallback(() => {
    if (activeRoot) void refresh(activeRoot.path);
  }, [activeRoot, refresh]);

  const handleJumpToPath = useCallback(
    async (path: string) => {
      try {
        if (!activeRoot) {
          return { ok: false, message: "ルートが未設定です" };
        }
        const normalized = await normalizePath(path);
        const segments = pathSegmentsUnder(normalized, activeRoot.path);
        if (segments === null) {
          return { ok: false, message: "現在のルート配下ではありません" };
        }
        let cursor = activeRoot.path;
        for (const seg of segments) {
          await setExpanded(cursor, true);
          const children = useFileExplorerStore.getState().entries[cursor];
          if (!children) break;
          const match = children.find(
            (entry) => entry.name.toLowerCase() === seg.toLowerCase(),
          );
          if (!match) break;
          cursor = match.path;
        }
        useFileExplorerStore.getState().setSelectedPath(cursor);
        addRecentJump(normalized);
        return { ok: true, message: "" };
      } catch (err) {
        return { ok: false, message: String(err) };
      }
    },
    [activeRoot, addRecentJump, setExpanded],
  );

  return (
    <div className="file-explorer" style={sidebarStyle}>
      <RootSwitcher
        roots={roots}
        activeRoot={activeRoot}
        onSelect={setActiveRootId}
        onAdd={handleAddRoot}
        onRemove={handleRemoveRoot}
        onRemoveRoot={removeRoot}
        onRefresh={handleRefresh}
      />
      <PathJumper onJump={handleJumpToPath} />
      <div
        className="file-explorer-tree"
        style={treeScrollStyle}
        onClick={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.ctrlKey || e.metaKey || e.shiftKey) return;
          clearSelection();
          closeContextMenu();
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {activeRoot ? (
          <RootNode root={activeRoot} />
        ) : (
          <div style={emptyStateStyle}>
            フォルダをピン留めしてください
            <br />
            <button type="button" style={emptyStateButtonStyle} onClick={handleAddRoot}>
              <FolderPlus size={14} /> 追加
            </button>
          </div>
        )}
      </div>
      <DragPreview />
      <ContextMenu />
    </div>
  );
});

const ContextMenu = memo(function ContextMenu() {
  const ctx = useFileExplorerStore((s) => s.contextMenu);
  const closeContextMenu = useFileExplorerStore((s) => s.closeContextMenu);
  const startCreating = useFileExplorerStore((s) => s.startCreating);
  const setExpanded = useFileExplorerStore((s) => s.setExpanded);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState({ left: 0, top: 0 });

  useEffect(() => {
    if (!ctx) return;
    const onMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        closeContextMenu();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeContextMenu();
    };
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [ctx, closeContextMenu]);

  useLayoutEffect(() => {
    if (!ctx || !menuRef.current) return;

    const rect = menuRef.current.getBoundingClientRect();
    const { left, top } = clampMenuPosition(ctx.x, ctx.y, rect.width, rect.height);

    setMenuPos((prev) =>
      prev.left === left && prev.top === top ? prev : { left, top },
    );
  }, [ctx]);

  if (!ctx) return null;

  const handleOpen = async () => {
    try {
      await openWithDefault(ctx.path);
    } catch (err) {
      console.warn("[fileExplorer] openWithDefault failed:", err);
    } finally {
      closeContextMenu();
    }
  };

  const handleNewFile = async () => {
    await setExpanded(ctx.path, true);
    startCreating(ctx.path, "file");
    closeContextMenu();
  };

  const handleNewFolder = async () => {
    await setExpanded(ctx.path, true);
    startCreating(ctx.path, "folder");
    closeContextMenu();
  };

  const handleReveal = async () => {
    try {
      await revealInExplorer(ctx.path);
    } catch (err) {
      console.warn("[fileExplorer] reveal failed:", err);
    } finally {
      closeContextMenu();
    }
  };

  return (
    <div
      ref={menuRef}
      style={{
        position: "fixed",
        left: menuPos.left,
        top: menuPos.top,
        zIndex: 9999,
        background: "var(--cmux-surface, #1a1a1a)",
        color: "var(--cmux-text, #ddd)",
        border: "1px solid var(--cmux-border)",
        borderRadius: 4,
        padding: 4,
        boxShadow: "0 4px 12px rgba(0, 0, 0, 0.5)",
        minWidth: 200,
      }}
    >
      {!ctx.isDir && (
        <MenuItem icon={<FileIcon size={12} />} label="開く" onClick={handleOpen} />
      )}
      {ctx.isDir && (
        <>
          <MenuItem
            icon={<FilePlus size={12} />}
            label="新規ファイル"
            onClick={handleNewFile}
          />
          <MenuItem
            icon={<FolderPlus size={12} />}
            label="新規フォルダ"
            onClick={handleNewFolder}
          />
        </>
      )}
      <MenuItem
        icon={<ExternalLink size={12} />}
        label="エクスプローラーで開く"
        onClick={handleReveal}
      />
    </div>
  );
});

function MenuItem({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={contextMenuItemStyle}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--cmux-hover)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

const DragPreview = memo(function DragPreview() {
  const dragging = useFileExplorerStore((s) => s.dragging);
  if (!dragging) return null;
  const label =
    dragging.paths.length <= 1
      ? dragging.primaryName
      : `${dragging.primaryName} + ${dragging.paths.length - 1} items`;
  return (
    <div
      style={{
        position: "fixed",
        left: dragging.x + 12,
        top: dragging.y + 12,
        pointerEvents: "none",
        zIndex: 9999,
        background: "var(--cmux-surface, #1a1a1a)",
        color: "var(--cmux-text, #ddd)",
        border: "1px solid var(--cmux-border)",
        borderRadius: 4,
        padding: "3px 10px",
        fontSize: 11,
        boxShadow: "0 4px 12px rgba(0, 0, 0, 0.5)",
        maxWidth: 320,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </div>
  );
});

const RootSwitcher = memo(function RootSwitcher({
  roots,
  activeRoot,
  onSelect,
  onAdd,
  onRemove,
  onRemoveRoot,
  onRefresh,
}: {
  roots: PinnedRoot[];
  activeRoot: PinnedRoot | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onRemove: () => void;
  onRemoveRoot: (id: string) => void;
  onRefresh: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const actionMenuRef = useRef<HTMLDivElement>(null);
  const [rootActionMenu, setRootActionMenu] = useState<{
    rootId: string;
    x: number;
    y: number;
  } | null>(null);
  const [actionMenuPos, setActionMenuPos] = useState({ left: 0, top: 0 });

  useEffect(() => {
    if (!menuOpen && !rootActionMenu) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      const insideRootMenu = !!menuRef.current?.contains(target);
      const insideActionMenu = !!actionMenuRef.current?.contains(target);
      if (!insideRootMenu && !insideActionMenu) {
        setMenuOpen(false);
        setRootActionMenu(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setRootActionMenu(null);
        setMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", handler);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", handler);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen, rootActionMenu]);

  useEffect(() => {
    if (!menuOpen) {
      setRootActionMenu(null);
    }
  }, [menuOpen]);

  useEffect(() => {
    if (roots.length === 0) {
      setMenuOpen(false);
      setRootActionMenu(null);
    }
  }, [roots.length]);

  useLayoutEffect(() => {
    if (!rootActionMenu || !actionMenuRef.current) return;
    const rect = actionMenuRef.current.getBoundingClientRect();
    const { left, top } = clampMenuPosition(
      rootActionMenu.x,
      rootActionMenu.y,
      rect.width,
      rect.height,
    );
    setActionMenuPos((prev) =>
      prev.left === left && prev.top === top ? prev : { left, top },
    );
  }, [rootActionMenu]);

  const handleRemoveFromList = useCallback(() => {
    if (!rootActionMenu) return;
    onRemoveRoot(rootActionMenu.rootId);
    setRootActionMenu(null);
  }, [onRemoveRoot, rootActionMenu]);

  return (
    <div style={rootSwitcherStyle}>
      <button
        type="button"
        style={rootNameButtonStyle}
        onClick={() => setMenuOpen((open) => !open)}
        disabled={roots.length === 0}
        title={activeRoot?.path ?? "ルート未設定"}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {activeRoot?.name ?? "ルート未設定"}
        </span>
        {roots.length > 1 ? <ChevronDown size={12} /> : null}
      </button>
      <div style={{ flex: 1 }} />
      <SortToggleButton />
      <IconButton title="ルート追加" onClick={onAdd}>
        <Plus size={14} />
      </IconButton>
      <IconButton title="更新" onClick={onRefresh} disabled={!activeRoot}>
        <RefreshCw size={14} />
      </IconButton>
      <IconButton title="このルートを外す" onClick={onRemove} disabled={!activeRoot}>
        <X size={14} />
      </IconButton>
      {menuOpen && roots.length > 0 && (
        <div ref={menuRef} style={rootMenuStyle}>
          {roots.map((root) => (
            <div key={root.id} style={rootMenuRowStyle}>
              <button
                type="button"
                style={{
                  ...rootMenuItemStyle,
                  background: root.id === activeRoot?.id ? "var(--cmux-hover)" : "transparent",
                }}
                onClick={() => {
                  onSelect(root.id);
                  setMenuOpen(false);
                }}
              >
                <Folder size={12} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {root.name}
                </span>
                <span style={rootMenuPathStyle} title={root.path}>
                  {root.path}
                </span>
              </button>
              <button
                type="button"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const rect = e.currentTarget.getBoundingClientRect();
                  setRootActionMenu((prev) =>
                    prev?.rootId === root.id
                      ? null
                      : {
                          rootId: root.id,
                          x: rect.right + 4,
                          y: rect.bottom + 2,
                        },
                  );
                }}
                style={{
                  ...rootMenuActionButtonStyle,
                  background: root.id === activeRoot?.id ? "rgba(255, 255, 255, 0.04)" : "transparent",
                }}
                tabIndex={-1}
                aria-label={`${root.name} actions`}
              >
                <MoreHorizontal size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      {rootActionMenu && (
        <div
          ref={actionMenuRef}
          style={{
            ...floatingMenuStyle,
            left: actionMenuPos.left,
            top: actionMenuPos.top,
            minWidth: 170,
          }}
        >
          <MenuItem
            icon={<X size={12} />}
            label="一覧から削除"
            onClick={handleRemoveFromList}
          />
        </div>
      )}
    </div>
  );
});

const SortToggleButton = memo(function SortToggleButton() {
  const sortMode = useFileExplorerStore((s) => s.sortMode);
  const setSortMode = useFileExplorerStore((s) => s.setSortMode);

  const handleClick = useCallback(() => {
    const idx = SORT_CYCLE.indexOf(sortMode);
    const next = SORT_CYCLE[(idx + 1) % SORT_CYCLE.length];
    setSortMode(next);
  }, [sortMode, setSortMode]);

  const isAsc = sortMode.endsWith("-asc");
  const DirIcon = isAsc ? ArrowUp : ArrowDown;
  const label = SORT_LABEL_BASE[sortMode];

  return (
    <button
      type="button"
      onClick={handleClick}
      title={`並び替え: ${label} ${isAsc ? "昇順" : "降順"} (クリックで切替)`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 3,
        height: 22,
        padding: "0 6px",
        background: "transparent",
        border: "none",
        color: "var(--cmux-text-secondary, #888)",
        fontSize: 10,
        cursor: "pointer",
        borderRadius: 4,
      }}
    >
      <DirIcon size={12} />
      <span>{label}</span>
    </button>
  );
});

const RootNode = memo(function RootNode({ root }: { root: PinnedRoot }) {
  const entries = useFileExplorerStore((s) => s.entries[root.path]);
  const error = useFileExplorerStore((s) => s.errors[root.path]);
  return <ChildList entries={entries} error={error} depth={0} parentPath={root.path} />;
});

const ChildList = memo(function ChildList({
  entries,
  error,
  depth,
  parentPath,
}: {
  entries: FileEntry[] | undefined;
  error: string | undefined;
  depth: number;
  parentPath: string;
}) {
  const sortMode = useFileExplorerStore((s) => s.sortMode);
  const creatingIn = useFileExplorerStore((s) => s.creatingIn);
  const sorted = sortEntries(entries, sortMode);
  const showCreating = !!creatingIn && creatingIn.parentPath === parentPath;

  if (error) {
    return <div style={{ ...errorRowStyle, paddingLeft: depth * INDENT_PX + 8 }}>error: {error}</div>;
  }
  if (!sorted && !showCreating) {
    return <div style={{ ...loadingRowStyle, paddingLeft: depth * INDENT_PX + 8 }}>読み込み中...</div>;
  }
  if (sorted && sorted.length === 0 && !showCreating) {
    return <div style={{ ...emptyRowStyle, paddingLeft: depth * INDENT_PX + 8 }}>(空)</div>;
  }

  const cappedNotice = sorted && sorted.length >= 5000 ? (
    <div style={{ ...emptyRowStyle, paddingLeft: depth * INDENT_PX + 8 }}>
      ... (5000 件で打切り)
    </div>
  ) : null;

  return (
    <>
      {showCreating && creatingIn && (
        <CreateRow
          parentPath={creatingIn.parentPath}
          kind={creatingIn.kind}
          depth={depth}
        />
      )}
      {sorted?.map((entry) => (
        <TreeNode key={entry.path} entry={entry} depth={depth} />
      ))}
      {cappedNotice}
    </>
  );
});

const TreeNode = memo(function TreeNode({
  entry,
  depth,
}: {
  entry: FileEntry;
  depth: number;
}) {
  const expanded = useFileExplorerStore((s) => s.expanded.has(entry.path));
  const children = useFileExplorerStore((s) => s.entries[entry.path]);
  const childError = useFileExplorerStore((s) => s.errors[entry.path]);
  const toggleExpand = useFileExplorerStore((s) => s.toggleExpand);
  const selected = useFileExplorerStore((s) => s.selectedPaths.has(entry.path));

  return (
    <>
      <TreeRow
        depth={depth}
        isDir={entry.is_dir}
        hasChildren={entry.is_dir}
        expanded={expanded}
        selected={selected}
        name={entry.name}
        path={entry.path}
        onToggle={() => toggleExpand(entry.path)}
      />
      {entry.is_dir && expanded && (
        <ChildList
          entries={children}
          error={childError}
          depth={depth + 1}
          parentPath={entry.path}
        />
      )}
    </>
  );
});

const CreateRow = memo(function CreateRow({
  parentPath,
  kind,
  depth,
}: {
  parentPath: string;
  kind: "file" | "folder";
  depth: number;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const committedRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (committedRef.current) return;
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        useFileExplorerStore.getState().cancelCreating();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !committedRef.current) {
        useFileExplorerStore.getState().cancelCreating();
      }
    };
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, []);

  const commit = useCallback(async () => {
    const name = value.trim();
    if (!name) {
      useFileExplorerStore.getState().cancelCreating();
      return;
    }
    committedRef.current = true;
    try {
      const newPath =
        kind === "file"
          ? await createFile(parentPath, name)
          : await createFolder(parentPath, name);
      useFileExplorerStore.getState().cancelCreating();
      await useFileExplorerStore.getState().refresh(parentPath);
      useFileExplorerStore.getState().setSelectedPath(newPath);
    } catch (err) {
      committedRef.current = false;
      setError(String(err));
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [kind, parentPath, value]);

  return (
    <div
      ref={containerRef}
      style={{
        display: "flex",
        flexDirection: "column",
        paddingLeft: depth * INDENT_PX + 6,
        paddingRight: 6,
        paddingTop: 1,
        paddingBottom: 1,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <span style={chevronSlotStyle} />
        <span style={iconSlotStyle}>
          {kind === "folder" ? (
            <Folder size={14} strokeWidth={1.5} />
          ) : (
            <FileIcon size={14} strokeWidth={1.5} />
          )}
        </span>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              e.preventDefault();
              void commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              useFileExplorerStore.getState().cancelCreating();
            }
          }}
          placeholder={kind === "folder" ? "フォルダ名" : "ファイル名"}
          spellCheck={false}
          style={{
            flex: 1,
            minWidth: 0,
            height: 20,
            padding: "1px 4px",
            background: "var(--cmux-bg, #0a0a0a)",
            border: "1px solid var(--cmux-accent, rgba(10, 132, 255, 0.7))",
            borderRadius: 3,
            color: "var(--cmux-text)",
            fontSize: 11,
            fontFamily: "inherit",
            outline: "none",
          }}
        />
      </div>
      {error && (
        <div
          style={{
            color: "#ff6b6b",
            fontSize: 10,
            marginTop: 2,
            marginLeft: 32,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: "100%",
          }}
          title={error}
        >
          {truncateErrorForUi(error)}
        </div>
      )}
    </div>
  );
});

function TreeRow({
  depth,
  isDir,
  hasChildren,
  expanded,
  selected,
  name,
  path,
  onToggle,
}: {
  depth: number;
  isDir: boolean;
  hasChildren: boolean;
  expanded: boolean;
  selected: boolean;
  name: string;
  path: string;
  onToggle: () => void;
}) {
  const justDraggedRef = useRef(false);
  const selectionHandledOnMouseDownRef = useRef(false);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;

    const store = useFileExplorerStore.getState();
    const orderedPaths = getVisibleOrderedPaths(store);
    const ctrlLike = e.ctrlKey || e.metaKey;

    if (e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      selectionHandledOnMouseDownRef.current = true;
      store.selectPathRange(path, orderedPaths, ctrlLike);
      store.closeContextMenu();
      return;
    }

    if (ctrlLike) {
      e.preventDefault();
      e.stopPropagation();
      selectionHandledOnMouseDownRef.current = true;
      store.toggleSelectedPath(path);
      store.closeContextMenu();
      return;
    }

    store.setSelectedPath(path);
    store.closeContextMenu();
    selectionHandledOnMouseDownRef.current = false;
  }, [path]);

  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (justDraggedRef.current) {
      justDraggedRef.current = false;
      return;
    }
    if (selectionHandledOnMouseDownRef.current) {
      selectionHandledOnMouseDownRef.current = false;
      return;
    }
    e.preventDefault();
    e.stopPropagation();

    const store = useFileExplorerStore.getState();
    if (isDir) {
      onToggle();
      return;
    }
    store.openContextMenu({
      path,
      isDir,
      x: e.clientX,
      y: e.clientY,
    });
  }, [isDir, onToggle, path]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 || e.pointerType === "touch") return;
      if (e.ctrlKey || e.metaKey || e.shiftKey) return;

      const startX = e.clientX;
      const startY = e.clientY;
      const thresholdSq = 16;
      let started = false;
      let dragPaths: string[] = [];

      const store = useFileExplorerStore.getState();

      const onMove = (ev: PointerEvent) => {
        if (!started) {
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          if (dx * dx + dy * dy < thresholdSq) return;
          started = true;
          dragPaths = getOrderedDragPaths(useFileExplorerStore.getState(), path);
          document.body.style.userSelect = "none";
          document.body.style.cursor = "grabbing";
          store.startDrag(dragPaths, name, ev.clientX, ev.clientY);
        } else {
          useFileExplorerStore.getState().updateDrag(ev.clientX, ev.clientY);
        }
      };

      const cleanup = () => {
        window.removeEventListener("pointermove", onMove, true);
        window.removeEventListener("pointerup", onUp, true);
        window.removeEventListener("pointercancel", onCancel, true);
        window.removeEventListener("keydown", onKey, true);
      };

      const onUp = (ev: PointerEvent) => {
        cleanup();
        if (!started) return;
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        justDraggedRef.current = true;
        setTimeout(() => {
          justDraggedRef.current = false;
        }, 0);

        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        const paneEl = el?.closest("[data-session-id]");
        const paneSessionId = paneEl?.getAttribute("data-session-id") ?? null;
        if (paneSessionId) {
          const workspaces = useWorkspaceListStore.getState().workspaces;
          let targetSessionId = paneSessionId;
          outer: for (const workspace of workspaces) {
            for (const pane of workspace.panes) {
              if (pane.sessionId === paneSessionId) {
                const activeTab = pane.tabs.find((tab) => tab.id === pane.activeTabId);
                targetSessionId = activeTab?.sessionId ?? paneSessionId;
                break outer;
              }
            }
          }
          const shellPayload = (dragPaths.length > 0 ? dragPaths : [path])
            .map((dragPath) => quoteShellPath(dragPath))
            .join(" ");
          void writeToSession(targetSessionId, `${shellPayload} `);
        }
        useFileExplorerStore.getState().endDrag();
      };

      const onCancel = () => {
        cleanup();
        if (started) {
          document.body.style.userSelect = "";
          document.body.style.cursor = "";
          useFileExplorerStore.getState().endDrag();
        }
      };

      const onKey = (ev: KeyboardEvent) => {
        if (ev.key === "Escape") onCancel();
      };

      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", onUp, true);
      window.addEventListener("pointercancel", onCancel, true);
      window.addEventListener("keydown", onKey, true);
    },
    [name, path],
  );

  const handleChevronClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();
      useFileExplorerStore.getState().setSelectedPath(path);
      useFileExplorerStore.getState().closeContextMenu();
      if (hasChildren) {
        onToggle();
      }
    },
    [hasChildren, onToggle, path],
  );

  const handleActionButtonClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const store = useFileExplorerStore.getState();
      store.setSelectedPath(path);
      const rect = e.currentTarget.getBoundingClientRect();
      store.openContextMenu({
        path,
        isDir,
        x: rect.right,
        y: rect.bottom + 2,
      });
    },
    [isDir, path],
  );

  const renderName = () => {
    if (isDir) {
      return <span style={nameStyle}>{name}</span>;
    }
    const { base, ext } = splitExtension(name);
    if (!ext) {
      return <span style={nameStyle}>{name}</span>;
    }
    return (
      <>
        <span style={{ ...nameStyle, flex: 1, minWidth: 0 }}>{base}</span>
        <span style={{ flexShrink: 0, color: "var(--cmux-text-secondary, #888)" }}>{ext}</span>
      </>
    );
  };

  return (
    <div
      onMouseDown={handleMouseDown}
      onPointerDown={handlePointerDown}
      onClick={handleClick}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      className={`file-explorer-row${selected ? " selected" : ""}`}
      style={{
        ...rowStyle,
        paddingLeft: depth * INDENT_PX + 6,
        background: selected ? "rgba(10, 132, 255, 0.18)" : "transparent",
        boxShadow: selected
          ? "inset 2px 0 0 var(--cmux-accent, #0a84ff), inset 0 0 0 1px rgba(10, 132, 255, 0.22)"
          : "none",
        color: selected ? "var(--cmux-text, #ddd)" : "var(--cmux-text-secondary, #aaa)",
      }}
      title={path}
    >
      <button
        type="button"
        disabled={!hasChildren}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={handleChevronClick}
        style={{
          ...chevronButtonStyle,
          cursor: hasChildren ? "pointer" : "default",
        }}
        tabIndex={-1}
        aria-label={expanded ? "Collapse folder" : "Expand folder"}
      >
        <span style={chevronSlotStyle}>
          {hasChildren ? (
            expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />
          ) : null}
        </span>
      </button>
      <span style={iconSlotStyle}>
        {isDir ? (
          expanded ? <FolderOpen size={14} strokeWidth={1.5} /> : <Folder size={14} strokeWidth={1.5} />
        ) : (
          <FileIcon size={14} strokeWidth={1.5} />
        )}
      </span>
      {renderName()}
      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={handleActionButtonClick}
        style={{
          ...rowActionButtonStyle,
          opacity: selected ? 1 : 0.72,
          color: selected ? "var(--cmux-text, #ddd)" : "var(--cmux-text-secondary, #888)",
        }}
        tabIndex={-1}
        aria-label="Open item actions"
      >
        <MoreHorizontal size={12} />
      </button>
    </div>
  );
}

function IconButton({
  children,
  onClick,
  title,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        ...iconButtonStyle,
        opacity: disabled ? 0.35 : 1,
        cursor: disabled ? "default" : "pointer",
      }}
    >
      {children}
    </button>
  );
}

const sidebarStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  background: "var(--cmux-sidebar, #111)",
  color: "var(--cmux-text, #ddd)",
  fontSize: 12,
  minWidth: 0,
};

const rootSwitcherStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 2,
  padding: "4px 6px",
  height: 32,
  borderBottom: "1px solid var(--cmux-border)",
  position: "relative",
};

const rootNameButtonStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  padding: "2px 6px",
  height: 24,
  maxWidth: 140,
  background: "transparent",
  border: "none",
  color: "var(--cmux-text)",
  fontSize: 12,
  cursor: "pointer",
  textAlign: "left",
  borderRadius: 4,
};

const iconButtonStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 22,
  height: 22,
  background: "transparent",
  border: "none",
  color: "var(--cmux-text-secondary, #888)",
  borderRadius: 4,
};

const rootMenuStyle: React.CSSProperties = {
  position: "absolute",
  top: 30,
  left: 4,
  right: 4,
  background: "var(--cmux-surface, #1a1a1a)",
  border: "1px solid var(--cmux-border)",
  borderRadius: 4,
  zIndex: 20,
  maxHeight: 200,
  overflowY: "auto",
  padding: 4,
};

const rootMenuRowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) 20px",
  gap: 4,
  alignItems: "center",
};

const rootMenuItemStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "14px auto minmax(0, 1fr)",
  gap: 6,
  alignItems: "center",
  width: "100%",
  padding: "4px 6px",
  border: "none",
  color: "var(--cmux-text)",
  fontSize: 12,
  cursor: "pointer",
  textAlign: "left",
  borderRadius: 3,
};

const rootMenuPathStyle: React.CSSProperties = {
  color: "var(--cmux-text-secondary, #777)",
  fontSize: 10,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  textAlign: "right",
};

const treeScrollStyle: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  overflowX: "hidden",
  paddingBottom: 8,
  userSelect: "none",
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  height: ROW_HEIGHT,
  paddingRight: 6,
  gap: 4,
  cursor: "pointer",
  color: "var(--cmux-text-secondary, #aaa)",
  borderRadius: 4,
};

const chevronSlotStyle: React.CSSProperties = {
  width: 14,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "var(--cmux-text-secondary, #888)",
  flexShrink: 0,
};

const chevronButtonStyle: React.CSSProperties = {
  width: 14,
  minWidth: 14,
  height: 18,
  padding: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "transparent",
  border: "none",
  cursor: "pointer",
  flexShrink: 0,
};

const iconSlotStyle: React.CSSProperties = {
  width: 14,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "var(--cmux-text-secondary, #888)",
  flexShrink: 0,
};

const rowActionButtonStyle: React.CSSProperties = {
  width: 18,
  minWidth: 18,
  height: 18,
  padding: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "transparent",
  border: "none",
  borderRadius: 4,
  cursor: "pointer",
  flexShrink: 0,
};

const rootMenuActionButtonStyle: React.CSSProperties = {
  ...rowActionButtonStyle,
  width: 20,
  minWidth: 20,
  height: 20,
  color: "var(--cmux-text-secondary, #888)",
};

const floatingMenuStyle: React.CSSProperties = {
  position: "fixed",
  zIndex: 9999,
  background: "var(--cmux-surface, #1a1a1a)",
  color: "var(--cmux-text, #ddd)",
  border: "1px solid var(--cmux-border)",
  borderRadius: 4,
  padding: 4,
  boxShadow: "0 4px 12px rgba(0, 0, 0, 0.5)",
};

const nameStyle: React.CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  flex: 1,
  minWidth: 0,
};

const emptyStateStyle: React.CSSProperties = {
  padding: 16,
  fontSize: 11,
  color: "var(--cmux-text-secondary, #888)",
  textAlign: "center",
  lineHeight: 1.6,
};

const emptyStateButtonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  marginTop: 8,
  padding: "4px 10px",
  background: "var(--cmux-hover)",
  color: "var(--cmux-text)",
  border: "1px solid var(--cmux-border)",
  borderRadius: 4,
  fontSize: 11,
  cursor: "pointer",
};

const errorRowStyle: React.CSSProperties = {
  padding: "2px 8px",
  color: "#ff6b6b",
  fontSize: 10,
  lineHeight: 1.4,
};

const loadingRowStyle: React.CSSProperties = {
  padding: "2px 8px",
  color: "var(--cmux-text-secondary, #777)",
  fontSize: 10,
};

const emptyRowStyle: React.CSSProperties = {
  padding: "2px 8px",
  color: "var(--cmux-text-secondary, #777)",
  fontSize: 10,
  fontStyle: "italic",
};

const contextMenuItemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  width: "100%",
  padding: "4px 10px",
  background: "transparent",
  border: "none",
  color: "var(--cmux-text, #ddd)",
  fontSize: 12,
  cursor: "pointer",
  textAlign: "left",
  borderRadius: 3,
};
