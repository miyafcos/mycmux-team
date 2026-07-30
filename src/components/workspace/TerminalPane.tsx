import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { open } from "@tauri-apps/plugin-shell";
import ErrorBoundary from "../common/ErrorBoundary";
import type { AgentSessionKind, Pane, PaneTab } from "../../types";
import PaneTabBar from "./PaneTabBar";
import { paneDndStrings } from "./paneDndStrings";
import XTermWrapper, { evictTerminalCache, hasTerminalBuffer } from "../terminal/XTermWrapper";
import BrowserPane from "./BrowserPane";
import OnlinePanel from "../online/OnlinePanel";
import {
  useWorkspaceLayoutStore,
  useUiStore,
  usePaneMetadataStore
} from "../../stores/workspaceStore";
import { useWorkspaceListStore } from "../../stores/workspaceListStore";
import { getAgent, getDefaultAgent } from "../../lib/agents";
import { killSession, previewArtifactUriForSessionV2 } from "../../lib/ipc";
import { revealPathInExplorer } from "../../lib/ipc";
import { isArtifactPreviewUri, isDirectoryLikeUri } from "../terminal/terminalLinkProvider";
import { focusController } from "../../lib/focusController";
import { usePaneDragStore, type PaneDragItem, type PaneDropTarget } from "../../stores/paneDragStore";
import { useSavepointDragStore } from "../../stores/savepointDragStore";
import { resolveLiveSavepointTargetKind, savepointTargetLabel } from "../../lib/savepointHandoff";
import { resolvePaneHandoffEligibility } from "../../lib/paneHandoff";
import { onlineStrings } from "../online/onlineStrings";

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

function resolveRestoreFallbackSessionIds(
  tab: PaneTab,
  savedSession: { kind: AgentSessionKind; sessionId: string } | null,
): string[] {
  if (!savedSession) return [];
  return (tab.suppressedAgentSessions ?? [])
    .filter((session) => session.agentKind === savedSession.kind)
    .map((session) => session.agentKind === "claude"
      ? (session.claudeSessionId ?? session.agentSessionId)
      : session.agentSessionId);
}

function isTerminalTab(tab: PaneTab | undefined): tab is PaneTab {
  return Boolean(tab && (tab.type === undefined || tab.type === "terminal"));
}

function buildLaunchArgs(
  command: string,
  args: string[],
  agentId: string | undefined,
  savedSession: { kind: AgentSessionKind; sessionId: string } | null,
  newSessionId: string | undefined,
  cwd: string | undefined,
  initialPrompt: string | undefined,
): string[] {
  if (!savedSession) {
    if (agentId === "claude-code" && newSessionId) {
      const launchArgs = [
        ...args,
        "--dangerously-skip-permissions",
        "--permission-mode",
        "bypassPermissions",
        "--session-id",
        newSessionId,
      ];
      return initialPrompt ? [...launchArgs, initialPrompt] : launchArgs;
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

function truncatePaneActionError(message: string, max = 96): string {
  if (message.length <= max) return message;
  return `${message.slice(0, max - 3)}...`;
}

const PANE_CLICK_ACTIVATE_MAX_DISTANCE_PX = 5;

type PaneActivationOptions = {
  focusTerminal?: boolean;
};

type PendingPaneClickActivation = {
  sessionId: string;
  pointerId: number;
  x: number;
  y: number;
  selectionText: string;
};

type ArtifactLinkPopoverState = {
  uri: string;
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
  if (target instanceof Element && target.closest(".xterm-helper-textarea")) {
    return false;
  }
  return target instanceof Element
    ? Boolean(target.closest(PANE_CLICK_IGNORED_TARGET_SELECTOR))
    : true;
}

function getDocumentSelectionText(): string {
  const selection = window.getSelection?.();
  return selection?.toString().trim() ?? "";
}

function defaultOpenUriForLocalPath(uri: string): string {
  const trimmed = uri.trim();
  if (/^\/[A-Za-z]\//.test(trimmed)) {
    return `${trimmed[1].toUpperCase()}:${trimmed.slice(2).replace(/\//g, "\\")}`;
  }
  return uri;
}

function getDropPreviewLabel(
  item: PaneDragItem,
  target: Exclude<PaneDropTarget, { kind: "handoff" }>,
): string {
  if (target.kind === "new-workspace") {
    return paneDndStrings.moveToNewWorkspace;
  }
  if (target.zone === "center") {
    return item.kind === "tab" ? paneDndStrings.attachTab : paneDndStrings.mergePane;
  }
  return paneDndStrings.split[target.zone];
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
  const zoomedPaneId = useUiStore((s) => s.zoomedPaneId);
  const isZoomed = zoomedPaneId === pane.id;
  const setZoomedPaneId = useUiStore((s) => s.setZoomedPaneId);
  const activeWorkspaceId = useWorkspaceListStore((s) => s.activeWorkspaceId);
  const isPaneVisible = activeWorkspaceId === workspaceId
    && (zoomedPaneId === null || isZoomed);
  const dragItem = usePaneDragStore((s) => s.item);
  const dropTarget = usePaneDragStore((s) =>
    s.target?.kind === "pane" && s.target.workspaceId === workspaceId && s.target.paneId === pane.id
      ? s.target
      : null,
  );
  const handoffDropTarget = usePaneDragStore((s) =>
    s.target?.kind === "handoff"
      && s.target.workspaceId === workspaceId
      && s.target.paneId === pane.id
      ? s.target
      : null,
  );
  const savepointDropTarget = useSavepointDragStore((state) =>
    state.target?.mode !== "export"
      && state.target?.workspaceId === workspaceId
      && state.target.paneId === pane.id
      ? state.target
      : null,
  );
  const savepointDragItem = useSavepointDragStore((state) => state.item);
  const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId) ?? pane.tabs[0];
  const activeTabMetadata = usePaneMetadataStore((s) =>
    activeTab ? s.metadata[activeTab.sessionId] : undefined,
  );
  const activeTabMetadataAgentKind = activeTabMetadata?.agentKind;
  const savepointPaneTargetKind = savepointDragItem
    ? resolveLiveSavepointTargetKind(activeTab, activeTabMetadataAgentKind)
    : null;
  const dragSourceTab = useWorkspaceListStore((state) => {
    if (!dragItem) return undefined;
    const sourceWorkspace = state.workspaces.find((workspace) => workspace.id === dragItem.workspaceId);
    const sourcePane = sourceWorkspace?.panes.find((candidate) => candidate.id === dragItem.paneId);
    if (!sourcePane) return undefined;
    return dragItem.kind === "tab"
      ? sourcePane.tabs.find((tab) => tab.id === dragItem.tabId)
      : (sourcePane.tabs.find((tab) => tab.id === sourcePane.activeTabId) ?? sourcePane.tabs[0]);
  });
  const dragSourceMetadata = usePaneMetadataStore((state) =>
    dragSourceTab ? state.metadata[dragSourceTab.sessionId] : undefined,
  );
  const paneHandoffEligibility = dragItem
    ? resolvePaneHandoffEligibility(
        {
          workspaceId: dragItem.workspaceId,
          paneId: dragItem.paneId,
          tab: dragSourceTab,
          metadata: dragSourceMetadata,
        },
        {
          workspaceId,
          paneId: pane.id,
          tab: activeTab,
          metadata: activeTabMetadata,
        },
      )
    : null;
  const paneRootRef = useRef<HTMLDivElement>(null);
  const pendingPaneClickActivationRef = useRef<PendingPaneClickActivation | null>(null);
  const pendingPreviewUriRef = useRef<string | null>(null);
  const artifactLinkPopoverRef = useRef<HTMLDivElement>(null);
  const [previewActionError, setPreviewActionError] = useState<string | null>(null);
  const [artifactLinkPopover, setArtifactLinkPopover] = useState<ArtifactLinkPopoverState | null>(null);

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

  useEffect(() => {
    if (!artifactLinkPopover) return;
    const onMouseDown = (event: MouseEvent) => {
      if (artifactLinkPopoverRef.current?.contains(event.target as Node)) return;
      setArtifactLinkPopover(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setArtifactLinkPopover(null);
    };
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [artifactLinkPopover]);

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
    if (!p || !isTerminalTab(tab)) return;
    focusController.request("pointer", {
      sessionId: tab.sessionId,
      action: "commit",
      focus: options.focusTerminal ?? true,
    });
    for (const candidate of p.tabs) {
      clearNotification(candidate.sessionId);
    }
  }, [workspaceId, pane.id, clearNotification]);

  const handlePanePointerDownCapture = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const isSelectionButton = event.button === 0 || event.button === 2;
    if (
      !isSelectionButton ||
      event.shiftKey ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      shouldIgnorePaneClickActivationTarget(event.target)
    ) {
      pendingPaneClickActivationRef.current = null;
      return;
    }
    const ws = useWorkspaceListStore.getState().getWorkspace(workspaceId);
    const p = ws?.panes.find((candidate) => candidate.id === pane.id);
    const tab = p?.tabs.find((candidate) => candidate.id === p.activeTabId) ?? p?.tabs[0];
    if (!p || !isTerminalTab(tab)) {
      pendingPaneClickActivationRef.current = null;
      return;
    }
    focusController.request("pointer", {
      sessionId: tab.sessionId,
      paneId: pane.id,
      action: "pending",
      pointerId: event.pointerId,
      focus: true,
    });
    if (event.button === 2) {
      pendingPaneClickActivationRef.current = null;
      activatePane();
      return;
    }
    pendingPaneClickActivationRef.current = {
      sessionId: tab.sessionId,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      selectionText: getDocumentSelectionText(),
    };
  }, [activatePane, workspaceId, pane.id]);

  const handlePanePointerUpCapture = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const pending = pendingPaneClickActivationRef.current;
    pendingPaneClickActivationRef.current = null;
    if (!pending || pending.pointerId !== event.pointerId || event.button !== 0) return;
    const abortPendingActivation = (): void => {
      focusController.request("pointer", { sessionId: pending.sessionId, action: "abort" });
    };
    if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
      abortPendingActivation();
      return;
    }
    if (shouldIgnorePaneClickActivationTarget(event.target)) {
      abortPendingActivation();
      return;
    }
    if (Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > PANE_CLICK_ACTIVATE_MAX_DISTANCE_PX) {
      abortPendingActivation();
      return;
    }
    const nextSelectionText = getDocumentSelectionText();
    if (nextSelectionText && nextSelectionText !== pending.selectionText) {
      abortPendingActivation();
      return;
    }
    activatePane();
  }, [activatePane]);

  const handlePanePointerCancelCapture = useCallback(() => {
    const pending = pendingPaneClickActivationRef.current;
    pendingPaneClickActivationRef.current = null;
    if (pending) {
      focusController.request("pointer", { sessionId: pending.sessionId, action: "abort" });
    }
  }, []);

  const handleAddTab = useCallback((agentId?: string, type?: PaneTab["type"]) => {
    addTabToPane(workspaceId, pane.id, agentId, type);
    focusController.focusPaneSoon(pane.id);
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
    if (isTerminalTab(tab)) {
      evictTerminalCache(tab.sessionId);
      killSession(tab.sessionId).catch((err) =>
        console.warn("[mycmux] killSession failed", tab.sessionId, err),
      );
      usePaneMetadataStore.getState().removeMetadata(tab.sessionId);
    }
    removeTabFromPane(workspaceId, pane.id, tabId);
    focusController.focusPaneSoon(pane.id);
  }, [workspaceId, pane.id, removeTabFromPane]);

  const handleSelectTab = useCallback((tabId: string) => {
    setActivePaneTab(workspaceId, pane.id, tabId);
    const ws = useWorkspaceListStore.getState().getWorkspace(workspaceId);
    const p = ws?.panes.find((x) => x.id === pane.id);
    const tab = p?.tabs.find((t) => t.id === tabId);
    if (isTerminalTab(tab)) {
      focusController.request("tab-click", { sessionId: tab.sessionId, focus: true });
    }
  }, [workspaceId, pane.id, setActivePaneTab]);

  const handleZoomToggle = useCallback(() => {
    const currentZoomed = useUiStore.getState().zoomedPaneId;
    setZoomedPaneId(currentZoomed === pane.id ? null : pane.id);
    // Restore keyboard focus to this pane's terminal after the layout change.
    // The keyboard path keeps focus on the xterm textarea, but the toolbar
    // zoom button moves focus to the <button>; without this the user must
    // click back into the terminal before typing.
    focusController.focusPaneSoon(pane.id);
  }, [pane.id, setZoomedPaneId]);

  const handleUrlClick = useCallback((uri: string) => {
    if (pendingPreviewUriRef.current) return;
    setArtifactLinkPopover(null);
    pendingPreviewUriRef.current = uri;
    setPreviewActionError(null);

    const reportOpenFailure = (message: string, error: unknown): void => {
      const detail = `${message}: ${String(error)}`;
      console.error("[mycmux] artifact open failed", detail);
      setPreviewActionError(detail);
    };

    const workspace = useWorkspaceListStore.getState().getWorkspace(workspaceId);
    const currentPane = workspace?.panes.find((candidate) => candidate.id === pane.id);
    const currentTab = currentPane?.tabs.find((tab) => tab.id === currentPane.activeTabId);
    if (!isTerminalTab(currentTab)) {
      open(uri)
        .catch((error) => reportOpenFailure("Open failed", error))
        .finally(() => {
          if (pendingPreviewUriRef.current === uri) pendingPreviewUriRef.current = null;
        });
      return;
    }
    previewArtifactUriForSessionV2(currentTab.sessionId, uri)
      .then((info) => {
        openOrReloadHtmlPreviewPane(workspaceId, pane.id, info);
        setPreviewActionError(null);
      })
      .catch((error) => {
        if (isLocalArtifactLink(uri)) {
          // In-app preview failed (e.g. unreadable file / backend error). Don't
          // swallow it into a dead click — fall back to the OS default app so
          // the user still sees the file open somewhere.
          console.warn("[mycmux] local artifact preview rejected, opening externally", error);
          return open(uri).catch((openError) =>
            reportOpenFailure("Preview failed and fallback open failed", openError),
          );
        }
        return open(uri).catch((openError) => reportOpenFailure("Open failed", openError));
      })
      .finally(() => {
        if (pendingPreviewUriRef.current === uri) {
          pendingPreviewUriRef.current = null;
        }
      });
  }, [openOrReloadHtmlPreviewPane, pane.id, workspaceId]);

  const reportArtifactActionFailure = useCallback((message: string, error: unknown): void => {
    const detail = `${message}: ${String(error)}`;
    console.error("[mycmux] artifact action failed", detail);
    setPreviewActionError(detail);
  }, []);

  const handleArtifactLinkClick = useCallback((uri: string, screenPos: { x: number; y: number }) => {
    if (isArtifactPreviewUri(uri)) {
      handleUrlClick(uri);
      return;
    }
    if (isDirectoryLikeUri(uri)) {
      setArtifactLinkPopover(null);
      setPreviewActionError(null);
      revealPathInExplorer(uri).catch((error) => {
        reportArtifactActionFailure("Reveal failed", error);
      });
      return;
    }
    const root = paneRootRef.current;
    if (!root) {
      handleUrlClick(uri);
      return;
    }
    const rect = root.getBoundingClientRect();
    const popoverWidth = 56;
    const popoverHeight = 34;
    const x = Math.max(4, Math.min(screenPos.x - rect.left, Math.max(4, rect.width - popoverWidth - 4)));
    const y = Math.max(4, Math.min(screenPos.y - rect.top, Math.max(4, rect.height - popoverHeight - 4)));
    setPreviewActionError(null);
    setArtifactLinkPopover({ uri, x, y });
  }, [handleUrlClick, reportArtifactActionFailure]);

  const handleOpenArtifactExternally = useCallback(() => {
    if (!artifactLinkPopover) return;
    const { uri } = artifactLinkPopover;
    setArtifactLinkPopover(null);
    open(defaultOpenUriForLocalPath(uri)).catch((error) => {
      reportArtifactActionFailure("Open failed", error);
    });
  }, [artifactLinkPopover, reportArtifactActionFailure]);

  const handleRevealArtifactInExplorer = useCallback(() => {
    if (!artifactLinkPopover) return;
    const { uri } = artifactLinkPopover;
    setArtifactLinkPopover(null);
    revealPathInExplorer(uri).catch((error) => {
      reportArtifactActionFailure("Reveal failed", error);
    });
  }, [artifactLinkPopover, reportArtifactActionFailure]);

  // Resolve CWD from pane/tab static data (metadata CWD handled by PTY monitor internally)
  const paneCwd = activeTab?.cwd ?? pane.cwd;
  const resolvedAgentId = activeTab?.agentId;
  const agent = resolvedAgentId ? (getAgent(resolvedAgentId) ?? getDefaultAgent()) : null;
  const savedAgentSession = useMemo(
    () => activeTab ? resolveSavedAgentSession(activeTab) : null,
    [activeTab],
  );
  const restoreFallbackSessionIds = useMemo(
    () => activeTab ? resolveRestoreFallbackSessionIds(activeTab, savedAgentSession) : [],
    [activeTab, savedAgentSession],
  );
  const launchCommand = activeTab?.commandArgv?.[0] ?? agent?.command ?? "";
  const launchArgs = useMemo(
    () => activeTab?.commandArgv?.length
      ? activeTab.commandArgv.slice(1)
      : agent
      ? buildLaunchArgs(
          agent.command,
          agent.args,
          resolvedAgentId,
          savedAgentSession,
          activeTab?.id,
          activeTab?.cwd ?? paneCwd,
          activeTab?.initialPrompt,
        )
      : [],
    [agent, resolvedAgentId, savedAgentSession, activeTab, paneCwd],
  );
  const launchEnv = useMemo(() => {
    if (!activeTab) return undefined;
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
  }, [activeTab, pane.launchEnv, resolvedAgentId, savedAgentSession]);
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
      ref={paneRootRef}
      data-session-id={pane.sessionId}
      data-pane-session-ids={pane.tabs.map((tab) => tab.sessionId).join(" ")}
      data-dnd-workspace-id={workspaceId}
      data-dnd-pane-id={pane.id}
      data-savepoint-drop-pane="true"
      data-active-pane={isActive && !isZoomed ? "true" : undefined}
      data-pane-zoomed={isZoomed ? "true" : undefined}
      tabIndex={-1}
      onPointerDownCapture={handlePanePointerDownCapture}
      onPointerUpCapture={handlePanePointerUpCapture}
      onPointerCancelCapture={handlePanePointerCancelCapture}
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
        isVisible={isPaneVisible}
        onClose={onClose ? () => {
          onClose();
          focusController.focusSessionSoon(useUiStore.getState().activePaneId);
        } : undefined}
        onSplitRight={onSplitRight ? () => {
          onSplitRight();
          focusController.focusSessionSoon(useUiStore.getState().activePaneId);
        } : undefined}
        onSplitDown={onSplitDown ? () => {
          onSplitDown();
          focusController.focusSessionSoon(useUiStore.getState().activePaneId);
        } : undefined}
        onZoomToggle={handleZoomToggle}
        onAddTab={handleAddTab}
        onRemoveTab={handleRemoveTab}
        onSelectTab={handleSelectTab}
        hasTerminalBuffer={hasTerminalBuffer}
      />
      {previewActionError && (
        <div
          style={{
            color: "var(--cmux-red)",
            fontSize: 11,
            padding: "2px 8px",
            borderBottom: "1px solid var(--cmux-border)",
            background: "color-mix(in srgb, var(--cmux-red) 10%, transparent)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={previewActionError}
        >
          {truncatePaneActionError(previewActionError)}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflow: "hidden", position: "relative", background: "transparent" }}>
        {activeTab?.type === "online" ? (
          <ErrorBoundary>
            <OnlinePanel workspaceId={workspaceId} paneId={pane.id} />
          </ErrorBoundary>
        ) : activeTab?.type === "browser" && activeTab.htmlPath ? (
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
                workspaceId={workspaceId}
                sessionId={activeTab.sessionId}
                command={launchCommand}
                args={launchArgs}
                agentId={resolvedAgentId}
                agentKind={savedAgentSession?.kind ?? activeTab.agentKind ?? activeTabMetadataAgentKind}
                onZoomToggle={handleZoomToggle}
                onUrlClick={handleUrlClick}
                onArtifactLinkClick={handleArtifactLinkClick}
                cwd={activeTab.cwd ?? paneCwd}
                initialReplay={savedAgentSession ? undefined : activeTab.terminalSnapshot}
                launchEnv={launchEnv}
                restoreFallbackSessionIds={restoreFallbackSessionIds}
              />
            </ErrorBoundary>
          </div>
        ) : null}
        {paneHandoffEligibility && (
          <div
            className={`pane-handoff-drop-chip${handoffDropTarget ? " is-active" : ""}`}
            data-dnd-handoff-target="true"
          >
            {paneDndStrings.handoffDropChip(
              savepointTargetLabel(paneHandoffEligibility.targetAgentKind),
            )}
          </div>
        )}
        {savepointPaneTargetKind && (
          <div
            className={`pane-handoff-drop-chip pane-handoff-drop-chip--savepoint${savepointDropTarget?.mode === "paste" ? " is-active" : ""}`}
            data-savepoint-paste-target="true"
          >
            {onlineStrings.dragGhostPasteTarget(
              savepointTargetLabel(savepointPaneTargetKind),
            )}
          </div>
        )}
      </div>
      {dropPreviewClass && (
        <div className={dropPreviewClass}>
          {dropPreviewLabel && (
            <span className="pane-drop-preview__label">{dropPreviewLabel}</span>
          )}
        </div>
      )}
      {savepointDropTarget?.mode === "paste" && savepointDropTarget.tabId === activeTab?.id && (
        <div className="savepoint-write-preview">
          <span className="savepoint-write-preview__prompt" aria-hidden="true">›</span>
          <span className="savepoint-write-preview__label">
            {onlineStrings.dragDropPastePreview(
              savepointTargetLabel(savepointDropTarget.targetKind),
            )}
          </span>
          <span className="savepoint-write-preview__caret" aria-hidden="true" />
        </div>
      )}
      {savepointDropTarget?.mode === "spawn" && (
        <div className={`pane-drop-preview pane-drop-preview--${savepointDropTarget.direction} pane-drop-preview--split pane-drop-preview--source-pane`}>
          <span className="pane-drop-preview__label">
            {onlineStrings.dragDropFullResumeSplit(savepointDropTarget.direction)}
          </span>
        </div>
      )}
      {artifactLinkPopover && (
        <div
          ref={artifactLinkPopoverRef}
          style={artifactLinkPopoverStyle(artifactLinkPopover)}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="pane-action-btn"
            title="既定のアプリで開く"
            aria-label="既定のアプリで開く"
            onClick={handleOpenArtifactExternally}
            style={artifactLinkPopoverButtonStyle}
          >
            <ExternalLinkIcon />
          </button>
          <button
            type="button"
            className="pane-action-btn"
            title="エクスプローラーで表示"
            aria-label="エクスプローラーで表示"
            onClick={handleRevealArtifactInExplorer}
            style={artifactLinkPopoverButtonStyle}
          >
            <FolderRevealIcon />
          </button>
        </div>
      )}
    </div>
  );
});

function ExternalLinkIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 3h6v6"></path>
      <path d="M10 14 21 3"></path>
      <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"></path>
    </svg>
  );
}

function FolderRevealIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
      <path d="M12 11v6"></path>
      <path d="m9 14 3 3 3-3"></path>
    </svg>
  );
}

function artifactLinkPopoverStyle(popover: ArtifactLinkPopoverState): CSSProperties {
  return {
    position: "absolute",
    left: popover.x,
    top: popover.y,
    zIndex: 120,
    background: "var(--cmux-popover)",
    border: "1px solid var(--cmux-border)",
    borderRadius: 6,
    padding: 4,
    display: "flex",
    gap: 4,
    boxShadow: "var(--cmux-shadow-popover)",
    color: "var(--cmux-text)",
  };
}

const artifactLinkPopoverButtonStyle: CSSProperties = {
  width: 22,
  height: 22,
  padding: 0,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};
