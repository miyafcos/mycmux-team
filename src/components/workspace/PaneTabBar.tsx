import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { clampMenuPosition } from "../../lib/menuPosition";
import {
  ATTENTION_REASON_COLOR,
  ATTENTION_REASON_LABEL,
  unseenAttentionLabel,
} from "../../lib/attentionPresentation";
import { useShallow } from "zustand/react/shallow";
import type { Pane, PaneTab } from "../../types";
import { getAgent, getDefaultAgent } from "../../lib/agents";
import { getTabDisplayLabel } from "../../lib/tabDisplayLabel";
import { resolveDisplayAgentKind } from "../../lib/agentDisplayKind";
import { agentKindColor } from "../../lib/agentKindColors";
import { crsmCreateHandoff, duplicateAgentSession } from "../../lib/ipc";
import {
  buildClonedDuplicateSessionPaneOptions,
  buildDuplicateSessionPaneOptions,
  resolveDuplicateSessionSource,
} from "../../lib/duplicateSession";
import { usePaneMetadataStore, useWorkspaceListStore } from "../../stores/workspaceStore";
import type { PaneMetadata } from "../../stores/paneMetadataStore";
import { deriveDisplayStatus, type EffectiveStatus } from "../../lib/notificationStatus";
import { useDismissOnOutside } from "../../hooks/useDismissOnOutside";
import { usePaneDragSource } from "../../hooks/usePaneDragSource";
import { usePaneDragStore } from "../../stores/paneDragStore";
import { useSavepointPublish } from "../../hooks/useSavepointPublish";
import { useSavepointDragStore } from "../../stores/savepointDragStore";
import { focusController } from "../../lib/focusController";
import { useWorkspaceLayoutStore } from "../../stores/workspaceLayoutStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useToastStore } from "../../stores/toastStore";
import { useOnlineSavepointStore } from "../../stores/onlineSavepointStore";
import { onlineStrings } from "../online/onlineStrings";
import { PublishProgress } from "../online/PublishProgress";
import { AgentKindIcon } from "../icons/AgentIcons";
import {
  attentionCategory,
  attentionDetail,
  isBlockingAttention,
  isAttentionUnseen,
  resolveAttentionTabs,
  useSessionAttentionStore,
  type AttentionCategory,
  type SessionAttention,
} from "../../stores/sessionAttentionStore";
import {
  isSavepointAgentKind,
  notifySavepointPublished,
  savepointIdentityKey,
  savepointPublishErrorMessage,
  type SavepointAgentKind,
} from "../online/onlineSavepoints";

interface PaneTabBarProps {
  pane: Pane;
  workspaceId: string;
  hasNotification?: boolean;
  isZoomed?: boolean;
  isVisible?: boolean;
  onClose?: () => void;
  onSplitRight?: () => void;
  onSplitDown?: () => void;
  onZoomToggle?: () => void;
  onAddTab?: (agentId?: string, type?: PaneTab["type"]) => void;
  onRemoveTab?: (tabId: string) => void;
  onSelectTab?: (tabId: string) => void;
  hasTerminalBuffer: (sessionId: string) => boolean;
}

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

const DuplicateIcon = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <rect x="8" y="8" width="12" height="12" rx="2"></rect>
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"></path>
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

const PinIcon = ({ size = 12, filled = false }: { size?: number; filled?: boolean }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"}
       stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
       aria-hidden="true" focusable="false">
    <path d="M9 3h6l-1 5 3 3v2H7v-2l3-3-1-5Z" />
    <line x1="12" y1="13" x2="12" y2="21" />
  </svg>
);

const PUBLISH_CWD_UNAVAILABLE = "Working directory is unavailable.";
const HANDOFF_TIMEOUT_MS = 9000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

type AgentKindStyle = CSSProperties & {
  "--agent-kind-color"?: string;
  "--agent-kind-fg"?: string;
  "--agent-kind-bg"?: string;
};

export function shouldShowPublishButton(
  activeTab: PaneTab | undefined,
  activeMeta: Pick<PaneMetadata, "agentKind" | "agentSessionId" | "claudeSessionId"> | undefined,
): boolean {
  if (!activeTab || activeTab.type === "browser" || activeTab.type === "online") return false;
  if (activeMeta?.agentKind === "claude-codex" || activeTab.agentKind === "claude-codex") {
    return false;
  }
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

/** The mouse button browsers report for a middle click. */
export const MIDDLE_MOUSE_BUTTON = 1;
const PANE_TAB_CHIP_PREVIEW_MAX_WIDTH = 200;

export type PaneTabPresentation = "pill" | "chip";

export function resolvePaneTabPresentation(
  tabId: string,
  activeTabId: string | null | undefined,
): PaneTabPresentation {
  return tabId === activeTabId ? "pill" : "chip";
}

export function shouldShowChipPreview(hovered: boolean, dragActive: boolean): boolean {
  return hovered && !dragActive;
}

export function resolveChipPreviewDirection(
  chipLeft: number,
  containerLeft: number,
  containerRight: number,
  previewWidth: number,
): "right" | "left" {
  const available = containerRight - containerLeft;
  if (previewWidth >= available) return "right";
  return chipLeft + previewWidth <= containerRight ? "right" : "left";
}

export function shouldStartRenameOnDoubleClick(presentation: PaneTabPresentation): boolean {
  return presentation === "pill";
}

/**
 * Middle-clicking a tab pill closes it, the way a browser tab does.
 *
 * Declines while the pill is in inline-rename mode (the middle button belongs
 * to the text field then) and when the press landed on one of the pill's own
 * controls — the pin, duplicate and close buttons keep their own meaning.
 */
export function shouldCloseTabOnAuxClick(
  button: number,
  isEditing: boolean,
  onPillControl: boolean,
): boolean {
  return button === MIDDLE_MOUSE_BUTTON && !isEditing && !onPillControl;
}

/** True when `target` sits inside a control the pill hosts rather than the pill itself. */
export function isPillControlTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("button, input"));
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
  "split-right",
  "zoom",
  "close",
  "publish",
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

// Narrow modes drop the inline pin button entirely — they only have room for a
// static indicator. The dropdown row stays the always-available toggle surface.
export function shouldShowInlinePinControl(mode: PaneTabBarMode): boolean {
  return mode === "full" || mode === "slim" || mode === "compact" || mode === "compact3";
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

export type TabStatusIndicator = "error" | "waiting" | "working" | null;

export function resolveTabStatusIndicator({
  unreadAttentionCategory,
  notificationCount,
  displayStatus,
}: {
  unreadAttentionCategory: AttentionCategory | null;
  notificationCount: number;
  displayStatus: EffectiveStatus;
}): TabStatusIndicator {
  if (unreadAttentionCategory === "error") return "error";
  if (displayStatus === "waiting" || notificationCount > 0 || unreadAttentionCategory === "waiting") {
    return "waiting";
  }
  if (displayStatus === "working") return "working";
  return null;
}

const TAB_STATUS_INDICATOR_CONFIG: Record<Exclude<TabStatusIndicator, null>, { color: string; title: string }> = {
  error: { color: ATTENTION_REASON_COLOR.error, title: unseenAttentionLabel("error") },
  waiting: { color: ATTENTION_REASON_COLOR.waiting, title: unseenAttentionLabel("waiting") },
  working: { color: "var(--status-working)", title: "作業中" },
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
  "antigravity": "Antigravity",
};

const AGENT_KIND_BADGE_LABELS: Record<string, string> = {
  "claude": "Claude",
  "codex": "Codex",
  "claude-codex": "Hybrid",
  "antigravity": "Antigravity",
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

function TabStatusIndicatorDot({ indicator }: { indicator: TabStatusIndicator }) {
  if (!indicator) return null;
  const config = TAB_STATUS_INDICATOR_CONFIG[indicator];
  return (
    <span
      title={config.title}
      aria-label={config.title}
      role="img"
      style={{
        width: 5,
        height: 5,
        borderRadius: "50%",
        background: config.color,
        boxShadow: "0 0 0 1px var(--cmux-bg)",
        flexShrink: 0,
      }}
    />
  );
}

function TabAgentIcon({ kind, indicator }: { kind: string | null | undefined; indicator: TabStatusIndicator }) {
  if (!agentKindColor(kind)) return null;
  return (
    <span style={{ position: "relative", display: "inline-flex", width: 14, height: 14, flexShrink: 0 }}>
      <AgentKindIcon kind={kind} size={14} />
      {indicator && (
        <span
          title={TAB_STATUS_INDICATOR_CONFIG[indicator].title}
          aria-label={TAB_STATUS_INDICATOR_CONFIG[indicator].title}
          role="img"
          style={{
            position: "absolute",
            right: -1,
            bottom: -1,
            width: 5,
            height: 5,
            borderRadius: "50%",
            background: TAB_STATUS_INDICATOR_CONFIG[indicator].color,
            boxShadow: "0 0 0 1px var(--cmux-bg)",
          }}
        />
      )}
    </span>
  );
}

function AttentionUnreadDot({ category }: { category: AttentionCategory | null }) {
  if (!category) return null;
  const color = ATTENTION_REASON_COLOR[category];
  const label = unseenAttentionLabel(category);
  return (
    <span
      key={category}
      className="cmux-badge-pop"
      title={label}
      aria-label={label}
      role="img"
      style={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        border: `2px solid ${color}`,
        background: "transparent",
        boxSizing: "border-box",
        flexShrink: 0,
      }}
    />
  );
}

export interface PaneTabMenuRow {
  tab: PaneTab;
  category: AttentionCategory | null;
  /** Hoisted to the top because the session needs attention. */
  hoisted: boolean;
  /** The pane's user-pinned tab (`Pane.pinnedTabId`). */
  isPinned: boolean;
}

// One list, not two. The previous two-section menu listed every attention tab a
// second time under "全タブ", so a pane with four busy tabs showed eight rows
// and the reader had to diff them. Attention tabs are hoisted to the top in
// occurrence order and marked; everything else keeps its tab-strip order.
// The user-pinned tab outranks attention and is extracted before hoisting, so
// it leads the list and still appears exactly once.
export function resolvePaneTabMenuRows(
  tabs: PaneTab[],
  attentionBySession: Record<string, SessionAttention | undefined>,
  seenAttentionByTab: Map<string, string>,
  pinnedTabId?: string,
): PaneTabMenuRow[] {
  const pinnedTab = pinnedTabId
    ? tabs.find((tab) => tab.id === pinnedTabId)
    : undefined;
  const rest = pinnedTab ? tabs.filter((tab) => tab.id !== pinnedTab.id) : tabs;
  const attention = resolveAttentionTabs(rest, attentionBySession, seenAttentionByTab)
    .filter(({ category }) => isBlockingAttention(category));
  const hoistedIds = new Set(attention.map(({ tab }) => tab.id));
  const pinnedRow: PaneTabMenuRow[] = pinnedTab
    ? [{
        tab: pinnedTab,
        category: attentionCategory(pinnedTab.id, attentionBySession[pinnedTab.sessionId], seenAttentionByTab),
        hoisted: false,
        isPinned: true,
      }]
    : [];
  return [
    ...pinnedRow,
    ...attention.map(({ tab, category }) => ({ tab, category, hoisted: true, isPinned: false })),
    ...rest
      .filter((tab) => !hoistedIds.has(tab.id))
      .map((tab) => ({ tab, category: null, hoisted: false, isPinned: false })),
  ];
}

// Prefer aligning the menu's right edge with the trigger, but fall back to
// left-alignment when that would push it off the left edge — otherwise a narrow
// pane's menu lands under an unrelated part of the window.
export function resolvePaneTabMenuLeft(
  anchorLeft: number,
  anchorRight: number,
  menuWidth: number,
): number {
  const rightAligned = anchorRight - menuWidth;
  return rightAligned >= 8 ? rightAligned : anchorLeft;
}

export function shouldMarkAttentionSeen(
  isVisible: boolean,
  tabId: string | undefined,
  attentionId: string | null | undefined,
): boolean {
  return Boolean(isVisible && tabId && attentionId);
}

// Shared dropdown listing every tab of a pane. Rendered from the "⋯" button
// when the full tab strip overflows, and from the "n/m ▾" button in compact
// mode, so both entry points behave identically.
function PaneTabListMenu({
  pane,
  metadataBySession,
  attentionBySession,
  seenAttentionByTab,
  getTabDisplayLabel,
  hasTerminalBuffer,
  onSelectTab,
  onRemoveTab,
  onTogglePin,
  onCloseMenu,
}: {
  pane: Pane;
  metadataBySession: Record<string, PaneMetadata | undefined>;
  attentionBySession: Record<string, SessionAttention | undefined>;
  seenAttentionByTab: Map<string, string>;
  getTabDisplayLabel: (tab: PaneTab, isTabActive: boolean) => string;
  hasTerminalBuffer: (sessionId: string) => boolean;
  onSelectTab?: (tabId: string) => void;
  onRemoveTab?: (tabId: string) => void;
  onTogglePin: (tabId: string) => void;
  onCloseMenu: () => void;
}) {
  // Fixed positioning + viewport clamping, matching the tab context menu.
  // An absolute menu anchored inside the tab bar gets clipped by pane
  // overflow once the pane is narrower than the menu (compact/micro modes).
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuWidth = Math.min(300, Math.max(200, window.innerWidth - 16));
  const menuMaxHeight = Math.min(360, Math.max(120, window.innerHeight - 24));
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const anchor = menuRef.current?.parentElement;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const height = Math.min(menuMaxHeight, menuRef.current?.offsetHeight ?? menuMaxHeight);
    setMenuPos(clampMenuPosition(
      resolvePaneTabMenuLeft(rect.left, rect.right, menuWidth),
      rect.bottom + 6,
      menuWidth,
      height,
    ));
  }, [menuMaxHeight, menuWidth]);
  const menuRows = resolvePaneTabMenuRows(
    pane.tabs,
    attentionBySession,
    seenAttentionByTab,
    pane.pinnedTabId,
  );
  // The pinned row leads the same top group the hoisted rows form, so the
  // separator sits below both.
  const topGroupCount = menuRows.filter((row) => row.hoisted || row.isPinned).length;
  const renderTabRow = ({ tab, category, hoisted, isPinned }: PaneTabMenuRow, isLastHoisted: boolean) => {
    const isTabActive = tab.id === pane.activeTabId;
    const tabMeta = metadataBySession[tab.sessionId];
    const rowAgentKind = resolveDisplayAgentKind(
      tabMeta?.agentKind ?? tab.agentKind,
      tab.commandArgv,
    );
    const rowKindColor = agentKindColor(rowAgentKind);
    const status = deriveDisplayStatus(tabMeta);
    const label = getTabDisplayLabel(tab, isTabActive);
    const attention = attentionBySession[tab.sessionId];
    const unreadCategory = isAttentionUnseen(tab.id, attention, seenAttentionByTab)
      ? attentionCategory(tab.id, attention, seenAttentionByTab)
      : null;
    const blockingUnreadCategory = isBlockingAttention(unreadCategory) ? unreadCategory : null;
    const unreadLabel = blockingUnreadCategory ? unseenAttentionLabel(blockingUnreadCategory) : null;
    const detail = attentionDetail(attention);
    const reasonColor = ATTENTION_REASON_COLOR[category ?? "waiting"];
    const showDeferredRestore = shouldShowDeferredRestoreBadge(
      tab,
      isTabActive,
      hasTerminalBuffer(tab.sessionId),
    );
    return (
      <div
        key={tab.id}
        className="pane-tab-menu-row"
        role="menuitem"
        tabIndex={0}
        title={detail ?? label}
        aria-label={[
          label,
          rowKindColor ? AGENT_KIND_BADGE_LABELS[rowAgentKind ?? ""] : null,
          unreadLabel,
          detail,
        ].filter(Boolean).join(": ")}
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
          gap: 7,
          minHeight: hoisted && detail ? 44 : 32,
          padding: "2px 5px 2px 6px",
          marginBottom: isLastHoisted ? 6 : 0,
          borderRadius: 6,
          // A colored rail marks "needs attention" without a section header, so
          // the row keeps its place in the single ordered list.
          borderLeft: hoisted
            ? `3px solid ${reasonColor}`
            : "3px solid transparent",
          background: isTabActive
            ? "var(--cmux-selected)"
            : isPinned
              ? "color-mix(in srgb, var(--cmux-accent) 12%, transparent)"
              : "transparent",
          color: "var(--cmux-text)",
          cursor: "pointer",
        }}
      >
        <AttentionUnreadDot category={blockingUnreadCategory} />
        {isPinned && (
          <span style={{ color: "var(--cmux-accent-text)", display: "inline-flex", flexShrink: 0 }}>
            <PinIcon size={11} filled />
          </span>
        )}
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: status === "idle" ? "var(--cmux-text-tertiary)" : STATUS_CONFIG[status].color,
            flexShrink: 0,
          }}
        />
        {rowKindColor && (
          <AgentKindIcon kind={rowAgentKind} size={14} />
        )}
        {rowKindColor && (
          <span
            className="agent-kind-badge"
            style={{
              "--agent-kind-fg": rowKindColor.fg,
              "--agent-kind-bg": rowKindColor.bg,
            } as AgentKindStyle}
          >
            {AGENT_KIND_BADGE_LABELS[rowAgentKind ?? ""]}
          </span>
        )}
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }}>
            {label}
          </span>
          {hoisted && detail && (
            <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11, color: "var(--cmux-text-secondary)" }}>
              {detail}
            </span>
          )}
        </span>
        {category && (
          <span
            style={{
              flexShrink: 0,
              fontSize: "var(--cmux-font-size-xs)",
              lineHeight: 1.5,
              padding: "0 5px",
              borderRadius: 999,
              whiteSpace: "nowrap",
              color: reasonColor,
              border: `1px solid color-mix(in srgb, ${reasonColor} 45%, transparent)`,
              background: `color-mix(in srgb, ${reasonColor} 12%, transparent)`,
            }}
          >
            {ATTENTION_REASON_LABEL[category]}
          </span>
        )}
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
        <button
          className={`pane-action-btn pane-tab-menu-pin-btn${isPinned ? " is-pinned" : ""}`}
          type="button"
          title={isPinned ? "Unpin tab" : "Pin tab"}
          aria-label={isPinned ? "Unpin tab" : "Pin tab"}
          aria-pressed={isPinned}
          onClick={(event) => {
            event.stopPropagation();
            onTogglePin(tab.id);
          }}
          style={{ padding: 3, flexShrink: 0 }}
        >
          <PinIcon size={11} filled={isPinned} />
        </button>
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
  };
  return (
    <div
      ref={menuRef}
      className="cmux-popover-panel pane-tab-menu"
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
        borderRadius: 10,
        background: "var(--cmux-popover)",
        // Dropdown-strength elevation: the pane-menu shadow was too faint to
        // separate this from the pane borders it necessarily overlaps.
        boxShadow: "var(--cmux-shadow-dropdown)",
      }}
    >
      {menuRows.map((row, index) =>
        renderTabRow(row, topGroupCount > 0 && index === topGroupCount - 1),
      )}
    </div>
  );
}

export default memo(function PaneTabBar({
  pane,
  workspaceId,
  hasNotification,
  isZoomed,
  isVisible = true,
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
  const tabAttention = useSessionAttentionStore(useShallow((s) =>
    pane.tabs.map((tab) => s.attentionBySession[tab.sessionId]),
  ));
  const seenAttentionByTab = useSessionAttentionStore((s) => s.seenAttentionByTab);
  const metadataBySession = useMemo(() => {
    const next: Record<string, typeof tabMetadata[number]> = {};
    pane.tabs.forEach((tab, index) => {
      next[tab.sessionId] = tabMetadata[index];
    });
    return next;
  }, [pane.tabs, tabMetadata]);
  const attentionBySession = useMemo(() => {
    const next: Record<string, typeof tabAttention[number]> = {};
    pane.tabs.forEach((tab, index) => {
      next[tab.sessionId] = tabAttention[index];
    });
    return next;
  }, [pane.tabs, tabAttention]);
  const { beginPointerDrag, shouldSuppressClick } = usePaneDragSource();
  const chipDragActive = usePaneDragStore((state) => state.item !== null);
  // Insertion slot of an in-progress reorder over this pane's strip, or null.
  const tabInsertionIndex = usePaneDragStore((state) =>
    state.target?.kind === "tab-index"
      && state.target.workspaceId === workspaceId
      && state.target.paneId === pane.id
      ? state.target.index
      : null,
  );
  const savepointDropTabId = useSavepointDragStore((state) =>
    state.target?.mode === "paste"
      && state.target.workspaceId === workspaceId
      && state.target.paneId === pane.id
      ? state.target.tabId
      : null,
  );
  const setTabLabel = useWorkspaceLayoutStore((s) => s.setTabLabel);
  const togglePaneTabPin = useWorkspaceLayoutStore((s) => s.togglePaneTabPin);
  const addPaneToWorkspaceWithOptions = useWorkspaceLayoutStore(
    (s) => s.addPaneToWorkspaceWithOptions,
  );
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [previewTabId, setPreviewTabId] = useState<string | null>(null);
  const previewTimerRef = useRef<number | null>(null);
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
  const duplicateSessionLocksRef = useRef(new Set<string>());
  const [duplicatingTabIds, setDuplicatingTabIds] = useState<Set<string>>(() => new Set());

  // Derive active tab's agent status for the status bar
  const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId);
  const activeMeta = activeTab ? metadataBySession[activeTab.sessionId] : undefined;
  const activeAttention = activeTab ? attentionBySession[activeTab.sessionId] : undefined;
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
  const activeStatus: EffectiveStatus = deriveDisplayStatus(activeMeta);
  const activeAgentKind = resolveDisplayAgentKind(
    activeMeta?.agentKind ?? activeTab?.agentKind,
    activeTab?.commandArgv,
  );
  const activeKindColor = agentKindColor(activeAgentKind);
  const activeAgentLabel = activeTab
    ? resolveActiveAgentLabel(
        activeTab.agentId,
        activeAgentKind ?? undefined,
        getAgent(activeTab.agentId)?.name,
      )
    : "シェル";
  const paneDragLabel = activeMeta?.processTitle ?? activeTab?.label ?? activeAgentLabel;

  useEffect(() => {
    if (!activeTab || !activeAttention?.attentionId) return;
    if (!shouldMarkAttentionSeen(isVisible, activeTab.id, activeAttention.attentionId)) return;
    useSessionAttentionStore.getState().markSeen(activeTab.id, activeAttention.attentionId);
  }, [activeAttention?.attentionId, activeTab?.id, isVisible]);

  const displayTabLabel = useCallback(
    (tab: PaneTab, isTabActive: boolean) => getTabDisplayLabel(tab, isTabActive, metadataBySession),
    [metadataBySession],
  );

  const clearChipPreviewTimer = useCallback(() => {
    if (previewTimerRef.current !== null) {
      window.clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }
  }, []);

  useEffect(() => () => clearChipPreviewTimer(), [clearChipPreviewTimer]);

  useEffect(() => {
    clearChipPreviewTimer();
    setPreviewTabId(null);
  }, [clearChipPreviewTimer, pane.activeTabId]);

  useEffect(() => {
    if (!chipDragActive) return;
    clearChipPreviewTimer();
    setPreviewTabId(null);
  }, [chipDragActive, clearChipPreviewTimer]);

  const handleDuplicateSession = useCallback(async (
    tab: PaneTab,
    label: string,
  ): Promise<void> => {
    if (duplicateSessionLocksRef.current.has(tab.id)) return;

    const metadata = usePaneMetadataStore.getState().metadata[tab.sessionId];
    const source = resolveDuplicateSessionSource({
      metadata,
      metadataCwd: metadata?.cwd,
      tabCwd: tab.cwd,
      paneCwd: pane.cwd,
      label,
    });
    if (!source) {
      useToastStore.getState().pushToast(
        "Failed to duplicate session: live session metadata is unavailable.",
        "error",
      );
      return;
    }

    duplicateSessionLocksRef.current.add(tab.id);
    setDuplicatingTabIds((current) => new Set(current).add(tab.id));

    try {
      let paneOptions;
      try {
        paneOptions = buildClonedDuplicateSessionPaneOptions(
          source,
          await duplicateAgentSession(source.agentKind, source.agentSessionId, source.cwd),
        );
      } catch (cloneError) {
        const message = cloneError instanceof Error ? cloneError.message : String(cloneError);
        useToastStore.getState().pushToast(
          `セッションの複製に失敗しました (${message})。引き継ぎ方式で開きます。`,
          "warning",
        );
        paneOptions = buildDuplicateSessionPaneOptions(
          source,
          (await withTimeout(
            crsmCreateHandoff(
              source.agentSessionId,
              source.agentKind,
              source.agentKind,
              20,
            ),
            HANDOFF_TIMEOUT_MS,
            "CRSM handoff",
          )).path,
        );
      }
      const sourcePane = useWorkspaceListStore.getState()
        .getWorkspace(workspaceId)
        ?.panes.find((candidate) => candidate.id === pane.id);
      if (!sourcePane?.tabs.some((candidate) => candidate.id === tab.id)) {
        throw new Error("Source tab is no longer available.");
      }
      addPaneToWorkspaceWithOptions(
        workspaceId,
        pane.id,
        "right",
        paneOptions,
      );
      useToastStore.getState().pushToast("Session duplicated.", "info");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      useToastStore.getState().pushToast(
        `Failed to duplicate session: ${message}`,
        "error",
      );
    } finally {
      duplicateSessionLocksRef.current.delete(tab.id);
      setDuplicatingTabIds((current) => {
        const next = new Set(current);
        next.delete(tab.id);
        return next;
      });
    }
  }, [addPaneToWorkspaceWithOptions, pane.cwd, pane.id, workspaceId]);

  useEffect(() => {
    if (!editingTabId) return;
    const timeoutId = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [editingTabId]);

  useDismissOnOutside(Boolean(contextMenu), contextMenuRef, () => setContextMenu(null));

  useLayoutEffect(() => {
    if (!contextMenu || !contextMenuRef.current) return;
    const rect = contextMenuRef.current.getBoundingClientRect();
    const { left, top } = clampMenuPosition(contextMenu.x, contextMenu.y, rect.width, rect.height);
    setContextMenuPos((prev) =>
      prev.left === left && prev.top === top ? prev : { left, top },
    );
  }, [contextMenu]);

  useDismissOnOutside(publishPopoverOpen, publishPopoverRef, () => setPublishPopoverOpen(false));

  useDismissOnOutside(allTabsOpen, allTabsMenuRef, () => setAllTabsOpen(false));

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

  useDismissOnOutside(kebabOpen, kebabRef, () => setKebabOpen(false));

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
      notifySavepointPublished(outcome.result, recordKind);
      setPublishSummary("");
    } catch (error) {
      useToastStore.getState().pushToast(savepointPublishErrorMessage(error), "error");
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
    startEditingTab(tab.id, displayTabLabel(tab, tab.id === pane.activeTabId));
  }, [contextMenu, displayTabLabel, pane.activeTabId, pane.tabs, startEditingTab]);

  const handleResetContextTab = useCallback(() => {
    if (!contextMenu) return;
    setTabLabel(workspaceId, pane.id, contextMenu.tabId, undefined);
    setContextMenu(null);
  }, [contextMenu, pane.id, setTabLabel, workspaceId]);

  const handleToggleTabPin = useCallback((tabId: string) => {
    togglePaneTabPin(workspaceId, pane.id, tabId);
  }, [pane.id, togglePaneTabPin, workspaceId]);

  const handleTogglePinContextTab = useCallback(() => {
    if (!contextMenu) return;
    togglePaneTabPin(workspaceId, pane.id, contextMenu.tabId);
    setContextMenu(null);
  }, [contextMenu, pane.id, togglePaneTabPin, workspaceId]);

  const contextTab = contextMenu
    ? pane.tabs.find((candidate) => candidate.id === contextMenu.tabId)
    : undefined;
  const canResetContextTabName = contextTab?.label !== undefined;
  const isContextTabPinned = contextTab !== undefined && contextTab.id === pane.pinnedTabId;

  const activeTabIndex = pane.tabs.findIndex((t) => t.id === pane.activeTabId);
  const activeTabLabel = activeTab ? displayTabLabel(activeTab, true) : "";
  const isEditingActiveTab = activeTab ? editingTabId === activeTab.id : false;
  const activeNotificationCount = activeMeta?.notificationCount ?? 0;
  const activeUnreadCategory = activeTab
    && isAttentionUnseen(activeTab.id, activeAttention, seenAttentionByTab)
    ? attentionCategory(activeTab.id, activeAttention, seenAttentionByTab)
    : null;
  const activeBlockingUnreadCategory = isBlockingAttention(activeUnreadCategory)
    ? activeUnreadCategory
    : null;
  const activeUnreadLabel = activeAttention?.kind === "rate_limited"
    ? "未確認の枠切れ"
    : activeBlockingUnreadCategory === "waiting"
    ? "未確認の入力待ち"
    : activeBlockingUnreadCategory === "error"
      ? "未確認のエラー"
        : null;
  const activeStatusIndicator = resolveTabStatusIndicator({
    unreadAttentionCategory: activeBlockingUnreadCategory,
    notificationCount: activeNotificationCount,
    displayStatus: activeStatus,
  });
  const usesTabStrip = renderMode === "full" || renderMode === "slim";
  const usesCompactTabs = !usesTabStrip && activeTab !== undefined;
  const previewTab = previewTabId ? pane.tabs.find((tab) => tab.id === previewTabId) : undefined;
  const previewElement = previewTab ? tabPillRefs.current.get(previewTab.id) : undefined;
  // Measured only while a preview is open: these force a layout, and this bar
  // re-renders on every session status tick.
  const previewChipRect = previewElement?.getBoundingClientRect();
  const previewBarRect = previewChipRect ? barRef.current?.getBoundingClientRect() : undefined;
  const previewDirection = previewChipRect && previewBarRect
    ? resolveChipPreviewDirection(
        previewChipRect.left,
        previewBarRect.left,
        previewBarRect.right,
        PANE_TAB_CHIP_PREVIEW_MAX_WIDTH,
      )
    : "right";
  const previewLeft = previewChipRect && previewBarRect
    ? previewChipRect.left - previewBarRect.left
    : 0;
  const previewRight = previewChipRect && previewBarRect
    ? previewChipRect.right - previewBarRect.left
    : 0;
  const previewMeta = previewTab ? metadataBySession[previewTab.sessionId] : undefined;
  const previewAgentKind = previewTab
    ? resolveDisplayAgentKind(previewMeta?.agentKind ?? previewTab.agentKind, previewTab.commandArgv)
    : undefined;
  const previewKindColor = agentKindColor(previewAgentKind);
  const showsInlinePinControl = shouldShowInlinePinControl(renderMode);
  const isActiveTabPinned = activeTab !== undefined && activeTab.id === pane.pinnedTabId;
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
                color: published ? "var(--cmux-accent-text)" : undefined,
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
        background: "var(--pane-tabbar-bg, var(--cmux-surface-raised))",
        borderBottom: hasNotification
          ? "1px solid color-mix(in srgb, var(--notification-color) 58%, transparent)"
          : "1px solid var(--cmux-border-hairline)",
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
        data-pane-tab-strip={pane.id}
        style={{
          display: "flex",
          alignItems: "center",
          flex: 1,
          overflowX: "auto",
          overflowY: "hidden",
          scrollbarWidth: "none",
          minWidth: 0,
        }}
        onScroll={() => setPreviewTabId(null)}
      >
        {pane.tabs.map((tab, tabIndex) => {
          const isTabActive = tab.id === pane.activeTabId;
          const tabMeta = metadataBySession[tab.sessionId];
          const tabAgentKind = resolveDisplayAgentKind(
            tabMeta?.agentKind ?? tab.agentKind,
            tab.commandArgv,
          );
          const tabKindColor = agentKindColor(tabAgentKind);
          const tabNotificationCount = tabMeta?.notificationCount ?? 0;
          const tabEffectiveStatus = deriveDisplayStatus(tabMeta);
          const canonicalAttention = attentionBySession[tab.sessionId];
          const canonicalUnreadCategory = isAttentionUnseen(
            tab.id,
            canonicalAttention,
            seenAttentionByTab,
          )
            ? attentionCategory(tab.id, canonicalAttention, seenAttentionByTab)
            : null;
          const canonicalBlockingUnreadCategory = isBlockingAttention(canonicalUnreadCategory)
            ? canonicalUnreadCategory
            : null;
          const canonicalDetail = attentionDetail(canonicalAttention);
          const canonicalUnreadLabel = canonicalAttention?.kind === "rate_limited"
            ? "未確認の枠切れ"
            : canonicalBlockingUnreadCategory === "waiting"
            ? "未確認の入力待ち"
            : canonicalBlockingUnreadCategory === "error"
              ? "未確認のエラー"
                : null;
          const tabStatusIndicator = resolveTabStatusIndicator({
            unreadAttentionCategory: canonicalBlockingUnreadCategory,
            notificationCount: tabNotificationCount,
            displayStatus: tabEffectiveStatus,
          });
          const label = displayTabLabel(tab, isTabActive);
          const presentation = resolvePaneTabPresentation(tab.id, pane.activeTabId);
          const isChip = presentation === "chip";
          const canRenameOnDoubleClick = shouldStartRenameOnDoubleClick(presentation);
          const isEditingTab = !isChip && editingTabId === tab.id;
          const isSavepointDropTarget = savepointDropTabId === tab.id;
          const canDuplicateSession = Boolean(tabMeta?.agentKind && tabMeta.agentSessionId);
          const isDuplicatingSession = duplicatingTabIds.has(tab.id);
          const duplicateSessionTitle = "セッションを複製";
          const isTabPinned = tab.id === pane.pinnedTabId;
          const showDeferredRestore = shouldShowDeferredRestoreBadge(
            tab,
            isTabActive,
            hasTerminalBuffer(tab.sessionId),
          );
          const tabTitle = canonicalDetail
            ? `${label} — ${canonicalDetail}`
            : showDeferredRestore
            ? `${label} — 未復元、クリックで再開`
            : label;

          return (
            <Fragment key={tab.id}>
            {tabInsertionIndex === tabIndex && (
              <span className="pane-tab-drop-indicator" aria-hidden="true" />
            )}
            <div
              data-tab-id={tab.id}
              data-savepoint-drop-workspace-id={workspaceId}
              data-savepoint-drop-pane-id={pane.id}
              data-savepoint-drop-tab-id={tab.id}
              ref={(element) => {
                if (element) tabPillRefs.current.set(tab.id, element);
                else tabPillRefs.current.delete(tab.id);
              }}
              onPointerDown={(event) => {
                if (isChip) {
                  clearChipPreviewTimer();
                  setPreviewTabId(null);
                }
                // Swallow the middle-button press so the webview never arms its
                // autoscroll cursor; the close itself runs on auxclick.
                if (!isEditingTab && event.button === MIDDLE_MOUSE_BUTTON) {
                  event.preventDefault();
                  return;
                }
                if (isEditingTab || event.button !== 0) return;
                if (canRenameOnDoubleClick && event.detail >= 2) {
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
                if (!canRenameOnDoubleClick) return;
                e.preventDefault();
                e.stopPropagation();
                suppressNextTabClick();
                startEditingTab(tab.id, label);
              }}
              onAuxClick={(event) => {
                if (!shouldCloseTabOnAuxClick(
                  event.button,
                  isEditingTab,
                  isPillControlTarget(event.target),
                )) return;
                event.preventDefault();
                event.stopPropagation();
                // Same handler as the pill's × so the close is recorded for
                // Ctrl+Shift+T.
                onRemoveTab?.(tab.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setContextMenu({ tabId: tab.id, x: e.clientX, y: e.clientY });
              }}
              onClick={(event) => {
                if (event.detail >= 2) {
                  if (canRenameOnDoubleClick) {
                    event.preventDefault();
                    event.stopPropagation();
                    suppressNextTabClick();
                    startEditingTab(tab.id, label);
                    return;
                  }
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
              title={isChip ? undefined : tabTitle}
              aria-label={[
                tabTitle,
                tabKindColor ? AGENT_KIND_BADGE_LABELS[tabAgentKind ?? ""] : null,
                canonicalUnreadLabel,
              ].filter(Boolean).join(": ")}
              className={`pane-tab-pill ${isChip ? "pane-tab-chip" : isTabActive ? "is-active" : ""}${isSavepointDropTarget ? " is-savepoint-write-target" : ""}` + (tabKindColor ? " has-agent-kind" : "") + (isTabPinned ? " is-pinned" : "")}
              style={isChip ? {
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                position: "relative",
                padding: 0,
                height: 36,
                width: 26,
                minWidth: 26,
                maxWidth: 26,
                flexShrink: 0,
                cursor: "pointer",
                background: "transparent",
                borderRight: "none",
                borderBottom: "2px solid transparent",
                "--agent-kind-color": tabKindColor?.fg,
              } as AgentKindStyle : {
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "0 8px 0 7px",
                height: 36,
                maxWidth: 160,
                // Widened to budget the always-mounted pin button.
                minWidth: isTabActive || canDuplicateSession ? 120 : 76,
                cursor: isEditingTab ? "text" : "pointer",
                background: isTabActive ? "var(--cmux-selected)" : "transparent",
                borderRight: "1px solid var(--cmux-border-hairline)",
                borderBottom: "2px solid transparent",
                flexShrink: 1,
                transition: "background 0.1s",
                "--agent-kind-color": tabKindColor?.fg,
              } as AgentKindStyle}
              onPointerEnter={isChip ? () => {
                clearChipPreviewTimer();
                if (!shouldShowChipPreview(true, chipDragActive)) return;
                previewTimerRef.current = window.setTimeout(() => {
                  setPreviewTabId(tab.id);
                }, 120);
              } : undefined}
              onPointerLeave={isChip ? () => {
                clearChipPreviewTimer();
                setPreviewTabId((id) => id === tab.id ? null : id);
              } : undefined}
            >
              {isChip ? <>
                <span className="pane-tab-chip-face">
                  {tabKindColor ? (
                    <TabAgentIcon kind={tabAgentKind} indicator={tabStatusIndicator} />
                  ) : (
                    <TabStatusIndicatorDot indicator={tabStatusIndicator} />
                  )}
                </span>
                {isTabPinned && (
                  <span className="pane-tab-chip-pin-badge" aria-hidden="true">
                    <PinIcon size={7} filled />
                  </span>
                )}
              </> : <>
              {tabKindColor ? (
                <TabAgentIcon kind={tabAgentKind} indicator={tabStatusIndicator} />
              ) : (
                <TabStatusIndicatorDot indicator={tabStatusIndicator} />
              )}
              {isTabPinned && (
                <span style={{ color: "var(--cmux-accent-text)", display: "inline-flex", flexShrink: 0 }}>
                  <PinIcon size={13} filled />
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
                  className={`pane-tab-label${showDeferredRestore ? " is-deferred-restore" : ""}`}
                  style={{
                    fontSize: 13,
                    fontWeight: isTabActive ? 600 : 400,
                    fontFamily: "var(--cmux-font-mono)",
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
              {/* Always mounted (opacity-hidden until hover/focus/pinned/active)
                  so the overflow ResizeObserver measures a stable width. */}
              <button
                type="button"
                className={`pane-action-btn pane-tab-pin-btn${isTabPinned ? " is-pinned" : ""}`}
                aria-label={isTabPinned ? "Unpin tab" : "Pin tab"}
                aria-pressed={isTabPinned}
                title={isTabPinned ? "Unpin tab" : "Pin tab"}
                onPointerDown={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  handleToggleTabPin(tab.id);
                }}
                style={{ padding: 3, flexShrink: 0 }}
              >
                <PinIcon />
              </button>
              {canDuplicateSession && (
                <button
                  type="button"
                  className="pane-action-btn"
                  disabled={isDuplicatingSession}
                  aria-busy={isDuplicatingSession || undefined}
                  aria-label={duplicateSessionTitle}
                  title={duplicateSessionTitle}
                  onPointerDown={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleDuplicateSession(tab, label);
                  }}
                  style={{ padding: 4, flexShrink: 0 }}
                >
                  <DuplicateIcon />
                </button>
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
              </>}
            </div>
            </Fragment>
          );
        })}
        {tabInsertionIndex === pane.tabs.length && (
          <span className="pane-tab-drop-indicator" aria-hidden="true" />
        )}
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
              attentionBySession={attentionBySession}
              seenAttentionByTab={seenAttentionByTab}
              getTabDisplayLabel={displayTabLabel}
              hasTerminalBuffer={hasTerminalBuffer}
              onSelectTab={onSelectTab}
              onRemoveTab={onRemoveTab}
              onTogglePin={handleToggleTabPin}
              onCloseMenu={() => setAllTabsOpen(false)}
            />
          )}
        </div>
      )}

      {paneActions}
      </>)}
      {usesCompactTabs && activeTab && (
        <>
          <div
            className={"pane-tab-pill is-active pane-tab-compact" + (activeKindColor ? " has-agent-kind" : "")}
            onPointerDown={(event) => {
              if (!isEditingActiveTab && event.button === MIDDLE_MOUSE_BUTTON) {
                event.preventDefault();
                return;
              }
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
            onAuxClick={(event) => {
              if (!shouldCloseTabOnAuxClick(
                event.button,
                isEditingActiveTab,
                isPillControlTarget(event.target),
              )) return;
              event.preventDefault();
              event.stopPropagation();
              onRemoveTab?.(activeTab.id);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setContextMenu({ tabId: activeTab.id, x: e.clientX, y: e.clientY });
            }}
            title={attentionDetail(activeAttention) ?? activeTabLabel}
            aria-label={[
              activeTabLabel,
              activeKindColor ? AGENT_KIND_BADGE_LABELS[activeAgentKind ?? ""] : null,
              activeUnreadLabel,
            ].filter(Boolean).join(": ")}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              height: 36,
              padding: "0 5px 0 7px",
              flex: 1,
              minWidth: 0,
              cursor: isEditingActiveTab ? "text" : "default",
              borderBottom: "2px solid transparent",
              "--agent-kind-color": activeKindColor?.fg,
            } as AgentKindStyle}
          >
            {activeKindColor ? (
              <TabAgentIcon kind={activeAgentKind} indicator={activeStatusIndicator} />
            ) : (
              <TabStatusIndicatorDot indicator={activeStatusIndicator} />
            )}
            {/* Narrow modes have no room for the toggle: show the state only,
                and let the dropdown row do the toggling. */}
            {!showsInlinePinControl && isActiveTabPinned && (
              <span
                title="Pinned tab"
                aria-label="Pinned tab"
                role="img"
                style={{ color: "var(--cmux-accent-text)", display: "inline-flex", flexShrink: 0 }}
              >
                <PinIcon size={12} filled />
              </span>
            )}
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
                  fontFamily: "var(--cmux-font-mono)",
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
            {showsInlinePinControl && (
              <button
                type="button"
                className={`pane-action-btn pane-tab-pin-btn${isActiveTabPinned ? " is-pinned" : ""}`}
                aria-label={isActiveTabPinned ? "Unpin tab" : "Pin tab"}
                aria-pressed={isActiveTabPinned}
                title={isActiveTabPinned ? "Unpin tab" : "Pin tab"}
                onPointerDown={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  handleToggleTabPin(activeTab.id);
                }}
                style={{ padding: 4, flexShrink: 0 }}
              >
                <PinIcon />
              </button>
            )}
            {activeMeta?.agentKind && activeMeta.agentSessionId && (
              <button
                type="button"
                className="pane-action-btn"
                disabled={duplicatingTabIds.has(activeTab.id)}
                aria-busy={duplicatingTabIds.has(activeTab.id) || undefined}
                aria-label="セッションを複製"
                title="セッションを複製"
                onPointerDown={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  void handleDuplicateSession(activeTab, activeTabLabel);
                }}
                style={{ padding: 4, flexShrink: 0 }}
              >
                <DuplicateIcon />
              </button>
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
                attentionBySession={attentionBySession}
                seenAttentionByTab={seenAttentionByTab}
                getTabDisplayLabel={displayTabLabel}
                hasTerminalBuffer={hasTerminalBuffer}
                onSelectTab={onSelectTab}
                onRemoveTab={onRemoveTab}
                onTogglePin={handleToggleTabPin}
                onCloseMenu={() => setAllTabsOpen(false)}
              />
            )}
          </div>
          {paneActions}
        </>
      )}
      </div>{/* end tab pills row */}
      {previewTab && previewChipRect && previewBarRect && (
        <div
          className={`pane-tab-chip-preview${previewDirection === "left" ? " is-left" : ""}`}
          aria-hidden="true"
          style={{
            position: "absolute",
            top: 4,
            ...(previewDirection === "right"
              ? { left: previewLeft }
              : { left: previewRight - PANE_TAB_CHIP_PREVIEW_MAX_WIDTH }),
            "--agent-kind-color": previewKindColor?.fg,
          } as AgentKindStyle}
        >
          {previewKindColor && <TabAgentIcon kind={previewAgentKind} indicator={null} />}
          <span style={{
            fontSize: "var(--cmux-font-size-xs)",
            fontFamily: "var(--cmux-font-mono)",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}>
            {displayTabLabel(previewTab, false)}
          </span>
        </div>
      )}
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
          <PaneTabContextMenuItem onClick={handleTogglePinContextTab}>
            {isContextTabPinned ? "Unpin tab" : "Pin tab"}
          </PaneTabContextMenuItem>
        </div>
      )}
    </>
  );
});
