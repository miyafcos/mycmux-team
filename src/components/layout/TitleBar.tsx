import { useState, useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { useWorkspaceListStore, useUiStore, usePaneMetadataStore } from "../../stores/workspaceStore";
import { formatShortcutLabel, IS_MAC } from "../../lib/keybindings";
import { useKeybindingStore } from "../../stores/keybindingStore";
import NotificationPanel from "./NotificationPanel";
import SettingsDialog from "../settings/SettingsDialog";
import { AiLogButton } from "../ailog/AiLogButton";
import { DashboardButton } from "../dashboard/DashboardButton";
import { AccountsButton } from "./AccountsButton";
import { onlineStrings } from "../online/onlineStrings";
import { resolveWorkspaceColor } from "../../lib/workspaceColors";
import { OVERLAY_EXIT_MS, useDeferredUnmount } from "../../hooks/useDeferredUnmount";
import { useAccountsPolling } from "../../hooks/useAccountsPolling";
import { useCliLoginEvents } from "../../hooks/useCliLoginEvents";
import { countNotifications } from "../../lib/notificationEntries";

interface TitleBarProps {
  uiVariant?: "default" | "cmux";
  onNewWorkspace?: () => void;
  /** Opens the dialog that picks the layout, folder, agents and models. */
  onOpenWorkspaceSetup?: () => void;
  onOpenOnlinePanel: () => void;
  onOpenCrsmPalette?: () => void;
}

const SidebarIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
    <line x1="9" y1="3" x2="9" y2="21"></line>
  </svg>
);

const BellIcon = ({ count }: { count?: number }) => (
  <div style={{ position: "relative", display: "flex" }}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
      <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
    </svg>
    {count ? <div style={{ position: "absolute", top: -3, right: -4, width: 6, height: 6, background: "var(--notification-color)", borderRadius: "50%" }} /> : null}
  </div>
);

const SavepointIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z"></path>
  </svg>
);

const PlusIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19"></line>
    <line x1="5" y1="12" x2="19" y2="12"></line>
  </svg>
);

const CaretDownIcon = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="6 9 12 15 18 9"></polyline>
  </svg>
);

const SettingsIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3"></circle>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33 1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82 1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
  </svg>
);

export default function TitleBar({
  uiVariant = "default",
  onNewWorkspace,
  onOpenWorkspaceSetup,
  onOpenOnlinePanel,
  onOpenCrsmPalette,
}: TitleBarProps) {
  const [testProfile, setTestProfile] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    void invoke<string | null>("get_test_profile").then(setTestProfile).catch(() => {});
  }, []);
  useAccountsPolling(testProfile === null);
  useCliLoginEvents();
  const activeWorkspace = useWorkspaceListStore((s) => s.getActiveWorkspace());
  const activeWorkspaceColor = resolveWorkspaceColor(activeWorkspace?.color);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const sidebarShortcut = useKeybindingStore((s) => formatShortcutLabel(s.keybindings["sidebar.toggle"]));
  const newWorkspaceShortcut = useKeybindingStore((s) => formatShortcutLabel(s.keybindings["workspace.new"]));
  const advancedWorkspaceShortcut = useKeybindingStore((s) => formatShortcutLabel(s.keybindings["workspace.new.advanced"]));
  // Counted off live tabs, not the raw metadata map: the badge must never
  // claim notifications the panel cannot list (see collectNotificationEntries).
  const workspacesForNotifications = useWorkspaceListStore((s) => s.workspaces);
  const totalNotifications = usePaneMetadataStore((state) =>
    countNotifications(workspacesForNotifications, state.metadata),
  );
  const [notificationPanelOpen, setNotificationPanelOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"appearance" | "usage">("appearance");
  const { mounted: notificationPanelMounted, closing: notificationPanelClosing } = useDeferredUnmount(
    notificationPanelOpen,
    OVERLAY_EXIT_MS,
  );
  const { mounted: settingsMounted, closing: settingsClosing } = useDeferredUnmount(
    isSettingsOpen,
    OVERLAY_EXIT_MS,
  );
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    win.isMaximized().then(setIsMaximized).catch(() => {});
    // Track maximize state via both resize and move events
    const unlistenResize = win.onResized(() => {
      win.isMaximized().then(setIsMaximized).catch(() => {});
    });
    const unlistenMove = win.onMoved(() => {
      win.isMaximized().then(setIsMaximized).catch(() => {});
    });
    return () => {
      unlistenResize.then((f) => f());
      unlistenMove.then((f) => f());
    };
  }, []);

  // Manual double-click detection for drag region compatibility
  const lastClickRef = useRef(0);
  const handleTitleBarClick = () => {
    const now = Date.now();
    if (now - lastClickRef.current < 300) {
      getCurrentWindow().toggleMaximize().catch(console.error);
      lastClickRef.current = 0;
    } else {
      lastClickRef.current = now;
    }
  };

  const handleMinimize = () => getCurrentWindow().minimize().catch(console.error);
  const handleMaximize = () => getCurrentWindow().toggleMaximize().catch(console.error);
  const handleClose = () => getCurrentWindow().close().catch(console.error);

  const groupMinWidth = 100;

  return (
    <div
      data-tauri-drag-region
      style={{
        height: 36,
        display: "flex",
        alignItems: "center",
        background: "var(--cmux-title-bg)",
        borderBottom: "1px solid var(--cmux-border-hairline)",
        flexShrink: 0,
        userSelect: "none",
        position: "relative",
      }}
    >
      {testProfile && (
        <div
          style={{
            marginLeft: 10,
            padding: "3px 7px",
            borderRadius: 4,
            background: "var(--cmux-red)",
            color: "white",
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: 0.3,
          }}
        >
          TEST ({testProfile})
        </div>
      )}
      {/* Left group: Sidebar, Bell, Plus */}
      {/* macOS (titleBarStyle: Overlay): native traffic lights float over the
          top-left corner, so inset the button group past them */}
      <div
        style={{
          paddingLeft: IS_MAC ? 78 : 10,
          display: "flex",
          alignItems: "center",
          gap: 2,
          minWidth: groupMinWidth,
        }}
      >
        <button
          onClick={toggleSidebar}
          title={`Toggle Sidebar (${sidebarShortcut})`}
          className="cmux-title-btn"
          style={{
            background: "none",
            border: "none",
            color: "var(--cmux-text-secondary)",
            cursor: "pointer",
            padding: "3px 4px",
            display: "flex",
            alignItems: "center",
            borderRadius: 3,
          }}
        >
          <SidebarIcon />
        </button>

        <div style={{ position: "relative" }}>
          <button
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => setNotificationPanelOpen((o) => !o)}
            title="Notifications"
            className="cmux-title-btn"
            style={{
              background: "none",
              border: "none",
              color: "var(--cmux-text-secondary)",
              cursor: "pointer",
              padding: "3px 6px",
              display: "flex",
              alignItems: "center",
              borderRadius: 3,
            }}
          >
            <BellIcon count={totalNotifications} />
          </button>
          {notificationPanelMounted && (
            <NotificationPanel closing={notificationPanelClosing} onClose={() => setNotificationPanelOpen(false)} />
          )}
        </div>

        {onOpenOnlinePanel && (
          <button
            onClick={onOpenOnlinePanel}
            title={onlineStrings.openPanelLabel}
            aria-label={onlineStrings.openPanelLabel}
            className="cmux-title-btn"
            style={{
              background: "none",
              border: "none",
              color: "var(--cmux-text-secondary)",
              cursor: "pointer",
              padding: "3px 6px",
              display: "flex",
              alignItems: "center",
              borderRadius: 3,
            }}
          >
            <SavepointIcon />
          </button>
        )}

        {/* Split button: the plus creates a workspace outright, the caret opens
            the dialog for the times a layout, folder or model actually matters.
            No context menu — a native WebView2 menu froze the app once. */}
        <button
          onClick={onNewWorkspace}
          title={`New Workspace (${newWorkspaceShortcut})`}
          className="cmux-title-btn"
          style={{
            background: "none",
            border: "none",
            color: "var(--cmux-text-secondary)",
            cursor: "pointer",
            padding: "3px 6px",
            display: "flex",
            alignItems: "center",
            borderRadius: 3,
          }}
        >
          <PlusIcon />
        </button>

        {onOpenWorkspaceSetup && (
          <button
            onClick={onOpenWorkspaceSetup}
            title={`New Workspace with agents and models (${advancedWorkspaceShortcut})`}
            aria-label="New Workspace with agents and models"
            className="cmux-title-btn"
            style={{
              background: "none",
              border: "none",
              color: "var(--cmux-text-tertiary)",
              cursor: "pointer",
              padding: "3px 2px",
              marginLeft: -4,
              display: "flex",
              alignItems: "center",
              borderRadius: 3,
            }}
          >
            <CaretDownIcon />
          </button>
        )}
      </div>

      {/* Center: TERMINAL · WorkspaceName (drag region + click-based maximize) */}
      <div
        data-tauri-drag-region
        onClick={handleTitleBarClick}
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          overflow: "hidden",
        }}
      >
        <span
          data-cmux-brand={uiVariant === "cmux" ? "true" : undefined}
          data-tauri-drag-region
          style={{
            flexShrink: 0,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.12em",
            color: "var(--cmux-text-secondary)",
            fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
            textTransform: "uppercase",
          }}
        >
          TERMINAL
        </span>

        {activeWorkspace && (
          <>
            <span data-tauri-drag-region style={{ flexShrink: 0, color: "var(--cmux-text-secondary)", fontSize: 12 }}>·</span>
            {activeWorkspaceColor && (
              <span
                data-tauri-drag-region
                className="workspace-color-dot"
                title={activeWorkspaceColor.label}
                aria-hidden="true"
                style={{ "--workspace-swatch-color": activeWorkspaceColor.value } as CSSProperties}
              />
            )}
            <span
              data-tauri-drag-region
              style={{
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontSize: 12,
                color: "var(--cmux-text-secondary)",
                fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
              }}
            >
              {activeWorkspace.name}
            </span>
          </>
        )}
      </div>

      {/* Right group: Minimize, Close */}
      <div style={{ display: "flex", alignItems: "center", gap: 2, paddingRight: 8, minWidth: groupMinWidth, justifyContent: "flex-end" }}>
        <AccountsButton
          onOpenUsageSettings={() => {
            setSettingsTab("usage");
            setIsSettingsOpen(true);
          }}
        />
        <AiLogButton />
        <DashboardButton />
        <div style={{ position: "relative" }}>
          <button
            onClick={() => {
              setSettingsTab("appearance");
              setIsSettingsOpen((v) => !v);
            }}
            title="Settings"
            className="cmux-title-btn"
            style={{
              background: "none",
              border: "none",
              color: "var(--cmux-text-secondary)",
              cursor: "pointer",
              padding: "3px 6px",
              borderRadius: 3,
              display: "flex",
              alignItems: "center",
            }}
          >
            <SettingsIcon />
          </button>
          {settingsMounted && (
            <SettingsDialog
              closing={settingsClosing}
              onClose={() => setIsSettingsOpen(false)}
              initialTab={settingsTab}
              onOpenCrsmPalette={onOpenCrsmPalette}
              onOpenOnlinePanel={onOpenOnlinePanel}
            />
          )}
        </div>
        {/* macOS provides native window controls (traffic lights) via the
            Overlay title bar, so the custom ones are Windows/Linux only */}
        {!IS_MAC && (
          <>
            <button
              onClick={handleMinimize}
              title="Minimize"
              className="cmux-title-btn"
              style={{
                background: "none",
                border: "none",
                color: "var(--cmux-text-secondary)",
                cursor: "pointer",
                padding: "3px 6px",
                borderRadius: 3,
                display: "flex",
                alignItems: "center",
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="5" y1="12" x2="19" y2="12"></line>
              </svg>
            </button>
            <button
              onClick={handleMaximize}
              title={isMaximized ? "Restore" : "Maximize"}
              className="cmux-title-btn"
              style={{
                background: "none",
                border: "none",
                color: "var(--cmux-text-secondary)",
                cursor: "pointer",
                padding: "3px 6px",
                borderRadius: 3,
                display: "flex",
                alignItems: "center",
              }}
            >
              {isMaximized ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="5" y="7" width="12" height="12" rx="1"></rect>
                  <path d="M7 7V6a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-1"></path>
                </svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="4" y="4" width="16" height="16" rx="1"></rect>
                </svg>
              )}
            </button>
            <button
              onClick={handleClose}
              title="Close"
              style={{
                background: "none",
                border: "none",
                color: "var(--cmux-text-secondary)",
                cursor: "pointer",
                padding: "3px 6px",
                borderRadius: 3,
                display: "flex",
                alignItems: "center",
              }}
              className="cmux-title-btn cmux-title-btn--close"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </>
        )}
      </div>
    </div>
  );
}
