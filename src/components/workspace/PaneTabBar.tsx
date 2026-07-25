import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { clampMenuPosition } from "../../lib/menuPosition";
import { useShallow } from "zustand/react/shallow";
import type { Pane, PaneTab } from "../../types";
import { getAgent, getDefaultAgent } from "../../lib/agents";
import { usePaneMetadataStore } from "../../stores/workspaceStore";
import type { PaneMetadata } from "../../stores/paneMetadataStore";
import { deriveEffectiveStatus, type EffectiveStatus } from "../../lib/notificationStatus";
import { usePaneDragSource } from "../../hooks/usePaneDragSource";
import { useSavepointPublish } from "../../hooks/useSavepointPublish";
import { useSavepointDragStore } from "../../stores/savepointDragStore";
import { focusController } from "../../lib/focusController";
import { useWorkspaceLayoutStore } from "../../stores/workspaceLayoutStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useToastStore } from "../../stores/toastStore";
import { useOnlineSavepointStore } from "../../stores/onlineSavepointStore";
import { onlineStrings } from "../online/onlineStrings";
import { PublishProgress } from "../online/PublishProgress";
import {
  isSavepointAgentKind,
  savepointIdentityKey,
  type SavepointAgentKind,
} from "../online/onlineSavepoints";

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
  hasTerminalBuffer: (sessionId: string) => boolean;
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

const BookmarkIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z"></path>
  </svg>
);

const PUBLISH_CWD_UNAVAILABLE = "Working directory is unavailable.";

export function shouldShowPublishButton(
  activeTab: PaneTab | undefined,
  activeMeta: Pick<PaneMetadata, "agentKind" | "agentSessionId" | "claudeSessionId"> | undefined,
): boolean {
  if (!activeTab || activeTab.type === "browser" || activeTab.type === "online") return false;
  // Deliberately not gated on processIsShell: the deepest-child heuristic
  // reports shell names while an agent runs tool subprocesses (for the whole
  // command duration with PowerShell tools), which made this button blink in
  // and out every polling tick. Publishing only reads the session jsonl, so
  // showing the button while a shell is momentarily foregrounded is harmless;
  // stale markers are cleared by the guarded metadata listener on real exit.
  return isSavepointAgentKind(activeMeta?.agentKind)
    || isSavepointAgentKind(activeTab.agentKind)
    || Boolean(activeMeta?.agentSessionId ?? activeMeta?.claudeSessionId
      ?? activeTab.agentSessionId ?? activeTab.claudeSessionId);
}

function resolvePublishIdentity(
  activeTab: PaneTab | undefined,
  activeMeta: Pick<PaneMetadata, "agentKind" | "agentSessionId" | "claudeSessionId"> | undefined,
): { kind: SavepointAgentKind; sessionId: string } | null {
  if (!activeTab) return null;
  const kind = isSavepointAgentKind(activeMeta?.agentKind)
    ? activeMeta.agentKind
    : isSavepointAgentKind(activeTab.agentKind)
      ? activeTab.agentKind
      : (activeMeta?.claudeSessionId || activeTab.claudeSessionId ? "claude" : null);
  if (!kind) return null;
  const sessionId = activeMeta?.agentSessionId
    ?? (kind === "claude" ? activeMeta?.claudeSessionId : undefined)
    ?? activeTab.agentSessionId
    ?? (kind === "claude" ? activeTab.claudeSessionId : undefined);
  return sessionId ? { kind, sessionId } : null;
}

export function shouldShowDeferredRestoreBadge(
  tab: PaneTab,
  isActive: boolean,
  hasBuffer: boolean,
): boolean {
  const isTerminal = tab.type === undefined || tab.type === "terminal";
  const hasSavedSession = Boolean(
    (tab.agentKind && tab.agentSessionId) || tab.claudeSessionId,
  );
  return isTerminal && !isActive && hasSavedSession && !hasBuffer;
}

export function isTabActivationKey(key: string): boolean {
  return key === "Enter" || key === " ";
}

export type PaneTabBarMode =
  | "full"
  | "slim"
  | "compact"
  | "compact3"
  | "compact2"
  | "compact1"
  | "micro";

export type PaneTabBarActionId =
  | "new-tab"
  | "publish"
  | "split-right"
  | "split-down"
  | "zoom"
  | "close";

export const PANE_TABBAR_SLIM_ENTER = 560;
export const PANE_TABBAR_SLIM_EXIT = 600;
export const PANE_TABBAR_COMPACT_ENTER = 360;
export const PANE_TABBAR_COMPACT_EXIT = 400;
export const PANE_TABBAR_COMPACT3_ENTER = 250;
export const PANE_TABBAR_COMPACT3_EXIT = 290;
export const PANE_TABBAR_COMPACT2_ENTER = 210;
export const PANE_TABBAR_COMPACT2_EXIT = 238;
export const PANE_TABBAR_COMPACT1_ENTER = 170;
export const PANE_TABBAR_COMPACT1_EXIT = 198;
export const PANE_TABBAR_MICRO_ENTER = 130;
export const PANE_TABBAR_MICRO_EXIT = 158;

const PANE_TABBAR_MODE_ORDER: readonly PaneTabBarMode[] = [
  "full",
  "slim",
  "compact",
  "compact3",
  "compact2",
  "compact1",
  "micro",
];

const PANE_TABBAR_BOUNDARIES = [
  { enter: PANE_TABBAR_SLIM_ENTER, exit: PANE_TABBAR_SLIM_EXIT },
  { enter: PANE_TABBAR_COMPACT_ENTER, exit: PANE_TABBAR_COMPACT_EXIT },
  { enter: PANE_TABBAR_COMPACT3_ENTER, exit: PANE_TABBAR_COMPACT3_EXIT },
  { enter: PANE_TABBAR_COMPACT2_ENTER, exit: PANE_TABBAR_COMPACT2_EXIT },
  { enter: PANE_TABBAR_COMPACT1_ENTER, exit: PANE_TABBAR_COMPACT1_EXIT },
  { enter: PANE_TABBAR_MICRO_ENTER, exit: PANE_TABBAR_MICRO_EXIT },
] as const;

const PANE_TABBAR_ACTION_ORDER: readonly PaneTabBarActionId[] = [
  "new-tab",
  "publish",
  "split-right",
  "split-down",
  "zoom",
  "close",
];

const PANE_TABBAR_PRIORITY_ACTIONS: readonly PaneTabBarActionId[] = [
  "publish",
  "split-right",
  "zoom",
  "close",
];

// Each boundary owns its collapse and restore thresholds. Walking the ordered
// table allows one measurement to cross multiple tiers without getting stuck.
export function resolvePaneTabBarMode(
  width: number,
  previous: PaneTabBarMode,
): PaneTabBarMode {
  if (width <= 0) return previous;
  let index = PANE_TABBAR_MODE_ORDER.indexOf(previous);

  while (
    index < PANE_TABBAR_BOUNDARIES.length
    && width < PANE_TABBAR_BOUNDARIES[index].enter
  ) {
    index += 1;
  }
  while (
    index > 0
    && width >= PANE_TABBAR_BOUNDARIES[index - 1].exit
  ) {
    index -= 1;
  }

  return PANE_TABBAR_MODE_ORDER[index];
}

export function resolvePaneTabBarActions(
  mode: PaneTabBarMode,
  { showPublish }: { showPublish: boolean },
): { visible: PaneTabBarActionId[]; overflow: PaneTabBarActionId[] } {
  const available = PANE_TABBAR_ACTION_ORDER.filter(
    (action) => action !== "publish" || showPublish,
  );

  if (mode === "full") return { visible: available, overflow: [] };
  if (mode === "micro") return { visible: [], overflow: available };

  const visiblePriorityCount = mode === "compact3"
    ? 3
    : mode === "compact2"
      ? 2
      : mode === "compact1"
        ? 1
        : PANE_TABBAR_PRIORITY_ACTIONS.length;
  const visiblePriorityActions = PANE_TABBAR_PRIORITY_ACTIONS.slice(-visiblePriorityCount);

  return {
    visible: available.filter((action) => visiblePriorityActions.includes(action)),
    overflow: available.filter((action) => !visiblePriorityActions.includes(action)),
  };
}

export function formatTabPosition(activeIndex: number, total: number): string {
  const safeTotal = Math.max(1, total);
  const position = activeIndex >= 0 && activeIndex < safeTotal ? activeIndex + 1 : 1;
  return `${position}/${safeTotal}`;
}

const publishPopoverButtonStyle: CSSProperties = {
  padding: "6px 11px",
  fontSize: 12,
  lineHeight: 1.4,
  borderRadius: 6,
  border: "1px solid var(--cmux-border)",
  background: "transparent",
  color: "var(--cmux-text)",
  cursor: "pointer",
};

const STATUS_CONFIG: Record<EffectiveStatus, { color: string; title: string; shape: "circle" | "diamond" }> = {
  working: { color: "var(--status-working)", title: "作業中", shape: "circle" },
  waiting: { color: "var(--status-waiting)", title: "入力待ち", shape: "diamond" },
  idle:    { color: "transparent",           title: "", shape: "circle" },
};

const AGENT_LABELS: Record<string, string> = {
  "shell-starter": "起動メニュー",
  "claude-code": "Claude Code",
  "gemini":      "Gemini",
  "codex":       "Codex",
  "aider":       "Aider",
  "shell":       "シェル",
};

const AGENT_KIND_LABELS: Record<string, string> = {
  "claude": "Claude Code",
  "codex": "Codex",
  "claude-codex": "Claude＋Codex",
};

export function resolveActiveAgentLabel(
  agentId: string | undefined,
  agentKind: string | undefined,
  fallbackName?: string,
): string {
  return AGENT_KIND_LABELS[agentKind ?? ""]
    ?? AGENT_LABELS[agentId ?? ""]
    ?? fallbackName
    ?? "シェル";
}

const tabRenameInputStyle: CSSProperties = {
  background: "var(--cmux-selected)",
  border: "1px solid var(--cmux-accent)",
  borderRadius: 4,
  padding: "1px 4px",
  fontSize: "inherit",
  fontFamily: "inherit",
  color: "inherit",
  outline: "none",
  flex: 1,
  width: "100%",
  minWidth: 0,
  userSelect: "text",
  WebkitUserSelect: "text",
};

const paneTabContextMenuStyle: CSSProperties = {
  position: "fixed",
  zIndex: 100,
  background: "var(--cmux-popover)",
  border: "1px solid var(--cmux-border)",
  borderRadius: 6,
  padding: "4px 0",
  boxShadow: "var(--cmux-shadow-pane-menu)",
  minWidth: 160,
  fontSize: 13,
};

const paneTabContextMenuItemStyle: CSSProperties = {
  padding: "6px 12px",
  cursor: "pointer",
  color: "var(--cmux-text)",
  userSelect: "none",
};

const paneTabContextMenuItemDisabledStyle: CSSProperties = {
  color: "var(--cmux-text-tertiary)",
  cursor: "default",
  opacity: 0.55,
};

function PaneTabContextMenuItem({
  children,
  disabled,
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <div
      role="menuitem"
      aria-disabled={disabled}
      onClick={() => {
        if (!disabled) onClick();
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.background = "var(--cmux-hover)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
      style={{
        ...paneTabContextMenuItemStyle,
        ...(disabled ? paneTabContextMenuItemDisabledStyle : {}),
      }}
    >
      {children}
    </div>
  );
}

function AgentStatusDot({ status }: { status: EffectiveStatus }) {
  const cfg = STATUS_CONFIG[status];
  if (status === "idle" || !cfg) return null;
  return (
    <span
      title={cfg.title}
      style={{
        width: cfg.shape === "diamond" ? 9 : 8,
        height: cfg.shape === "diamond" ? 9 : 8,
        borderRadius: cfg.shape === "diamond" ? 2 : "50%",
        background: cfg.color,
        boxShadow: "0 0 0 1px var(--cmux-bg-solid)",
        flexShrink: 0,
        transform: cfg.shape === "diamond" ? "rotate(45deg)" : undefined,
      }}
    />
  );
}

// Shared dropdown listing every tab of a pane. Rendered from the "⋯" button
// when the full tab strip overflows, and from the "n/m ▾" button in compact
// mode, so both entry points behave identically.
function PaneTabListMenu({
  pane,
  metadataBySession,
  getTabDisplayLabel,
  hasTerminalBuffer,
  onSelectTab,
  onRemoveTab,
  onCloseMenu,
}: {
  pane: Pane;
  metadataBySession: Record<string, PaneMetadata | undefined>;
  getTabDisplayLabel: (tab: PaneTab, isTabActive: boolean) => string;
  hasTerminalBuffer: (sessionId: string) => boolean;
  onSelectTab?: (tabId: string) => void;
  onRemoveTab?: (tabId: string) => void;
  onCloseMenu: () => void;
}) {
  // Fixed positioning + viewport clamping, matching the tab context menu.
  // An absolute menu anchored inside the tab bar gets clipped by pane
  // overflow once the pane is narrower than the menu (compact/micro modes).
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuWidth = Math.min(280, Math.max(180, window.innerWidth - 16));
  const menuMaxHeight = Math.min(320, Math.max(120, window.innerHeight - 24));
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const anchor = menuRef.current?.parentElement;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const height = Math.min(menuMaxHeight, menuRef.current?.offsetHeight ?? menuMaxHeight);
    setMenuPos(clampMenuPosition(rect.right - menuWidth, rect.bottom + 2, menuWidth, height));
  }, [menuMaxHeight, menuWidth]);
  return (
    <div
      ref={menuRef}
      role="menu"
      style={{
        position: "fixed",
        left: menuPos?.left ?? -9999,
        top: menuPos?.top ?? -9999,
        visibility: menuPos ? "visible" : "hidden",
        zIndex: 130,
        width: menuWidth,
        maxHeight: menuMaxHeight,
        overflowY: "auto",
        boxSizing: "border-box",
        padding: 6,
        border: "1px solid var(--cmux-border)",
        borderRadius: 7,
        background: "var(--cmux-popover)",
        boxShadow: "var(--cmux-shadow-pane-menu)",
      }}
    >
      <div style={{ padding: "4px 7px 7px", fontSize: 11, fontWeight: 650, color: "var(--cmux-text-secondary)" }}>
        All tabs
      </div>
      {pane.tabs.map((tab) => {
        const isTabActive = tab.id === pane.activeTabId;
        const tabMeta = metadataBySession[tab.sessionId];
        const status = deriveEffectiveStatus(tabMeta);
        const label = getTabDisplayLabel(tab, isTabActive);
        const showDeferredRestore = shouldShowDeferredRestoreBadge(
          tab,
          isTabActive,
          hasTerminalBuffer(tab.sessionId),
        );
        return (
          <div
            key={tab.id}
            role="menuitem"
            tabIndex={0}
            onClick={() => {
              onSelectTab?.(tab.id);
              onCloseMenu();
            }}
            onKeyDown={(event) => {
              if (event.currentTarget !== event.target || !isTabActivationKey(event.key)) return;
              event.preventDefault();
              onSelectTab?.(tab.id);
              onCloseMenu();
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              minHeight: 30,
              padding: "2px 5px 2px 8px",
              borderRadius: 5,
              background: isTabActive ? "var(--cmux-selected)" : "transparent",
              color: "var(--cmux-text)",
              cursor: "pointer",
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: status === "idle" ? "var(--cmux-text-tertiary)" : STATUS_CONFIG[status].color,
                flexShrink: 0,
              }}
            />
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }}>
              {label}
            </span>
            {showDeferredRestore && (
              <span
                className="pane-tab-restore-badge is-label"
                title="未復元 — クリックで再開"
                aria-label="未復元 — クリックで再開"
                style={{
                  color: "var(--cmux-usage-warn)",
                  borderColor: "color-mix(in srgb, var(--cmux-usage-warn) 58%, var(--cmux-border))",
                }}
              >
                未復元
              </span>
            )}
            {pane.tabs.length > 1 && (
              <button
                className="pane-action-btn"
                type="button"
                title="Close tab"
                onClick={(event) => {
                  event.stopPropagation();
                  onRemoveTab?.(tab.id);
                }}
                style={{ padding: 3, flexShrink: 0 }}
              >
                <CloseIcon size={9} />
              </button>
            )}
          </div>
        );
      })}
    </div>
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
  hasTerminalBuffer,
}: PaneTabBarProps) {
  const showSplitDownButton = useSettingsStore((s) => s.showSplitDownButton);
  const showSplitRightButton = useSettingsStore((s) => s.showSplitRightButton);
  const tabMetadata = usePaneMetadataStore(useShallow((s) =>
    pane.tabs.map((tab) => s.metadata[tab.sessionId]),
  ));
  const tabLastLog = usePaneMetadataStore(useShallow((s) =>
    pane.tabs.map((tab) => s.lastLog[tab.sessionId]),
  ));
  const metadataBySession = useMemo(() => {
    const next: Record<string, typeof tabMetadata[number]> = {};
    pane.tabs.forEach((tab, index) => {
      next[tab.sessionId] = tabMetadata[index];
    });
    return next;
  }, [pane.tabs, tabMetadata]);
  const lastLogBySession = useMemo(() => {
    const next: Record<string, string | undefined> = {};
    pane.tabs.forEach((tab, index) => {
      next[tab.sessionId] = tabLastLog[index];
    });
    return next;
  }, [pane.tabs, tabLastLog]);
  const { beginPointerDrag, shouldSuppressClick } = usePaneDragSource();
  const savepointDropTabId = useSavepointDragStore((state) =>
    state.target?.mode === "paste"
      && state.target.workspaceId === workspaceId
      && state.target.paneId === pane.id
      ? state.target.tabId
      : null,
  );
  const setTabLabel = useWorkspaceLayoutStore((s) => s.setTabLabel);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const skipNextBlurCommitRef = useRef(false);
  const [contextMenu, setContextMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const [contextMenuPos, setContextMenuPos] = useState({ left: 0, top: 0 });
  const [publishPopoverOpen, setPublishPopoverOpen] = useState(false);
  const [publishSummary, setPublishSummary] = useState("");
  const publishPopoverRef = useRef<HTMLDivElement>(null);
  const tabStripRef = useRef<HTMLDivElement>(null);
  const tabPillRefs = useRef(new Map<string, HTMLDivElement>());
  const [tabsOverflowing, setTabsOverflowing] = useState(false);
  const [allTabsOpen, setAllTabsOpen] = useState(false);
  const allTabsMenuRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [barMode, setBarMode] = useState<PaneTabBarMode>("full");
  const [kebabOpen, setKebabOpen] = useState(false);
  const kebabRef = useRef<HTMLDivElement>(null);

  // Derive active tab's agent status for the status bar
  const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId);
  const activeMeta = activeTab ? metadataBySession[activeTab.sessionId] : undefined;
  const showPublishButton = shouldShowPublishButton(activeTab, activeMeta);
  const renderMode: PaneTabBarMode = !activeTab && barMode !== "full" && barMode !== "slim"
    ? "full"
    : barMode;
  const { visible: visibleActions, overflow: overflowActions } = resolvePaneTabBarActions(
    renderMode,
    { showPublish: showPublishButton },
  );
  const publishIdentity = resolvePublishIdentity(activeTab, activeMeta);
  const agentSessionId = publishIdentity?.sessionId;
  const agentKind = publishIdentity?.kind;
  const publishIdentityKey = publishIdentity
    ? savepointIdentityKey(publishIdentity.kind, publishIdentity.sessionId)
    : null;
  const {
    state: { publishing, stage: publishStage, result: publishResult },
    run: runSavepointPublish,
  } = useSavepointPublish({ mode: "single", identity: publishIdentityKey });
  const published = useOnlineSavepointStore((state) =>
    publishIdentityKey ? state.publishedSessionIds[publishIdentityKey] === true : false,
  );
  const activeStatus: EffectiveStatus = deriveEffectiveStatus(activeMeta);
  const activeLastLog = activeTab ? lastLogBySession[activeTab.sessionId] : undefined;
  const activeAgentLabel = activeTab
    ? resolveActiveAgentLabel(
        activeTab.agentId,
        activeMeta?.agentKind ?? activeTab.agentKind,
        getAgent(activeTab.agentId)?.name,
      )
    : "シェル";
  const showStatusBar = activeStatus !== "idle";
  const statusCfg = STATUS_CONFIG[activeStatus];
  const paneDragLabel = activeMeta?.processTitle ?? activeTab?.label ?? activeAgentLabel;

  const getTabDisplayLabel = useCallback((tab: PaneTab, isTabActive: boolean) => {
    const agent = getAgent(tab.agentId) ?? getDefaultAgent();
    const tabMeta = metadataBySession[tab.sessionId];
    const tabProcessTitle = tabMeta?.processTitle;
    const tabCwd = tabMeta?.cwd;
    return tab.label
      ?? (tabProcessTitle
          ? tabProcessTitle
          : (isTabActive && tabCwd ? tabCwd.split("/").pop() || agent.name : agent.name));
  }, [metadataBySession]);

  useEffect(() => {
    if (!editingTabId) return;
    const timeoutId = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [editingTabId]);

  useEffect(() => {
    if (!contextMenu) return;
    const onMouseDown = (event: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(event.target as Node)) {
        setContextMenu(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setContextMenu(null);
    };
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [contextMenu]);

  useLayoutEffect(() => {
    if (!contextMenu || !contextMenuRef.current) return;
    const rect = contextMenuRef.current.getBoundingClientRect();
    const { left, top } = clampMenuPosition(contextMenu.x, contextMenu.y, rect.width, rect.height);
    setContextMenuPos((prev) =>
      prev.left === left && prev.top === top ? prev : { left, top },
    );
  }, [contextMenu]);

  useEffect(() => {
    if (!publishPopoverOpen) return;
    const onMouseDown = (event: MouseEvent) => {
      if (publishPopoverRef.current && !publishPopoverRef.current.contains(event.target as Node)) {
        setPublishPopoverOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPublishPopoverOpen(false);
    };
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [publishPopoverOpen]);

  useEffect(() => {
    if (!allTabsOpen) return;
    const onMouseDown = (event: MouseEvent) => {
      if (allTabsMenuRef.current && !allTabsMenuRef.current.contains(event.target as Node)) {
        setAllTabsOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAllTabsOpen(false);
    };
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [allTabsOpen]);

  // Adaptive layout progressively folds low-priority actions, then the tab
  // strip, then priority actions while preserving usable hit targets.
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const measure = () => setBarMode((prev) => resolvePaneTabBarMode(bar.clientWidth, prev));
    const frame = window.requestAnimationFrame(measure);
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (overflowActions.length === 0) setKebabOpen(false);
  }, [overflowActions.length]);

  useEffect(() => {
    if (!kebabOpen) return;
    const onMouseDown = (event: MouseEvent) => {
      if (kebabRef.current && !kebabRef.current.contains(event.target as Node)) {
        setKebabOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setKebabOpen(false);
    };
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [kebabOpen]);

  useEffect(() => {
    const strip = tabStripRef.current;
    if (!strip) {
      setTabsOverflowing(false);
      return;
    }
    const measure = () => setTabsOverflowing(strip.scrollWidth > strip.clientWidth + 1);
    const frame = window.requestAnimationFrame(measure);
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    for (const child of strip.children) observer.observe(child);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [editingTabId, metadataBySession, pane.tabs, barMode]);

  useEffect(() => {
    const strip = tabStripRef.current;
    if (!strip) return;
    const onWheel = (event: WheelEvent) => {
      if (strip.scrollWidth <= strip.clientWidth + 1 || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      strip.scrollLeft += event.deltaY;
      event.preventDefault();
    };
    strip.addEventListener("wheel", onWheel, { passive: false });
    return () => strip.removeEventListener("wheel", onWheel);
  }, [barMode]);

  useEffect(() => {
    // Compact and micro modes reuse allTabsOpen for their "n/m ▾" dropdown;
    // only tab-strip modes auto-close when the strip stops overflowing.
    if (barMode !== "full" && barMode !== "slim") return;
    if (!tabsOverflowing) {
      setAllTabsOpen(false);
      return;
    }
    tabPillRefs.current.get(pane.activeTabId)?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }, [pane.activeTabId, tabsOverflowing, barMode]);

  const handlePublishSavepoint = useCallback(async (recordKind: "current" | "final" = "current") => {
    if (!activeTab || !agentKind || !agentSessionId || publishing) return;
    const cwd = metadataBySession[activeTab.sessionId]?.cwd ?? activeTab.cwd ?? pane.cwd;
    if (!cwd) {
      useToastStore.getState().pushToast(
        onlineStrings.publishErrorPrefix + PUBLISH_CWD_UNAVAILABLE,
        "error",
      );
      return;
    }
    try {
      const outcome = await runSavepointPublish({
        cwd,
        agentKind,
        agentSessionId,
        summary: publishSummary.trim() || undefined,
        recordKind,
        closedReason: recordKind === "final" ? "manual" : undefined,
      });
      if (!outcome.ok) throw outcome.error;
      const result = outcome.result;
      useToastStore.getState().pushToast(
        (recordKind === "final"
          ? onlineStrings.finalizeSuccess
          : (result.updated ? onlineStrings.publishSuccessUpdate : onlineStrings.publishSuccessNew))
          + (result.warnings.length > 0
            ? ` — ${result.warnings.length}${onlineStrings.publishWarningsSuffix}`
            : ""),
        "warning",
      );
      void useOnlineSavepointStore.getState().refresh();
      window.dispatchEvent(new CustomEvent("mycmux:savepoint-published"));
      setPublishSummary("");
    } catch (error) {
      const message = String(error);
      useToastStore.getState().pushToast(
        message.includes("Session transcript") && message.includes("not found")
          ? onlineStrings.publishNoTranscript
          : onlineStrings.publishErrorPrefix + message,
        "error",
      );
    }
  }, [activeTab, agentKind, agentSessionId, metadataBySession, pane.cwd, publishSummary, publishing, runSavepointPublish]);

  const startEditingTab = useCallback((tabId: string, label: string) => {
    setContextMenu(null);
    skipNextBlurCommitRef.current = false;
    setEditingTabId(tabId);
    setEditValue(label);
  }, []);

  const suppressNextTabClick = useCallback(() => {
    focusController.request("tab-rename", { action: "suppress-tab-click", suppressMs: 250 });
  }, []);

  const commitTabLabel = useCallback((tab: PaneTab) => {
    const trimmed = editValue.trim();
    const nextLabel = trimmed === "" ? undefined : trimmed;
    if (nextLabel !== tab.label) {
      setTabLabel(workspaceId, pane.id, tab.id, nextLabel);
    }
    setEditingTabId(null);
  }, [editValue, pane.id, setTabLabel, workspaceId]);

  const handleRenameContextTab = useCallback(() => {
    if (!contextMenu) return;
    const tab = pane.tabs.find((candidate) => candidate.id === contextMenu.tabId);
    if (!tab) {
      setContextMenu(null);
      return;
    }
    startEditingTab(tab.id, getTabDisplayLabel(tab, tab.id === pane.activeTabId));
  }, [contextMenu, getTabDisplayLabel, pane.activeTabId, pane.tabs, startEditingTab]);

  const handleResetContextTab = useCallback(() => {
    if (!contextMenu) return;
    setTabLabel(workspaceId, pane.id, contextMenu.tabId, undefined);
    setContextMenu(null);
  }, [contextMenu, pane.id, setTabLabel, workspaceId]);

  const contextTab = contextMenu
    ? pane.tabs.find((candidate) => candidate.id === contextMenu.tabId)
    : undefined;
  const canResetContextTabName = contextTab?.label !== undefined;

  const activeTabIndex = pane.tabs.findIndex((t) => t.id === pane.activeTabId);
  const activeTabLabel = activeTab ? getTabDisplayLabel(activeTab, true) : "";
  const isEditingActiveTab = activeTab ? editingTabId === activeTab.id : false;
  const activeNotificationCount = activeMeta?.notificationCount ?? 0;
  const activeWorkDoneCount = activeMeta?.workDoneCount ?? 0;
  const usesTabStrip = renderMode === "full" || renderMode === "slim";
  const usesCompactTabs = !usesTabStrip && activeTab !== undefined;
  const paneActions = (
    <>
      {visibleActions.includes("new-tab") && (
        <button
          className="pane-action-btn"
          onClick={() => onAddTab?.(getDefaultAgent().id, "terminal")}
          title="New terminal tab"
          style={{ margin: "0 1px", padding: "3px 5px", flexShrink: 0, order: 3 }}
        >
          <PlusIcon />
        </button>
      )}
      {(visibleActions.length > 0 || overflowActions.length > 0) && (
        <div style={{ display: "flex", alignItems: "center", gap: 2, paddingRight: 6, flexShrink: 0, order: 4 }}>
          {visibleActions.includes("publish") && showPublishButton && (
            <button
              className="pane-action-btn"
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                // The monitor reports agentKind before the session id resolves;
                // a silently-disabled button reads as "broken", so explain instead.
                if (!agentSessionId) {
                  useToastStore.getState().pushToast(onlineStrings.publishNoSession, "error");
                  return;
                }
                setPublishPopoverOpen(true);
              }}
              title={agentSessionId
                ? (published ? onlineStrings.publishButtonTitleUpdate : onlineStrings.publishButtonTitleNew)
                : onlineStrings.publishNoSession}
              style={{
                color: published ? "var(--cmux-accent)" : undefined,
                opacity: agentSessionId ? 1 : 0.55,
              }}
            >
              <BookmarkIcon />
            </button>
          )}
          {visibleActions.includes("split-right") && onSplitRight && showSplitRightButton && (
            <button className="pane-action-btn pane-tabbar-split" onClick={onSplitRight} title="Split right">
              <SplitRightIcon />
            </button>
          )}
          {visibleActions.includes("split-down") && onSplitDown && showSplitDownButton && (
            <button className="pane-action-btn pane-tabbar-split" onClick={onSplitDown} title="Split down">
              <SplitDownIcon />
            </button>
          )}
          {visibleActions.includes("zoom") && onZoomToggle && (
            <button
              className="pane-action-btn pane-tabbar-zoom"
              onClick={onZoomToggle}
              title={isZoomed ? "Restore pane (Ctrl+Shift+Enter)" : "Zoom pane (Ctrl+Shift+Enter)"}
            >
              {isZoomed ? <MinimizeIcon /> : <MaximizeIcon />}
            </button>
          )}
          {visibleActions.includes("close") && onClose && (
            <button className="pane-action-btn" onClick={onClose} title="Close pane">
              <CloseIcon size={11} />
            </button>
          )}
          {overflowActions.length > 0 && (
            <div ref={kebabRef} style={{ position: "relative", flexShrink: 0 }}>
              <button
                className="pane-action-btn"
                type="button"
                title="Pane actions"
                aria-label="Pane actions"
                aria-expanded={kebabOpen}
                onClick={(event) => {
                  event.stopPropagation();
                  setKebabOpen((open) => !open);
                }}
                style={{ margin: "0 1px", padding: "3px 6px", flexShrink: 0, fontSize: 14, lineHeight: 1 }}
              >
                ⋮
              </button>
              {kebabOpen && (
                <div
                  role="menu"
                  style={{
                    position: "absolute",
                    top: "calc(100% + 2px)",
                    right: 0,
                    zIndex: 130,
                    background: "var(--cmux-popover)",
                    border: "1px solid var(--cmux-border)",
                    borderRadius: 6,
                    padding: "4px 0",
                    boxShadow: "var(--cmux-shadow-pane-menu)",
                    minWidth: 160,
                    fontSize: 13,
                  }}
                >
                  {overflowActions.includes("new-tab") && (
                    <PaneTabContextMenuItem
                      onClick={() => {
                        setKebabOpen(false);
                        onAddTab?.(getDefaultAgent().id, "terminal");
                      }}
                    >
                      New terminal tab
                    </PaneTabContextMenuItem>
                  )}
                  {overflowActions.includes("publish") && showPublishButton && (
                    <PaneTabContextMenuItem
                      onClick={() => {
                        setKebabOpen(false);
                        if (!agentSessionId) {
                          useToastStore.getState().pushToast(onlineStrings.publishNoSession, "error");
                          return;
                        }
                        setPublishPopoverOpen(true);
                      }}
                    >
                      {published ? "Update savepoint…" : "Publish savepoint…"}
                    </PaneTabContextMenuItem>
                  )}
                  {overflowActions.includes("split-right") && onSplitRight && showSplitRightButton && (
                    <PaneTabContextMenuItem
                      onClick={() => {
                        setKebabOpen(false);
                        onSplitRight();
                      }}
                    >
                      Split right
                    </PaneTabContextMenuItem>
                  )}
                  {overflowActions.includes("split-down") && onSplitDown && showSplitDownButton && (
                    <PaneTabContextMenuItem
                      onClick={() => {
                        setKebabOpen(false);
                        onSplitDown();
                      }}
                    >
                      Split down
                    </PaneTabContextMenuItem>
                  )}
                  {overflowActions.includes("zoom") && onZoomToggle && (
                    <PaneTabContextMenuItem
                      onClick={() => {
                        setKebabOpen(false);
                        onZoomToggle();
                      }}
                    >
                      {isZoomed ? "Restore pane" : "Zoom pane"}
                    </PaneTabContextMenuItem>
                  )}
                  {overflowActions.includes("close") && onClose && (
                    <PaneTabContextMenuItem
                      onClick={() => {
                        setKebabOpen(false);
                        onClose();
                      }}
                    >
                      Close pane
                    </PaneTabContextMenuItem>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );

  return (
    <>
    <div
      ref={barRef}
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
        background: "var(--pane-tabbar-bg, var(--cmux-surface))",
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
      {/* Tab pills row */}
      <div style={{ height: 36, display: "flex", alignItems: "center" }}>
      {usesTabStrip && (<>
      {/* Tab pills scroll independently so fixed actions always remain reachable. */}
      <div
        ref={tabStripRef}
        className="pane-tab-scroll"
        role="tablist"
        style={{
          display: "flex",
          alignItems: "center",
          flex: 1,
          overflowX: "auto",
          overflowY: "hidden",
          scrollbarWidth: "none",
          minWidth: 0,
        }}
      >
        {pane.tabs.map((tab) => {
          const isTabActive = tab.id === pane.activeTabId;
          const tabMeta = metadataBySession[tab.sessionId];
          const tabNotificationCount = tabMeta?.notificationCount ?? 0;
          const tabWorkDoneCount = tabMeta?.workDoneCount ?? 0;
          const tabEffectiveStatus = deriveEffectiveStatus(tabMeta);
          const label = getTabDisplayLabel(tab, isTabActive);
          const isEditingTab = editingTabId === tab.id;
          const isSavepointDropTarget = savepointDropTabId === tab.id;
          const showDeferredRestore = shouldShowDeferredRestoreBadge(
            tab,
            isTabActive,
            hasTerminalBuffer(tab.sessionId),
          );
          const tabTitle = showDeferredRestore
            ? `${label} — 未復元、クリックで再開`
            : label;

          return (
            <div
              key={tab.id}
              data-savepoint-drop-workspace-id={workspaceId}
              data-savepoint-drop-pane-id={pane.id}
              data-savepoint-drop-tab-id={tab.id}
              ref={(element) => {
                if (element) tabPillRefs.current.set(tab.id, element);
                else tabPillRefs.current.delete(tab.id);
              }}
              onPointerDown={(event) => {
                if (isEditingTab || event.button !== 0) return;
                if (event.detail >= 2) {
                  event.preventDefault();
                  event.stopPropagation();
                  suppressNextTabClick();
                  startEditingTab(tab.id, label);
                  return;
                }
                beginPointerDrag(event, {
                  kind: "tab",
                  workspaceId,
                  paneId: pane.id,
                  tabId: tab.id,
                  label,
                });
              }}
              onDoubleClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                suppressNextTabClick();
                startEditingTab(tab.id, label);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setContextMenu({ tabId: tab.id, x: e.clientX, y: e.clientY });
              }}
              onClick={(event) => {
                if (event.detail >= 2) {
                  event.preventDefault();
                  event.stopPropagation();
                  suppressNextTabClick();
                  startEditingTab(tab.id, label);
                  return;
                }
                if (isEditingTab || focusController.shouldSuppressTabClick() || shouldSuppressClick()) {
                  event.preventDefault();
                  event.stopPropagation();
                  return;
                }
                onSelectTab?.(tab.id);
              }}
              onKeyDown={(event) => {
                if (event.currentTarget !== event.target || !isTabActivationKey(event.key)) return;
                event.preventDefault();
                onSelectTab?.(tab.id);
              }}
              role="tab"
              aria-selected={isTabActive}
              tabIndex={0}
              title={tabTitle}
              aria-label={tabTitle}
              className={`pane-tab-pill ${isTabActive ? "is-active" : ""}${isSavepointDropTarget ? " is-savepoint-write-target" : ""}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "0 8px 0 7px",
                height: 36,
                maxWidth: 160,
                minWidth: isTabActive ? 120 : 64,
                cursor: isEditingTab ? "text" : "pointer",
                background: isTabActive ? "var(--cmux-selected)" : "transparent",
                borderRight: "1px solid var(--cmux-border)",
                borderBottom: isTabActive ? "2px solid var(--cmux-accent)" : "2px solid transparent",
                flexShrink: 1,
                transition: "background 0.1s",
              }}
            >
              {/* notification dot: amber = approval waiting, emerald = work done */}
              {tabNotificationCount > 0 && (
                <span title="Waiting for approval" style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--status-waiting)", boxShadow: "0 0 0 1px var(--cmux-bg-solid)", flexShrink: 0 }} />
              )}
              {tabNotificationCount === 0 && tabWorkDoneCount > 0 && (
                <span title="Work done" style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--status-done)", boxShadow: "0 0 0 1px var(--cmux-bg-solid)", flexShrink: 0 }} />
              )}
              <AgentStatusDot status={tabEffectiveStatus} />
              {/* folder icon */}
              <span style={{ color: isTabActive ? "var(--cmux-accent)" : "var(--cmux-text-tertiary)", flexShrink: 0 }}>
                <FolderIcon />
              </span>
              {showDeferredRestore && (
                <span
                  className="pane-tab-restore-badge"
                  title="未復元 — クリックで再開"
                  aria-label="未復元 — クリックで再開"
                  style={{
                    color: "var(--cmux-usage-warn)",
                    borderColor: "color-mix(in srgb, var(--cmux-usage-warn) 58%, var(--cmux-border))",
                  }}
                >
                  ▶
                </span>
              )}
              {/* label */}
              {isEditingTab ? (
                <input
                  ref={inputRef}
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onPointerDown={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                  onBlur={() => {
                    if (skipNextBlurCommitRef.current) {
                      skipNextBlurCommitRef.current = false;
                      return;
                    }
                    commitTabLabel(tab);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      e.stopPropagation();
                      commitTabLabel(tab);
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      skipNextBlurCommitRef.current = true;
                      setEditingTabId(null);
                    }
                  }}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  style={tabRenameInputStyle}
                />
              ) : (
                <span
                  className="pane-tab-label"
                  style={{
                    fontSize: 13,
                    fontWeight: isTabActive ? 600 : 400,
                    fontFamily: "'JetBrains Mono', 'Geist Mono', monospace",
                    color: isTabActive ? "var(--cmux-text)" : "var(--cmux-text-secondary)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    flex: 1,
                    minWidth: 0,
                  }}
                >
                  {label}
                </span>
              )}
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

      {tabsOverflowing && (
        <div ref={allTabsMenuRef} style={{ position: "relative", flexShrink: 0, order: 2 }}>
          <button
            className="pane-action-btn"
            type="button"
            title="All tabs"
            aria-label="All tabs"
            aria-expanded={allTabsOpen}
            onClick={(event) => {
              event.stopPropagation();
              setAllTabsOpen((open) => !open);
            }}
            style={{ margin: "0 1px", padding: "3px 6px", flexShrink: 0, fontSize: 16, lineHeight: 1 }}
          >
            ⋯
          </button>
          {allTabsOpen && (
            <PaneTabListMenu
              pane={pane}
              metadataBySession={metadataBySession}
              getTabDisplayLabel={getTabDisplayLabel}
              hasTerminalBuffer={hasTerminalBuffer}
              onSelectTab={onSelectTab}
              onRemoveTab={onRemoveTab}
              onCloseMenu={() => setAllTabsOpen(false)}
            />
          )}
        </div>
      )}

      {showStatusBar && (
        <div
          className="pane-tabbar-status"
          style={{
            height: 22,
            maxWidth: "min(360px, 38%)",
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "0 2px",
            marginLeft: 6,
            border: "none",
            borderRadius: 0,
            background: "transparent",
            overflow: "hidden",
            flexShrink: 1,
            minWidth: 120,
            order: 1,
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: statusCfg.shape === "diamond" ? 2 : "50%",
              background: statusCfg.color,
              transform: statusCfg.shape === "diamond" ? "rotate(45deg)" : undefined,
              flexShrink: 0,
            }}
          />
          <span style={{ fontSize: 11, color: statusCfg.color, fontWeight: 600, flexShrink: 0, letterSpacing: "0.02em" }}>
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

      {paneActions}
      </>)}
      {usesCompactTabs && activeTab && (
        <>
          <div
            className="pane-tab-pill is-active pane-tab-compact"
            onPointerDown={(event) => {
              if (isEditingActiveTab || event.button !== 0) return;
              if (event.detail >= 2) {
                event.preventDefault();
                event.stopPropagation();
                suppressNextTabClick();
                startEditingTab(activeTab.id, activeTabLabel);
                return;
              }
              beginPointerDrag(event, {
                kind: "tab",
                workspaceId,
                paneId: pane.id,
                tabId: activeTab.id,
                label: activeTabLabel,
              });
            }}
            onDoubleClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              suppressNextTabClick();
              startEditingTab(activeTab.id, activeTabLabel);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setContextMenu({ tabId: activeTab.id, x: e.clientX, y: e.clientY });
            }}
            title={activeTabLabel}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              height: 36,
              padding: "0 5px 0 7px",
              flex: 1,
              minWidth: 0,
              cursor: isEditingActiveTab ? "text" : "default",
              borderBottom: "2px solid var(--cmux-accent)",
            }}
          >
            {activeNotificationCount > 0 && (
              <span title="Waiting for approval" style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--status-waiting)", boxShadow: "0 0 0 1px var(--cmux-bg-solid)", flexShrink: 0 }} />
            )}
            {activeNotificationCount === 0 && activeWorkDoneCount > 0 && (
              <span title="Work done" style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--status-done)", boxShadow: "0 0 0 1px var(--cmux-bg-solid)", flexShrink: 0 }} />
            )}
            <AgentStatusDot status={activeStatus} />
            {isEditingActiveTab ? (
              <input
                ref={inputRef}
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onPointerDown={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                onBlur={() => {
                  if (skipNextBlurCommitRef.current) {
                    skipNextBlurCommitRef.current = false;
                    return;
                  }
                  commitTabLabel(activeTab);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    e.stopPropagation();
                    commitTabLabel(activeTab);
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    skipNextBlurCommitRef.current = true;
                    setEditingTabId(null);
                  }
                }}
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                style={tabRenameInputStyle}
              />
            ) : (
              <span
                className="pane-tab-label"
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  fontFamily: "'JetBrains Mono', 'Geist Mono', monospace",
                  color: "var(--cmux-text)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  flex: 1,
                  minWidth: 0,
                }}
              >
                {activeTabLabel}
              </span>
            )}
          </div>
          <div ref={allTabsMenuRef} style={{ position: "relative", flexShrink: 0 }}>
            <button
              className="pane-action-btn"
              type="button"
              title="All tabs"
              aria-label={`All tabs (${formatTabPosition(activeTabIndex, pane.tabs.length)})`}
              aria-expanded={allTabsOpen}
              onClick={(event) => {
                event.stopPropagation();
                setAllTabsOpen((open) => !open);
              }}
              style={{ margin: "0 1px", padding: "3px 5px", flexShrink: 0, fontSize: 11, lineHeight: 1, whiteSpace: "nowrap" }}
            >
              {formatTabPosition(activeTabIndex, pane.tabs.length)} ▾
            </button>
            {allTabsOpen && (
              <PaneTabListMenu
                pane={pane}
                metadataBySession={metadataBySession}
                getTabDisplayLabel={getTabDisplayLabel}
                hasTerminalBuffer={hasTerminalBuffer}
                onSelectTab={onSelectTab}
                onRemoveTab={onRemoveTab}
                onCloseMenu={() => setAllTabsOpen(false)}
              />
            )}
          </div>
          {paneActions}
        </>
      )}
      </div>{/* end tab pills row */}
      {publishPopoverOpen && agentSessionId && (
        <div
          ref={publishPopoverRef}
          onPointerDown={(event) => event.stopPropagation()}
          style={{
            position: "absolute",
            top: "100%",
            right: 6,
            zIndex: 120,
            width: 280,
            boxSizing: "border-box",
            background: "var(--cmux-popover)",
            border: "1px solid var(--cmux-border)",
            borderRadius: 6,
            padding: 10,
            boxShadow: "var(--cmux-shadow-pane-menu)",
            color: "var(--cmux-text)",
          }}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void handlePublishSavepoint("current");
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>
              {published ? onlineStrings.publishDialogTitleUpdate : onlineStrings.publishDialogTitleNew}
            </div>
            <label style={{ display: "block", fontSize: 11, color: "var(--cmux-text-secondary)" }}>
              {onlineStrings.publishSummaryLabel}
              <input
                type="text"
                value={publishSummary}
                onChange={(event) => setPublishSummary(event.target.value)}
                placeholder={onlineStrings.publishSummaryPlaceholder}
                disabled={publishing}
                autoFocus
                style={{
                  display: "block",
                  width: "100%",
                  boxSizing: "border-box",
                  marginTop: 5,
                  padding: "7px 8px",
                  border: "1px solid var(--cmux-border)",
                  borderRadius: 5,
                  background: "var(--cmux-surface)",
                  color: "var(--cmux-text)",
                  outline: "none",
                }}
              />
            </label>
            <PublishProgress
              publishing={publishing}
              stage={publishStage}
              result={publishResult}
            />
            <div style={{ marginTop: 10, fontSize: 11, lineHeight: 1.55, color: "var(--cmux-text-tertiary)" }}>
              {onlineStrings.finalizeHint}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: 7, marginTop: 10 }}>
              <button
                type="button"
                disabled={publishing}
                onClick={() => setPublishPopoverOpen(false)}
                style={{ ...publishPopoverButtonStyle, order: 1 }}
              >
                {onlineStrings.publishCancel}
              </button>
              <button
                type="button"
                disabled={publishing}
                onClick={() => void handlePublishSavepoint("final")}
                style={{ ...publishPopoverButtonStyle, flexBasis: "100%", order: 0 }}
              >
                {onlineStrings.finalizeConfirm}
              </button>
              <button
                type="submit"
                disabled={publishing}
                style={{
                  ...publishPopoverButtonStyle,
                  order: 2,
                  border: 0,
                  background: "var(--cmux-accent)",
                  color: "white",
                  opacity: publishing ? 0.6 : 1,
                }}
              >
                {publishing
                  ? onlineStrings.publishInProgress
                  : (published ? onlineStrings.publishConfirmUpdate : onlineStrings.publishConfirmNew)}
              </button>
            </div>
          </form>
        </div>
      )}
      </div>
      {contextMenu && (
        <div
          ref={contextMenuRef}
          role="menu"
          style={{
            ...paneTabContextMenuStyle,
            top: contextMenuPos.top,
            left: contextMenuPos.left,
          }}
        >
          <PaneTabContextMenuItem onClick={handleRenameContextTab}>
            Rename
          </PaneTabContextMenuItem>
          <PaneTabContextMenuItem
            disabled={!canResetContextTabName}
            onClick={handleResetContextTab}
          >
            Reset name to auto
          </PaneTabContextMenuItem>
        </div>
      )}
    </>
  );
});
