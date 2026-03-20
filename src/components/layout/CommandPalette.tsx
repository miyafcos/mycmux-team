import { useEffect, useState, useRef, useMemo, useCallback } from "react";
import Fuse from "fuse.js";
import { useWorkspaceListStore, useWorkspaceLayoutStore, useUiStore } from "../../stores/workspaceStore";
import { useThemeStore } from "../../stores/themeStore";
import { THEMES } from "../theme/themeDefinitions";

interface Action {
  id: string;
  title: string;
  category: string;
  perform: () => void;
}

export default function CommandPalette() {
  const isPaletteOpen = useUiStore((s) => s.isPaletteOpen);
  const setIsPaletteOpen = useUiStore((s) => s.setIsPaletteOpen);
  const workspaces = useWorkspaceListStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceListStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useWorkspaceListStore((s) => s.setActiveWorkspace);
  const setIsKeybindingsOpen = useUiStore((s) => s.setIsKeybindingsOpen);
  const setTheme = useThemeStore((s) => s.setTheme);
  const currentThemeId = useThemeStore((s) => s.themeId);

  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Create workspace function
  const createWorkspace = useCallback((name: string, gridTemplateId: "1x1" | "2x1") => {
    const workspaceId = crypto.randomUUID();
    const { panes, splitRows } = useWorkspaceLayoutStore.getState().buildInitialPanes(workspaceId, gridTemplateId);
    useWorkspaceListStore.getState().createWorkspace(name, gridTemplateId, panes, splitRows);
  }, []);

  // Close palette if clicking outside
  useEffect(() => {
    if (!isPaletteOpen) {
      setQuery("");
      setSelectedIndex(0);
      return;
    }
    setTimeout(() => {
      inputRef.current?.focus();
    }, 50);
  }, [isPaletteOpen]);

  // Collect all actions
  const actions: Action[] = useMemo(() => {
    const arr: Action[] = [];

    // 1. Workspace switching
    workspaces.forEach((w) => {
      if (w.id !== activeWorkspaceId) {
        arr.push({
          id: `workspace-switch-${w.id}`,
          title: `Switch Workspace: ${w.name}`,
          category: "Workspaces",
          perform: () => setActiveWorkspace(w.id),
        });
      }
    });

    // 2. Workspace creation
    arr.push({
      id: "workspace-create-1",
      title: "New Workspace (Single Pane)",
      category: "Workspaces",
      perform: () => createWorkspace(`Workspace ${workspaces.length + 1}`, "1x1"),
    });
    arr.push({
      id: "workspace-create-2",
      title: "New Workspace (2 Columns)",
      category: "Workspaces",
      perform: () => createWorkspace(`Workspace ${workspaces.length + 1}`, "2x1"),
    });

    // 3. Theme switching
    THEMES.forEach((theme) => {
      arr.push({
        id: `theme-switch-${theme.id}`,
        title: `Theme: ${theme.name}${theme.id === currentThemeId ? " (Active)" : ""}`,
        category: "Theme",
        perform: () => setTheme(theme.id),
      });
    });

    arr.push({
      id: "settings-keybindings",
      title: "Settings: Keyboard Shortcuts",
      category: "Settings",
      perform: () => setIsKeybindingsOpen(true),
    });

    return arr;
  }, [workspaces, activeWorkspaceId, setActiveWorkspace, createWorkspace, setTheme, setIsKeybindingsOpen, currentThemeId]);

  // Fuzzy search
  const fuse = useMemo(
    () => new Fuse(actions, { keys: ["title", "category"], threshold: 0.3 }),
    [actions]
  );

  const results = query ? fuse.search(query).map((res) => res.item) : actions;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => {
        const next = (prev + 1) % results.length;
        scrollToIndex(next);
        return next;
      });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => {
        const next = (prev - 1 + results.length) % results.length;
        scrollToIndex(next);
        return next;
      });
    } else if (e.key === "Enter") {
      e.preventDefault();
      const selected = results[selectedIndex];
      if (selected) {
        selected.perform();
        setIsPaletteOpen(false);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      setIsPaletteOpen(false);
    }
  };

  const scrollToIndex = (index: number) => {
    if (!listRef.current) return;
    const item = listRef.current.children[index] as HTMLElement;
    if (item) {
      item.scrollIntoView({ block: "nearest" });
    }
  };

  if (!isPaletteOpen) return null;

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        backgroundColor: "rgba(0, 0, 0, 0.4)",
        backdropFilter: "blur(4px)",
        zIndex: 9999,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "15vh",
      }}
      onClick={() => setIsPaletteOpen(false)}
    >
      <div
        style={{
          width: 600,
          maxWidth: "90%",
          backgroundColor: "var(--cmux-surface)",
          border: "1px solid var(--cmux-border)",
          borderRadius: 8,
          boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--cmux-border)" }}>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Type a command or search..."
            style={{
              width: "100%",
              background: "transparent",
              border: "none",
              color: "var(--cmux-text)",
              fontSize: 16,
              outline: "none",
              fontFamily: "'JetBrains Mono', monospace",
            }}
          />
        </div>
        <div ref={listRef} style={{ maxHeight: 400, overflowY: "auto", padding: "8px 0" }}>
          {results.length === 0 ? (
            <div style={{ padding: "12px 16px", color: "var(--cmux-text-secondary)", fontSize: 13 }}>No results found.</div>
          ) : (
            results.map((action, idx) => (
              <div
                key={action.id}
                onClick={() => {
                  action.perform();
                  setIsPaletteOpen(false);
                }}
                onMouseEnter={() => setSelectedIndex(idx)}
                style={{
                  padding: "10px 16px",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  cursor: "pointer",
                  backgroundColor: idx === selectedIndex ? "var(--cmux-hover)" : "transparent",
                  color: "var(--cmux-text)",
                }}
              >
                <span style={{ fontSize: 13, fontFamily: "'JetBrains Mono', monospace" }}>{action.title}</span>
                <span style={{ fontSize: 11, color: "var(--cmux-text-tertiary)", fontFamily: "'JetBrains Mono', monospace" }}>{action.category}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
