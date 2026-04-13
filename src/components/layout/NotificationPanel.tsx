import { useEffect, useRef, useMemo } from "react";
import { useWorkspaceListStore, usePaneMetadataStore, useWorkspaceLayoutStore } from "../../stores/workspaceStore";
import { useUiStore } from "../../stores/uiStore";
import { getAgent } from "../../lib/agents";

interface NotificationPanelProps {
  onClose: () => void;
}

export default function NotificationPanel({ onClose }: NotificationPanelProps) {
  const workspaces = useWorkspaceListStore((s) => s.workspaces);
  const setActive = useWorkspaceListStore((s) => s.setActiveWorkspace);
  const setActivePaneTab = useWorkspaceLayoutStore((s) => s.setActivePaneTab);
  const paneMetadata = usePaneMetadataStore((s) => s.metadata);
  const clearNotification = usePaneMetadataStore((s) => s.clearNotification);
  const setActivePaneId = useUiStore((s) => s.setActivePaneId);
  const panelRef = useRef<HTMLDivElement>(null);

  // Collect all panes with notifications (memoized to avoid O(n*m) rebuild)
  const notifications = useMemo(() => {
    const result: {
      workspaceId: string;
      workspaceName: string;
      workspaceColor: string;
      paneId: string;
      tabId: string;
      sessionId: string;
      count: number;
      kind: "waiting" | "done";
      label: string;
      lastLogLine?: string;
    }[] = [];
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
              workspaceColor: ws.color ?? "#0A84FF",
              paneId: pane.id,
              tabId: tab.id,
              sessionId: tab.sessionId,
              count: m.notificationCount ?? 0,
              kind: "waiting",
              label,
              lastLogLine: m.lastLogLine,
            });
          } else if ((m.workDoneCount ?? 0) > 0) {
            result.push({
              workspaceId: ws.id,
              workspaceName: ws.name,
              workspaceColor: ws.color ?? "#0A84FF",
              paneId: pane.id,
              tabId: tab.id,
              sessionId: tab.sessionId,
              count: m.workDoneCount ?? 0,
              kind: "done",
              label,
              lastLogLine: m.lastLogLine,
            });
          }
        }
      }
    }
    // Waiting (approval) sorts ahead of done.
    return result.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "waiting" ? -1 : 1;
      return b.count - a.count;
    });
  }, [workspaces, paneMetadata]);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  function handleClearAll() {
    for (const n of notifications) {
      clearNotification(n.sessionId);
    }
    onClose();
  }

  function focusPane(sessionId: string) {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>(`[data-session-id="${sessionId}"]`);
        const textarea = el?.querySelector<HTMLTextAreaElement>("textarea");
        if (textarea) {
          textarea.focus();
        } else {
          el?.focus();
        }
      });
    });
  }

  return (
    <div
      ref={panelRef}
      style={{
        position: "absolute",
        top: "100%",
        left: 0,
        marginTop: 4,
        width: 260,
        maxWidth: "min(260px, calc(100vw - 16px))",
        background: "var(--cmux-sidebar)",
        border: "1px solid var(--cmux-border)",
        borderRadius: 6,
        zIndex: 100,
        boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
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
        <div>
          {notifications.map((n) => (
            <div
              key={n.sessionId}
              onClick={() => {
                setActive(n.workspaceId);
                setActivePaneTab(n.workspaceId, n.paneId, n.tabId);
                setActivePaneId(n.sessionId);
                clearNotification(n.sessionId);
                onClose();
                focusPane(n.sessionId);
              }}
              style={{
                cursor: "pointer",
                borderBottom: "1px solid var(--cmux-border)",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.05)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px" }}>
                {/* Workspace color dot */}
                <span style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: n.workspaceColor,
                  flexShrink: 0,
                }} />
                {/* Workspace name */}
                <span style={{ flex: 1, fontWeight: 500, fontSize: 12 }}>{n.workspaceName}</span>
                <span style={{ color: "var(--cmux-text-tertiary)", fontSize: 11, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {n.label}
                </span>
                {/* Count badge — red for approval waiting, green for work done */}
                <span style={{
                  background: n.kind === "waiting" ? "#ff3b30" : "#30d158",
                  color: "white",
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
                  {n.count}
                </span>
              </div>
              {n.lastLogLine && (
                <div style={{
                  padding: "0 12px 8px 28px",
                  fontSize: 11,
                  color: "var(--cmux-text-secondary)",
                  fontFamily: "monospace",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}>
                  {n.lastLogLine}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
