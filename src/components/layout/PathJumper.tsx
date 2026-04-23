import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import Fuse from "fuse.js";
import {
  Clock3,
  File as FileIcon,
  Folder,
  FolderOpen,
  Search,
  Star,
} from "lucide-react";

import type { FileEntry } from "../../lib/ipc";
import { basename, pathSegmentsUnder } from "../../lib/paths";
import { useFileExplorerStore } from "../../stores/fileExplorerStore";

type JumpResult = { ok: boolean; message: string };
type JumpItemKind = "pinned" | "recent" | "entry";

interface JumpItem {
  id: string;
  path: string;
  name: string;
  kind: JumpItemKind;
  isDir: boolean;
}

const BLUR_CLOSE_DELAY_MS = 200;

function pathKey(path: string): string {
  return path.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
}

function collectLoadedEntries(
  rootPath: string,
  entries: Record<string, FileEntry[]>,
): FileEntry[] {
  const flattened: FileEntry[] = [];
  const seen = new Set<string>();

  const visit = (parentPath: string): void => {
    const children = entries[parentPath];
    if (!children) {
      return;
    }

    for (const entry of children) {
      const key = pathKey(entry.path);
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      flattened.push(entry);
      if (entry.is_dir) {
        visit(entry.path);
      }
    }
  };

  visit(rootPath);
  return flattened;
}

function getParentPath(path: string, rootPath: string): string | null {
  const trimmedPath = path.replace(/[\\/]+$/, "");
  const trimmedRoot = rootPath.replace(/[\\/]+$/, "");
  if (pathKey(trimmedPath) === pathKey(trimmedRoot)) {
    return null;
  }

  const index = Math.max(trimmedPath.lastIndexOf("/"), trimmedPath.lastIndexOf("\\"));
  if (index < 0) {
    return null;
  }

  const parent = trimmedPath.slice(0, index);
  if (!parent) {
    return rootPath.startsWith("/") ? "/" : rootPath;
  }

  if (/^[A-Za-z]:$/.test(parent)) {
    return `${parent}\\`;
  }

  return pathSegmentsUnder(parent, rootPath) !== null ? parent : rootPath;
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  );
}

export default memo(function PathJumper({
  onJump,
}: {
  onJump: (path: string) => Promise<JumpResult>;
}) {
  const roots = useFileExplorerStore((state) => state.roots);
  const activeRootId = useFileExplorerStore((state) => state.activeRootId);
  const entries = useFileExplorerStore((state) => state.entries);
  const recentJumps = useFileExplorerStore((state) => state.recentJumps);
  const searchIndex = useFileExplorerStore((state) => state.searchIndex);
  const searchIndexStatus = useFileExplorerStore((state) => state.searchIndexStatus);
  const selectedPath = useFileExplorerStore((state) => state.selectedPath);
  const setExpanded = useFileExplorerStore((state) => state.setExpanded);
  const buildSearchIndex = useFileExplorerStore((state) => state.buildSearchIndex);

  const activeRoot = useMemo(
    () => roots.find((root) => root.id === activeRootId) ?? null,
    [activeRootId, roots],
  );

  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const blurTimerRef = useRef<number | null>(null);

  const trimmedQuery = query.trim();

  const clearBlurTimer = useCallback(() => {
    if (blurTimerRef.current !== null) {
      window.clearTimeout(blurTimerRef.current);
      blurTimerRef.current = null;
    }
  }, []);

  const closeDropdown = useCallback(() => {
    clearBlurTimer();
    setIsOpen(false);
    setSelectedIndex(-1);
  }, [clearBlurTimer]);

  const openDropdown = useCallback(() => {
    clearBlurTimer();
    setIsOpen(true);
  }, [clearBlurTimer]);

  useEffect(() => () => clearBlurTimer(), [clearBlurTimer]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "p") {
        return;
      }

      const target = event.target as HTMLElement | null;
      const activeElement = document.activeElement as HTMLElement | null;
      if (isEditableElement(target) && !containerRef.current?.contains(target)) {
        return;
      }
      if (
        activeElement &&
        activeElement !== document.body &&
        isEditableElement(activeElement) &&
        !containerRef.current?.contains(activeElement)
      ) {
        return;
      }

      event.preventDefault();
      openDropdown();
      window.requestAnimationFrame(() => inputRef.current?.focus());
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [openDropdown]);

  const pinnedItems = useMemo<JumpItem[]>(
    () =>
      roots.map((root) => ({
        id: `pinned:${root.id}`,
        path: root.path,
        name: root.name || basename(root.path) || root.path,
        kind: "pinned",
        isDir: true,
      })),
    [roots],
  );

  const recentItems = useMemo<JumpItem[]>(
    () =>
      recentJumps
        .filter((path) => !roots.some((root) => pathKey(root.path) === pathKey(path)))
        .map((path) => ({
          id: `recent:${path}`,
          path,
          name: basename(path) || path,
          kind: "recent",
          isDir: true,
        })),
    [recentJumps, roots],
  );

  const sourceEntries = useMemo<FileEntry[]>(
    () =>
      activeRoot
        ? searchIndex[activeRoot.path] ?? collectLoadedEntries(activeRoot.path, entries)
        : [],
    [activeRoot, entries, searchIndex],
  );

  const activeRootSearchStatus = activeRoot
    ? (searchIndexStatus[activeRoot.path] ?? "idle")
    : "idle";

  const sourceEntryItems = useMemo<JumpItem[]>(
    () =>
      sourceEntries.map((entry) => ({
        id: `entry:${entry.path}`,
        path: entry.path,
        name: entry.name || basename(entry.path) || entry.path,
        kind: "entry",
        isDir: entry.is_dir,
      })),
    [sourceEntries],
  );

  const searchItems = useMemo(() => {
    const deduped = new Map<string, JumpItem>();
    for (const item of [...pinnedItems, ...recentItems, ...sourceEntryItems]) {
      const key = pathKey(item.path);
      if (!deduped.has(key)) {
        deduped.set(key, item);
      }
    }
    return [...deduped.values()];
  }, [pinnedItems, recentItems, sourceEntryItems]);

  const fuse = useMemo(
    () => new Fuse(searchItems, { keys: ["name", "path"], threshold: 0.35 }),
    [searchItems],
  );

  const visibleItems = useMemo(() => {
    if (trimmedQuery.length === 0) {
      return [...pinnedItems, ...recentItems];
    }
    return fuse.search(trimmedQuery).map((result) => result.item);
  }, [fuse, pinnedItems, recentItems, trimmedQuery]);

  const selectableIndexes = useMemo(
    () =>
      visibleItems.reduce<number[]>((acc, item, index) => {
        if (item.isDir) {
          acc.push(index);
        }
        return acc;
      }, []),
    [visibleItems],
  );

  const selectedItem =
    selectedIndex >= 0 ? (visibleItems[selectedIndex] ?? null) : null;
  const showIndexingHint =
    activeRootSearchStatus === "building" && sourceEntryItems.length === 0;

  useEffect(() => {
    if (!isOpen || selectableIndexes.length === 0) {
      if (selectedIndex !== -1) {
        setSelectedIndex(-1);
      }
      return;
    }

    if (!selectableIndexes.includes(selectedIndex)) {
      setSelectedIndex(selectableIndexes[0]);
    }
  }, [isOpen, selectableIndexes, selectedIndex]);

  useEffect(() => {
    if (!isOpen || selectedIndex < 0) {
      return;
    }

    rowRefs.current[selectedIndex]?.scrollIntoView({ block: "nearest" });
  }, [isOpen, selectedIndex, visibleItems]);

  const moveSelection = useCallback(
    (direction: 1 | -1) => {
      if (selectableIndexes.length === 0) {
        return;
      }

      if (selectedIndex < 0) {
        setSelectedIndex(
          direction === 1
            ? selectableIndexes[0]
            : selectableIndexes[selectableIndexes.length - 1],
        );
        return;
      }

      const currentPosition = selectableIndexes.indexOf(selectedIndex);
      const nextPosition =
        currentPosition < 0
          ? 0
          : (currentPosition + direction + selectableIndexes.length) %
            selectableIndexes.length;
      setSelectedIndex(selectableIndexes[nextPosition]);
    },
    [selectableIndexes, selectedIndex],
  );

  const handleJump = useCallback(
    async (path: string, closeAfterJump: boolean) => {
      const result = await onJump(path);
      if (!result.ok) {
        setError(result.message);
        openDropdown();
        window.requestAnimationFrame(() => inputRef.current?.focus());
        return;
      }

      setError(null);
      setQuery("");
      if (closeAfterJump) {
        closeDropdown();
        inputRef.current?.blur();
        return;
      }

      openDropdown();
      window.requestAnimationFrame(() => inputRef.current?.focus());
    },
    [closeDropdown, onJump, openDropdown],
  );

  const handleDrill = useCallback(async () => {
    if (!selectedItem?.isDir) {
      return;
    }

    setError(null);
    await setExpanded(selectedItem.path, true);
    openDropdown();
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [openDropdown, selectedItem, setExpanded]);

  const handleJumpToParent = useCallback(() => {
    if (!activeRoot) {
      return;
    }

    const currentPath = selectedPath ?? activeRoot.path;
    const parentPath = getParentPath(currentPath, activeRoot.path);
    if (!parentPath) {
      return;
    }

    void handleJump(parentPath, false);
  }, [activeRoot, handleJump, selectedPath]);

  const renderItem = useCallback(
    (item: JumpItem, index: number) => {
      const selected = index === selectedIndex;
      const selectable = item.isDir;

      return (
        <button
          key={item.id}
          ref={(node) => {
            rowRefs.current[index] = node;
          }}
          type="button"
          role="option"
          aria-selected={selected}
          aria-disabled={!selectable}
          title={item.path}
          onMouseEnter={() => {
            if (selectable) {
              setSelectedIndex(index);
            }
          }}
          onClick={() => {
            if (!selectable) {
              return;
            }
            void handleJump(item.path, true);
          }}
          style={{
            ...itemRowStyle,
            background: selected ? "rgba(10, 132, 255, 0.16)" : "transparent",
            borderColor: selected
              ? "rgba(10, 132, 255, 0.36)"
              : "transparent",
            color: selectable
              ? "var(--cmux-text, #ddd)"
              : "var(--cmux-text-secondary, #888)",
            cursor: selectable ? "pointer" : "default",
            opacity: selectable ? 1 : 0.58,
          }}
        >
          <span style={itemIconStyle}>
            {item.isDir ? (
              selected ? <FolderOpen size={14} /> : <Folder size={14} />
            ) : (
              <FileIcon size={14} />
            )}
          </span>
          <span style={itemTextStyle}>
            <span style={itemNameStyle}>{item.name}</span>
            <span style={itemPathStyle}>{item.path}</span>
          </span>
          <span style={badgeStyle}>
            {item.kind === "pinned"
              ? "Pinned"
              : item.kind === "recent"
                ? "Recent"
                : item.isDir
                  ? "Dir"
                  : "File"}
          </span>
        </button>
      );
    },
    [handleJump, selectedIndex],
  );

  const handleInputFocus = useCallback(() => {
    if (activeRoot && activeRootSearchStatus === "idle") {
      void buildSearchIndex(activeRoot.path);
    }
    openDropdown();
  }, [activeRoot, activeRootSearchStatus, buildSearchIndex, openDropdown]);

  return (
    <div ref={containerRef} style={containerStyle}>
      <div style={inputShellStyle}>
        <Search size={12} style={{ color: "var(--cmux-text-secondary, #888)" }} />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onFocus={handleInputFocus}
          onBlur={() => {
            clearBlurTimer();
            blurTimerRef.current = window.setTimeout(() => {
              closeDropdown();
              setError(null);
            }, BLUR_CLOSE_DELAY_MS);
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            setError(null);
            if (!isOpen) {
              openDropdown();
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              openDropdown();
              moveSelection(1);
              return;
            }

            if (event.key === "ArrowUp") {
              event.preventDefault();
              openDropdown();
              moveSelection(-1);
              return;
            }

            if (event.key === "ArrowRight" || event.key === "Tab") {
              if (!selectedItem?.isDir) {
                return;
              }
              event.preventDefault();
              void handleDrill();
              return;
            }

            if (event.key === "ArrowLeft" && query.length === 0) {
              event.preventDefault();
              handleJumpToParent();
              return;
            }

            if (
              event.key === "Backspace" &&
              query.length === 0 &&
              event.currentTarget.selectionStart === 0 &&
              event.currentTarget.selectionEnd === 0
            ) {
              event.preventDefault();
              handleJumpToParent();
              return;
            }

            if (event.key === "Enter") {
              if (event.nativeEvent.isComposing || event.keyCode === 229) {
                return;
              }
              event.preventDefault();
              if (selectedItem?.isDir) {
                void handleJump(selectedItem.path, true);
              }
              return;
            }

            if (event.key === "Escape") {
              event.preventDefault();
              if (query.length > 0) {
                setQuery("");
                setError(null);
                openDropdown();
                return;
              }
              setError(null);
              closeDropdown();
              inputRef.current?.blur();
            }
          }}
          placeholder="Path jumper... Ctrl+P"
          spellCheck={false}
          style={inputStyle}
        />
      </div>

      {error ? <div style={errorStyle}>{error}</div> : null}
      {showIndexingHint ? <div style={hintStyle}>Indexing...</div> : null}

      {isOpen ? (
        <div
          role="listbox"
          style={dropdownStyle}
          onMouseDown={(event) => {
            event.preventDefault();
            clearBlurTimer();
          }}
        >
          {trimmedQuery.length === 0 ? (
            <>
              {pinnedItems.length > 0 ? (
                <div style={sectionStyle}>
                  <div style={sectionHeaderStyle}>
                    <Star size={12} />
                    <span>Pinned</span>
                  </div>
                  {pinnedItems.map((item, index) => renderItem(item, index))}
                </div>
              ) : null}

              {recentItems.length > 0 ? (
                <div style={sectionStyle}>
                  <div style={sectionHeaderStyle}>
                    <Clock3 size={12} />
                    <span>Recent</span>
                  </div>
                  {recentItems.map((item, index) =>
                    renderItem(item, pinnedItems.length + index),
                  )}
                </div>
              ) : null}

              {pinnedItems.length === 0 && recentItems.length === 0 ? (
                <div style={emptyStyle}>Pinned と recent はここに表示されます。</div>
              ) : null}
            </>
          ) : visibleItems.length > 0 ? (
            visibleItems.map((item, index) => renderItem(item, index))
          ) : showIndexingHint ? (
            <div style={hintStyle}>Indexing...</div>
          ) : (
            <div style={emptyStyle}>一致するパスがありません。</div>
          )}
        </div>
      ) : null}
    </div>
  );
});

const containerStyle: CSSProperties = {
  position: "relative",
  padding: "6px",
  borderBottom: "1px solid var(--cmux-border)",
};

const inputShellStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  height: 24,
  padding: "2px 6px",
  background: "var(--cmux-bg, #0a0a0a)",
  border: "1px solid var(--cmux-border)",
  borderRadius: 4,
  boxSizing: "border-box",
};

const inputStyle: CSSProperties = {
  width: "100%",
  minWidth: 0,
  background: "transparent",
  border: "none",
  color: "var(--cmux-text)",
  fontSize: 11,
  fontFamily: "inherit",
  outline: "none",
};

const errorStyle: CSSProperties = {
  marginTop: 4,
  color: "#ff6b6b",
  fontSize: 10,
  lineHeight: 1.3,
};

const hintStyle: CSSProperties = {
  marginTop: 4,
  color: "var(--cmux-text-secondary, #888)",
  fontSize: 10,
  lineHeight: 1.3,
};

const dropdownStyle: CSSProperties = {
  position: "absolute",
  left: 6,
  right: 6,
  top: 36,
  zIndex: 30,
  maxHeight: 280,
  overflowY: "auto",
  padding: 4,
  background: "var(--cmux-surface, #1a1a1a)",
  border: "1px solid var(--cmux-border)",
  borderRadius: 6,
  boxShadow: "0 10px 24px rgba(0, 0, 0, 0.32)",
};

const sectionStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const sectionHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 8px 4px",
  color: "var(--cmux-text-secondary, #888)",
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: 0.4,
};

const itemRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "7px 8px",
  border: "1px solid transparent",
  borderRadius: 5,
  background: "transparent",
  textAlign: "left",
};

const itemIconStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 14,
  flexShrink: 0,
};

const itemTextStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  minWidth: 0,
  flex: 1,
};

const itemNameStyle: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: 11,
};

const itemPathStyle: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "var(--cmux-text-secondary, #888)",
  fontSize: 10,
};

const badgeStyle: CSSProperties = {
  flexShrink: 0,
  padding: "2px 6px",
  borderRadius: 999,
  background: "rgba(255, 255, 255, 0.06)",
  color: "var(--cmux-text-secondary, #999)",
  fontSize: 9,
  textTransform: "uppercase",
  letterSpacing: 0.3,
};

const emptyStyle: CSSProperties = {
  padding: "10px 8px",
  color: "var(--cmux-text-secondary, #888)",
  fontSize: 11,
};
