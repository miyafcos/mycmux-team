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
import { killSession, writeToSession } from "../../lib/ipc";
import { quoteShellPath } from "../../lib/paths";
import { evictTerminalCache } from "../terminal/XTermWrapper";

interface TerminalPaneProps {
  pane: Pane;
  workspaceId: string;
  onClose?: () => void;
  onSplitRight?: () => void;
  onSplitDown?: () => void;
}

export default memo(function TerminalPane({ pane, workspaceId, onClose, onSplitRight, onSplitDown }: TerminalPaneProps) {
  // Derived boolean selectors — only re-renders when THIS pane's state actually changes.
  // isActive now checks against any of this pane's tab sessionIds so that it
  // works both when focus fires on pane.sessionId and when a specific tab is selected.
  const activePaneId = useUiStore((s) => s.activePaneId);
  const isActive = activePaneId !== null && (
    activePaneId === pane.sessionId ||
    pane.tabs.some((t) => t.sessionId === activePaneId)
  );
  const isZoomed = useUiStore((s) => s.zoomedPaneId === pane.id);
  const setActivePaneId = useUiStore((s) => s.setActivePaneId);
  const setZoomedPaneId = useUiStore((s) => s.setZoomedPaneId);

  // Granular metadata selectors — only re-renders when notification/done count changes
  const notificationCount = usePaneMetadataStore((s) =>
    pane.tabs.reduce(
      (sum, tab) =>
        sum +
        (s.metadata[tab.sessionId]?.notificationCount ?? 0) +
        (s.metadata[tab.sessionId]?.workDoneCount ?? 0),
      0,
    ),
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
    // Read current tabs from store at call time (avoids stale pane.tabs dependency)
    const ws = useWorkspaceListStore.getState().getWorkspace(workspaceId);
    const p = ws?.panes.find((x) => x.id === pane.id);
    // Set activePaneId to the *currently visible* tab's sessionId so that
    // XTermWrapper notification suppression can use a single store check.
    const activeTab = p?.tabs.find((t) => t.id === p.activeTabId);
    setActivePaneId(activeTab?.sessionId ?? pane.sessionId);
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
    if (tab) {
      evictTerminalCache(tab.sessionId);
      killSession(tab.sessionId).catch(() => {});
      usePaneMetadataStore.getState().removeMetadata(tab.sessionId);
    }
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

  const handleInternalDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    // Only accept our own internal MIME so we don't interfere with other drops.
    if (e.dataTransfer.types.includes("application/x-mycmux-path")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const handleInternalDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      const path = e.dataTransfer.getData("application/x-mycmux-path");
      if (!path) return;
      e.preventDefault();
      e.stopPropagation();
      const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId);
      const targetSessionId = activeTab?.sessionId ?? pane.sessionId;
      void writeToSession(targetSessionId, quoteShellPath(path) + " ");
    },
    [pane.tabs, pane.activeTabId, pane.sessionId],
  );

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
      onDragOver={handleInternalDragOver}
      onDrop={handleInternalDrop}
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
        isZoomed={isZoomed}
        onClose={onClose}
        onSplitRight={onSplitRight}
        onSplitDown={onSplitDown}
        onZoomToggle={handleZoomToggle}
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
                  onZoomToggle={handleZoomToggle}
                  cwd={tabCwd}
                  launchEnv={(() => {
                    const env: Record<string, string> = {
                      MYCMUX_PANE_SESSION_ID: tab.sessionId,
                    };
                    if (tab.claudeSessionId) {
                      // claudeSessionId is detected from ~/.claude/projects/ so always resume as claude.
                      // The shell agent launches bash → launcher.sh handles MYCMUX_RESUME.
                      env.MYCMUX_RESUME = "claude";
                      env.MYCMUX_SESSION_ID = tab.claudeSessionId;
                    }
                    return env;
                  })()}
                />
              </ErrorBoundary>
            </div>
          );
        })}
      </div>
    </div>
  );
});
