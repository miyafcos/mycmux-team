import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  File as FileIcon,
  Folder,
  FolderOpen,
  FolderPlus,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import { v4 as uuidv4 } from "uuid";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { useFileExplorerStore } from "../../stores/fileExplorerStore";
import { useWorkspaceListStore } from "../../stores/workspaceListStore";
import {
  normalizePath,
  revealInExplorer,
  writeToSession,
  type FileEntry,
  type PinnedRoot,
} from "../../lib/ipc";
import { basename, pathSegmentsUnder, quoteShellPath } from "../../lib/paths";

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

  const activeRoot = roots.find((r) => r.id === activeRootId) ?? null;

  // Ensure active root's top level is loaded whenever the root changes.
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
        if (!activeRoot) return { ok: false, message: "ルートが未設定です" };
        const normalized = await normalizePath(path);
        const segments = pathSegmentsUnder(normalized, activeRoot.path);
        if (segments === null) {
          return { ok: false, message: "現在のルート外です" };
        }
        // Walk down using the *actual* entry paths returned by list_directory so
        // we never trip over Windows case-folding (user types `src` but the
        // folder is `Src`). Each ensureLoaded resolves before the next lookup.
        let cursor = activeRoot.path;
        for (const seg of segments) {
          await setExpanded(cursor, true);
          const children = useFileExplorerStore.getState().entries[cursor];
          if (!children) break;
          const match = children.find(
            (e) => e.name.toLowerCase() === seg.toLowerCase(),
          );
          if (!match) break;
          cursor = match.path;
        }
        useFileExplorerStore.getState().setSelectedPath(cursor);
        return { ok: true, message: "" };
      } catch (err) {
        return { ok: false, message: String(err) };
      }
    },
    [activeRoot, setExpanded],
  );

  return (
    <div className="file-explorer" style={sidebarStyle}>
      <RootSwitcher
        roots={roots}
        activeRoot={activeRoot}
        onSelect={setActiveRootId}
        onAdd={handleAddRoot}
        onRemove={handleRemoveRoot}
        onRefresh={handleRefresh}
      />
      <PathInput onSubmit={handleJumpToPath} />
      <div className="file-explorer-tree" style={treeScrollStyle}>
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

// ─── Context menu (right-click on a tree row) ───────────────────────────────

const ContextMenu = memo(function ContextMenu() {
  const ctx = useFileExplorerStore((s) => s.contextMenu);
  const closeContextMenu = useFileExplorerStore((s) => s.closeContextMenu);
  const menuRef = useRef<HTMLDivElement>(null);

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

  if (!ctx) return null;

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
        left: ctx.x,
        top: ctx.y,
        zIndex: 9999,
        background: "var(--cmux-surface, #1a1a1a)",
        color: "var(--cmux-text, #ddd)",
        border: "1px solid var(--cmux-border)",
        borderRadius: 4,
        padding: 4,
        boxShadow: "0 4px 12px rgba(0, 0, 0, 0.5)",
        minWidth: 180,
      }}
    >
      <button
        type="button"
        onClick={handleReveal}
        style={contextMenuItemStyle}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--cmux-hover)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
        }}
      >
        <ExternalLink size={12} />
        <span>エクスプローラーで開く</span>
      </button>
    </div>
  );
});

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

// ─── Drag preview (cursor-following ghost during manual drag) ───────────────

const DragPreview = memo(function DragPreview() {
  const dragging = useFileExplorerStore((s) => s.dragging);
  if (!dragging) return null;
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
      {dragging.name}
    </div>
  );
});

// ─── Root switcher (top bar) ─────────────────────────────────────────────────

const RootSwitcher = memo(function RootSwitcher({
  roots,
  activeRoot,
  onSelect,
  onAdd,
  onRemove,
  onRefresh,
}: {
  roots: PinnedRoot[];
  activeRoot: PinnedRoot | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onRemove: () => void;
  onRefresh: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  return (
    <div style={rootSwitcherStyle}>
      <button
        type="button"
        style={rootNameButtonStyle}
        onClick={() => setMenuOpen((v) => !v)}
        disabled={roots.length === 0}
        title={activeRoot?.path ?? "ルート未設定"}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {activeRoot?.name ?? "ルート未設定"}
        </span>
        {roots.length > 1 ? <ChevronDown size={12} /> : null}
      </button>
      <div style={{ flex: 1 }} />
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
          {roots.map((r) => (
            <button
              key={r.id}
              type="button"
              style={{
                ...rootMenuItemStyle,
                background: r.id === activeRoot?.id ? "var(--cmux-hover)" : "transparent",
              }}
              onClick={() => {
                onSelect(r.id);
                setMenuOpen(false);
              }}
            >
              <Folder size={12} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {r.name}
              </span>
              <span style={rootMenuPathStyle} title={r.path}>
                {r.path}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

// ─── Path input ──────────────────────────────────────────────────────────────

const PathInput = memo(function PathInput({
  onSubmit,
}: {
  onSubmit: (path: string) => Promise<{ ok: boolean; message: string }>;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(async () => {
    if (!value.trim()) return;
    const res = await onSubmit(value.trim());
    if (!res.ok) {
      setError(res.message);
    } else {
      setError(null);
      setValue("");
    }
  }, [value, onSubmit]);

  return (
    <div style={pathInputContainerStyle}>
      <input
        type="text"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          if (error) setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void handleSubmit();
          }
        }}
        placeholder="パス貼付 → Enter"
        spellCheck={false}
        style={pathInputStyle}
      />
      {error ? <div style={pathErrorStyle}>{error}</div> : null}
    </div>
  );
});

// ─── Tree rendering ──────────────────────────────────────────────────────────

const RootNode = memo(function RootNode({ root }: { root: PinnedRoot }) {
  const entries = useFileExplorerStore((s) => s.entries[root.path]);
  const error = useFileExplorerStore((s) => s.errors[root.path]);

  // The active root is always implicitly expanded: it's the tree's viewport.
  // Children render at depth 0 so there's no wasted left gutter.
  return <ChildList entries={entries} error={error} depth={0} />;
});

const ChildList = memo(function ChildList({
  entries,
  error,
  depth,
}: {
  entries: FileEntry[] | undefined;
  error: string | undefined;
  depth: number;
}) {
  if (error) {
    return <div style={{ ...errorRowStyle, paddingLeft: depth * INDENT_PX + 8 }}>error: {error}</div>;
  }
  if (!entries) {
    return (
      <div style={{ ...loadingRowStyle, paddingLeft: depth * INDENT_PX + 8 }}>読み込み中...</div>
    );
  }
  if (entries.length === 0) {
    return <div style={{ ...emptyRowStyle, paddingLeft: depth * INDENT_PX + 8 }}>(空)</div>;
  }
  const cappedNotice = entries.length >= 5000 ? (
    <div style={{ ...emptyRowStyle, paddingLeft: depth * INDENT_PX + 8 }}>... (5000 件で打切り)</div>
  ) : null;
  return (
    <>
      {entries.map((entry) => (
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
  const selected = useFileExplorerStore((s) => s.selectedPath === entry.path);
  const setSelected = useFileExplorerStore((s) => s.setSelectedPath);

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
        onSelect={() => setSelected(entry.path)}
      />
      {entry.is_dir && expanded && (
        <ChildList entries={children} error={childError} depth={depth + 1} />
      )}
    </>
  );
});

// ─── Single row ──────────────────────────────────────────────────────────────

function TreeRow({
  depth,
  isDir,
  hasChildren,
  expanded,
  selected,
  name,
  path,
  onToggle,
  onSelect,
}: {
  depth: number;
  isDir: boolean;
  hasChildren: boolean;
  expanded: boolean;
  selected: boolean;
  name: string;
  path: string;
  onToggle: () => void;
  onSelect: () => void;
}) {
  const justDraggedRef = useRef(false);

  const handleClick = useCallback(() => {
    // If a drag just concluded, swallow the synthetic click so the user's
    // drop doesn't also collapse/expand the source row.
    if (justDraggedRef.current) {
      justDraggedRef.current = false;
      return;
    }
    onSelect();
    if (isDir && hasChildren) onToggle();
  }, [isDir, hasChildren, onSelect, onToggle]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Left button only; ignore touch/pen for now.
      if (e.button !== 0 || e.pointerType === "touch") return;

      const startX = e.clientX;
      const startY = e.clientY;
      const THRESHOLD_SQ = 16; // 4px in any direction
      let started = false;

      const store = useFileExplorerStore.getState();

      const onMove = (ev: PointerEvent) => {
        if (!started) {
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          if (dx * dx + dy * dy < THRESHOLD_SQ) return;
          started = true;
          document.body.style.userSelect = "none";
          document.body.style.cursor = "grabbing";
          store.startDrag(path, name, ev.clientX, ev.clientY);
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
        // Clear the flag on the next tick in case the click event never fires.
        setTimeout(() => {
          justDraggedRef.current = false;
        }, 0);

        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        const paneEl = el?.closest("[data-session-id]");
        const paneSessionId = paneEl?.getAttribute("data-session-id") ?? null;
        if (paneSessionId) {
          const wsList = useWorkspaceListStore.getState().workspaces;
          let targetSessionId = paneSessionId;
          outer: for (const ws of wsList) {
            for (const p of ws.panes) {
              if (p.sessionId === paneSessionId) {
                const activeTab = p.tabs.find((t) => t.id === p.activeTabId);
                targetSessionId = activeTab?.sessionId ?? paneSessionId;
                break outer;
              }
            }
          }
          void writeToSession(targetSessionId, quoteShellPath(path) + " ");
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

      // Capture phase so xterm or other libs can't stopPropagation before us.
      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", onUp, true);
      window.addEventListener("pointercancel", onCancel, true);
      window.addEventListener("keydown", onKey, true);
    },
    [path, name],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      useFileExplorerStore
        .getState()
        .openContextMenu({ path, isDir, x: e.clientX, y: e.clientY });
    },
    [path, isDir],
  );

  return (
    <div
      onPointerDown={handlePointerDown}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      className={`file-explorer-row${selected ? " selected" : ""}`}
      style={{
        ...rowStyle,
        paddingLeft: depth * INDENT_PX + 6,
        background: selected ? "var(--cmux-hover)" : "transparent",
      }}
      title={path}
    >
      <span style={chevronSlotStyle}>
        {hasChildren ? (
          expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />
        ) : null}
      </span>
      <span style={iconSlotStyle}>
        {isDir ? (
          expanded ? <FolderOpen size={14} strokeWidth={1.5} /> : <Folder size={14} strokeWidth={1.5} />
        ) : (
          <FileIcon size={14} strokeWidth={1.5} />
        )}
      </span>
      <span style={nameStyle}>{name}</span>
    </div>
  );
}

// ─── Shared small components ─────────────────────────────────────────────────

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

// ─── Inline styles ──────────────────────────────────────────────────────────

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
  maxWidth: 160,
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

const rootMenuItemStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "14px auto 1fr",
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

const pathInputContainerStyle: React.CSSProperties = {
  padding: "6px",
  borderBottom: "1px solid var(--cmux-border)",
};

const pathInputStyle: React.CSSProperties = {
  width: "100%",
  height: 24,
  padding: "2px 6px",
  background: "var(--cmux-bg, #0a0a0a)",
  border: "1px solid var(--cmux-border)",
  borderRadius: 4,
  color: "var(--cmux-text)",
  fontSize: 11,
  fontFamily: "inherit",
  outline: "none",
  boxSizing: "border-box",
};

const pathErrorStyle: React.CSSProperties = {
  marginTop: 4,
  color: "#ff6b6b",
  fontSize: 10,
  lineHeight: 1.3,
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
};

const chevronSlotStyle: React.CSSProperties = {
  width: 14,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "var(--cmux-text-secondary, #888)",
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

