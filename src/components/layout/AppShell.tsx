import { useState, useCallback, useEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { GridTemplateId, ThemeBackgroundSettings } from "../../types";
import {
  useWorkspaceListStore,
  useWorkspaceLayoutStore,
  useUiStore,
  usePaneMetadataStore,
} from "../../stores/workspaceStore";
import { killSession } from "../../lib/ipc";
import { evictTerminalCache } from "../terminal/XTermWrapper";
import { SIDEBAR_WIDTH } from "../../lib/constants";
import TabBar from "./TabBar";
import TitleBar from "./TitleBar";
import WorkspaceView from "../workspace/WorkspaceView";
import PaneDragOverlay from "../workspace/PaneDragOverlay";
import SavepointDragOverlay from "../online/SavepointDragOverlay";
import WorkspaceSetup from "../setup/WorkspaceSetup";
import SocketListener from "./SocketListener";
import KeybindingsModal from "./KeybindingsModal";
import CrsmPalette, { preloadCrsmSessions } from "../CommandPalette/CrsmPalette";
import { useKeybindingStore } from "../../stores/keybindingStore";
import { isEditableTarget } from "../../lib/keybindings";
import { useThemeStore } from "../../stores/themeStore";
import ErrorBoundary from "../common/ErrorBoundary";
import { THEME_BACKGROUND_PRESETS } from "../../lib/themeTweaks";
import { focusController } from "../../lib/focusController";
import { OVERLAY_EXIT_MS, useDeferredUnmount } from "../../hooks/useDeferredUnmount";
import { confirm, message } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { beforePaneClose } from "../../lib/paneCloseLifecycle";
import { popClosedPane } from "../../stores/closedPaneStore";
import { useOnlineSavepointStore } from "../../stores/onlineSavepointStore";
import {
  resolveNextAttentionTarget,
  useSessionAttentionStore,
} from "../../stores/sessionAttentionStore";

type Direction = "up" | "down" | "left" | "right";

const TERMINAL_PLAIN_INPUT_KEYS = new Set([
  "Backspace",
  "Delete",
  "Enter",
  "Escape",
  "Tab",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Insert",
]);

function colorWithOpacity(color: string, opacity: number): string {
  if (opacity >= 0.995) {
    return color;
  }

  const shortHex = /^#([0-9a-f]{3})$/i.exec(color);
  const fullHex = /^#([0-9a-f]{6})$/i.exec(color);
  const hex = fullHex?.[1] ?? shortHex?.[1].split("").map((char) => `${char}${char}`).join("");
  if (!hex) {
    return color;
  }

  const red = parseInt(hex.slice(0, 2), 16);
  const green = parseInt(hex.slice(2, 4), 16);
  const blue = parseInt(hex.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${opacity})`;
}

const LIGHT_COLOR_LUMINANCE_THRESHOLD = 140;

// Whether a hex color reads as "light". Used to pick chrome shadows from the
// effective chrome background — which includes user color overrides — rather
// than the theme's declared colorScheme. The threshold is BT.601 luma on a
// 0-255 scale; 140 keeps mid amber/blue accents on the safer contrast side.
// Non-hex input falls back to dark.
function isLightColor(color: string): boolean {
  const shortHex = /^#([0-9a-f]{3})$/i.exec(color);
  const fullHex = /^#([0-9a-f]{6})$/i.exec(color);
  const hex = fullHex?.[1] ?? shortHex?.[1].split("").map((char) => `${char}${char}`).join("");
  if (!hex) {
    return false;
  }
  const red = parseInt(hex.slice(0, 2), 16);
  const green = parseInt(hex.slice(2, 4), 16);
  const blue = parseInt(hex.slice(4, 6), 16);
  // Perceived luminance (ITU-R BT.601).
  return (red * 299 + green * 587 + blue * 114) / 1000 > LIGHT_COLOR_LUMINANCE_THRESHOLD;
}

function textOnColor(color: string): string {
  return isLightColor(color) ? "#0a0a0a" : "#ffffff";
}

function AppBackgroundLayer({ background }: { background: ThemeBackgroundSettings }) {
  const preset = THEME_BACKGROUND_PRESETS.find((item) => item.id === background.presetId) ?? THEME_BACKGROUND_PRESETS[0];
  const userImageUrl = background.mode === "image" && background.imagePath
    ? convertFileSrc(background.imagePath)
    : "";
  const presetImageUrl = background.mode === "preset" ? preset.imageUrl : "";
  const finalImageUrl = userImageUrl || presetImageUrl;
  const [currentImageUrl, setCurrentImageUrl] = useState(finalImageUrl);
  const [previousImageUrl, setPreviousImageUrl] = useState("");
  const [fadeStarted, setFadeStarted] = useState(false);
  const currentImageUrlRef = useRef(finalImageUrl);

  useEffect(() => {
    if (finalImageUrl === currentImageUrlRef.current) {
      return;
    }

    const previousUrl = currentImageUrlRef.current;
    currentImageUrlRef.current = finalImageUrl;
    setPreviousImageUrl(previousUrl);
    setCurrentImageUrl(finalImageUrl);
    setFadeStarted(false);

    const frameId = window.requestAnimationFrame(() => setFadeStarted(true));
    const timeoutId = window.setTimeout(() => {
      setPreviousImageUrl("");
    }, 420);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.clearTimeout(timeoutId);
    };
  }, [finalImageUrl]);

  const hasVisualBackground = Boolean(currentImageUrl || previousImageUrl);
  const dimOpacity = currentImageUrl
    ? background.imageDim
    : previousImageUrl && !fadeStarted
      ? background.imageDim
      : 0;

  const renderImageLayer = (imageUrl: string, opacity: number) => {
    if (!imageUrl) {
      return null;
    }

    return (
      <div
        style={{
          position: "absolute",
          inset: background.imageBlur > 0 ? -24 : 0,
          backgroundImage: `url("${imageUrl}")`,
          backgroundSize: "cover",
          backgroundPosition: "center",
          backgroundRepeat: "no-repeat",
          opacity,
          filter: background.imageBlur > 0 ? `blur(${background.imageBlur}px)` : undefined,
          transform: background.imageBlur > 0 ? "scale(1.04)" : undefined,
          transition: "opacity 0.4s ease",
        }}
      />
    );
  };

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none", zIndex: 0 }}>
      <div style={{ position: "absolute", inset: 0, background: "var(--cmux-bg-solid)" }} />
      {hasVisualBackground && (
        <>
          {renderImageLayer(previousImageUrl, fadeStarted ? 0 : background.imageOpacity)}
          {renderImageLayer(
            currentImageUrl,
            previousImageUrl ? (fadeStarted ? background.imageOpacity : 0) : background.imageOpacity,
          )}
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: `rgba(0, 0, 0, ${dimOpacity})`,
              transition: "background 0.4s ease",
            }}
          />
        </>
      )}
    </div>
  );
}

/**
 * Find the best pane to focus when navigating in a direction.
 * Uses actual DOM positions for accurate navigation in any layout.
 */
function findPaneInDirection(
  currentSessionId: string,
  direction: Direction,
  panes: { sessionId: string }[]
): string | null {
  const currentEl = document.querySelector<HTMLElement>(`[data-session-id="${currentSessionId}"]`);
  if (!currentEl) return null;
  
  const currentRect = currentEl.getBoundingClientRect();
  const currentCenterX = currentRect.left + currentRect.width / 2;
  const currentCenterY = currentRect.top + currentRect.height / 2;
  
  let bestCandidate: string | null = null;
  let bestScore = Infinity;
  
  for (const pane of panes) {
    if (pane.sessionId === currentSessionId) continue;
    
    const el = document.querySelector<HTMLElement>(`[data-session-id="${pane.sessionId}"]`);
    if (!el) continue;
    
    const rect = el.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    
    // Check if pane is in the correct direction
    let isInDirection = false;
    let primaryDistance = 0;
    let secondaryDistance = 0;
    
    switch (direction) {
      case "up":
        // Pane must be above (its bottom edge above our top edge, with some tolerance)
        isInDirection = rect.bottom <= currentRect.top + 5;
        primaryDistance = currentRect.top - rect.bottom; // Distance in primary direction
        secondaryDistance = Math.abs(centerX - currentCenterX); // Horizontal alignment
        break;
      case "down":
        // Pane must be below (its top edge below our bottom edge, with some tolerance)
        isInDirection = rect.top >= currentRect.bottom - 5;
        primaryDistance = rect.top - currentRect.bottom;
        secondaryDistance = Math.abs(centerX - currentCenterX);
        break;
      case "left":
        // Pane must be to the left (its right edge left of our left edge)
        isInDirection = rect.right <= currentRect.left + 5;
        primaryDistance = currentRect.left - rect.right;
        secondaryDistance = Math.abs(centerY - currentCenterY);
        break;
      case "right":
        // Pane must be to the right (its left edge right of our right edge)
        isInDirection = rect.left >= currentRect.right - 5;
        primaryDistance = rect.left - currentRect.right;
        secondaryDistance = Math.abs(centerY - currentCenterY);
        break;
    }
    
    if (!isInDirection || primaryDistance < 0) continue;
    
    // Score: prioritize closest in primary direction, then best alignment
    // Lower score = better candidate
    const score = primaryDistance + secondaryDistance * 0.5;
    
    if (score < bestScore) {
      bestScore = score;
      bestCandidate = pane.sessionId;
    }
  }
  
  return bestCandidate;
}

function paneMatchesSession(
  pane: { sessionId: string; tabs?: Array<{ sessionId: string }> },
  sessionId: string | null | undefined,
): boolean {
  return Boolean(
    sessionId
    && (pane.sessionId === sessionId || pane.tabs?.some((tab) => tab.sessionId === sessionId)),
  );
}

function isPlainXtermInputEvent(event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.altKey || event.metaKey) return false;
  const target = event.target as HTMLElement | null;
  if (!target?.closest(".xterm")) return false;
  return event.key.length === 1 || TERMINAL_PLAIN_INPUT_KEYS.has(event.key);
}

// xterm's hidden helper textarea lives inside the ".xterm" container —
// global shortcuts must keep firing while it's focused
// (that's how terminal-focused Ctrl+P/Ctrl+B/etc. work today), but every
// other native editable control (dialog inputs, selects, contentEditable)
// should NOT let global shortcuts fire while the user is typing into it.
function isXtermTarget(target: EventTarget | null): boolean {
  return Boolean((target as HTMLElement | null)?.closest(".xterm"));
}

// Compact fallback for chrome-region ErrorBoundaries: a crash in a chrome
// widget (title bar, sidebar, palette, etc.) should not unmount the whole
// AppShell — and with it every live terminal pane, which already has its own
// per-pane ErrorBoundary further down the tree. This renders a small inline
// bar in the crashed region's place instead of taking down the app.
function chromeCrashFallback(label: string) {
  return (error: Error, reset: () => void) => (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 10px",
        fontSize: 11,
        color: "var(--cmux-text-secondary, rgba(255,255,255,0.6))",
        background: "var(--cmux-surface, #161616)",
        border: "1px solid var(--cmux-border, rgba(255,255,255,0.1))",
      }}
    >
      <span style={{ color: "var(--cmux-red)" }}>⚠</span>
      <span style={{ color: "var(--cmux-text, #ededed)" }}>
        {label}が予期せず停止しました
      </span>
      <span style={{ color: "var(--cmux-text-tertiary, rgba(255,255,255,0.3))" }}>
        ({error.message})
      </span>
      <button
        onClick={reset}
        style={{
          marginLeft: "auto",
          padding: "3px 10px",
          fontSize: 11,
          background: "var(--cmux-bg, #0a0a0a)",
          border: "1px solid var(--cmux-border, rgba(255,255,255,0.1))",
          borderRadius: 4,
          color: "var(--cmux-text, #ededed)",
          cursor: "pointer",
        }}
      >
        再試行
      </button>
    </div>
  );
}

interface AppShellProps {
  uiVariant?: "default" | "cmux";
}

export default function AppShell({ uiVariant = "default" }: AppShellProps) {
  const [showSetup, setShowSetup] = useState(false);
  const [isCrsmPaletteOpen, setIsCrsmPaletteOpen] = useState(false);
  const workspaces = useWorkspaceListStore((s) => s.workspaces);
  const activeId = useWorkspaceListStore((s) => s.activeWorkspaceId);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const setActiveWorkspace = useWorkspaceListStore((s) => s.setActiveWorkspace);
  const removeWorkspace = useWorkspaceListStore((s) => s.removeWorkspace);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const activePaneId = useUiStore((s) => s.activePaneId);
  const lastActivePaneId = useUiStore((s) => s.lastActivePaneId);
  const zoomedPaneId = useUiStore((s) => s.zoomedPaneId);
  const setZoomedPaneId = useUiStore((s) => s.setZoomedPaneId);
  const addPaneToWorkspace = useWorkspaceLayoutStore((s) => s.addPaneToWorkspace);
  const addPaneToWorkspaceWithOptions = useWorkspaceLayoutStore((s) => s.addPaneToWorkspaceWithOptions);
  const openOnlinePanel = useWorkspaceLayoutStore((s) => s.openOnlinePanel);
  const removePaneFromWorkspace = useWorkspaceLayoutStore((s) => s.removePaneFromWorkspace);
  const addTabToPane = useWorkspaceLayoutStore((s) => s.addTabToPane);
  const setActivePaneTab = useWorkspaceLayoutStore((s) => s.setActivePaneTab);
  const isKeybindingsOpen = useUiStore((s) => s.isKeybindingsOpen);
  const setIsKeybindingsOpen = useUiStore((s) => s.setIsKeybindingsOpen);
  const { mounted: keybindingsMounted, closing: keybindingsClosing } = useDeferredUnmount(
    isKeybindingsOpen,
    OVERLAY_EXIT_MS,
  );
  const getActionsForEvent = useKeybindingStore((s) => s.getActionsForEvent);
  const currentTheme = useThemeStore((s) => s.theme);
  const themeBackground = useThemeStore((s) => s.themeTweaks.background);

  useEffect(() => {
    preloadCrsmSessions();
  }, []);

  useEffect(() => {
    void useOnlineSavepointStore.getState().refresh();
  }, []);

  // Self-heal stale zoom: if the zoomed pane was closed (or we switched to a
  // workspace that doesn't contain it), clear zoomedPaneId so the
  // hide-during-pane-zoom CSS doesn't blank the whole workspace.
  useEffect(() => {
    if (!zoomedPaneId) return;
    const activeWs = workspaces.find((w) => w.id === activeId);
    const stillExists = activeWs?.panes.some((p) => p.id === zoomedPaneId) ?? false;
    if (!stillExists) {
      setZoomedPaneId(null);
    }
  }, [zoomedPaneId, activeId, workspaces, setZoomedPaneId]);
  // Chrome shadows key off the effective chrome background (color overrides
  // included), not colorScheme — a dark theme recolored light needs this too.
  const isLightChrome = isLightColor(currentTheme.chrome.background);
  const mediaBackgroundActive = themeBackground.mode === "preset" || (
    themeBackground.mode === "image" && themeBackground.imagePath.length > 0
  );
  const panelOpacity = mediaBackgroundActive ? themeBackground.panelOpacity : 1;

  const themeVars = {
    "--cmux-bg-solid": currentTheme.chrome.background,
    "--cmux-bg": colorWithOpacity(currentTheme.chrome.background, panelOpacity),
    "--cmux-sidebar": colorWithOpacity(currentTheme.chrome.surface, panelOpacity),
    "--cmux-popover": currentTheme.chrome.surface,
    "--cmux-title-bg": colorWithOpacity(currentTheme.chrome.background, panelOpacity),
    "--cmux-surface": colorWithOpacity(currentTheme.chrome.surface, panelOpacity),
    "--cmux-terminal-bg": colorWithOpacity(
      currentTheme.terminal.background,
      mediaBackgroundActive ? themeBackground.terminalOpacity : 1,
    ),
    "--cmux-accent": currentTheme.chrome.accent,
    "--cmux-border": currentTheme.chrome.border,
    "--cmux-text": currentTheme.chrome.text,
    "--cmux-text-secondary": currentTheme.chrome.textMuted,
    "--cmux-text-tertiary": currentTheme.chrome.textDim,
    "--cmux-text-dim": currentTheme.chrome.textDim,
    "--cmux-hover": currentTheme.chrome.hover,
    "--cmux-selected": currentTheme.chrome.selected,
    "--cmux-red": currentTheme.chrome.danger,
    "--cmux-on-accent": textOnColor(currentTheme.chrome.accent),
    "--cmux-on-working": textOnColor(currentTheme.status.working),
    "--cmux-on-waiting": textOnColor(currentTheme.status.waiting),
    "--cmux-on-done": textOnColor(currentTheme.status.done),
    "--cmux-on-error": textOnColor(currentTheme.status.error),
    "--cmux-backdrop": isLightChrome ? "rgba(15, 23, 42, 0.22)" : "rgba(0, 0, 0, 0.55)",
    "--cmux-focus-ring": "color-mix(in srgb, var(--cmux-accent) 45%, transparent)",
    "--cmux-dnd-tab": isLightChrome ? currentTheme.status.working : "#38bdf8",
    "--cmux-dnd-pane": isLightChrome ? currentTheme.status.waiting : "#f59e0b",
    "--cmux-usage-ok": isLightChrome ? currentTheme.status.done : "#3eb86b",
    "--cmux-usage-warn": isLightChrome ? currentTheme.status.waiting : "#f5a623",
    "--cmux-usage-danger": isLightChrome ? currentTheme.status.error : "#ff3b30",
    "--cmux-shadow-menu": isLightChrome ? "0 8px 20px rgba(15, 23, 42, 0.16)" : "0 4px 12px rgba(0, 0, 0, 0.5)",
    "--cmux-shadow-popover": isLightChrome ? "0 8px 26px rgba(15, 23, 42, 0.16)" : "0 4px 16px rgba(0,0,0,0.4)",
    "--cmux-shadow-dropdown": isLightChrome ? "0 12px 28px rgba(15, 23, 42, 0.16)" : "0 10px 24px rgba(0, 0, 0, 0.32)",
    "--cmux-shadow-dialog": isLightChrome ? "0 20px 60px rgba(15, 23, 42, 0.18)" : "0 18px 60px rgba(0,0,0,0.45)",
    "--cmux-shadow-palette": isLightChrome ? "0 24px 70px rgba(15, 23, 42, 0.18)" : "0 24px 70px rgba(0,0,0,0.45)",
    "--cmux-shadow-pane-menu": isLightChrome ? "0 8px 18px rgba(15, 23, 42, 0.14)" : "0 4px 12px rgba(0,0,0,0.2)",
    "--cmux-shadow-dnd": isLightChrome
      ? "0 14px 34px rgba(15, 23, 42, 0.18), inset 0 0 0 1px color-mix(in srgb, var(--cmux-text) 8%, transparent)"
      : "0 14px 34px rgba(0, 0, 0, 0.36), inset 0 0 0 1px rgba(255, 255, 255, 0.05)",
    "--cmux-shadow-dnd-strong": isLightChrome
      ? "0 16px 38px rgba(15, 23, 42, 0.22), 0 0 24px color-mix(in srgb, var(--pane-dnd-color) 18%, transparent)"
      : "0 16px 38px rgba(0, 0, 0, 0.42), 0 0 24px color-mix(in srgb, var(--pane-dnd-color) 22%, transparent)",
    "--cmux-shadow-dnd-label": isLightChrome ? "0 8px 20px rgba(15, 23, 42, 0.16)" : "0 6px 18px rgba(0, 0, 0, 0.34)",
    "--status-working": currentTheme.status.working,
    "--status-waiting": currentTheme.status.waiting,
    "--status-done": currentTheme.status.done,
    "--status-error": currentTheme.status.error,
    "--notification-color": currentTheme.notification,
    "--cmux-chrome-text-shadow": "none",
    "--cmux-chrome-icon-shadow": "none",
    colorScheme: currentTheme.colorScheme,
  } as React.CSSProperties;

  useEffect(() => {
    if (workspaces.length === 0) {
      setShowSetup(true);
    }
  }, [workspaces.length]);

  // Surface backend remote-server failures (port bind, token validation, etc.)
  // The Rust side already emits "remote-error"; without a listener the Settings →
  // Remote panel would just sit blank with no way to know it failed.
  useEffect(() => {
    // Capture the listen() promise itself (not its resolved value) so cleanup
    // can chain onto it regardless of whether it resolves before or after
    // unmount — assigning `unlisten` inside a separate .then() left a window
    // where an unmount racing the IPC round-trip would never call it,
    // leaking the backend listener. Mirrors App.tsx's unlistenMeta/
    // unlistenWorkDone/unlistenDragDrop pattern.
    const unlistenPromise = listen<string>("remote-error", (event) => {
      const text = typeof event.payload === "string" && event.payload.length > 0
        ? event.payload
        : "Remote terminal encountered an unknown error.";
      console.error("[remote-error]", text);
      void message(text, { title: "mycmux Remote Terminal", kind: "error" });
    });
    unlistenPromise.catch((err) => {
      console.error("Failed to subscribe to remote-error events", err);
    });
    return () => {
      unlistenPromise.then((fn) => fn()).catch(() => {});
    };
  }, []);

  const handleNewWorkspace = useCallback(() => {
    setShowSetup(true);
  }, []);

  const handleLaunch = useCallback(
    (
      name: string,
      gridTemplateId: GridTemplateId,
      agentAssignments: Record<number, string>,
    ) => {
      // Build panes using layout store
      const workspaceId = crypto.randomUUID();
      const { panes, splitColumns } = useWorkspaceLayoutStore.getState().buildInitialPanes(
        workspaceId,
        gridTemplateId,
        agentAssignments
      );

      // Create workspace in list store
      useWorkspaceListStore.getState().createWorkspace(
        name,
        gridTemplateId,
        panes,
        splitColumns,
        {
          id: workspaceId,
        },
      );
      
      setShowSetup(false);
    },
    [],
  );

  const handleCloseWorkspace = useCallback(
    async (id: string) => {
      const wsName = workspaces.find((w) => w.id === id)?.name ?? "ワークスペース";
      const shouldClose = await confirm(`ワークスペース「${wsName}」を閉じますか？`, {
        title: "ワークスペースを閉じる",
        kind: "warning",
        okLabel: "閉じる",
        cancelLabel: "キャンセル",
      }).catch(() => false);

      if (!shouldClose) return;

      // Re-read fresh from the store (not the `workspaces` closure) — panes
      // can be added to this workspace while confirm() was awaited (drag-and-
      // drop, pane.reopen, etc.), and the stale closure would skip their
      // session kill / cache eviction while still removing the workspace.
      const ws = useWorkspaceListStore.getState().workspaces.find((w) => w.id === id);
      if (ws) {
        for (const pane of ws.panes) {
          for (const tab of pane.tabs) {
            evictTerminalCache(tab.sessionId);
            killSession(tab.sessionId).catch((err) =>
              console.warn("[mycmux] killSession failed", tab.sessionId, err),
            );
            usePaneMetadataStore.getState().removeMetadata(tab.sessionId);
          }
        }
      }
      removeWorkspace(id);
    },
    [workspaces, removeWorkspace],
  );

  const handleCancelSetup = useCallback(() => {
    setShowSetup(false);
  }, []);

  // Keyboard shortcuts — use refs so the listener doesn't re-attach on every state change
  const stateRef = useRef({ workspaces, activeId, activePaneId, lastActivePaneId });
  stateRef.current = { workspaces, activeId, activePaneId, lastActivePaneId };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Skip if modals are open
      if (isKeybindingsOpen || isCrsmPaletteOpen) return;
      if (isPlainXtermInputEvent(e)) return;
      // Skip if focus is on a native editable control (dialog inputs, selects,
      // contentEditable) outside the terminal — e.g. typing into
      // UsageAccountsDialog's OAuth-code field shouldn't pop CrsmPalette on
      // Ctrl+P. xterm's own hidden helper textarea is exempted so terminal
      // typing keeps triggering global shortcuts exactly as before.
      if (isEditableTarget(e.target) && !isXtermTarget(e.target)) return;

      // Get all actions that match this keyboard event (BridgeSpace pattern)
      const actions = getActionsForEvent(e);
      
      // No match → let event pass through to focused element (terminal, input, etc.)
      if (actions.length === 0) return;

      // Match found → prevent default behavior and execute action
      e.preventDefault();
      e.stopImmediatePropagation();

      const action = actions[0]; // Execute first matching action
      const {
        workspaces: ws,
        activeId: aid,
        activePaneId: apid,
        lastActivePaneId: lpid,
      } = stateRef.current;

      // Execute the action based on action ID
      switch (action) {
        case "settings.keybindings":
          setIsKeybindingsOpen(true);
          break;

        case "crsm.palette":
          setIsCrsmPaletteOpen(true);
          break;

        case "workspace.close":
          if (aid) handleCloseWorkspace(aid);
          break;

        case "sidebar.toggle":
          toggleSidebar();
          break;

        case "workspace.new":
          setShowSetup(true);
          break;

        case "workspace.next":
        case "workspace.prev": {
          if (ws.length < 2) return;
          const idx = ws.findIndex((w) => w.id === aid);
          if (action === "workspace.prev") {
            const prev = (idx - 1 + ws.length) % ws.length;
            setActiveWorkspace(ws[prev].id);
          } else {
            const next = (idx + 1) % ws.length;
            setActiveWorkspace(ws[next].id);
          }
          break;
        }

        case "workspace.jump.1":
        case "workspace.jump.2":
        case "workspace.jump.3":
        case "workspace.jump.4":
        case "workspace.jump.5":
        case "workspace.jump.6":
        case "workspace.jump.7":
        case "workspace.jump.8": {
          const num = parseInt(action.split(".")[2], 10);
          if (ws[num - 1]) setActiveWorkspace(ws[num - 1].id);
          break;
        }

        case "workspace.jump.9":
          if (ws.length) setActiveWorkspace(ws[ws.length - 1].id);
          break;

        case "pane.split.right": {
          const activeWs = ws.find((w) => w.id === aid);
          const activePane = activeWs?.panes.find((p) => paneMatchesSession(p, apid));
          if (activeWs && activePane) {
            addPaneToWorkspace(activeWs.id, activePane.id, "right");
            focusController.focusSessionSoon(useUiStore.getState().activePaneId);
          }
          break;
        }

        case "pane.split.down": {
          const activeWs = ws.find((w) => w.id === aid);
          const activePane = activeWs?.panes.find((p) => paneMatchesSession(p, apid));
          if (activeWs && activePane) {
            addPaneToWorkspace(activeWs.id, activePane.id, "down");
            focusController.focusSessionSoon(useUiStore.getState().activePaneId);
          }
          break;
        }

        case "pane.zoom.toggle": {
          const activeWs = ws.find((w) => w.id === aid);
          const activePane = activeWs?.panes.find((p) => paneMatchesSession(p, apid));
          if (activePane) {
            const currentZoomed = useUiStore.getState().zoomedPaneId;
            setZoomedPaneId(currentZoomed === activePane.id ? null : activePane.id);
          }
          break;
        }

        case "pane.close": {
          const activeWs = ws.find((w) => w.id === aid);
          const activePane = activeWs?.panes.find((p) => paneMatchesSession(p, apid));
          if (activeWs && activePane && activeWs.panes.length > 1) {
            beforePaneClose(activePane);
            for (const tab of activePane.tabs) {
              evictTerminalCache(tab.sessionId);
              killSession(tab.sessionId).catch((err) =>
                console.warn("[mycmux] killSession failed", tab.sessionId, err),
              );
              usePaneMetadataStore.getState().removeMetadata(tab.sessionId);
            }
            removePaneFromWorkspace(activeWs.id, activePane.id);
            // Focus a remaining pane after close
            const remaining = activeWs.panes.filter((p) => p.id !== activePane.id);
            if (remaining.length > 0) {
              const neighbor =
                findPaneInDirection(apid!, "right", remaining) ||
                findPaneInDirection(apid!, "down", remaining) ||
                findPaneInDirection(apid!, "left", remaining) ||
                findPaneInDirection(apid!, "up", remaining) ||
                remaining[0].sessionId;
              focusController.request("keyboard", { sessionId: neighbor, focus: true });
            } else {
              focusController.request("keyboard", { sessionId: null, focus: false });
            }
          }
          break;
        }

        case "pane.reopen": {
          const activeWs = ws.find((w) => w.id === aid);
          if (!activeWs) return;
          const anchorPane = activeWs.panes.find((p) => paneMatchesSession(p, apid))
            ?? activeWs.panes.find((p) => paneMatchesSession(p, lpid))
            ?? activeWs.panes[0];
          if (!anchorPane) return;
          const closedPane = popClosedPane();
          if (!closedPane) return;
          const launchEnv: Record<string, string> | undefined =
            closedPane.agentKind && closedPane.agentSessionId
              ? {
                  MYCMUX_RESUME: closedPane.agentKind,
                  MYCMUX_SESSION_ID: closedPane.agentSessionId,
                  MYCMUX_AGENT_KIND: closedPane.agentKind,
                }
              : undefined;
          addPaneToWorkspaceWithOptions(activeWs.id, anchorPane.id, "right", {
            agentId: "shell-starter",
            label: closedPane.label ?? undefined,
            cwd: closedPane.cwd ?? undefined,
            agentKind: closedPane.agentKind ?? undefined,
            agentSessionId: closedPane.agentSessionId ?? undefined,
            launchEnv,
          });
          break;
        }

        case "pane.tab.next":
        case "pane.tab.prev": {
          const activeWs = ws.find((w) => w.id === aid);
          if (!activeWs) return;
          const activePane = activeWs.panes.find((p) => paneMatchesSession(p, apid))
            ?? activeWs.panes.find((p) => paneMatchesSession(p, lpid))
            ?? activeWs.panes[0];
          if (!activePane || activePane.tabs.length < 2) return;
          const idx = activePane.tabs.findIndex((t) => t.id === activePane.activeTabId);
          const delta = action === "pane.tab.next" ? 1 : -1;
          const nextTab = activePane.tabs[(idx + delta + activePane.tabs.length) % activePane.tabs.length];
          setActivePaneTab(activeWs.id, activePane.id, nextTab.id);
          if (nextTab.type === undefined || nextTab.type === "terminal") {
            focusController.request("keyboard", { sessionId: nextTab.sessionId, focus: true });
          }
          break;
        }

        case "pane.attention.next": {
          const currentWorkspace = ws.find((workspace) => workspace.id === aid);
          const currentPane = currentWorkspace?.panes.find((pane) => paneMatchesSession(pane, apid))
            ?? currentWorkspace?.panes.find((pane) => paneMatchesSession(pane, lpid))
            ?? currentWorkspace?.panes[0];
          const currentTabId = currentPane?.activeTabId ?? null;
          const attentionState = useSessionAttentionStore.getState();
          const target = resolveNextAttentionTarget(
            ws,
            attentionState.attentionBySession,
            attentionState.seenAttentionByTab,
            currentTabId,
          );
          if (!target) return;
          const keepZoom = useUiStore.getState().zoomedPaneId !== null;
          setActiveWorkspace(target.workspaceId);
          setActivePaneTab(target.workspaceId, target.paneId, target.tab.id);
          if (keepZoom) setZoomedPaneId(target.paneId);
          if (target.tab.type === undefined || target.tab.type === "terminal") {
            focusController.request("keyboard", { sessionId: target.tab.sessionId, focus: true });
          } else {
            focusController.request("keyboard", { sessionId: null, focus: false });
          }
          break;
        }

        case "pane.focus.right":
        case "pane.focus.left":
        case "pane.focus.up":
        case "pane.focus.down": {
          const activeWs = ws.find((w) => w.id === aid);
          if (!activeWs || activeWs.panes.length <= 1) return;

          // activePaneId is cleared on terminal blur. Use the last non-null pane
          // as fallback, and normalize tab sessionIds back to pane sessionIds
          // because findPaneInDirection uses pane DOM nodes.
          const resolvePaneSessionId = (sid: string | null | undefined) => {
            if (!sid) return null;
            const pane = activeWs.panes.find(
              (p) => p.sessionId === sid || p.tabs.some((t) => t.sessionId === sid),
            );
            return pane?.sessionId ?? null;
          };
          const originId =
            resolvePaneSessionId(apid) ??
            resolvePaneSessionId(lpid) ??
            activeWs.panes[0]?.sessionId ??
            null;
          if (!originId) return;

          // Map action to direction
          const directionMap: Record<string, Direction> = {
            "pane.focus.right": "right",
            "pane.focus.left": "left",
            "pane.focus.up": "up",
            "pane.focus.down": "down",
          };
          const direction = directionMap[action];
          
          // Find the best pane in the requested direction using DOM positions
          const targetSessionId = findPaneInDirection(originId, direction, activeWs.panes);
          if (!targetSessionId) return; // No pane in that direction
          
          focusController.request("keyboard", { sessionId: targetSessionId, focus: true });
          if (useUiStore.getState().zoomedPaneId) {
            const targetPane = activeWs.panes.find((p) => p.sessionId === targetSessionId);
            if (targetPane) {
              setZoomedPaneId(targetPane.id);
            }
          }
          
          break;
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    getActionsForEvent,
    isKeybindingsOpen,
    isCrsmPaletteOpen,
    setIsKeybindingsOpen,
    handleCloseWorkspace,
    toggleSidebar,
    setShowSetup,
    setActiveWorkspace,
    addPaneToWorkspace,
    addPaneToWorkspaceWithOptions,
    removePaneFromWorkspace,
    addTabToPane,
    setActivePaneTab,
    setZoomedPaneId,
  ]);

  return (
    <div
      className={uiVariant === "cmux" ? "ui-cmux" : undefined}
      data-cmux-zoom-active={zoomedPaneId ? "true" : undefined}
      style={{
        ...themeVars,
        width: "100vw",
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        position: "relative",
        overflow: "hidden",
        background: "var(--cmux-bg-solid)",
      }}
    >
      <AppBackgroundLayer background={themeBackground} />
      <div style={{ position: "relative", zIndex: 1, width: "100%", height: "100%", display: "flex", flexDirection: "column" }}>
        <SocketListener />
        <div data-cmux-hide-during-pane-zoom={zoomedPaneId ? "true" : undefined}>
          <ErrorBoundary fallback={chromeCrashFallback("タイトルバー")}>
            <TitleBar
              uiVariant={uiVariant}
              onNewWorkspace={handleNewWorkspace}
              onOpenOnlinePanel={() => {
                const workspace = workspaces.find((candidate) => candidate.id === activeId);
                const sourcePane = workspace?.panes.find((pane) =>
                  pane.sessionId === activePaneId
                  || pane.tabs.some((tab) => tab.sessionId === activePaneId),
                ) ?? workspace?.panes[0];
                if (workspace && sourcePane) openOnlinePanel(workspace.id, sourcePane.id);
              }}
              onOpenCrsmPalette={() => setIsCrsmPaletteOpen(true)}
            />
          </ErrorBoundary>
        </div>
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "row",
            overflow: zoomedPaneId ? "visible" : "hidden",
            minHeight: 0,
          }}
        >
        {/* Sidebar — kept mounted so terminals don't remount; width animates to 0 */}
        <div
          data-cmux-hide-during-pane-zoom={zoomedPaneId ? "true" : undefined}
          style={{
            width: sidebarCollapsed ? 0 : SIDEBAR_WIDTH,
            overflow: "hidden",
            flexShrink: 0,
            transition: "width 0.2s ease",
          }}
        >
          <ErrorBoundary fallback={chromeCrashFallback("ワークスペース一覧")}>
            <TabBar
              uiVariant={uiVariant}
              onNewWorkspace={handleNewWorkspace}
              onCloseWorkspace={handleCloseWorkspace}
            />
          </ErrorBoundary>
        </div>

        {/* Main content — WorkspaceView always mounted to keep terminals alive */}
        <div
          style={{
            flex: 1,
            overflow: zoomedPaneId ? "visible" : "hidden",
            minWidth: 0,
            position: "relative",
          }}
        >
          <WorkspaceView />
          <PaneDragOverlay />
          <SavepointDragOverlay />
          {keybindingsMounted && (
            <ErrorBoundary fallback={chromeCrashFallback("キーボードショートカット設定")}>
              <KeybindingsModal closing={keybindingsClosing} onClose={() => setIsKeybindingsOpen(false)} />
            </ErrorBoundary>
          )}
          <ErrorBoundary fallback={chromeCrashFallback("コマンドパレット")}>
            <CrsmPalette open={isCrsmPaletteOpen} onClose={() => setIsCrsmPaletteOpen(false)} />
          </ErrorBoundary>
          {showSetup && (
            <div style={{ position: "absolute", inset: 0, zIndex: 50, background: "var(--cmux-bg)" }}>
              <ErrorBoundary fallback={chromeCrashFallback("ワークスペース作成画面")}>
                <WorkspaceSetup onLaunch={handleLaunch} onCancel={handleCancelSetup} />
              </ErrorBoundary>
            </div>
          )}
        </div>

        </div>
      </div>
    </div>
  );
}
