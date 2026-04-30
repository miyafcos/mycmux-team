import { memo, useCallback } from "react";
import ErrorBoundary from "../common/ErrorBoundary";
import type { AgentSessionKind, Pane, PaneTab } from "../../types";
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
import { evictTerminalCache } from "../terminal/XTermWrapper";
import { usePaneDragStore, type PaneDragItem, type PaneDropTarget } from "../../stores/paneDragStore";

interface TerminalPaneProps {
  pane: Pane;
  workspaceId: string;
  onClose?: () => void;
  onSplitRight?: () => void;
  onSplitDown?: () => void;
}

function isShellLauncher(agentId: string | undefined, command: string): boolean {
  if (agentId === "shell" || agentId === "shell-starter") return true;
  const leaf = command.toLowerCase().split(/[\\/]/).pop()?.replace(/\.exe$/, "");
  return leaf === "bash" || leaf === "sh";
}

function resolveSavedAgentSession(tab: PaneTab): { kind: AgentSessionKind; sessionId: string } | null {
  if (tab.agentKind && tab.agentSessionId) {
    return { kind: tab.agentKind, sessionId: tab.agentSessionId };
  }
  if (tab.claudeSessionId) {
    return { kind: "claude", sessionId: tab.claudeSessionId };
  }
  return null;
}

function buildLaunchArgs(
  command: string,
  args: string[],
  agentId: string | undefined,
  savedSession: { kind: AgentSessionKind; sessionId: string } | null,
  newSessionId: string | undefined,
  cwd: string | undefined,
): string[] {
  if (!savedSession) {
    if (agentId === "claude-code" && newSessionId) {
      return [
        ...args,
        "--dangerously-skip-permissions",
        "--permission-mode",
        "bypassPermissions",
        "--session-id",
        newSessionId,
      ];
    }
    return args;
  }
  if (isShellLauncher(agentId, command)) return args;
  switch (savedSession.kind) {
    case "claude":
      return [
        "--dangerously-skip-permissions",
        "--permission-mode",
        "bypassPermissions",
        "--resume",
        savedSession.sessionId,
      ];
    case "codex":
      return [
        "resume",
        "--no-alt-screen",
        ...(cwd ? ["-C", cwd] : []),
        savedSession.sessionId,
      ];
    case "claude-codex":
      return ["--resume", savedSession.sessionId];
  }
  return args;
}

function getDropPreviewLabel(item: PaneDragItem, target: PaneDropTarget): string {
  if (target.kind === "new-workspace") {
    return item.kind === "tab" ? "Move tab to new workspace" : "Move pane to new workspace";
  }
  if (target.zone === "center") {
    return item.kind === "tab" ? "Attach tab here" : "Merge panes";
  }
  const direction = {
    left: "left",
    right: "right",
    up: "above",
    down: "below",
  }[target.zone];
  return item.kind === "tab"
    ? `Split tab ${direction}`
    : `Split pane ${direction}`;
}

export default memo(function TerminalPane({ pane, workspaceId, onClose, onSplitRight, onSplitDown }: TerminalPaneProps) {
  // Derived boolean selectors only re-render when THIS pane's state actually changes.
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
  const dragItem = usePaneDragStore((s) => s.item);
  const dropTarget = usePaneDragStore((s) =>
    s.target?.kind === "pane" && s.target.workspaceId === workspaceId && s.target.paneId === pane.id
      ? s.target
      : null,
  );
  const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId);
  const activeTabMetadataAgentKind = usePaneMetadataStore((s) =>
    activeTab ? s.metadata[activeTab.sessionId]?.agentKind : undefined,
  );

  // Granular metadata selectors only re-render when notification/done count changes.
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
    // Set activePaneId to the currently visible tab's sessionId so that
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

  // Resolve CWD from pane/tab static data (metadata CWD handled by PTY monitor internally)
  const paneCwd = activeTab?.cwd ?? pane.cwd;
  const resolvedAgentId = activeTab?.agentId;
  const agent = resolvedAgentId ? (getAgent(resolvedAgentId) ?? getDefaultAgent()) : null;
  const savedAgentSession = activeTab ? resolveSavedAgentSession(activeTab) : null;
  const launchArgs = agent
    ? buildLaunchArgs(agent.command, agent.args, resolvedAgentId, savedAgentSession, activeTab?.id, activeTab?.cwd ?? paneCwd)
    : [];
  const dropPreviewClass = dropTarget && dragItem
    ? [
        "pane-drop-preview",
        `pane-drop-preview--${dropTarget.zone}`,
        dropTarget.zone === "center"
          ? (dragItem.kind === "tab" ? "pane-drop-preview--attach-tab" : "pane-drop-preview--merge-pane")
          : "pane-drop-preview--split",
        `pane-drop-preview--source-${dragItem.kind}`,
      ].join(" ")
    : null;
  const dropPreviewLabel = dropTarget && dragItem
    ? getDropPreviewLabel(dragItem, dropTarget)
    : null;

  return (
    <div
      data-session-id={pane.sessionId}
      data-dnd-workspace-id={workspaceId}
      data-dnd-pane-id={pane.id}
      tabIndex={-1}
      onFocus={handleFocus}
      onBlur={handleBlur}
      className={`terminal-pane-border${hasNotification ? " has-notification" : ""}`}
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
        {activeTab && agent ? (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <ErrorBoundary>
              <XTermWrapper
                sessionId={activeTab.sessionId}
                command={agent.command}
                args={launchArgs}
                agentId={resolvedAgentId}
                agentKind={savedAgentSession?.kind ?? activeTab.agentKind ?? activeTabMetadataAgentKind}
                onZoomToggle={handleZoomToggle}
                cwd={activeTab.cwd ?? paneCwd}
                initialReplay={savedAgentSession ? undefined : activeTab.terminalSnapshot}
                launchEnv={(() => {
                  const env: Record<string, string> = {
                    MYCMUX_PANE_SESSION_ID: activeTab.sessionId,
                    MYCMUX_TAB_ID: activeTab.id,
                  };
                  if (resolvedAgentId === "shell-starter") {
                    env.__CMUX_LAUNCHER_DONE = "1";
                  }
                  if (savedAgentSession) {
                    env.MYCMUX_AGENT_KIND = savedAgentSession.kind;
                    env.MYCMUX_SESSION_ID = savedAgentSession.sessionId;
                    env.MYCMUX_RESUME = savedAgentSession.kind;
                  } else if (resolvedAgentId === "claude-code") {
                    env.MYCMUX_AGENT_KIND = "claude";
                  }
                  return env;
                })()}
              />
            </ErrorBoundary>
          </div>
        ) : null}
      </div>
      {dropPreviewClass && (
        <div className={dropPreviewClass}>
          {dropPreviewLabel && (
            <span className="pane-drop-preview__label">{dropPreviewLabel}</span>
          )}
        </div>
      )}
    </div>
  );
});
