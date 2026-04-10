import { memo, useCallback, useEffect, useState } from "react";
import ErrorBoundary from "../common/ErrorBoundary";
import type { Pane, PaneTab } from "../../types";
import PaneTabBar from "./PaneTabBar";
import XTermWrapper from "../terminal/XTermWrapper";
import {
  useWorkspaceLayoutStore,
  useUiStore,
  usePaneMetadataStore
} from "../../stores/workspaceStore";
import { useWorkspaceListStore } from "../../stores/workspaceListStore";
import { getAgent, getDefaultAgent } from "../../lib/agents";
import { killSession } from "../../lib/ipc";

interface TerminalPaneProps {
  pane: Pane;
  workspaceId: string;
  onClose?: () => void;
  onSplitRight?: () => void;
  onSplitDown?: () => void;
}

export default memo(function TerminalPane({ pane, workspaceId, onClose, onSplitRight, onSplitDown }: TerminalPaneProps) {
  // Derived boolean selectors — only re-renders when THIS pane's state actually changes
  const isActive = useUiStore((s) => s.activePaneId === pane.sessionId);
  const isZoomed = useUiStore((s) => s.zoomedPaneId === pane.id);
  const setActivePaneId = useUiStore((s) => s.setActivePaneId);
  const setZoomedPaneId = useUiStore((s) => s.setZoomedPaneId);

  // Granular metadata selectors — only re-renders when notification count changes
  const notificationCount = usePaneMetadataStore((s) =>
    pane.tabs.reduce((sum, tab) => sum + (s.metadata[tab.sessionId]?.notificationCount ?? 0), 0)
  );
  const clearNotification = usePaneMetadataStore((s) => s.clearNotification);

  const addTabToPane = useWorkspaceLayoutStore((s) => s.addTabToPane);
  const removeTabFromPane = useWorkspaceLayoutStore((s) => s.removeTabFromPane);
  const setActivePaneTab = useWorkspaceLayoutStore((s) => s.setActivePaneTab);

  const hasNotification = notificationCount > 0;
  const [mountedTabIds, setMountedTabIds] = useState<Set<string>>(() => new Set([pane.activeTabId]));

  // Two-state border: active (accent) or inactive (transparent).
  // Notification border is handled by the CSS .has-notification class.
  const borderColor = isZoomed
    ? "transparent"
    : isActive
      ? "var(--cmux-accent, rgba(10, 132, 255, 0.7))"
      : "transparent";
  const borderWidth = isActive && !isZoomed ? 2 : 1;

  const handleFocus = useCallback(() => {
    setActivePaneId(pane.sessionId);
    // Read current tabs from store at call time (avoids stale pane.tabs dependency)
    const ws = useWorkspaceListStore.getState().getWorkspace(workspaceId);
    const p = ws?.panes.find((x) => x.id === pane.id);
    if (p) {
      for (const tab of p.tabs) {
        clearNotification(tab.sessionId);
      }
    }
  }, [pane.sessionId, pane.id, workspaceId, setActivePaneId, clearNotification]);

  const handleBlur = useCallback(() => {
    setActivePaneId(null);
  }, [setActivePaneId]);

  const handleAddTab = useCallback((agentId?: string, type?: PaneTab["type"]) => {
    addTabToPane(workspaceId, pane.id, agentId, type);
  }, [workspaceId, pane.id, addTabToPane]);

  const handleRemoveTab = useCallback((tabId: string) => {
    const ws = useWorkspaceListStore.getState().getWorkspace(workspaceId);
    const p = ws?.panes.find((x) => x.id === pane.id);
    const tab = p?.tabs.find((t) => t.id === tabId);
    if (tab) killSession(tab.sessionId).catch(() => {});
    removeTabFromPane(workspaceId, pane.id, tabId);
  }, [workspaceId, pane.id, removeTabFromPane]);

  const handleSelectTab = useCallback((tabId: string) => {
    setActivePaneTab(workspaceId, pane.id, tabId);
    const ws = useWorkspaceListStore.getState().getWorkspace(workspaceId);
    const p = ws?.panes.find((x) => x.id === pane.id);
    const tab = p?.tabs.find((t) => t.id === tabId);
    if (tab) setActivePaneId(tab.sessionId);
  }, [workspaceId, pane.id, setActivePaneTab, setActivePaneId]);

  const handleZoomToggle = useCallback(() => {
    const currentZoomed = useUiStore.getState().zoomedPaneId;
    setZoomedPaneId(currentZoomed === pane.id ? null : pane.id);
  }, [pane.id, setZoomedPaneId]);

  useEffect(() => {
    setMountedTabIds((prev) => {
      if (prev.has(pane.activeTabId)) {
        return prev;
      }
      const next = new Set(prev);
      next.add(pane.activeTabId);
      return next;
    });
  }, [pane.activeTabId]);

  // Resolve CWD from pane/tab static data (metadata CWD handled by PTY monitor internally)
  const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId);
  const paneCwd = activeTab?.cwd ?? pane.cwd;

  return (
    <div
      data-session-id={pane.sessionId}
      tabIndex={-1}
      onFocus={handleFocus}
      onBlur={handleBlur}
      className={`terminal-pane-border${hasNotification ? ' has-notification' : ''}`}
      style={{
        ...(isZoomed ? {
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 100,
          background: "var(--cmux-bg, #0a0a0a)",
        } : {
          position: "relative",
          width: "100%",
          height: "100%",
        }),
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        background: "var(--cmux-bg, #0a0a0a)",
        ["--pane-border-width" as string]: `${borderWidth}px`,
        ["--pane-border-color" as string]: borderColor,
      } as React.CSSProperties & Record<string, string>}
    >
      <PaneTabBar
        pane={pane}
        workspaceId={workspaceId}
        hasNotification={hasNotification}
        onClose={onClose}
        onSplitRight={onSplitRight}
        onSplitDown={onSplitDown}
        onAddTab={handleAddTab}
        onRemoveTab={handleRemoveTab}
        onSelectTab={handleSelectTab}
      />

      <div style={{ flex: 1, minHeight: 0, overflow: "hidden", position: "relative", background: "var(--cmux-bg, #0a0a0a)" }}>
        {pane.tabs.filter((tab) => mountedTabIds.has(tab.id)).map((tab) => {
          const isActiveTab = tab.id === pane.activeTabId;
          const resolvedAgentId = tab.agentId === "shell-starter" ? "shell" : tab.agentId;
          const agent = getAgent(resolvedAgentId) ?? getDefaultAgent();
          const tabCwd = tab.cwd ?? paneCwd;

          return (
            <div
              key={tab.id}
              style={{
                position: "absolute",
                inset: 0,
                display: isActiveTab ? "flex" : "none",
                flexDirection: "column",
              }}
            >
              <ErrorBoundary>
                <XTermWrapper
                  sessionId={tab.sessionId}
                  command={agent.command}
                  args={agent.args}
                  suppressNotifications={isActive && tab.id === pane.activeTabId}
                  onZoomToggle={handleZoomToggle}
                  cwd={tabCwd}
                />
              </ErrorBoundary>
            </div>
          );
        })}
      </div>
    </div>
  );
});
