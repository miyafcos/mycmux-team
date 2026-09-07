import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useDismissOnOutside } from "../../hooks/useDismissOnOutside";
import { useWorkspaceListStore, usePaneMetadataStore, useWorkspaceLayoutStore } from "../../stores/workspaceStore";
import { useSessionAttentionStore } from "../../stores/sessionAttentionStore";
import { buildNotificationPanelModel, type NotificationPanelRow } from "../../lib/notificationPanelModel";
import { AgentKindIcon } from "../icons/AgentIcons";
import { notificationPanelStrings as strings } from "./notificationPanelStrings";
import { NotificationAnswer, useNotificationBriefs } from "./NotificationAnswer";
import { focusController } from "../../lib/focusController";

interface NotificationPanelProps {
  closing?: boolean;
  onClose: () => void;
}

const NotificationItem = memo(function NotificationItem({ notification, activeWorkspaceId, onActivate, expanded = false, onToggle }: {
  notification: NotificationPanelRow;
  activeWorkspaceId: string | null;
  onActivate: (notification: NotificationPanelRow) => void;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const lastLogLine = usePaneMetadataStore((s) => s.lastLog[notification.sessionId]);
  const needsAnswer = notification.kind !== "unread";
  const answerId = useId();
  const [visited, setVisited] = useState(false);
  const [busy, setBusy] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!expanded) return;
    setVisited(true);
    rowRef.current?.querySelector<HTMLElement>("[data-notification-answer]")?.focus();
  }, [expanded]);

  return (
    <div ref={rowRef} data-notification-row>
    <button
      type="button"
      className="cmux-notification-item"
      aria-expanded={needsAnswer ? expanded : undefined}
      aria-controls={needsAnswer ? answerId : undefined}
      onClick={() => needsAnswer ? onToggle?.() : onActivate(notification)}
      style={{
        display: "block", width: "100%", padding: "10px 12px", border: 0,
        background: "transparent", color: "inherit", font: "inherit", textAlign: "left", cursor: "pointer",
        borderBottom: "1px solid var(--cmux-border-hairline)",
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <AgentKindIcon kind={notification.agentKind} size={18} />
        <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere", fontWeight: 500, fontSize: 12 }}>
          {notification.label}
        </span>
        <span style={{ flexShrink: 0, fontSize: 11, color: "var(--cmux-text-secondary)" }}>
          {busy ? strings.sending : notification.kind === "unread" ? notification.count : strings[notification.kind]}
        </span>
      </span>
      {notification.workspaceId !== activeWorkspaceId && (
        <span style={{ display: "block", marginTop: 4, overflowWrap: "anywhere", fontSize: 11, color: "var(--cmux-text-secondary)" }}>
          {notification.workspaceName}
        </span>
      )}
      <span style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, marginTop: 6 }}>
        {!needsAnswer && lastLogLine && (
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            fontSize: 11, color: "var(--cmux-text-secondary)", fontFamily: "var(--cmux-font-mono)" }}>
            {lastLogLine}
          </span>
        )}
        <span style={{ flexShrink: 0, fontSize: 11, color: "var(--cmux-accent-text)" }}>
          {needsAnswer ? strings.answer : strings.open}
        </span>
      </span>
    </button>
    {needsAnswer && (expanded || visited) && <div id={answerId} hidden={!expanded}>
      <NotificationAnswer active={expanded} sessionId={notification.sessionId} label={notification.label}
        onOpen={() => onActivate(notification)} onBusyChange={setBusy} />
    </div>}
    </div>
  );
});

export default function NotificationPanel({ closing = false, onClose }: NotificationPanelProps) {
  const workspaces = useWorkspaceListStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceListStore((s) => s.activeWorkspaceId);
  const setActive = useWorkspaceListStore((s) => s.setActiveWorkspace);
  const setActivePaneTab = useWorkspaceLayoutStore((s) => s.setActivePaneTab);
  const paneMetadata = usePaneMetadataStore((s) => s.metadata);
  const volatilePaneMetadata = usePaneMetadataStore((s) => s.volatileMetadata);
  const attentionBySession = useSessionAttentionStore((s) => s.attentionBySession);
  const clearNotification = usePaneMetadataStore((s) => s.clearNotification);
  const panelRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const [expandedTab, setExpandedTab] = useState<string | null>(null);
  useNotificationBriefs(closing);
  const [position, setPosition] = useState({ left: 8, top: 40 });
  const model = useMemo(
    () => buildNotificationPanelModel(workspaces, attentionBySession, paneMetadata, volatilePaneMetadata),
    [workspaces, attentionBySession, paneMetadata, volatilePaneMetadata],
  );

  useDismissOnOutside(!closing, panelRef, (reason) => {
    if (reason === "escape") {
      const expanded = panelRef.current?.querySelector<HTMLButtonElement>('.cmux-notification-item[aria-expanded="true"]');
      if (expanded) {
        setExpandedTab(null);
        expanded.focus();
        return;
      }
      panelRef.current?.parentElement?.querySelector<HTMLButtonElement>("button")?.focus();
    }
    onClose();
  });

  useLayoutEffect(() => {
    if (closing) return;
    const place = () => {
      const anchor = panelRef.current?.parentElement?.getBoundingClientRect();
      const width = Math.min(380, window.innerWidth - 16);
      setPosition({
        left: Math.max(8, Math.min(anchor?.left ?? 8, window.innerWidth - width - 8)),
        top: Math.max(8, Math.min((anchor?.bottom ?? 36) + 4, window.innerHeight - 48)),
      });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [closing]);

  useEffect(() => {
    if (!closing) panelRef.current?.querySelector<HTMLButtonElement>(".cmux-notification-item")?.focus();
  }, [closing]);

  useEffect(() => {
    if (expandedTab && !model.attention.some((row) => row.tabId === expandedTab)) setExpandedTab(null);
  }, [expandedTab, model.attention]);

  function handleClearUnread() {
    for (const n of model.unread) {
      clearNotification(n.sessionId);
    }
    onClose();
  }

  function activate(notification: NotificationPanelRow) {
    setActive(notification.workspaceId);
    setActivePaneTab(notification.workspaceId, notification.paneId, notification.tabId);
    focusController.request("programmatic", { sessionId: notification.sessionId, focus: true });
    if (notification.kind === "unread") clearNotification(notification.sessionId);
    onClose();
  }

  return (
    <div
      ref={panelRef}
      onKeyDown={(event) => {
        if (closing) return;
        if (event.nativeEvent.isComposing || event.keyCode === 229) {
          event.preventDefault();
          return;
        }
        const target = event.target as HTMLElement;
        if (/^[1-9]$/.test(event.key) && target.matches('.cmux-notification-item[aria-expanded="true"]')) {
          event.preventDefault();
          event.stopPropagation();
          if (!event.repeat && !event.altKey && !event.ctrlKey && !event.metaKey) {
            target.closest("[data-notification-row]")?.querySelector<HTMLButtonElement>(
              `[data-ask-question-option="${event.key}"], [data-notification-option="${event.key}"]`,
            )?.click();
          }
          return;
        }
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(".cmux-notification-item"));
        const currentRow = (document.activeElement as HTMLElement | null)?.closest("[data-notification-row]");
        const index = rows.findIndex((row) => currentRow?.contains(row));
        if (index < 0 || rows.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        rows[(index + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]?.focus();
      }}
      className={`cmux-popover-panel${closing ? " is-closing" : ""}`}
      inert={closing ? true : undefined}
      aria-hidden={closing ? true : undefined}
      style={{
        position: "fixed", ...position, width: 380, maxWidth: "calc(100vw - 16px)", boxSizing: "border-box",
        maxHeight: `calc(100dvh - ${position.top + 8}px)`, overflowY: "auto", overflowX: "hidden",
        background: "var(--cmux-popover)", border: "1px solid var(--cmux-border)", borderRadius: 6,
        zIndex: 100, boxShadow: "var(--cmux-shadow-popover)", fontSize: 12,
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif", color: "var(--cmux-text)",
      }}
    >
      <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--cmux-border-hairline)", fontWeight: 600, fontSize: 11 }}>
        {strings.title}
      </div>
      <section aria-labelledby={`${headingId}-attention`}>
        <h3 id={`${headingId}-attention`} style={{ margin: 0, padding: "12px", fontSize: 12 }}>
          {strings.attentionHeading(model.attentionCount, model.questionCount, model.approvalCount)}
        </h3>
        {model.attention.length === 0 && (
          <div style={{ padding: "0 12px 12px", fontSize: 11, color: "var(--cmux-text-secondary)" }}>{strings.noAttention}</div>
        )}
        {model.attention.map((notification) => (
          <NotificationItem key={notification.tabId + notification.sessionId} notification={notification} activeWorkspaceId={activeWorkspaceId} onActivate={activate}
            expanded={expandedTab === notification.tabId}
            onToggle={() => setExpandedTab((current) => current === notification.tabId ? null : notification.tabId)} />
        ))}
      </section>
      <section aria-labelledby={`${headingId}-unread`} style={{ borderTop: "1px solid var(--cmux-border)" }}>
        <div style={{ padding: "12px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <h3 id={`${headingId}-unread`} style={{ margin: 0, fontSize: 12 }}>{strings.unreadHeading(model.unreadCount)}</h3>
          {model.unread.length > 0 && (
            <button type="button" onClick={handleClearUnread}
              style={{ background: "none", border: "none", color: "var(--cmux-accent-text)", cursor: "pointer", fontSize: 11, padding: "4px 0" }}>
              {strings.clearUnread}
            </button>
          )}
        </div>
        {model.unread.length === 0 && (
          <div style={{ padding: "0 12px 12px", fontSize: 11, color: "var(--cmux-text-secondary)" }}>{strings.noUnread}</div>
        )}
        {model.unread.map((notification) => (
          <NotificationItem key={notification.tabId + notification.sessionId} notification={notification} activeWorkspaceId={activeWorkspaceId} onActivate={activate} />
        ))}
      </section>
    </div>
  );
}
