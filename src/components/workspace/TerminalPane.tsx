import { memo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import ErrorBoundary from "../common/ErrorBoundary";
import type { Pane, PaneTab } from "../../types";
import PaneTabBar from "./PaneTabBar";
import XTermWrapper from "../terminal/XTermWrapper";
import BrowserPane from "../browser/BrowserPane";
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
  const paneMeta = usePaneMetadataStore((s) => s.metadata[pane.sessionId]);
  const notificationCount = paneMeta?.notificationCount ?? 0;
  const paneCwd = paneMeta?.cwd ?? pane.cwd;
  const flashingPaneIds = usePaneMetadataStore((s) => s.flashingPaneIds);
  const activePaneId = useUiStore((s) => s.activePaneId);
  const setActivePaneId = useUiStore((s) => s.setActivePaneId);
  const zoomedPaneId = useUiStore((s) => s.zoomedPaneId);
  const setZoomedPaneId = useUiStore((s) => s.setZoomedPaneId);
  const clearNotification = usePaneMetadataStore((s) => s.clearNotification);
  const addTabToPane = useWorkspaceLayoutStore((s) => s.addTabToPane);
  const removeTabFromPane = useWorkspaceLayoutStore((s) => s.removeTabFromPane);
  const setActivePaneTab = useWorkspaceLayoutStore((s) => s.setActivePaneTab);

  const isActive = activePaneId === pane.sessionId;
  const isFlashing = flashingPaneIds.has(pane.sessionId);
  const isZoomed = zoomedPaneId === pane.id;

  // Agent status from active tab's metadata
  const activeTabSessionId = pane.tabs.find((t) => t.id === pane.activeTabId)?.sessionId;
  const activeTabMeta = usePaneMetadataStore((s) => activeTabSessionId ? s.metadata[activeTabSessionId] : undefined);
  const agentStatus = activeTabMeta?.agentStatus ?? "idle";

  // Map status to rgba border colors (inactive panes get 40% opacity)
  const STATUS_BORDERS = {
    working: { active: "rgba(59, 130, 246, 0.9)", inactive: "rgba(59, 130, 246, 0.25)" },
    waiting: { active: "rgba(245, 158, 11, 1.0)", inactive: "rgba(245, 158, 11, 0.35)" },
    done:    { active: "rgba(16, 185, 129, 0.9)", inactive: "rgba(16, 185, 129, 0.25)" },
    idle:    { active: "var(--cmux-accent, rgba(10, 132, 255, 0.7))", inactive: "transparent" },
  };
  const statusKey = (agentStatus in STATUS_BORDERS ? agentStatus : "idle") as keyof typeof STATUS_BORDERS;
  const borderColor = isZoomed ? "transparent" : (isActive ? STATUS_BORDERS[statusKey].active : STATUS_BORDERS[statusKey].inactive);
  const borderWidth = isActive && !isZoomed ? 2 : 1;

  const handleFocus = useCallback(() => {
    setActivePaneId(pane.sessionId);
    clearNotification(pane.sessionId);
  }, [pane.sessionId, setActivePaneId, clearNotification]);

  const handleBlur = useCallback(() => {
    setActivePaneId(null);
  }, [setActivePaneId]);

  const handleAddTab = useCallback((agentId?: string, type?: PaneTab["type"]) => {
    addTabToPane(workspaceId, pane.id, agentId, type);
  }, [workspaceId, pane.id, addTabToPane]);

  const handleRemoveTab = useCallback((tabId: string) => {
    // Kill the PTY session for this tab before removing
    const tab = pane.tabs.find((t) => t.id === tabId);
    if (tab) killSession(tab.sessionId).catch(() => {});
    removeTabFromPane(workspaceId, pane.id, tabId);
  }, [workspaceId, pane.id, pane.tabs, removeTabFromPane]);

  const handleSelectTab = useCallback((tabId: string) => {
    setActivePaneTab(workspaceId, pane.id, tabId);
    // Update active pane when switching tabs
    const tab = pane.tabs.find((t) => t.id === tabId);
    if (tab) setActivePaneId(tab.sessionId);
  }, [workspaceId, pane.id, pane.tabs, setActivePaneTab, setActivePaneId]);

  const handleZoomToggle = useCallback(() => {
    const currentZoomed = useUiStore.getState().zoomedPaneId;
    setZoomedPaneId(currentZoomed === pane.id ? null : pane.id);
  }, [pane.id, setZoomedPaneId]);

  // Open clicked URLs in the browser pane (reuse existing or create new)
  const handleUrlClick = useCallback((url: string) => {
    const workspace = useWorkspaceListStore.getState().getWorkspace(workspaceId);
    const currentPane = workspace?.panes.find((p) => p.id === pane.id);
    const existingBrowser = currentPane?.tabs.find((t) => t.type === "browser");

    if (existingBrowser) {
      // Switch to the browser tab and navigate
      setActivePaneTab(workspaceId, pane.id, existingBrowser.id);
      invoke("browser_navigate", { sessionId: existingBrowser.sessionId, url }).catch(console.error);
    } else {
      // Create a new browser tab, then navigate after it mounts
      addTabToPane(workspaceId, pane.id, undefined, "browser");
      // Give BrowserPane time to mount and create the webview
      setTimeout(() => {
        const updated = useWorkspaceListStore.getState().getWorkspace(workspaceId);
        const updatedPane = updated?.panes.find((p) => p.id === pane.id);
        const newBrowser = updatedPane?.tabs.find((t) => t.type === "browser");
        if (newBrowser) {
          invoke("browser_navigate", { sessionId: newBrowser.sessionId, url }).catch(console.error);
        }
      }, 800);
    }
  }, [workspaceId, pane.id, addTabToPane, setActivePaneTab]);

  return (
    <div
      data-session-id={pane.sessionId}
      tabIndex={-1}
      onFocus={handleFocus}
      onBlur={handleBlur}
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
        outline: `${borderWidth}px solid ${borderColor}`,
        transition: "outline 0.15s",
      }}
    >
      {/* Flash overlay */}
      {isFlashing && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            zIndex: 20,
            borderRadius: 2,
            animation: "paneFlash 0.9s ease-out",
            border: "3px solid var(--cmux-accent)",
          }}
        />
      )}

      <PaneTabBar
        pane={pane}
        workspaceId={workspaceId}
        hasNotification={notificationCount > 0}
        onClose={onClose}
        onSplitRight={onSplitRight}
        onSplitDown={onSplitDown}
        onAddTab={handleAddTab}
        onRemoveTab={handleRemoveTab}
        onSelectTab={handleSelectTab}
      />

      <div style={{ flex: 1, minHeight: 0, overflow: "hidden", position: "relative" }}>
        {/* Render all tabs — hide inactive ones to preserve PTY state */}
        {pane.tabs.map((tab) => {
          const isActiveTab = tab.id === pane.activeTabId;
          const agent = getAgent(tab.agentId) ?? getDefaultAgent();

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
                {tab.type === "browser" ? (
                  <BrowserPane sessionId={tab.sessionId} />
                ) : (
                  <XTermWrapper
                    sessionId={tab.sessionId}
                    command={agent.command}
                    args={agent.args}
                    suppressNotifications={isActive && tab.id === pane.activeTabId}
                    onZoomToggle={handleZoomToggle}
                    onUrlClick={handleUrlClick}
                    cwd={paneCwd}
                  />
                )}
              </ErrorBoundary>
            </div>
          );
        })}
      </div>
    </div>
  );
});
