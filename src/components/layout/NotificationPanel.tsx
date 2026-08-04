import { memo, useEffect, useMemo, useRef } from "react";
import { useWorkspaceListStore, usePaneMetadataStore, useWorkspaceLayoutStore } from "../../stores/workspaceStore";
import { getAgent } from "../../lib/agents";
import { focusController } from "../../lib/focusController";

interface NotificationPanelProps {
  closing?: boolean;
  onClose: () => void;
}

type NotificationEntry = {
  workspaceId: string;
  workspaceName: string;
  paneId: string;
  tabId: string;
  sessionId: string;
  count: number;
  kind: "waiting" | "done";
  label: string;
};

const NotificationItem = memo(function NotificationItem({
  notification,
  onActivate,
}: {
  notification: NotificationEntry;
  onActivate: (notification: NotificationEntry) => void;
}) {
  const lastLogLine = usePaneMetadataStore((s) => s.lastLog[notification.sessionId]);

  return (
    <div
      className="cmux-notification-item"
      onClick={() => onActivate(notification)}
      style={{
        cursor: "pointer",
        borderBottom: "1px solid var(--cmux-border)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px" }}>
        <span style={{ flex: 1, fontWeight: 500, fontSize: 12 }}>{notification.workspaceName}</span>
        <span style={{ color: "var(--cmux-text-tertiary)", fontSize: 11, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {notification.label}
        </span>
        <span key={`${notification.kind}-${notification.count}`} className="cmux-badge-pop" style={{
          background: notification.kind === "waiting" ? "var(--status-waiting)" : "var(--status-done)",
          color: notification.kind === "waiting" ? "var(--cmux-on-waiting)" : "var(--cmux-on-done)",
          fontSize: 9,
          fontWeight: "bold",
          borderRadius: "50%",
          width: 16,
          height: 16,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}>
          {notification.count}
        </span>
      </div>
      {lastLogLine && (
        <div style={{
          padding: "0 12px 8px 12px",
          fontSize: 11,
          color: "var(--cmux-text-secondary)",
          fontFamily: "monospace",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}>
          {lastLogLine}
        </div>
      )}
    </div>
  );
});

export default function NotificationPanel({ closing = false, onClose }: NotificationPanelProps) {
  const workspaces = useWorkspaceListStore((s) => s.workspaces);
  const setActive = useWorkspaceListStore((s) => s.setActiveWorkspace);
  const setActivePaneTab = useWorkspaceLayoutStore((s) => s.setActivePaneTab);
  const paneMetadata = usePaneMetadataStore((s) => s.metadata);
  const clearNotification = usePaneMetadataStore((s) => s.clearNotification);
  const panelRef = useRef<HTMLDivElement>(null);

  const notifications = useMemo(() => {
    const result: NotificationEntry[] = [];
    for (const ws of workspaces) {
      for (const pane of ws.panes) {
        for (const tab of pane.tabs) {
          const m = paneMetadata[tab.sessionId];
          if (!m) continue;
          const agentName = getAgent(tab.agentId)?.name ?? "Shell";
          const label = tab.label ?? m.processTitle ?? m.cwd?.split("/").pop() ?? agentName;
          if ((m.notificationCount ?? 0) > 0) {
            result.push({
              workspaceId: ws.id,
              workspaceName: ws.name,
              paneId: pane.id,
              tabId: tab.id,
              sessionId: tab.sessionId,
              count: m.notificationCount ?? 0,
              kind: "waiting",
              label,
            });
          } else if ((m.workDoneCount ?? 0) > 0) {
            result.push({
              workspaceId: ws.id,
              workspaceName: ws.name,
              paneId: pane.id,
              tabId: tab.id,
              sessionId: tab.sessionId,
              count: m.workDoneCount ?? 0,
              kind: "done",
              label,
            });
          }
        }
      }
    }
    return result.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "waiting" ? -1 : 1;
      return b.count - a.count;
    });
  }, [workspaces, paneMetadata]);

  useEffect(() => {
    if (closing) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [closing, onClose]);

  function handleClearAll() {
    for (const n of notifications) {
      clearNotification(n.sessionId);
    }
    onClose();
  }

  return (
    <div
      ref={panelRef}
      className={`cmux-popover-panel${closing ? " is-closing" : ""}`}
      inert={closing ? true : undefined}
      aria-hidden={closing ? true : undefined}
      style={{
        position: "absolute",
        top: "100%",
        left: 0,
        marginTop: 4,
        width: 260,
        maxWidth: "min(260px, calc(100vw - 16px))",
        background: "var(--cmux-popover)",
        border: "1px solid var(--cmux-border)",
        borderRadius: 6,
        zIndex: 100,
        boxShadow: "var(--cmux-shadow-popover)",
        fontSize: 12,
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        color: "var(--cmux-text)",
        overflow: "hidden",
      }}
    >
      <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--cmux-border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontWeight: 600, fontSize: 11 }}>Notifications</span>
        {notifications.length > 0 && (
          <button
            onClick={handleClearAll}
            style={{ background: "none", border: "none", color: "var(--cmux-text-tertiary)", cursor: "pointer", fontSize: 11, padding: 0 }}
          >
            Clear all
          </button>
        )}
      </div>
      {notifications.length === 0 ? (
        <div style={{ padding: "12px", color: "var(--cmux-text-tertiary)", textAlign: "center", fontSize: 11 }}>
          No notifications
        </div>
      ) : (
        <div style={{ maxHeight: "min(400px, calc(100vh - 120px))", overflowY: "auto" }}>
          {notifications.map((n) => (
            <NotificationItem
              key={n.sessionId}
              notification={n}
              onActivate={(notification) => {
                setActive(notification.workspaceId);
                setActivePaneTab(notification.workspaceId, notification.paneId, notification.tabId);
                focusController.request("programmatic", { sessionId: notification.sessionId, focus: true });
                clearNotification(notification.sessionId);
                onClose();
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
