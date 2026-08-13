import { memo, useRef, useState, useCallback, useEffect, useLayoutEffect, useMemo } from "react";
import type { CSSProperties, MutableRefObject, ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { useWorkspaceListStore, usePaneMetadataStore } from "../../stores/workspaceStore";
import { usePaneDragStore } from "../../stores/paneDragStore";
import { useSavepointDragStore } from "../../stores/savepointDragStore";
import { SIDEBAR_WIDTH } from "../../lib/constants";
import { deriveDisplayStatus } from "../../lib/notificationStatus";
import { clampMenuPosition } from "../../lib/menuPosition";
import { workspaceTabCount, workspaceTabPreview } from "../../lib/workspaceRow";
import {
  summarizeUnseenAttention,
  useSessionAttentionStore,
  type SessionAttention,
} from "../../stores/sessionAttentionStore";
import { useDismissOnOutside } from "../../hooks/useDismissOnOutside";
import {
  WORKSPACE_COLORS,
  WORKSPACE_COLOR_NONE_LABEL,
  resolveWorkspaceColor,
} from "../../lib/workspaceColors";
import TabItem from "./TabItem";
import type { PetSpriteState } from "../workspace/PetSprite";
import { useStallStore } from "../../stores/stallStore";
import { tearOutWorkspaceToNewWindow } from "../../lib/workspaceTearOut";
import { isOutsideWindowViewport } from "../../lib/windowEdge";
import { TearOutBanner } from "../workspace/PaneDragOverlay";
import { paneDndStrings } from "../workspace/paneDndStrings";
import { useToastStore } from "../../stores/toastStore";
import type { Workspace } from "../../types";
import { resolvePet } from "../../lib/pets";
import { usePetSettingsStore } from "../../stores/petSettingsStore";

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

// Mirrors the pane tab bar's context menu chrome so the two menus read as one
// system (see PaneTabBar's paneTabContextMenuStyle).
const workspaceContextMenuStyle: CSSProperties = {
  position: "fixed",
  zIndex: 100,
  background: "var(--cmux-popover)",
  border: "1px solid var(--cmux-border)",
  borderRadius: 6,
  padding: "4px 0",
  boxShadow: "var(--cmux-shadow-pane-menu)",
  minWidth: 176,
  fontSize: 13,
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
};

function WorkspaceContextMenuItem({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <div
      role="menuitem"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--cmux-hover)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
      style={{
        padding: "6px 12px",
        cursor: "pointer",
        color: "var(--cmux-text)",
        userSelect: "none",
      }}
    >
      {children}
    </div>
  );
}

interface WorkspaceColorSwatchesProps {
  selected: string | undefined;
  onSelect: (color: string | undefined) => void;
}

function WorkspaceColorSwatches({ selected, onSelect }: WorkspaceColorSwatchesProps) {
  return (
    <div className="workspace-color-swatches" role="group" aria-label="ワークスペースの色">
      {WORKSPACE_COLORS.map((option) => (
        <button
          key={option.id}
          type="button"
          className="workspace-color-swatch"
          title={option.label}
          aria-label={option.label}
          aria-pressed={selected === option.value}
          style={{ "--workspace-swatch-color": option.value } as CSSProperties}
          onClick={() => onSelect(option.value)}
        />
      ))}
      <button
        type="button"
        className="workspace-color-swatch workspace-color-swatch--none"
        title={WORKSPACE_COLOR_NONE_LABEL}
        aria-label={WORKSPACE_COLOR_NONE_LABEL}
        aria-pressed={selected === undefined}
        onClick={() => onSelect(undefined)}
      />
    </div>
  );
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
  renameSignal: number;
  onPointerDown: (e: React.PointerEvent, index: number) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onContextMenu: (e: React.MouseEvent, workspaceId: string) => void;
  onMenu: (workspaceId: string, x: number, y: number) => void;
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
  renameSignal,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onContextMenu,
  onMenu,
  onClick,
  onClose,
  onRename,
}: WorkspaceTabEntryProps) {
  const petDisplayMode = usePetSettingsStore((state) => state.petDisplayMode);
  const pets = usePetSettingsStore((state) => state.pets);
  const workspaceTabs = useMemo(
    () => ws.panes.flatMap((pane) => pane.tabs),
    [ws.panes],
  );
  const sessionIds = useMemo(
    () => workspaceTabs.map((tab) => tab.sessionId),
    [workspaceTabs],
  );
  const tabMetadata = usePaneMetadataStore(useShallow((s) =>
    sessionIds.map((sessionId) => s.metadata[sessionId]),
  ));
  const tabAttention = useSessionAttentionStore(useShallow((s) =>
    sessionIds.map((sessionId) => s.attentionBySession[sessionId]),
  ));
  const tabStalls = useStallStore(useShallow((s) =>
    sessionIds.map((sessionId) => s.entries[sessionId]),
  ));
  const seenAttentionByTab = useSessionAttentionStore((s) => s.seenAttentionByTab);

  let totalWsNotifications = 0;
  let hasWorkspaceError = false;
  const statusCounts = { working: 0, waiting: 0 };
  const attentionBySession: Record<string, SessionAttention | undefined> = {};
  sessionIds.forEach((sessionId, index) => {
    const m = tabMetadata[index];
    attentionBySession[sessionId] = tabAttention[index];
    if (tabAttention[index]?.kind === "error") hasWorkspaceError = true;
    if (m) {
      totalWsNotifications += m.notificationCount ?? 0;
      const eff = deriveDisplayStatus(m);
      if (eff === "working" || eff === "waiting") {
        statusCounts[eff]++;
      }
    }
  });
  // A background workspace holding an unread error/approval used to look idle
  // in the sidebar unless it also bumped a notification counter.
  const unseenAttention = summarizeUnseenAttention(
    workspaceTabs,
    attentionBySession,
    seenAttentionByTab,
  );
  const petState: PetSpriteState = statusCounts.waiting > 0
    ? "waving"
    : hasWorkspaceError
      ? "failed"
      : tabStalls.some(Boolean)
        ? "waiting"
        : statusCounts.working > 0
          ? "running"
          : "idle";

  const tabPreview = workspaceTabPreview(ws);
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
      onContextMenu={(e) => onContextMenu(e, ws.id)}
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
        tabCount={workspaceTabCount(ws)}
        activeTabLabels={tabPreview.labels}
        remainingTabCount={tabPreview.remainingCount}
        notificationCount={totalWsNotifications || undefined}
        petState={petState}
        petAtlasUrl={resolvePet(pets, ws.pet).atlasUrl}
        showPet={petDisplayMode !== "none"}
        unseenAttentionCount={unseenAttention.count}
        unseenAttentionCategory={unseenAttention.category}
        color={ws.color}
        active={active}
        renameSignal={renameSignal}
        onClick={() => { if (!draggingRef.current) onClick(ws.id); }}
        onClose={() => onClose(ws.id)}
        onMenu={(x, y) => onMenu(ws.id, x, y)}
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
  const setWorkspaceColor = useWorkspaceListStore((s) => s.setWorkspaceColor);
  const paneMoveDragActive = usePaneDragStore((s) => s.item !== null);
  const paneMoveHoverWorkspaceId = usePaneDragStore((s) => s.hoverWorkspaceId);
  const savepointDragActive = useSavepointDragStore((s) => s.item !== null);
  const savepointHoverWorkspaceId = useSavepointDragStore((s) => s.hoverWorkspaceId);
  const paneDragActive = paneMoveDragActive || savepointDragActive;
  const hoverWorkspaceId = paneMoveHoverWorkspaceId ?? savepointHoverWorkspaceId;
  const newWorkspaceDropActive = usePaneDragStore((s) => s.target?.kind === "new-workspace");

  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  // Pointer is currently outside the window mid-drag: releasing tears the
  // workspace out to a new OS window instead of reordering.
  const [tearOutReady, setTearOutReady] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ workspaceId: string; x: number; y: number } | null>(null);
  const [contextMenuPos, setContextMenuPos] = useState({ left: 0, top: 0 });
  const [renameSignals, setRenameSignals] = useState<Record<string, number>>({});
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const startY = useRef(0);
  const startX = useRef(0);
  const dragging = useRef(false);
  const pointerIdRef = useRef<number | null>(null);
  const dragElRef = useRef<HTMLElement | null>(null);

  const handlePointerDown = useCallback((e: React.PointerEvent, index: number) => {
    if (paneDragActive) return;
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.tagName === "BUTTON" || target.tagName === "INPUT" || target.closest("button, input")) return;
    startY.current = e.clientY;
    startX.current = e.clientX;
    dragging.current = false;
    pointerIdRef.current = e.pointerId;
    dragElRef.current = e.currentTarget as HTMLElement;
    setDragIndex(index);
  }, [paneDragActive]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (paneDragActive) return;
    if (dragIndex === null) return;
    if (!dragging.current) {
      // Vertical movement starts a reorder; a mostly-horizontal pull (out of
      // the sidebar) starts the same drag so it can leave the window.
      if (Math.abs(e.clientY - startY.current) < 5 && Math.abs(e.clientX - startX.current) < 24) return;
      dragging.current = true;
      if (dragElRef.current && pointerIdRef.current !== null) {
        dragElRef.current.setPointerCapture(pointerIdRef.current);
      }
    }
    // Pointer capture keeps the moves coming after the cursor leaves the
    // window; out there the gesture stops meaning "reorder" and starts
    // meaning "tear out" (Phase 3c).
    const outside = isOutsideWindowViewport(
      e.clientX,
      e.clientY,
      window.innerWidth,
      window.innerHeight,
    );
    setTearOutReady(outside);
    if (outside) {
      setDropIndex(null);
      return;
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

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (paneDragActive) return;
    if (dragging.current && tearOutReady && dragIndex !== null) {
      const workspace = workspaces[dragIndex];
      if (workspace) {
        void tearOutWorkspaceToNewWindow(workspace.id, {
          x: e.screenX - 40,
          y: e.screenY - 20,
        }).catch((err) => {
          console.error("[multiwindow] drag tear-out failed", err);
          useToastStore.getState().pushToast("新しいウィンドウを開けませんでした", "error");
        });
      }
    } else if (dragIndex !== null && dropIndex !== null && dragging.current) {
      reorder(dragIndex, dropIndex);
    }
    setTearOutReady(false);
    setDragIndex(null);
    setDropIndex(null);
    dragging.current = false;
    pointerIdRef.current = null;
    dragElRef.current = null;
  }, [dragIndex, dropIndex, paneDragActive, reorder, tearOutReady, workspaces]);

  useEffect(() => {
    const up = () => {
      if (dragIndex !== null) {
        setDragIndex(null);
        setDropIndex(null);
        setTearOutReady(false);
        dragging.current = false;
      }
    };
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, [dragIndex]);

  const handleContextMenu = useCallback((e: React.MouseEvent, workspaceId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ workspaceId, x: e.clientX, y: e.clientY });
  }, []);

  // The primary, mouse-only route to the same menu: the ⋮ hover button on the
  // row. Right-click still works but nothing depends on it.
  const handleMenuButton = useCallback((workspaceId: string, x: number, y: number) => {
    setContextMenu((prev) => (prev?.workspaceId === workspaceId ? null : { workspaceId, x, y }));
  }, []);

  useDismissOnOutside(Boolean(contextMenu), contextMenuRef, () => setContextMenu(null));

  useLayoutEffect(() => {
    if (!contextMenu || !contextMenuRef.current) return;
    const rect = contextMenuRef.current.getBoundingClientRect();
    const { left, top } = clampMenuPosition(contextMenu.x, contextMenu.y, rect.width, rect.height);
    setContextMenuPos((prev) => (prev.left === left && prev.top === top ? prev : { left, top }));
  }, [contextMenu]);

  // A workspace closed while its menu is open must not leave a menu pointing at
  // nothing.
  useEffect(() => {
    if (contextMenu && !workspaces.some((ws) => ws.id === contextMenu.workspaceId)) {
      setContextMenu(null);
    }
  }, [contextMenu, workspaces]);

  const contextWorkspace = contextMenu
    ? workspaces.find((ws) => ws.id === contextMenu.workspaceId)
    : undefined;

  return (
    <div
      data-tauri-drag-region
      style={{
        width: SIDEBAR_WIDTH,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "var(--cmux-sidebar)",
        borderRight: "1px solid var(--cmux-border-hairline)",
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
          borderBottom: "1px solid var(--cmux-border-hairline)",
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
              renameSignal={renameSignals[ws.id] ?? 0}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onContextMenu={handleContextMenu}
              onMenu={handleMenuButton}
              onClick={setActive}
              onClose={onCloseWorkspace}
              onRename={rename}
            />
          );
        })}
      </div>

      {/* New workspace button at bottom */}
      <button
        type="button"
        data-dnd-new-workspace-target="true"
        onClick={onNewWorkspace}
        title="New workspace (Ctrl+Shift+N)"
        className={`tab-new-workspace-btn${uiVariant === "cmux" ? " cmux-title-btn" : ""}`}
        data-pane-drag-active={paneDragActive ? "true" : undefined}
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
            : "1px solid var(--cmux-border-hairline)",
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
      >
        <PlusIcon />
        <span>New workspace</span>
      </button>

      {tearOutReady && <TearOutBanner label={`⬈ ${paneDndStrings.dropInNewWindow}`} />}

      {contextMenu && contextWorkspace && (
        <div
          ref={contextMenuRef}
          role="menu"
          aria-label="ワークスペースの操作"
          style={{
            ...workspaceContextMenuStyle,
            top: contextMenuPos.top,
            left: contextMenuPos.left,
          }}
        >
          <div
            style={{
              padding: "4px 12px 2px",
              color: "var(--cmux-text-tertiary)",
              fontSize: 11,
              fontWeight: 600,
              userSelect: "none",
            }}
          >
            色
          </div>
          <WorkspaceColorSwatches
            selected={resolveWorkspaceColor(contextWorkspace.color)?.value}
            onSelect={(color) => {
              setWorkspaceColor(contextWorkspace.id, color);
              setContextMenu(null);
            }}
          />
          <div
            style={{
              height: 1,
              margin: "4px 0",
              background: "var(--cmux-border-hairline)",
            }}
          />
          <WorkspaceContextMenuItem
            onClick={() => {
              const workspaceId = contextWorkspace.id;
              setContextMenu(null);
              setRenameSignals((prev) => ({ ...prev, [workspaceId]: (prev[workspaceId] ?? 0) + 1 }));
            }}
          >
            名前を変更
          </WorkspaceContextMenuItem>
          <WorkspaceContextMenuItem
            onClick={() => {
              // Tear-out (Phase 3b). The workspace moves to a new OS window
              // with its sessions still running; closing that window merges it
              // back here. Allowed even for the last workspace — the sessions
              // live on in the new window and this one shows its empty state.
              const workspaceId = contextWorkspace.id;
              setContextMenu(null);
              void tearOutWorkspaceToNewWindow(workspaceId, {
                x: window.screenX + 80,
                y: window.screenY + 60,
              }).catch((err) => {
                console.error("[multiwindow] tear-out failed", err);
                useToastStore
                  .getState()
                  .pushToast("新しいウィンドウを開けませんでした", "error");
              });
            }}
          >
            新しいウィンドウで開く
          </WorkspaceContextMenuItem>
        </div>
      )}
    </div>
  );
}
