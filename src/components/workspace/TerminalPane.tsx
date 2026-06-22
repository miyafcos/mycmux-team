import { memo, useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { open } from "@tauri-apps/plugin-shell";
import ErrorBoundary from "../common/ErrorBoundary";
import type { AgentSessionKind, Pane, PaneTab } from "../../types";
import PaneTabBar from "./PaneTabBar";
import XTermWrapper from "../terminal/XTermWrapper";
import BrowserPane from "./BrowserPane";
import {
  useWorkspaceLayoutStore,
  useUiStore,
  usePaneMetadataStore
} from "../../stores/workspaceStore";
import { useWorkspaceListStore } from "../../stores/workspaceListStore";
import { getAgent, getDefaultAgent } from "../../lib/agents";
import { killSession, previewArtifactUriForSessionV2 } from "../../lib/ipc";
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

/**
 * OSC 9988 payload normalization: convert "file:///C:/..." or "/C:/..." into a
 * raw absolute path that convertFileSrc() expects (e.g. "C:/Users/...").
 * Handles Windows drive letters and POSIX paths uniformly, and collapses
 * backslashes to "/" so the same file yields one canonical string (stable dedup).
 */
function normalizeHtmlPath(payload: string): string {
  let p = payload.trim();
  if (p.startsWith("file://")) {
    p = p.slice(7);
    // Windows: leading "/C:/..." → strip the slash; POSIX: keep "/Users/...".
    if (/^\/[A-Za-z]:/.test(p)) {
      p = p.slice(1);
    }
  }
  try {
    p = decodeURIComponent(p);
  } catch {
    // payload was not URL-encoded; leave as-is
  }
  return p.replace(/\\/g, "/");
}

/**
 * Security gate for OSC 9988. The terminal emits arbitrary bytes, so the payload
 * path is fully untrusted — any program writing to the pane could forge the
 * escape with a path to credentials or any other local file, and assetProtocol
 * scope is "**". The Rust backend injects exactly one canonical sidetab path per
 * session (~/.mycmux/sessions/<sessionId>/out.html) and strips inbound overrides,
 * so the only legitimate target is that file. Bind the rendered path to the
 * pane's own (app-assigned) sessionId and the fixed leaf, rejecting everything
 * else regardless of where $HOME lives. paneSessionId is trusted; the path is not.
 */
function isCanonicalSidetabPath(normalizedPath: string, paneSessionId: string): boolean {
  if (!paneSessionId || /[\\/]/.test(paneSessionId) || paneSessionId.includes("..")) {
    return false;
  }
  if (normalizedPath.includes("..")) {
    return false;
  }
  const expectedSuffix = `/.mycmux/sessions/${paneSessionId}/out.html`;
  // Path segments are backend-fixed lowercase + a lowercase-hex uuid; compare
  // case-insensitively so Windows drive/home casing never yields a false reject.
  return normalizedPath.toLowerCase().endsWith(expectedSuffix.toLowerCase());
}

function isLocalArtifactLink(uri: string): boolean {
  const trimmed = uri.trim();
  return (
    /^file:\/\//i.test(trimmed)
    || /^[A-Za-z]:[\\/]/.test(trimmed)
    // MSYS / Git-Bash absolute form: `/c/Users/...` (single-letter drive).
    || /^\/[A-Za-z]\//.test(trimmed)
  );
}

function focusTerminalElement(paneEl: HTMLElement | null | undefined): boolean {
  const textarea = paneEl?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
  if (textarea) {
    textarea.focus();
    return true;
  }
  return false;
}

function scheduleTerminalFocus(resolvePane: () => HTMLElement | null | undefined): void {
  let attempts = 0;
  const restoreFocus = (): void => {
    attempts += 1;
    const didFocusTerminal = focusTerminalElement(resolvePane());
    if (didFocusTerminal || attempts >= 8) {
      return;
    }
    window.setTimeout(() => {
      if (typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(restoreFocus);
        return;
      }
      restoreFocus();
    }, attempts < 3 ? 16 : 50);
  };

  window.setTimeout(() => {
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(restoreFocus);
      return;
    }
    restoreFocus();
  }, 0);
}

function focusTerminalInPaneSoon(paneId: string): void {
  scheduleTerminalFocus(() => document.querySelector<HTMLElement>(`[data-dnd-pane-id="${paneId}"]`));
}

function focusActiveTerminalSoon(fallbackPaneId: string): void {
  scheduleTerminalFocus(() => {
    const activePaneId = useUiStore.getState().activePaneId;
    const activePaneEl = activePaneId
      ? document.querySelector<HTMLElement>(`[data-session-id="${activePaneId}"]`)
      : null;
    if (activePaneEl) {
      return activePaneEl;
    }
    return document.querySelector<HTMLElement>(`[data-dnd-pane-id="${fallbackPaneId}"]`);
  });
}

const PANE_CLICK_ACTIVATE_MAX_DISTANCE_PX = 5;

type PaneActivationOptions = {
  focusTerminal?: boolean;
};

type PendingPaneClickActivation = {
  pointerId: number;
  x: number;
  y: number;
};

const PANE_CLICK_IGNORED_TARGET_SELECTOR = [
  "button",
  "a",
  "input",
  "textarea",
  "select",
  "iframe",
  "[contenteditable='true']",
  ".pane-tabbar",
  ".pane-tab-pill",
  ".pane-action-btn",
  "[data-pane-drag-handle]",
].join(",");

function shouldIgnorePaneClickActivationTarget(target: EventTarget | null): boolean {
  return target instanceof Element
    ? Boolean(target.closest(PANE_CLICK_IGNORED_TARGET_SELECTOR))
    : true;
}

function hasDocumentTextSelection(): boolean {
  const selection = window.getSelection?.();
  return Boolean(selection && selection.toString().trim().length > 0);
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
  // isActive checks against any of this pane's tab sessionIds so the border
  // follows the session that is actually receiving input, not mouse selection.
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
  const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId) ?? pane.tabs[0];
  const activeTabMetadataAgentKind = usePaneMetadataStore((s) =>
    activeTab ? s.metadata[activeTab.sessionId]?.agentKind : undefined,
  );
  const pendingPaneClickActivationRef = useRef<PendingPaneClickActivation | null>(null);

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
  const openOrReloadHtmlPreviewPane = useWorkspaceLayoutStore((s) => s.openOrReloadHtmlPreviewPane);
  const setBrowserTabDirty = useWorkspaceLayoutStore((s) => s.setBrowserTabDirty);
  const refreshBrowserTabPreview = useWorkspaceLayoutStore((s) => s.refreshBrowserTabPreview);

  // OSC 9988 from XTermWrapper. Match by pane.tabs membership (not activeTab)
  // so reloads still fire after the browser tab is activated and the terminal
  // sessionId is no longer activeTab.sessionId.
  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as
        | { paneSessionId?: string; payload?: string }
        | undefined;
      if (!detail?.paneSessionId || !detail.payload) return;
      if (!pane.tabs.some((t) => t.sessionId === detail.paneSessionId)) return;
      const htmlPath = normalizeHtmlPath(detail.payload);
      if (!htmlPath) return;
      // Reject forged OSC payloads that point anywhere but this session's
      // canonical sidetab file. Without this, terminal output could render
      // arbitrary local files in the iframe (assetProtocol scope is "**").
      if (!isCanonicalSidetabPath(htmlPath, detail.paneSessionId)) {
        return;
      }
      openOrReloadHtmlPreviewPane(workspaceId, pane.id, {
        previewPath: htmlPath,
        sourcePath: htmlPath,
        sourceKind: "html",
      });
    };
    window.addEventListener("mycmux:html-out", handler);
    return () => window.removeEventListener("mycmux:html-out", handler);
  }, [pane.tabs, pane.id, workspaceId, openOrReloadHtmlPreviewPane]);

  const hasNotification = notificationCount > 0;

  // Two-state border: active (accent) or inactive (transparent).
  // Notification border is handled by the CSS .has-notification class.
  const borderColor = isZoomed
    ? "transparent"
    : isActive
      ? "var(--cmux-accent, rgba(10, 132, 255, 0.7))"
      : "transparent";
  const borderWidth = isActive && !isZoomed ? 2 : 1;


  const activatePane = useCallback((options: PaneActivationOptions = {}) => {
    const ws = useWorkspaceListStore.getState().getWorkspace(workspaceId);
    const p = ws?.panes.find((candidate) => candidate.id === pane.id);
    const tab = p?.tabs.find((candidate) => candidate.id === p.activeTabId) ?? p?.tabs[0];
    if (!p || !tab || tab.type === "browser") return;
    if (useUiStore.getState().activePaneId !== tab.sessionId) {
      setActivePaneId(tab.sessionId);
    }
    for (const candidate of p.tabs) {
      clearNotification(candidate.sessionId);
    }
    if (options.focusTerminal ?? true) {
      focusTerminalInPaneSoon(pane.id);
    }
  }, [workspaceId, pane.id, setActivePaneId, clearNotification]);

  const handlePanePointerDownCapture = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (
      event.button !== 0 ||
      event.shiftKey ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      shouldIgnorePaneClickActivationTarget(event.target)
    ) {
      pendingPaneClickActivationRef.current = null;
      return;
    }
    pendingPaneClickActivationRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };
    activatePane({ focusTerminal: false });
  }, [activatePane]);

  const handlePanePointerUpCapture = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const pending = pendingPaneClickActivationRef.current;
    pendingPaneClickActivationRef.current = null;
    if (!pending || pending.pointerId !== event.pointerId || event.button !== 0) return;
    if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
    if (shouldIgnorePaneClickActivationTarget(event.target)) return;
    if (Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > PANE_CLICK_ACTIVATE_MAX_DISTANCE_PX) return;
    if (hasDocumentTextSelection()) return;
    activatePane();
  }, [activatePane]);

  const handlePaneWheelCapture = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    if (shouldIgnorePaneClickActivationTarget(event.target)) return;
    activatePane({ focusTerminal: false });
  }, [activatePane]);

  const handlePanePointerCancelCapture = useCallback(() => {
    pendingPaneClickActivationRef.current = null;
  }, []);

  const handleAddTab = useCallback((agentId?: string, type?: PaneTab["type"]) => {
    addTabToPane(workspaceId, pane.id, agentId, type);
    focusTerminalInPaneSoon(pane.id);
  }, [workspaceId, pane.id, addTabToPane]);

  const handleRemoveTab = useCallback((tabId: string) => {
    const ws = useWorkspaceListStore.getState().getWorkspace(workspaceId);
    const p = ws?.panes.find((x) => x.id === pane.id);
    const tab = p?.tabs.find((t) => t.id === tabId);
    if (tab?.type === "browser" && tab.isDirty) {
      const label = tab.label ?? tab.sourcePath ?? tab.htmlPath ?? "artifact";
      if (!window.confirm(`${label} has unsaved edits. Close it anyway?`)) {
        return;
      }
    }
    if (tab) {
      evictTerminalCache(tab.sessionId);
      killSession(tab.sessionId).catch(() => {});
      usePaneMetadataStore.getState().removeMetadata(tab.sessionId);
    }
    removeTabFromPane(workspaceId, pane.id, tabId);
    focusTerminalInPaneSoon(pane.id);
  }, [workspaceId, pane.id, removeTabFromPane]);

  const handleSelectTab = useCallback((tabId: string) => {
    setActivePaneTab(workspaceId, pane.id, tabId);
    const ws = useWorkspaceListStore.getState().getWorkspace(workspaceId);
    const p = ws?.panes.find((x) => x.id === pane.id);
    const tab = p?.tabs.find((t) => t.id === tabId);
    if (tab) setActivePaneId(tab.sessionId);
    focusTerminalInPaneSoon(pane.id);
  }, [workspaceId, pane.id, setActivePaneTab, setActivePaneId]);

  const handleZoomToggle = useCallback(() => {
    const currentZoomed = useUiStore.getState().zoomedPaneId;
    setZoomedPaneId(currentZoomed === pane.id ? null : pane.id);
    // Restore keyboard focus to this pane's terminal after the layout change.
    // The keyboard path keeps focus on the xterm textarea, but the toolbar
    // zoom button moves focus to the <button>; without this the user must
    // click back into the terminal before typing.
    focusTerminalInPaneSoon(pane.id);
  }, [pane.id, setZoomedPaneId]);

  const handleUrlClick = useCallback((uri: string) => {
    const workspace = useWorkspaceListStore.getState().getWorkspace(workspaceId);
    const currentPane = workspace?.panes.find((candidate) => candidate.id === pane.id);
    const currentTab = currentPane?.tabs.find((tab) => tab.id === currentPane.activeTabId);
    if (!currentTab || currentTab.type === "browser") {
      open(uri).catch((error) => console.error("[mycmux] open URL failed", error));
      return;
    }
    previewArtifactUriForSessionV2(currentTab.sessionId, uri)
      .then((info) => openOrReloadHtmlPreviewPane(workspaceId, pane.id, info))
      .catch((error) => {
        if (isLocalArtifactLink(uri)) {
          // In-app preview failed (e.g. unreadable file / backend error). Don't
          // swallow it into a dead click — fall back to the OS default app so
          // the user still sees the file open somewhere.
          console.warn("[mycmux] local artifact preview rejected, opening externally", error);
          open(uri).catch((openError) =>
            console.error("[mycmux] fallback open of local artifact failed", openError),
          );
          return;
        }
        open(uri).catch((error) => console.error("[mycmux] open URL failed", error));
      });
  }, [openOrReloadHtmlPreviewPane, pane.id, workspaceId]);

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
      data-active-pane={isActive && !isZoomed ? "true" : undefined}
      data-pane-zoomed={isZoomed ? "true" : undefined}
      tabIndex={-1}
      onPointerDownCapture={handlePanePointerDownCapture}
      onPointerUpCapture={handlePanePointerUpCapture}
      onPointerCancelCapture={handlePanePointerCancelCapture}
      onWheelCapture={handlePaneWheelCapture}
      className={`terminal-pane-border${hasNotification ? " has-notification" : ""}`}
      style={{
        ...(isZoomed ? {
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 100,
        } : {
          position: "relative",
          width: "100%",
          height: "100%",
        }),
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        background: "transparent",
        ["--pane-border-width" as string]: `${borderWidth}px`,
        ["--pane-border-color" as string]: borderColor,
      } as React.CSSProperties & Record<string, string>}
    >
      <PaneTabBar
        pane={pane}
        workspaceId={workspaceId}
        hasNotification={hasNotification}
        isZoomed={isZoomed}
        onClose={onClose ? () => {
          onClose();
          focusActiveTerminalSoon(pane.id);
        } : undefined}
        onSplitRight={onSplitRight ? () => {
          onSplitRight();
          focusActiveTerminalSoon(pane.id);
        } : undefined}
        onSplitDown={onSplitDown ? () => {
          onSplitDown();
          focusActiveTerminalSoon(pane.id);
        } : undefined}
        onZoomToggle={handleZoomToggle}
        onAddTab={handleAddTab}
        onRemoveTab={handleRemoveTab}
        onSelectTab={handleSelectTab}
      />

      <div style={{ flex: 1, minHeight: 0, overflow: "hidden", position: "relative", background: "transparent" }}>
        {activeTab?.type === "browser" && activeTab.htmlPath ? (
          <ErrorBoundary>
            <BrowserPane
              htmlPath={activeTab.htmlPath}
              sourcePath={activeTab.sourcePath}
              sourceKind={activeTab.sourceKind}
              previewPath={activeTab.previewPath ?? activeTab.htmlPath}
              reloadKey={activeTab.reloadCounter ?? 0}
              isDirty={activeTab.isDirty ?? false}
              onDirtyChange={(isDirty) => setBrowserTabDirty(workspaceId, pane.id, activeTab.id, isDirty)}
              onZoomToggle={handleZoomToggle}
              onSaved={(result) => {
                refreshBrowserTabPreview(workspaceId, pane.id, activeTab.id, {
                  previewPath: result.previewPath,
                  sourcePath: result.sourcePath,
                  sourceKind: activeTab.sourceKind ?? "html",
                });
              }}
            />
          </ErrorBoundary>
        ) : activeTab && agent ? (
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
                onUrlClick={handleUrlClick}
                cwd={activeTab.cwd ?? paneCwd}
                initialReplay={savedAgentSession ? undefined : activeTab.terminalSnapshot}
                launchEnv={(() => {
                  const env: Record<string, string> = {
                    ...(activeTab.launchEnv ?? pane.launchEnv ?? {}),
                    MYCMUX_PANE_SESSION_ID: activeTab.sessionId,
                    MYCMUX_TAB_ID: activeTab.id,
                  };
                  if (resolvedAgentId === "shell-starter") {
                    env.__CMUX_LAUNCHER_DONE = "1";
                  }
                  if (savedAgentSession && !env.MYCMUX_HANDOFF) {
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
