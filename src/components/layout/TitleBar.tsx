import { useState, useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useWorkspaceListStore, useUiStore, usePaneMetadataStore } from "../../stores/workspaceStore";
import NotificationPanel from "./NotificationPanel";

interface TitleBarProps {
  uiVariant?: "default" | "cmux";
  onNewWorkspace?: () => void;
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
    {count ? <div style={{ position: "absolute", top: -3, right: -4, width: 6, height: 6, background: "#007aff", borderRadius: "50%" }} /> : null}
  </div>
);

const PlusIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19"></line>
    <line x1="5" y1="12" x2="19" y2="12"></line>
  </svg>
);

export default function TitleBar({ uiVariant = "default", onNewWorkspace }: TitleBarProps) {
  const activeWorkspace = useWorkspaceListStore((s) => s.getActiveWorkspace());
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const paneMetadata = usePaneMetadataStore((s) => s.metadata);
  const [notificationPanelOpen, setNotificationPanelOpen] = useState(false);
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

  const totalNotifications = Object.values(paneMetadata).reduce(
    (sum, m) => sum + (m.notificationCount ?? 0) + (m.workDoneCount ?? 0),
    0,
  );

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
        background: uiVariant === "cmux" ? "#0f0f10" : "#111111",
        borderBottom: "1px solid var(--cmux-border)",
        flexShrink: 0,
        userSelect: "none",
        position: "relative",
      }}
    >
      {/* Left group: Sidebar, Bell, Plus */}
      <div
        style={{
          paddingLeft: 10,
          display: "flex",
          alignItems: "center",
          gap: 2,
          minWidth: groupMinWidth,
        }}
      >
        <button
          onClick={toggleSidebar}
          title="Toggle Sidebar (Ctrl+B)"
          className={uiVariant === "cmux" ? "cmux-title-btn" : undefined}
          style={{
            background: "none",
            border: "none",
            color: "var(--cmux-text-tertiary)",
            cursor: "pointer",
            padding: "3px 4px",
            display: "flex",
            alignItems: "center",
            borderRadius: 3,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "rgba(255,255,255,0.08)";
            e.currentTarget.style.color = "var(--cmux-text-secondary)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "none";
            e.currentTarget.style.color = "var(--cmux-text-tertiary)";
          }}
        >
          <SidebarIcon />
        </button>

        <div style={{ position: "relative" }}>
          <button
            onClick={() => setNotificationPanelOpen((o) => !o)}
            title="Notifications"
            className={uiVariant === "cmux" ? "cmux-title-btn" : undefined}
            style={{
              background: "none",
              border: "none",
              color: "var(--cmux-text-tertiary)",
              cursor: "pointer",
              padding: "3px 6px",
              display: "flex",
              alignItems: "center",
              borderRadius: 3,
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.08)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
          >
            <BellIcon count={totalNotifications} />
          </button>
          {notificationPanelOpen && (
            <NotificationPanel onClose={() => setNotificationPanelOpen(false)} />
          )}
        </div>

        <button
          onClick={onNewWorkspace}
          title="New Workspace (Ctrl+Shift+N)"
          className={uiVariant === "cmux" ? "cmux-title-btn" : undefined}
          style={{
            background: "none",
            border: "none",
            color: "var(--cmux-text-tertiary)",
            cursor: "pointer",
            padding: "3px 6px",
            display: "flex",
            alignItems: "center",
            borderRadius: 3,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "rgba(255,255,255,0.08)";
            e.currentTarget.style.color = "var(--cmux-text-secondary)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "none";
            e.currentTarget.style.color = "var(--cmux-text-tertiary)";
          }}
        >
          <PlusIcon />
        </button>
      </div>

      {/* Center: TERMINAL · WorkspaceName (drag region + click-based maximize) */}
      <div
        data-tauri-drag-region
        onClick={handleTitleBarClick}
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
        }}
      >
        <span
          data-cmux-brand={uiVariant === "cmux" ? "true" : undefined}
          data-tauri-drag-region
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.12em",
            color: uiVariant === "cmux" ? "#d8d8d8" : "var(--cmux-text-secondary)",
            fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
            textTransform: "uppercase",
          }}
        >
          TERMINAL
        </span>

        {activeWorkspace && (
          <>
            <span data-tauri-drag-region style={{ color: "var(--cmux-text-tertiary)", fontSize: 12 }}>·</span>
            <span
              data-tauri-drag-region
              style={{
                fontSize: 12,
                color: "var(--cmux-text-tertiary)",
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
        <button
          onClick={handleMinimize}
          title="Minimize"
          className={uiVariant === "cmux" ? "cmux-title-btn" : undefined}
          style={{
            background: "none",
            border: "none",
            color: "var(--cmux-text-tertiary)",
            cursor: "pointer",
            padding: "3px 6px",
            borderRadius: 3,
            display: "flex",
            alignItems: "center",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.08)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
        </button>
        <button
          onClick={handleMaximize}
          title={isMaximized ? "Restore" : "Maximize"}
          className={uiVariant === "cmux" ? "cmux-title-btn" : undefined}
          style={{
            background: "none",
            border: "none",
            color: "var(--cmux-text-tertiary)",
            cursor: "pointer",
            padding: "3px 6px",
            borderRadius: 3,
            display: "flex",
            alignItems: "center",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.08)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
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
            color: "var(--cmux-text-tertiary)",
            cursor: "pointer",
            padding: "3px 6px",
            borderRadius: 3,
            display: "flex",
            alignItems: "center",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "rgba(255,59,48,0.3)";
            e.currentTarget.style.color = "#ff3b30";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "none";
            e.currentTarget.style.color = "var(--cmux-text-tertiary)";
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
    </div>
  );
}
