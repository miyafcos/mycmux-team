import { memo } from "react";
import type { Pane, PaneTab } from "../../types";
import { getAgent, getDefaultAgent } from "../../lib/agents";
import { usePaneMetadataStore } from "../../stores/workspaceStore";
import { deriveEffectiveStatus, type EffectiveStatus } from "../../lib/notificationStatus";
import { usePaneDragSource } from "../../hooks/usePaneDragSource";

interface PaneTabBarProps {
  pane: Pane;
  workspaceId: string;
  hasNotification?: boolean;
  isZoomed?: boolean;
  onClose?: () => void;
  onSplitRight?: () => void;
  onSplitDown?: () => void;
  onZoomToggle?: () => void;
  onAddTab?: (agentId?: string, type?: PaneTab["type"]) => void;
  onRemoveTab?: (tabId: string) => void;
  onSelectTab?: (tabId: string) => void;
}

const FolderIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
  </svg>
);

const SplitRightIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
    <line x1="12" y1="3" x2="12" y2="21"></line>
    <line x1="12" y1="12" x2="21" y2="12"></line>
  </svg>
);

const SplitDownIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
    <line x1="3" y1="12" x2="21" y2="12"></line>
    <line x1="12" y1="12" x2="12" y2="21"></line>
  </svg>
);

const MaximizeIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="15 3 21 3 21 9"></polyline>
    <polyline points="9 21 3 21 3 15"></polyline>
    <line x1="21" y1="3" x2="14" y2="10"></line>
    <line x1="3" y1="21" x2="10" y2="14"></line>
  </svg>
);

const MinimizeIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="4 14 10 14 10 20"></polyline>
    <polyline points="20 10 14 10 14 4"></polyline>
    <line x1="14" y1="10" x2="21" y2="3"></line>
    <line x1="3" y1="21" x2="10" y2="14"></line>
  </svg>
);

const CloseIcon = ({ size = 10 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18"></line>
    <line x1="6" y1="6" x2="18" y2="18"></line>
  </svg>
);

const PlusIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19"></line>
    <line x1="5" y1="12" x2="19" y2="12"></line>
  </svg>
);

const STATUS_CONFIG: Record<EffectiveStatus, { color: string; title: string }> = {
  working: { color: "var(--status-working)", title: "Running" },
  waiting: { color: "var(--status-waiting)", title: "Waiting for input" },
  idle:    { color: "transparent",           title: "" },
};

const AGENT_LABELS: Record<string, string> = {
  "shell-starter": "Shell",
  "claude-code": "Claude Code",
  "gemini":      "Gemini",
  "codex":       "Codex",
  "aider":       "Aider",
  "shell":       "Shell",
};

function AgentStatusDot({ status }: { status: EffectiveStatus }) {
  const cfg = STATUS_CONFIG[status];
  if (status === "idle" || !cfg) return null;
  return (
    <span
      title={cfg.title}
      style={{
        width: 5,
        height: 5,
        borderRadius: "50%",
        background: cfg.color,
        flexShrink: 0,
      }}
    />
  );
}

export default memo(function PaneTabBar({
  pane,
  workspaceId,
  hasNotification,
  isZoomed,
  onClose,
  onSplitRight,
  onSplitDown,
  onZoomToggle,
  onAddTab,
  onRemoveTab,
  onSelectTab,
}: PaneTabBarProps) {
  const allMetadata = usePaneMetadataStore((s) => s.metadata);
  const { beginPointerDrag, shouldSuppressClick } = usePaneDragSource();

  // Derive active tab's agent status for the status bar
  const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId);
  const activeMeta = activeTab ? allMetadata[activeTab.sessionId] : undefined;
  const activeStatus: EffectiveStatus = deriveEffectiveStatus(activeMeta);
  const activeLastLog = activeMeta?.lastLogLine;
  const activeAgentLabel = activeTab
    ? (AGENT_LABELS[activeTab.agentId ?? ""] ?? getAgent(activeTab.agentId)?.name ?? "Shell")
    : "Shell";
  const showStatusBar = activeStatus !== "idle";
  const statusCfg = STATUS_CONFIG[activeStatus];
  const paneDragLabel = activeMeta?.processTitle ?? activeTab?.label ?? activeAgentLabel;

  return (
    <div
      className="pane-tabbar"
      onPointerDown={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest(".pane-tab-pill, button, input, textarea, select")) return;
        beginPointerDrag(event, {
          kind: "pane",
          workspaceId,
          paneId: pane.id,
          label: paneDragLabel,
          tabCount: pane.tabs.length,
        });
      }}
      style={{
        display: "flex",
        flexDirection: "column",
        background: "var(--cmux-surface)",
        borderBottom: hasNotification
          ? "1px solid color-mix(in srgb, var(--notification-color) 58%, transparent)"
          : "1px solid var(--cmux-border)",
        flexShrink: 0,
        userSelect: "none",
        position: "relative",
        overflow: "visible",
        zIndex: 10,
      }}
    >
      {/* Agent status bar — shown above tabs when an agent is active */}
      {showStatusBar && (
        <div
          style={{
            height: 22,
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "0 10px",
            borderBottom: `1px solid color-mix(in srgb, ${statusCfg.color} 38%, transparent)`,
            background: `color-mix(in srgb, ${statusCfg.color} 10%, transparent)`,
            overflow: "hidden",
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: statusCfg.color,
              flexShrink: 0,
            }}
          />
          <span style={{ fontSize: 11, color: statusCfg.color, fontWeight: 600, flexShrink: 0, textTransform: "uppercase", letterSpacing: "0.04em" }}>
            {statusCfg.title}
          </span>
          <span style={{ fontSize: 11, color: "var(--cmux-text-tertiary)", flexShrink: 0 }}>
            {activeAgentLabel}
          </span>
          {activeLastLog && (
            <>
              <span style={{ fontSize: 11, color: "var(--cmux-text-tertiary)", flexShrink: 0 }}>—</span>
              <span style={{ fontSize: 11, color: "var(--cmux-text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                {activeLastLog}
              </span>
            </>
          )}
        </div>
      )}

      {/* Tab pills row */}
      <div style={{ height: 36, display: "flex", alignItems: "center" }}>
      {/* Tab pills — overflow:hidden here to clip tab text, not the dropdown */}
      <div style={{ display: "flex", alignItems: "center", flex: 1, overflow: "hidden", minWidth: 0 }}>
        {pane.tabs.map((tab) => {
          const agent = getAgent(tab.agentId) ?? getDefaultAgent();
          const isActive = tab.id === pane.activeTabId;
          const tabMeta = allMetadata[tab.sessionId];
          const tabNotificationCount = tabMeta?.notificationCount ?? 0;
          const tabWorkDoneCount = tabMeta?.workDoneCount ?? 0;
          const tabProcessTitle = tabMeta?.processTitle;
          const tabCwd = tabMeta?.cwd;
          const tabEffectiveStatus = deriveEffectiveStatus(tabMeta);
          const label = tab.label
            ?? (tabProcessTitle
                ? tabProcessTitle
                : (isActive && tabCwd ? tabCwd.split("/").pop() || agent.name : agent.name));

          return (
            <div
              key={tab.id}
              onPointerDown={(event) => beginPointerDrag(event, {
                kind: "tab",
                workspaceId,
                paneId: pane.id,
                tabId: tab.id,
                label,
              })}
              onClick={(event) => {
                if (shouldSuppressClick()) {
                  event.preventDefault();
                  event.stopPropagation();
                  return;
                }
                onSelectTab?.(tab.id);
              }}
              title={label}
              className={`pane-tab-pill ${isActive ? "is-active" : ""}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "0 8px 0 7px",
                height: 36,
                maxWidth: 160,
                cursor: "pointer",
                background: isActive ? "var(--cmux-selected)" : "transparent",
                borderRight: "1px solid var(--cmux-border)",
                borderBottom: isActive ? `2px solid var(--cmux-accent)` : "2px solid transparent",
                flexShrink: 0,
                transition: "background 0.1s",
              }}
            >
              {/* notification dot: amber = approval waiting, emerald = work done */}
              {tabNotificationCount > 0 && (
                <span title="Waiting for approval" style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--status-waiting)", flexShrink: 0 }} />
              )}
              {tabNotificationCount === 0 && tabWorkDoneCount > 0 && (
                <span title="Work done" style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--status-done)", flexShrink: 0 }} />
              )}
              <AgentStatusDot status={tabEffectiveStatus} />
              {/* folder icon */}
              <span style={{ color: isActive ? "var(--cmux-accent)" : "var(--cmux-text-tertiary)", flexShrink: 0 }}>
                <FolderIcon />
              </span>
              {/* label */}
              <span
                className="pane-tab-label"
                style={{
                  fontSize: 13,
                  fontFamily: "'JetBrains Mono', 'Geist Mono', monospace",
                  color: isActive ? "var(--cmux-text)" : "var(--cmux-text-secondary)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  flex: 1,
                  minWidth: 0,
                }}
              >
                {label}
              </span>
              {/* close tab button */}
              {pane.tabs.length > 1 && (
                <button
                  className="pane-action-btn"
                  onClick={(e) => { e.stopPropagation(); onRemoveTab?.(tab.id); }}
                  title="Close tab"
                  style={{ padding: 2, flexShrink: 0 }}
                >
                  <CloseIcon size={9} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Add terminal tab — direct, no dropdown */}
      <button
        className="pane-action-btn"
        onClick={() => onAddTab?.(getDefaultAgent().id, "terminal")}
        title="New terminal tab"
        style={{ margin: "0 1px", padding: "3px 5px", flexShrink: 0 }}
      >
        <PlusIcon />
      </button>
      {/* Right: split + zoom + close pane buttons */}
      <div style={{ display: "flex", alignItems: "center", gap: 2, paddingRight: 6, flexShrink: 0 }}>
        {onSplitRight && (
          <button className="pane-action-btn" onClick={onSplitRight} title="Split right">
            <SplitRightIcon />
          </button>
        )}
        {onSplitDown && (
          <button className="pane-action-btn" onClick={onSplitDown} title="Split down">
            <SplitDownIcon />
          </button>
        )}
        {onZoomToggle && (
          <button
            className="pane-action-btn"
            onClick={onZoomToggle}
            title={isZoomed ? "Restore pane (Ctrl+Shift+Enter)" : "Zoom pane (Ctrl+Shift+Enter)"}
          >
            {isZoomed ? <MinimizeIcon /> : <MaximizeIcon />}
          </button>
        )}
        {onClose && (
          <button className="pane-action-btn" onClick={onClose} title="Close pane">
            <CloseIcon size={11} />
          </button>
        )}
      </div>
      </div>{/* end tab pills row */}
    </div>
  );
});
