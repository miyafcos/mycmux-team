import { memo, useRef, useState, useCallback, useEffect, useMemo } from "react";
import type { MutableRefObject } from "react";
import { useShallow } from "zustand/react/shallow";
import { useWorkspaceListStore, usePaneMetadataStore } from "../../stores/workspaceStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { usePaneDragStore } from "../../stores/paneDragStore";
import { useSavepointDragStore } from "../../stores/savepointDragStore";
import { SIDEBAR_WIDTH } from "../../lib/constants";
import { deriveEffectiveStatus } from "../../lib/notificationStatus";
import { BuddyWidget } from "../../buddy/BuddyWidget";
import TabItem from "./TabItem";
import type { Workspace } from "../../types";

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

interface WorkspaceTabEntryProps {
  uiVariant: "default" | "cmux";
  ws: Workspace;
  wsIndex: number;
  active: boolean;
  dragIndex: number | null;
  dropIndex: number | null;
  paneDragActive: boolean;
  hoverWorkspaceId: string | null;
  draggingRef: MutableRefObject<boolean>;
  itemRefs: MutableRefObject<(HTMLDivElement | null)[]>;
  onPointerDown: (e: React.PointerEvent, index: number) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: () => void;
  onClick: (workspaceId: string) => void;
  onClose: (workspaceId: string) => void;
  onRename: (workspaceId: string, newName: string) => void;
}

const WorkspaceTabEntry = memo(function WorkspaceTabEntry({
  uiVariant,
  ws,
  wsIndex,
  active,
  dragIndex,
  dropIndex,
  paneDragActive,
  hoverWorkspaceId,
  draggingRef,
  itemRefs,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onClick,
  onClose,
  onRename,
}: WorkspaceTabEntryProps) {
  const sessionIds = useMemo(
    () => ws.panes.flatMap((pane) => pane.tabs.map((tab) => tab.sessionId)),
    [ws.panes],
  );
  const tabMetadata = usePaneMetadataStore(useShallow((s) =>
    sessionIds.map((sessionId) => s.metadata[sessionId]),
  ));
  const tabLastLog = usePaneMetadataStore(useShallow((s) =>
    sessionIds.map((sessionId) => s.lastLog[sessionId]),
  ));

  let totalWsNotifications = 0;
  let totalWsWorkDone = 0;
  let lastLog: string | undefined;
  const statusCounts = { working: 0, waiting: 0 };
  const metadataBySession: Record<string, typeof tabMetadata[number]> = {};
  sessionIds.forEach((sessionId, index) => {
    const m = tabMetadata[index];
    metadataBySession[sessionId] = m;
    if (m) {
      totalWsNotifications += m.notificationCount ?? 0;
      totalWsWorkDone += m.workDoneCount ?? 0;
      const eff = deriveEffectiveStatus(m);
      if (eff === "working" || eff === "waiting") {
        statusCounts[eff]++;
      }
    }
    if (tabLastLog[index]) lastLog = tabLastLog[index];
  });

  const firstActiveTabSessionId = ws.panes[0]?.tabs.find((t) => t.id === ws.panes[0]?.activeTabId)?.sessionId;
  const firstPaneMeta = firstActiveTabSessionId ? metadataBySession[firstActiveTabSessionId] : undefined;
  const isDragged = draggingRef.current && dragIndex === wsIndex;
  const showLine = draggingRef.current && dropIndex === wsIndex && dragIndex !== wsIndex;
  const isPaneDropHover = paneDragActive && hoverWorkspaceId === ws.id;

  return (
    <div
      data-dnd-workspace-target-id={ws.id}
      ref={(el) => { itemRefs.current[wsIndex] = el; }}
      onPointerDown={(e) => onPointerDown(e, wsIndex)}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
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
        name={ws.name}
        paneCount={ws.panes.length}
        cwd={firstPaneMeta?.cwd}
        gitBranch={firstPaneMeta?.gitBranch}
        notificationCount={totalWsNotifications || undefined}
        workDoneCount={totalWsWorkDone || undefined}
        lastLogLine={lastLog}
        statusCounts={statusCounts}
        active={active}
        onClick={() => { if (!draggingRef.current) onClick(ws.id); }}
        onClose={() => onClose(ws.id)}
        onRename={(newName) => onRename(ws.id, newName)}
      />
    </div>
  );
});

export default function TabBar({ uiVariant = "default", onNewWorkspace, onCloseWorkspace }: TabBarProps) {
  const workspaces = useWorkspaceListStore((s) => s.workspaces);
  const activeId = useWorkspaceListStore((s) => s.activeWorkspaceId);
  const setActive = useWorkspaceListStore((s) => s.setActiveWorkspace);
  const reorder = useWorkspaceListStore((s) => s.reorderWorkspaces);
  const rename = useWorkspaceListStore((s) => s.renameWorkspace);
  const buddyEnabled = useSettingsStore((s) => s.buddyEnabled);
  const paneMoveDragActive = usePaneDragStore((s) => s.item !== null);
  const paneMoveHoverWorkspaceId = usePaneDragStore((s) => s.hoverWorkspaceId);
  const savepointDragActive = useSavepointDragStore((s) => s.item !== null);
  const savepointHoverWorkspaceId = useSavepointDragStore((s) => s.hoverWorkspaceId);
  const paneDragActive = paneMoveDragActive || savepointDragActive;
  const hoverWorkspaceId = paneMoveHoverWorkspaceId ?? savepointHoverWorkspaceId;
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
      <div
        style={{
          padding: "10px 12px 6px 16px",
          borderBottom: "1px solid var(--cmux-border)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          color: "var(--cmux-text-tertiary)",
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: 0,
        }}
      >
        <span>Workspaces</span>
        <span>{workspaces.length}</span>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", paddingTop: 4 }}>
        {workspaces.map((ws, wsIndex) => {
          return (
            <WorkspaceTabEntry
              key={ws.id}
              uiVariant={uiVariant}
              ws={ws}
              wsIndex={wsIndex}
              active={ws.id === activeId}
              dragIndex={dragIndex}
              dropIndex={dropIndex}
              paneDragActive={paneDragActive}
              hoverWorkspaceId={hoverWorkspaceId}
              draggingRef={dragging}
              itemRefs={itemRefs}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onClick={setActive}
              onClose={onCloseWorkspace}
              onRename={rename}
            />
          );
        })}
      </div>

      {buddyEnabled && <BuddyWidget />}

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
