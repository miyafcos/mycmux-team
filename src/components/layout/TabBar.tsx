import { useRef, useState, useCallback, useEffect } from "react";
import { useWorkspaceListStore, usePaneMetadataStore } from "../../stores/workspaceStore";
import { usePaneDragStore } from "../../stores/paneDragStore";
import { SIDEBAR_WIDTH } from "../../lib/constants";
import { deriveEffectiveStatus } from "../../lib/notificationStatus";
import TabItem from "./TabItem";

const PlusIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19"></line>
    <line x1="5" y1="12" x2="19" y2="12"></line>
  </svg>
);

interface TabBarProps {
  uiVariant?: "default" | "cmux";
  onNewWorkspace: () => void;
  onCloseWorkspace: (id: string) => void;
}

export default function TabBar({ uiVariant = "default", onNewWorkspace, onCloseWorkspace }: TabBarProps) {
  const workspaces = useWorkspaceListStore((s) => s.workspaces);
  const activeId = useWorkspaceListStore((s) => s.activeWorkspaceId);
  const setActive = useWorkspaceListStore((s) => s.setActiveWorkspace);
  const reorder = useWorkspaceListStore((s) => s.reorderWorkspaces);
  const rename = useWorkspaceListStore((s) => s.renameWorkspace);
  const paneMetadata = usePaneMetadataStore((s) => s.metadata);
  const paneDragActive = usePaneDragStore((s) => s.item !== null);
  const hoverWorkspaceId = usePaneDragStore((s) => s.hoverWorkspaceId);
  const newWorkspaceDropActive = usePaneDragStore((s) => s.target?.kind === "new-workspace");

  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const startY = useRef(0);
  const dragging = useRef(false);
  const pointerIdRef = useRef<number | null>(null);
  const dragElRef = useRef<HTMLElement | null>(null);

  const handlePointerDown = useCallback((e: React.PointerEvent, index: number) => {
    if (paneDragActive) return;
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.tagName === "BUTTON" || target.tagName === "INPUT" || target.closest("button, input")) return;
    startY.current = e.clientY;
    dragging.current = false;
    pointerIdRef.current = e.pointerId;
    dragElRef.current = e.currentTarget as HTMLElement;
    setDragIndex(index);
  }, [paneDragActive]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (paneDragActive) return;
    if (dragIndex === null) return;
    if (!dragging.current) {
      if (Math.abs(e.clientY - startY.current) < 5) return;
      dragging.current = true;
      if (dragElRef.current && pointerIdRef.current !== null) {
        dragElRef.current.setPointerCapture(pointerIdRef.current);
      }
    }
    const y = e.clientY;
    let target = 0;
    for (let i = 0; i < itemRefs.current.length; i++) {
      const el = itemRefs.current[i];
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (y > rect.top + rect.height / 2) target = i + 1;
    }
    target = Math.min(target, workspaces.length - 1);
    setDropIndex(target === dragIndex ? null : target);
  }, [dragIndex, paneDragActive, workspaces.length]);

  const handlePointerUp = useCallback(() => {
    if (paneDragActive) return;
    if (dragIndex !== null && dropIndex !== null && dragging.current) {
      reorder(dragIndex, dropIndex);
    }
    setDragIndex(null);
    setDropIndex(null);
    dragging.current = false;
    pointerIdRef.current = null;
    dragElRef.current = null;
  }, [dragIndex, dropIndex, paneDragActive, reorder]);

  useEffect(() => {
    const up = () => {
      if (dragIndex !== null) {
        setDragIndex(null);
        setDropIndex(null);
        dragging.current = false;
      }
    };
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, [dragIndex]);

  return (
    <div
      data-tauri-drag-region
      style={{
        width: SIDEBAR_WIDTH,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "var(--cmux-sidebar)",
        borderRight: "1px solid var(--cmux-border)",
        flexShrink: 0,
        overflowY: "hidden",
        overflowX: "hidden",
        position: "relative",
        // Theme-adaptive sidebar text contrast. AppShell aliases
        // --cmux-text-secondary and --cmux-text-tertiary to chrome.textMuted
        // which is often too dim to read workspace labels against. Derive
        // brighter variants from the theme's own --cmux-text so the cascade
        // stays theme-aware (works on both dark and light themes).
        "--cmux-text-secondary": "color-mix(in srgb, var(--cmux-text) 82%, transparent)",
        "--cmux-text-tertiary":  "color-mix(in srgb, var(--cmux-text) 58%, transparent)",
      } as React.CSSProperties}
    >
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden" }}>
        {workspaces.map((ws, wsIndex) => {
          let totalWsNotifications = 0;
          let totalWsWorkDone = 0;
          let lastLog: string | undefined;
          const statusCounts = { working: 0, waiting: 0 };
          for (const pane of ws.panes) {
            for (const tab of pane.tabs) {
              const m = paneMetadata[tab.sessionId];
              if (m) {
                totalWsNotifications += m.notificationCount ?? 0;
                totalWsWorkDone += m.workDoneCount ?? 0;
                if (m.lastLogLine) lastLog = m.lastLogLine;
                const eff = deriveEffectiveStatus(m);
                if (eff === "working" || eff === "waiting") {
                  statusCounts[eff]++;
                }
              }
            }
          }
          const firstActiveTabSessionId = ws.panes[0]?.tabs.find((t) => t.id === ws.panes[0]?.activeTabId)?.sessionId;
          const firstPaneMeta = firstActiveTabSessionId ? paneMetadata[firstActiveTabSessionId] : undefined;
          const isDragged = dragging.current && dragIndex === wsIndex;
          const showLine = dragging.current && dropIndex === wsIndex && dragIndex !== wsIndex;
          const isPaneDropHover = paneDragActive && hoverWorkspaceId === ws.id;
          return (
            <div
              key={ws.id}
              data-dnd-workspace-target-id={ws.id}
              ref={(el) => { itemRefs.current[wsIndex] = el; }}
              onPointerDown={(e) => handlePointerDown(e, wsIndex)}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              style={{
                touchAction: "none",
                opacity: isDragged ? 0.35 : 1,
                borderTop: showLine ? "2px solid var(--cmux-accent, #007aff)" : "2px solid transparent",
                outline: isPaneDropHover ? "1px solid var(--cmux-accent, #007aff)" : "1px solid transparent",
                outlineOffset: -2,
                background: isPaneDropHover ? "color-mix(in srgb, var(--cmux-accent) 16%, transparent)" : undefined,
              }}
            >
              <TabItem
                uiVariant={uiVariant}
                index={wsIndex}
                name={ws.name}
                color={ws.color}
                paneCount={ws.panes.length}
                cwd={firstPaneMeta?.cwd}
                gitBranch={firstPaneMeta?.gitBranch}
                notificationCount={totalWsNotifications || undefined}
                workDoneCount={totalWsWorkDone || undefined}
                lastLogLine={lastLog}
                statusCounts={statusCounts}
                active={ws.id === activeId}
                onClick={() => { if (!dragging.current) setActive(ws.id); }}
                onClose={() => onCloseWorkspace(ws.id)}
                onRename={(newName) => rename(ws.id, newName)}
              />
            </div>
          );
        })}
      </div>

      {/* New workspace button at bottom */}
      <button
        type="button"
        data-dnd-new-workspace-target="true"
        onClick={onNewWorkspace}
        title="New workspace (Ctrl+Shift+N)"
        className={uiVariant === "cmux" ? "cmux-title-btn" : undefined}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          background: newWorkspaceDropActive
            ? "color-mix(in srgb, var(--cmux-accent) 18%, transparent)"
            : "none",
          border: "none",
          borderTop: newWorkspaceDropActive
            ? "1px solid color-mix(in srgb, var(--cmux-accent) 70%, var(--cmux-border))"
            : "1px solid var(--cmux-border)",
          color: newWorkspaceDropActive ? "var(--cmux-text)" : "var(--cmux-text-tertiary)",
          cursor: "pointer",
          padding: "10px 16px",
          fontSize: 12,
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          textAlign: "left",
          flexShrink: 0,
          outline: newWorkspaceDropActive ? "1px solid var(--cmux-accent)" : "1px solid transparent",
          outlineOffset: -3,
          boxShadow: newWorkspaceDropActive
            ? "inset 0 0 0 1px color-mix(in srgb, var(--cmux-accent) 38%, transparent)"
            : "none",
        }}
        onMouseEnter={(e) => {
          if (paneDragActive) return;
          e.currentTarget.style.background = "var(--cmux-hover)";
          e.currentTarget.style.color = "var(--cmux-text-secondary)";
        }}
        onMouseLeave={(e) => {
          if (paneDragActive) return;
          e.currentTarget.style.background = "none";
          e.currentTarget.style.color = "var(--cmux-text-tertiary)";
        }}
      >
        <PlusIcon />
        <span>New workspace</span>
      </button>
    </div>
  );
}
