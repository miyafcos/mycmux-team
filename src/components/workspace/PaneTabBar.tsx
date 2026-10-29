import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import type { RefObject } from "react";
import { usePopoverPosition } from "../../hooks/usePopoverPosition";
import { PaneTabRenameEditor } from "./PaneTabRenameEditor";
import {
  ATTENTION_REASON_COLOR,
  ATTENTION_REASON_LABEL,
  unseenAttentionLabel,
} from "../../lib/attentionPresentation";
import { useShallow } from "zustand/react/shallow";
import type { Pane, PaneTab } from "../../types";
import { getDefaultAgent } from "../../lib/agents";
import { getTabDisplayLabel, getTabDisplayFullLabel } from "../../lib/tabDisplayLabel";
import { resolveTabMark, tabMarkSource, type TabMark } from "../../lib/tabMark";
import { AGENT_DORMANT_LABEL, dormantAgentDescription } from "../../lib/agentDormancy";
import { openDormantCompletionRecord } from "../../lib/dormantCompletion";
import { crsmCreateHandoff, duplicateAgentSession } from "../../lib/ipc";
import {
  buildClonedDuplicateSessionPaneOptions,
  buildDuplicateSessionPaneOptions,
  resolveDuplicateSessionSource,
} from "../../lib/duplicateSession";
import { usePaneMetadataStore, useWorkspaceListStore } from "../../stores/workspaceStore";
import type { PaneMetadata, PaneVolatileMetadata } from "../../stores/paneMetadataStore";
import { deriveDisplayStatus, type EffectiveStatus } from "../../lib/notificationStatus";
import { useDismissOnOutside } from "../../hooks/useDismissOnOutside";
import { usePaneDragSource } from "../../hooks/usePaneDragSource";
import { useSavepointPublish } from "../../hooks/useSavepointPublish";
import { useSavepointDragStore } from "../../stores/savepointDragStore";
import { capturePaneFocusReturn, captureTemporaryFocusReturn, focusController } from "../../lib/focusController";
import { useWorkspaceLayoutStore } from "../../stores/workspaceLayoutStore";
import { useUiStore } from "../../stores/uiStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { isDeclaredTab } from "../../lib/tabLifecycle";
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
import { requestDashboard } from "../layout/openDashboardForTab";
import { TAB_RESTORE_CLOSED_EVENT } from "../layout/tabSweep";
import { peekClosedPane } from "../../stores/closedPaneStore";
import { paneTabMenuStrings, paneToolbarStrings, terminalPaneStrings } from "./terminalPaneStrings";
import { formatShortcutLabel } from "../../lib/keybindings";
import { useKeybindingStore } from "../../stores/keybindingStore";
import { TERMINAL_SEARCH_EVENT } from "../terminal/XTermWrapper";
import { TerminalHistoryEntry } from "../terminal/TerminalHistoryEntry";
import { displayedPaneShortcutSource } from "./webPaneShortcuts";
import { useLiveBriefStore } from "../../stores/liveBriefStore";
import { useSessionStateClock } from "../../hooks/useSessionStateClock";
import { isManualDoneMarkValid, sessionLastActivityAt } from "../../lib/manualDoneMark";
import { useStallStore } from "../../stores/stallStore";
import { presentSessionState, SESSION_STATE_LABELS } from "../../lib/sessionStatePresentation";

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
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
    <line x1="12" y1="3" x2="12" y2="21"></line>
    <line x1="12" y1="12" x2="21" y2="12"></line>
  </svg>
);

const SplitDownIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
    <line x1="3" y1="12" x2="21" y2="12"></line>
    <line x1="12" y1="12" x2="12" y2="21"></line>
  </svg>
);

const MaximizeIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="15 3 21 3 21 9"></polyline>
    <polyline points="9 21 3 21 3 15"></polyline>
    <line x1="21" y1="3" x2="14" y2="10"></line>
    <line x1="3" y1="21" x2="10" y2="14"></line>
  </svg>
);

const MinimizeIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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

const PinIcon = ({ size = 12, filled = false }: { size?: number; filled?: boolean }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"}
       stroke="currentColor" strokeWidth={24 / size} strokeLinecap="round" strokeLinejoin="round"
       aria-hidden="true" focusable="false">
    <path d="M9 3h6l-1 5 3 3v2H7v-2l3-3-1-5Z" />
    <line x1="12" y1="13" x2="12" y2="21" />
  </svg>
);

// The overflow control used to be the text character U+22EE, which put a
// font glyph in a row of vectors: different weight, different rhythm, and it
// followed the UI font rather than the icons beside it. Circles of radius 2
// on a 24 viewBox drawn at 12px are 2 device pixels across and sit on whole
// pixel boundaries, so the dots stay round instead of smearing.
const KebabIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
    <circle cx="12" cy="5" r="2" />
    <circle cx="12" cy="12" r="2" />
    <circle cx="12" cy="19" r="2" />
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
  if (!activeTab || activeTab.type === "browser" || activeTab.type === "online" || activeTab.type === "web"
    || activeTab.type === "launcher") return false;
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
  const metadataMatches = activeMeta?.agentKind === kind || (!activeMeta?.agentKind && kind === "claude");
  const tabMatches = activeTab.agentKind === kind || (!activeTab.agentKind && kind === "claude");
  const sessionId = (metadataMatches ? activeMeta?.agentSessionId : undefined)
    ?? (metadataMatches && kind === "claude" ? activeMeta?.claudeSessionId : undefined)
    ?? (tabMatches ? activeTab.agentSessionId : undefined)
    ?? (tabMatches && kind === "claude" ? activeTab.claudeSessionId : undefined);
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
  | "search"
  | "publish"
  | "split-right"
  | "split-down"
  | "zoom"
  | "dashboard"
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
  "search",
  "publish",
  "split-right",
  "split-down",
  "zoom",
  "dashboard",
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

  // `visible` is what sits on the heading's right edge and `overflow` is only
  // its complement; the kebab menu has its own gates and still lists the split
  // and close-place items while they are on the heading.
  // Splitting is how a new tab gets a place of its own, so the split buttons
  // came back to the heading on 2026-10-14, and the right-edge × closes the
  // place with its hidden tabs while the per-tab × beside the name is drawn at
  // every width. Each extra control costs the name about 22px, so they fold
  // from the outside in: the opt-in down split below slim, right split and the
  // place × below compact (the name keeps its 0.88.0 width in compact3), zoom
  // below compact3. A 9-column heading (about 181px) therefore still shows four
  // controls including the name.
  const atLeast = (tier: PaneTabBarMode) => PANE_TABBAR_MODE_ORDER.indexOf(mode) <= PANE_TABBAR_MODE_ORDER.indexOf(tier);
  const visible: PaneTabBarActionId[] = [
    ...(atLeast("compact") ? ["split-right" as const] : []),
    ...(atLeast("slim") ? ["split-down" as const] : []),
    ...(atLeast("compact3") ? ["zoom" as const] : []),
    ...(atLeast("compact") ? ["close" as const] : []),
  ];
  return { visible, overflow: available.filter((action) => !visible.includes(action)) };
}

export function formatHiddenTabCount(count: number, mode: PaneTabBarMode): string {
  return mode === "compact2" || mode === "compact1" || mode === "micro" ? `+${count}` : `裏 ${count}`;
}

/** Same severity order as the individual status dots. */
export function resolveHiddenTabStatus(indicators: readonly TabStatusIndicator[]): TabStatusIndicator {
  for (const indicator of ["error", "waiting", "working"] as const) {
    if (indicators.includes(indicator)) return indicator;
  }
  return null;
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
  "grok": "Grok Build",
  "antigravity": "Antigravity",
  "hermes": "Hermes",
  "omp": "Oh My Pi",
  "cursor": "Cursor",
};

export function resolveActiveAgentLabel(
  agentId: string | undefined,
  agentKind: string | null | undefined,
  fallbackName?: string,
): string {
  if (agentKind === null) return "シェル";
  return AGENT_KIND_LABELS[agentKind ?? ""]
    ?? AGENT_LABELS[agentId ?? ""]
    ?? fallbackName
    ?? "シェル";
}


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
  display: "block",
  width: "100%",
  border: 0,
  background: "transparent",
  font: "inherit",
  textAlign: "left",
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
  title,
  onClick,
  actionId,
}: {
  children: ReactNode;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
  actionId?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-pane-action={actionId}
      aria-disabled={disabled}
      title={title}
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
    </button>
  );
}

function handlePaneMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='menuitem'], [data-terminal-magnifier]"));
  if (items.length === 0) return;
  event.preventDefault();
  event.stopPropagation();
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  const delta = event.key === "ArrowDown" ? 1 : -1;
  items[(index + delta + items.length) % items.length]?.focus();
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

function TabAgentIcon({ mark, indicator }: { mark: TabMark; indicator: TabStatusIndicator }) {
  return (
    <span data-mark-source={mark.source} style={{ position: "relative", display: "inline-flex", width: 14, height: 14, flexShrink: 0, opacity: mark.dormant ? 0.45 : 1 }}>
      <AgentKindIcon kind={mark.kind} size={14} />
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
// second time under an all-tabs section, so a pane with four busy tabs showed eight rows
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

// Shared dropdown listing every tab of a pane, opened by the hidden-tab count.
function PaneTabListMenu({
  pane,
  workspaceId,
  menuRef,
  anchorRef,
  metadataBySession,
  volatileMetadataBySession,
  attentionBySession,
  seenAttentionByTab,
  getTabDisplayLabel,
  hasTerminalBuffer,
  onSelectTab,
  onRemoveTab,
  onTogglePin,
  onRenameTab,
  onReturnFocus,
  onLaunchDeclaredTab,
  onCloseMenu,
}: {
  pane: Pane;
  workspaceId: string;
  menuRef: RefObject<HTMLDivElement | null>;
  anchorRef: RefObject<HTMLButtonElement | null>;
  metadataBySession: Record<string, PaneMetadata | undefined>;
  volatileMetadataBySession: Record<string, PaneVolatileMetadata | undefined>;
  attentionBySession: Record<string, SessionAttention | undefined>;
  seenAttentionByTab: Map<string, string>;
  getTabDisplayLabel: (tab: PaneTab, isTabActive: boolean) => string;
  hasTerminalBuffer: (sessionId: string) => boolean;
  onSelectTab?: (tabId: string) => void;
  onRemoveTab?: (tabId: string) => void;
  onTogglePin: (tabId: string) => void;
  onRenameTab: (tabId: string, label: string) => void;
  onReturnFocus: () => void;
  onLaunchDeclaredTab: (tabId: string) => void;
  onCloseMenu: () => void;
}) {
  const menuPos = usePopoverPosition(true, menuRef, anchorRef);
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
    const declared = isDeclaredTab(tab);
    const tabMeta = metadataBySession[tab.sessionId];
    const rowLive = volatileMetadataBySession[tab.sessionId];
    const rowMark = resolveTabMark(tab, rowLive?.liveAgentKind, rowLive?.ptyAlive === true);
    const dormantDescription = declared ? undefined : dormantAgentDescription(rowMark);
    const status = deriveDisplayStatus(tabMeta, volatileMetadataBySession[tab.sessionId]);
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
        data-menu-tab-id={tab.id}
        role="menuitem"
        tabIndex={0}
        title={[getTabDisplayFullLabel(tab, isTabActive, metadataBySession, volatileMetadataBySession), dormantDescription ?? detail].filter(Boolean).join(" — ")}
        aria-label={[
          label,
          rowMark?.label ?? null,
          dormantDescription,
          unreadLabel,
          detail,
        ].filter(Boolean).join(": ")}
        onContextMenu={event => {
          event.preventDefault(); event.stopPropagation();
          onRenameTab(tab.id, label); onCloseMenu();
        }}
        onClick={() => {
          if (!openDormantCompletionRecord(tab, Boolean(dormantDescription))) onSelectTab?.(tab.id);
          if (declared) onLaunchDeclaredTab(tab.id);
          onCloseMenu();
        }}
        onKeyDown={(event) => {
          if (event.currentTarget !== event.target || !isTabActivationKey(event.key)) return;
          event.preventDefault();
          if (!openDormantCompletionRecord(tab, Boolean(dormantDescription))) onSelectTab?.(tab.id);
          if (declared) onLaunchDeclaredTab(tab.id);
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
        {rowMark && (
          <span style={{ opacity: rowMark.dormant ? 0.45 : 1 }}><AgentKindIcon kind={rowMark.kind} size={14} /></span>
        )}
        {rowMark && (
          <span
            className="agent-kind-badge"
            style={{
              "--agent-kind-fg": rowMark.color.fg,
              "--agent-kind-bg": rowMark.color.bg,
              opacity: rowMark.dormant ? 0.45 : 1,
            } as AgentKindStyle}
          >
            {rowMark.label}
            {dormantDescription ? `・${AGENT_DORMANT_LABEL}` : ""}
          </span>
        )}
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }}>
            {declared ? `＋ ${label}（まだ）` : label}
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
          type="button"
          className="pane-action-btn pane-tab-menu-rename-btn"
          title={paneTabMenuStrings.rename}
          aria-label={paneTabMenuStrings.rename}
          onPointerDown={event => event.stopPropagation()}
          onClick={event => {
            event.stopPropagation();
            onRenameTab(tab.id, label);
            onCloseMenu();
          }}
          style={{ padding: 3, flexShrink: 0 }}
        >
          {"\u270e"}
        </button>
        <button
          className={`pane-action-btn pane-tab-menu-pin-btn${isPinned ? " is-pinned" : ""}`}
          type="button"
          title={isPinned ? paneToolbarStrings.unpinTab : paneToolbarStrings.pinTab}
          aria-label={isPinned ? paneToolbarStrings.unpinTab : paneToolbarStrings.pinTab}
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
            title={paneToolbarStrings.closeTab}
            onClick={(event) => {
              event.stopPropagation();
              onReturnFocus();
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
      data-pane-focus-workspace-id={workspaceId}
      data-pane-focus-pane-id={pane.id}
      onPointerDown={event => event.stopPropagation()}
      onMouseDown={event => event.stopPropagation()}
      onClick={event => event.stopPropagation()}
      style={{
        position: "fixed",
        left: menuPos?.left ?? -9999,
        top: menuPos?.top ?? -9999,
        visibility: menuPos ? "visible" : "hidden",
        zIndex: 130,
        width: "min(300px, calc(100vw - 16px))",
        maxHeight: "min(360px, calc(100vh - 16px))",
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
  const declaredLaunchEnabled = useSettingsStore((s) => s.declaredLaunchEnabled);
  const tabMetadata = usePaneMetadataStore(useShallow((s) =>
    pane.tabs.map((tab) => s.metadata[tab.sessionId]),
  ));
  const tabVolatileMetadata = usePaneMetadataStore(useShallow((s) =>
    pane.tabs.map((tab) => s.volatileMetadata[tab.sessionId]),
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
  const volatileMetadataBySession = useMemo(() => {
    const next: Record<string, typeof tabVolatileMetadata[number]> = {};
    pane.tabs.forEach((tab, index) => {
      next[tab.sessionId] = tabVolatileMetadata[index];
    });
    return next;
  }, [pane.tabs, tabVolatileMetadata]);
  const attentionBySession = useMemo(() => {
    const next: Record<string, typeof tabAttention[number]> = {};
    pane.tabs.forEach((tab, index) => {
      next[tab.sessionId] = tabAttention[index];
    });
    return next;
  }, [pane.tabs, tabAttention]);
  const { beginPointerDrag, shouldSuppressClick } = usePaneDragSource();
  const savepointDropTabId = useSavepointDragStore((state) =>
    state.target?.mode === "paste"
      && state.target.workspaceId === workspaceId
      && state.target.paneId === pane.id
      ? state.target.tabId
      : null,
  );
  const setTabLabel = useWorkspaceLayoutStore((s) => s.setTabLabel);
  const togglePaneTabPin = useWorkspaceLayoutStore((s) => s.togglePaneTabPin);
  const launchDeclaredTab = useWorkspaceLayoutStore((s) => s.launchDeclaredTab);
  const addPaneToWorkspaceWithOptions = useWorkspaceLayoutStore(
    (s) => s.addPaneToWorkspaceWithOptions,
  );
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const renameEditorRef = useRef<HTMLDivElement>(null);
  const renameFocusReturnRef = useRef<ReturnType<typeof capturePaneFocusReturn> | null>(null);
  const [editValue, setEditValue] = useState("");
  const pendingTabClickRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [contextMenu, setContextMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const contextFocusReturnRef = useRef<ReturnType<typeof capturePaneFocusReturn> | null>(null);
  const [publishPopoverOpen, setPublishPopoverOpen] = useState(false);
  const [publishSummary, setPublishSummary] = useState("");
  const publishPopoverRef = useRef<HTMLDivElement>(null);
  const publishFocusReturnRef = useRef<ReturnType<typeof capturePaneFocusReturn> | null>(null);
  const tabPillRefs = useRef(new Map<string, HTMLDivElement>());
  const [allTabsOpen, setAllTabsOpen] = useState(false);
  const allTabsTriggerRef = useRef<HTMLButtonElement>(null);
  const allTabsFocusReturnRef = useRef<ReturnType<typeof capturePaneFocusReturn> | null>(null);
  const allTabsMenuRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [barMode, setBarMode] = useState<PaneTabBarMode>("full");
  const [kebabOpen, setKebabOpen] = useState(false);
  const kebabRef = useRef<HTMLDivElement>(null);
  const kebabTriggerRef = useRef<HTMLButtonElement>(null);
  const kebabMenuRef = useRef<HTMLDivElement>(null);
  const kebabFocusReturnRef = useRef<ReturnType<typeof capturePaneFocusReturn> | null>(null);
  const contextMenuPos = usePopoverPosition(Boolean(contextMenu), contextMenuRef, barRef, contextMenu);
  const kebabMenuPos = usePopoverPosition(kebabOpen, kebabMenuRef, kebabTriggerRef);
  const publishPopoverPos = usePopoverPosition(publishPopoverOpen, publishPopoverRef, barRef);
  useLayoutEffect(() => {
    setPortalTarget(barRef.current?.closest<HTMLElement>("[data-cmux-themed-root]") ?? document.body);
  }, []);
  useEffect(() => {
    if (isVisible) return;
    contextFocusReturnRef.current?.cancel(); contextFocusReturnRef.current = null;
    allTabsFocusReturnRef.current?.cancel(); allTabsFocusReturnRef.current = null;
    kebabFocusReturnRef.current?.cancel(); kebabFocusReturnRef.current = null;
    publishFocusReturnRef.current?.cancel(); publishFocusReturnRef.current = null;
    renameFocusReturnRef.current?.cancel(); renameFocusReturnRef.current = null;
    setEditingTabId(null);
    setContextMenu(null);
    setAllTabsOpen(false);
    setKebabOpen(false);
    setPublishPopoverOpen(false);
  }, [isVisible]);
  const canCloseWholePane = useWorkspaceListStore((state) =>
    (state.workspaces.find((workspace) => workspace.id === workspaceId)?.panes.length ?? 1) > 1,
  );
  const duplicateSessionLocksRef = useRef(new Set<string>());
  const [duplicatingTabIds, setDuplicatingTabIds] = useState<Set<string>>(() => new Set());

  // Derive active tab's agent status for the status bar
  const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId);
  const activeTabDeclared = Boolean(activeTab && isDeclaredTab(activeTab));
  const canSearchTerminal = Boolean(activeTab && !activeTabDeclared
    && (activeTab.type === undefined || activeTab.type === "terminal"));
  const handleSearchTerminal = () => {
    if (!canSearchTerminal || !activeTab) return;
    setKebabOpen(false);
    window.dispatchEvent(new CustomEvent(TERMINAL_SEARCH_EVENT, {
      detail: { sessionId: activeTab.sessionId },
    }));
  };
  const activeMeta = activeTab ? metadataBySession[activeTab.sessionId] : undefined;
  const activeVolatileMeta = activeTab ? volatileMetadataBySession[activeTab.sessionId] : undefined;
  const activeAttention = activeTab ? attentionBySession[activeTab.sessionId] : undefined;
  const activeSessionId = activeTab?.sessionId ?? "";
  const activeSignals = useSessionAttentionStore((state) => state.statusSignalsBySession[activeSessionId]);
  const activeBrief = useLiveBriefStore((state) => state.briefsBySession[activeSessionId]);
  const activeObservation = useLiveBriefStore((state) => state.observationsBySession[activeSessionId]);
  const activeDoneMark = useSessionAttentionStore((state) => state.doneMarkByTab.get(activeTab?.id ?? ""));
  const activeLastLogAt = usePaneMetadataStore((state) => state.lastLogAt[activeSessionId]);
  const activeStall = useStallStore((state) => state.entries[activeSessionId]);
  const stateNow = useSessionStateClock(isVisible && Boolean(activeTab) && !activeTabDeclared);
  const activePresentation = presentSessionState({ attention: activeAttention, signals: activeSignals,
    brief: activeBrief, observation: activeObservation, now: stateNow,
    identity: { sessionId: activeSessionId, agentKind: activeMeta?.agentKind ?? activeTab?.agentKind,
      agentSessionId: activeMeta?.agentSessionId ?? activeTab?.agentSessionId ?? activeTab?.claudeSessionId } });
  const humanCompleted = activeDoneMark !== undefined
    && activePresentation !== "running" && activePresentation !== "needsHuman" && activePresentation !== "error"
    && isManualDoneMarkValid({
    brief: activeBrief, attention: activeAttention, operationalState: activeBrief?.operationalState,
    attentionCategory: activeTab ? attentionCategory(activeTab.id, activeAttention, seenAttentionByTab) : null,
    lastActivityAt: sessionLastActivityAt(activeMeta, activeLastLogAt), stall: activeStall,
  }, activeDoneMark);
  const activeStateLabel = humanCompleted ? "完了" : activePresentation ? SESSION_STATE_LABELS[activePresentation]
    : activeMeta?.agentKind ? SESSION_STATE_LABELS.unknown : null;
  // These tooltips used to spell the shortcut out as "Ctrl+Shift+Enter". On
  // macOS the same binding answers to ⇧⌘↩, so the tooltip was naming keys the
  // user does not press — and it went stale whenever the binding was rebound.
  const zoomShortcut = useKeybindingStore((s) => formatShortcutLabel(s.keybindings["pane.zoom.toggle"]));
  const splitRightShortcut = useKeybindingStore((s) => formatShortcutLabel(s.keybindings["pane.split.right"]));
  const splitDownShortcut = useKeybindingStore((s) => formatShortcutLabel(s.keybindings["pane.split.down"]));
  const searchShortcut = useKeybindingStore((s) => formatShortcutLabel(s.keybindings["terminal.search"]));
  const showPublishButton = shouldShowPublishButton(activeTab, activeMeta);
  const renderMode = barMode;
  const { visible: visibleActions } = resolvePaneTabBarActions(renderMode, { showPublish: showPublishButton });
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
  const activeStatus: EffectiveStatus = activePresentation === "running" ? "working"
    : activePresentation === "needsHuman" ? "waiting"
    : activePresentation ? "idle" : deriveDisplayStatus(activeMeta, activeVolatileMeta);
  const activeMark = activeTab ? resolveTabMark(activeTab, activeVolatileMeta?.liveAgentKind, activeVolatileMeta?.ptyAlive === true) : null;
  // Heading and icon share the same authority; a live null cannot fall back
  // to the launcher's saved agentId.
  const activeAgentLabel = activeTab?.type === "web" || activeTab?.type === "browser"
    ? activeMark?.label ?? "シェル"
    : resolveActiveAgentLabel(activeTab?.agentId, activeMark?.kind ?? null);
  const paneDragLabel = activeTab ? getTabDisplayLabel(activeTab, true, metadataBySession, volatileMetadataBySession) : activeAgentLabel;

  useEffect(() => {
    if (!activeTab || !activeAttention?.attentionId) return;
    if (dormantAgentDescription(activeMark) && useSessionAttentionStore.getState().dormantCompletionsBySession[activeTab.sessionId]) return;
    if (!shouldMarkAttentionSeen(isVisible, activeTab.id, activeAttention.attentionId)) return;
    useSessionAttentionStore.getState().markSeen(activeTab.id, activeAttention.attentionId);
  }, [activeAttention?.attentionId, activeTab?.id, activeMark?.dormant, isVisible]);

  const displayTabLabel = useCallback(
    (tab: PaneTab, isTabActive: boolean) => getTabDisplayLabel(
      tab,
      isTabActive,
      metadataBySession,
      volatileMetadataBySession,
    ),
    [metadataBySession, volatileMetadataBySession],
  );

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

  useEffect(() => () => {
    if (pendingTabClickRef.current !== null) clearTimeout(pendingTabClickRef.current);
    renameFocusReturnRef.current?.cancel(); contextFocusReturnRef.current?.cancel(); publishFocusReturnRef.current?.cancel();
    allTabsFocusReturnRef.current?.cancel(); kebabFocusReturnRef.current?.cancel();
  }, []);

  const closeContextMenu = (restore = true) => {
    if (restore) contextFocusReturnRef.current?.(contextMenuRef.current);
    contextFocusReturnRef.current?.cancel(); contextFocusReturnRef.current = null;
    setContextMenu(null);
  };
  useDismissOnOutside(Boolean(contextMenu), contextMenuRef, (reason) => {
    closeContextMenu(reason === "escape");
  }, { preventDefaultOnEscape: true });

  useLayoutEffect(() => {
    if (!contextMenu || !contextMenuRef.current) return;
    contextMenuRef.current.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus();
  }, [contextMenu]);

  const closePublishPopover = (restore = true) => {
    if (restore) publishFocusReturnRef.current?.(publishPopoverRef.current);
    publishFocusReturnRef.current?.cancel(); publishFocusReturnRef.current = null;
    setPublishPopoverOpen(false);
  };
  useDismissOnOutside(publishPopoverOpen, publishPopoverRef, reason => closePublishPopover(reason === "escape"));

  useDismissOnOutside(allTabsOpen, [allTabsMenuRef, allTabsTriggerRef], reason => {
    if (reason === "escape") allTabsFocusReturnRef.current?.(allTabsMenuRef.current);
    allTabsFocusReturnRef.current?.cancel(); allTabsFocusReturnRef.current = null;
    setAllTabsOpen(false);
  });

  // Keep the established width thresholds; only zoom folds into the menu.
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

  useLayoutEffect(() => {
    if (!kebabOpen || !kebabMenuRef.current) return;
    kebabMenuRef.current.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus();
  }, [kebabOpen]);

  const closeKebab = (restore = true) => {
    if (restore) kebabFocusReturnRef.current?.(kebabMenuRef.current);
    kebabFocusReturnRef.current?.cancel(); kebabFocusReturnRef.current = null;
    setKebabOpen(false);
  };
  useDismissOnOutside(kebabOpen, [kebabRef, kebabMenuRef], (reason) => {
    closeKebab(reason === "escape");
  }, { preventDefaultOnEscape: true });

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

  const captureFocusReturn = useCallback((trigger: HTMLElement | null, temporary?: () => HTMLElement | null) => {
    const owner = barRef.current?.closest<HTMLElement>("[data-dnd-pane-id]") ?? null;
    const isLive = () => {
      const state = useWorkspaceListStore.getState();
      const zoomed = useUiStore.getState().zoomedPaneId;
      return state.activeWorkspaceId === workspaceId && (!zoomed || zoomed === pane.id)
        && Boolean(state.workspaces.find(ws => ws.id === workspaceId)?.panes.some(p => p.id === pane.id));
    };
    return temporary ? captureTemporaryFocusReturn(owner, trigger, temporary, isLive)
      : capturePaneFocusReturn(owner, trigger, isLive);
  }, [workspaceId, pane.id]);

  const finishEditingTab = useCallback(() => {
    renameFocusReturnRef.current?.(renameEditorRef.current);
    renameFocusReturnRef.current = null;
    setEditingTabId(null);
  }, []);

  const startEditingTab = useCallback((tabId: string, label: string) => {
    const doc = barRef.current?.ownerDocument;
    renameFocusReturnRef.current?.cancel();
    renameFocusReturnRef.current = captureFocusReturn(doc?.activeElement instanceof HTMLElement ? doc.activeElement : null, () => renameEditorRef.current);
    contextFocusReturnRef.current?.cancel(); contextFocusReturnRef.current = null;
    kebabFocusReturnRef.current?.cancel(); kebabFocusReturnRef.current = null;
    allTabsFocusReturnRef.current?.cancel(); allTabsFocusReturnRef.current = null;
    setContextMenu(null);
    setKebabOpen(false);
    if (pendingTabClickRef.current !== null) clearTimeout(pendingTabClickRef.current);
    pendingTabClickRef.current = null;
    setAllTabsOpen(false);
    setEditingTabId(tabId);
    setEditValue(label);
  }, [captureFocusReturn]);

  const suppressNextTabClick = useCallback(() => {
    focusController.request("tab-rename", { action: "suppress-tab-click", suppressMs: 250 });
  }, []);

  const commitTabLabel = useCallback((tab: PaneTab) => {
    const trimmed = editValue.trim();
    const nextLabel = trimmed === "" ? undefined : trimmed;
    if (nextLabel !== tab.label) {
      setTabLabel(workspaceId, pane.id, tab.id, nextLabel);
    }
    finishEditingTab();
  }, [editValue, pane.id, setTabLabel, workspaceId, finishEditingTab]);

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
    captureFocusReturn(tabPillRefs.current.get(contextMenu.tabId) ?? null)(contextMenuRef.current);
    setTabLabel(workspaceId, pane.id, contextMenu.tabId, undefined);
    closeContextMenu(false);
  }, [captureFocusReturn, contextMenu, pane.id, setTabLabel, workspaceId]);

  const handleToggleTabPin = useCallback((tabId: string) => {
    togglePaneTabPin(workspaceId, pane.id, tabId);
  }, [pane.id, togglePaneTabPin, workspaceId]);

  const handleLaunchDeclaredTab = useCallback((tabId: string) => {
    if (!declaredLaunchEnabled) return;
    launchDeclaredTab(workspaceId, pane.id, tabId);
  }, [declaredLaunchEnabled, launchDeclaredTab, pane.id, workspaceId]);

  const handleTogglePinContextTab = useCallback(() => {
    if (!contextMenu) return;
    captureFocusReturn(tabPillRefs.current.get(contextMenu.tabId) ?? null)(contextMenuRef.current);
    togglePaneTabPin(workspaceId, pane.id, contextMenu.tabId);
    closeContextMenu(false);
  }, [captureFocusReturn, contextMenu, pane.id, togglePaneTabPin, workspaceId]);

  const contextTab = contextMenu
    ? pane.tabs.find((candidate) => candidate.id === contextMenu.tabId)
    : undefined;
  const canResetContextTabName = contextTab?.label !== undefined;
  const isContextTabPinned = contextTab !== undefined && contextTab.id === pane.pinnedTabId;

  const activeTabLabel = activeTab ? displayTabLabel(activeTab, true) : "";
  const editingTab = pane.tabs.find(tab => tab.id === editingTabId);
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
    unreadAttentionCategory: activePresentation ? activePresentation === "error" ? "error" : activePresentation === "needsHuman" ? "waiting" : null : activeBlockingUnreadCategory,
    notificationCount: activePresentation ? 0 : activeNotificationCount,
    displayStatus: activeStatus,
  });
  const hiddenTabs = pane.tabs.filter((tab) => tab.id !== pane.activeTabId);
  const hiddenStatus = resolveHiddenTabStatus(hiddenTabs.map((tab) => {
    const attention = attentionBySession[tab.sessionId];
    const category = isAttentionUnseen(tab.id, attention, seenAttentionByTab)
      ? attentionCategory(tab.id, attention, seenAttentionByTab) : null;
    return resolveTabStatusIndicator({
      unreadAttentionCategory: isBlockingAttention(category) ? category : null,
      notificationCount: metadataBySession[tab.sessionId]?.notificationCount ?? 0,
      displayStatus: deriveDisplayStatus(metadataBySession[tab.sessionId], volatileMetadataBySession[tab.sessionId]),
    });
  }));
  const closeTitle = pane.tabs.length > 1 ? paneToolbarStrings.closeTab : paneToolbarStrings.closePane(Math.max(0, pane.tabs.length - 1));
  const headerCloseDisabled = pane.tabs.length > 1 ? !activeTab || !onRemoveTab : !canCloseWholePane || !onClose;
  const handleHeaderClose = () => {
    if (headerCloseDisabled) return;
    if (pane.tabs.length > 1 && activeTab) onRemoveTab?.(activeTab.id);
    else onClose?.();
  };
  // The right-edge × closes the whole place, hidden tabs included, through the
  // same pane-close path as the kebab menu item (running agents are confirmed there).
  const placeCloseDisabled = !canCloseWholePane || !onClose;
  const headerCloseButton = <button type="button" className="pane-action-btn pane-header-close" onClick={handleHeaderClose}
    disabled={headerCloseDisabled} aria-label={closeTitle}
    title={pane.tabs.length <= 1 && !canCloseWholePane ? paneToolbarStrings.lastPaneCloseUnavailable : closeTitle}>
    <CloseIcon size={10} />
  </button>;
  const placeCloseLabel = `${paneToolbarStrings.closePaneWithHidden(hiddenTabs.length)}。${paneToolbarStrings.reopenActiveOnly}`;

  // Each item has one definition, so L29 can replace search/history locally.
  const showHeaderMagnifier = visibleActions.includes("zoom"); // Plan B; set false for plan A (menu only).
  const menuItems: Array<{
    id: string;
    label?: string;
    show?: boolean;
    disabled?: boolean;
    title?: string;
    run?: () => void;
    content?: ReactNode;
  }> = [
    { id: "new-tab", label: paneToolbarStrings.newTab, run: () => onAddTab?.(getDefaultAgent().id, "launcher") },
    { id: "rename", label: paneTabMenuStrings.rename, disabled: !activeTab,
      run: () => { if (activeTab) startEditingTab(activeTab.id, activeTabLabel); } },
    { id: "reset-name", label: paneTabMenuStrings.resetName, disabled: activeTab?.label === undefined,
      title: activeTab?.label === undefined ? terminalPaneStrings.automaticName : undefined,
      run: () => { if (activeTab) setTabLabel(workspaceId, pane.id, activeTab.id, undefined); } },
    { id: "search", label: terminalPaneStrings.searchTerminal, disabled: !canSearchTerminal,
      title: canSearchTerminal ? terminalPaneStrings.searchTerminalTitle(searchShortcut) : terminalPaneStrings.searchUnavailable,
      run: handleSearchTerminal },
    { id: "publish", label: published ? onlineStrings.publishButtonTitleUpdate : onlineStrings.publishButtonTitleNew,
      show: showPublishButton, title: !agentSessionId ? onlineStrings.publishNoSession : undefined,
      run: () => {
        if (!agentSessionId) { useToastStore.getState().pushToast(onlineStrings.publishNoSession, "error"); return; }
        publishFocusReturnRef.current?.cancel();
        publishFocusReturnRef.current = captureFocusReturn(kebabTriggerRef.current, () => publishPopoverRef.current);
        setPublishPopoverOpen(true);
      } },
    { id: "dashboard", label: paneToolbarStrings.openInDashboard, show: Boolean(activeTab),
      run: () => { if (activeTab) void requestDashboard({ tabId: activeTab.id, sessionId: activeTab.sessionId }); } },
    { id: "history", content: <TerminalHistoryEntry sessionId={canSearchTerminal ? activeTab!.sessionId : null}
        visible={isVisible} variant="menu" /> },
    { id: "duplicate", label: paneToolbarStrings.duplicateSession, show: Boolean(activeMeta?.agentKind && activeMeta.agentSessionId),
      disabled: activeTab ? duplicatingTabIds.has(activeTab.id) : true,
      run: () => { if (activeTab) void handleDuplicateSession(activeTab, activeTabLabel); } },
    { id: "split-right", label: paneToolbarStrings.splitRight, show: Boolean(onSplitRight && showSplitRightButton), run: onSplitRight },
    { id: "split-down", label: paneToolbarStrings.splitDown, show: Boolean(onSplitDown && showSplitDownButton), run: onSplitDown },
    { id: "zoom", label: isZoomed ? paneToolbarStrings.restorePane : paneToolbarStrings.zoomPane,
      show: Boolean(!visibleActions.includes("zoom") && onZoomToggle), run: onZoomToggle },
    { id: "reopen", label: terminalPaneStrings.reopenTab, disabled: !peekClosedPane(),
      title: !peekClosedPane() ? terminalPaneStrings.noClosedTab : undefined,
      run: () => { if (peekClosedPane()) window.dispatchEvent(new Event(TAB_RESTORE_CLOSED_EVENT)); } },
    { id: "close-pane", label: paneToolbarStrings.closePaneWithHidden(hiddenTabs.length), show: pane.tabs.length > 1,
      disabled: !canCloseWholePane || !onClose,
      title: canCloseWholePane ? paneToolbarStrings.reopenActiveOnly
        : `${paneToolbarStrings.lastPaneCloseUnavailable}。${paneToolbarStrings.reopenActiveOnly}`,
      run: onClose },
  ];

  const activeHeading = (() => {
    if (!activeTab) return null;
    const tab = activeTab;
    const label = activeTabLabel;
    const isEditingTab = editingTabId === tab.id;
    const openNameMenu = (trigger: HTMLElement, x: number, y: number, select: boolean) => {
      if (select && !isEditingTab && (tab.type === "browser" || tab.type === "web" || tab.type === "online")
        && displayedPaneShortcutSource(tab.id)) onSelectTab?.(tab.id);
      contextFocusReturnRef.current?.cancel();
      contextFocusReturnRef.current = captureFocusReturn(trigger, () => contextMenuRef.current);
      setContextMenu({ tabId: tab.id, x, y });
    };
    const dormantDescription = activeTabDeclared ? undefined : dormantAgentDescription(activeMark);
    const detail = attentionDetail(activeAttention);
    const tabTitle = activeTabDeclared
      ? declaredLaunchEnabled ? `${label} — まだ起動していません。クリックで起動` : `${label} — 起動は無効化中`
      : dormantDescription ? `${label} — ${dormantDescription}` : detail ? `${label} — ${detail}` : label;
    return <div
      data-pane-tab-strip={pane.id}
      data-tab-id={tab.id}
      data-mark-kind={activeMark?.kind ?? ""}
      data-mark-source={tabMarkSource(tab, activeVolatileMeta?.ptyAlive === true)}
      data-savepoint-drop-workspace-id={workspaceId}
      data-savepoint-drop-pane-id={pane.id}
      data-savepoint-drop-tab-id={tab.id}
      ref={(element) => {
        if (element) tabPillRefs.current.set(tab.id, element);
        else tabPillRefs.current.delete(tab.id);
      }}
      onPointerDown={(event) => {
        if (!isEditingTab && event.button === MIDDLE_MOUSE_BUTTON) { event.preventDefault(); return; }
        if (isEditingTab || event.button !== 0) return;
        if (event.detail >= 2) {
          event.preventDefault(); event.stopPropagation(); suppressNextTabClick(); startEditingTab(tab.id, label); return;
        }
        beginPointerDrag(event, { kind: "tab", workspaceId, paneId: pane.id, tabId: tab.id, label });
      }}
      onDoubleClick={(event) => {
        event.preventDefault(); event.stopPropagation(); suppressNextTabClick(); startEditingTab(tab.id, label);
      }}
      onAuxClick={(event) => {
        if (!shouldCloseTabOnAuxClick(event.button, isEditingTab, isPillControlTarget(event.target))) return;
        event.preventDefault(); event.stopPropagation(); onRemoveTab?.(tab.id);
      }}
      onContextMenu={(event) => {
        event.preventDefault(); event.stopPropagation();
        const keyboardMenu = event.button === 0 && event.detail === 0;
        openNameMenu(event.currentTarget, event.clientX, event.clientY,
          !event.altKey && !event.ctrlKey && !event.metaKey && (!event.shiftKey || keyboardMenu));
      }}
      onClick={(event) => {
        if (event.detail >= 2) {
          event.preventDefault(); event.stopPropagation(); suppressNextTabClick(); startEditingTab(tab.id, label); return;
        }
        if (isEditingTab || focusController.shouldSuppressTabClick() || shouldSuppressClick()) {
          event.preventDefault(); event.stopPropagation(); return;
        }
        if (!activeTabDeclared && !dormantDescription) {
          const isNonTerminalHeading = tab.type === "browser" || tab.type === "web" || tab.type === "online";
          if (!isNonTerminalHeading || event.button !== 0
            || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
          if (pendingTabClickRef.current !== null) clearTimeout(pendingTabClickRef.current);
          pendingTabClickRef.current = null;
          onSelectTab?.(tab.id);
          return;
        }
        if (pendingTabClickRef.current !== null) clearTimeout(pendingTabClickRef.current);
        const selectionRevision = useUiStore.getState().focusRevision;
        pendingTabClickRef.current = setTimeout(() => {
          pendingTabClickRef.current = null;
          const state = useWorkspaceListStore.getState();
          const currentPane = state.workspaces.find(workspace => workspace.id === workspaceId)?.panes.find(candidate => candidate.id === pane.id);
          const displayed = currentPane?.tabs.find(candidate => candidate.id === currentPane.activeTabId) ?? currentPane?.tabs[0];
          if (useUiStore.getState().focusRevision !== selectionRevision
            || state.activeWorkspaceId !== workspaceId || displayed?.id !== tab.id) return;
          if (!openDormantCompletionRecord(tab, Boolean(dormantDescription))) onSelectTab?.(tab.id);
          if (activeTabDeclared) handleLaunchDeclaredTab(tab.id);
        }, 250);
      }}
      onKeyDown={(event) => {
        if (event.currentTarget !== event.target) return;
        if (!event.altKey && !event.ctrlKey && !event.metaKey
          && (event.key === "ContextMenu" && !event.shiftKey || event.key === "F10" && event.shiftKey)) {
          event.preventDefault(); event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          openNameMenu(event.currentTarget, rect.left, rect.bottom, true);
          return;
        }
        if (event.key === "F2") {
          event.preventDefault(); event.stopPropagation(); startEditingTab(tab.id, label); return;
        }
        if (!isTabActivationKey(event.key)) return;
        event.preventDefault();
        if (!openDormantCompletionRecord(tab, Boolean(dormantDescription))) onSelectTab?.(tab.id);
        if (activeTabDeclared) handleLaunchDeclaredTab(tab.id);
      }}
      role="tab"
      aria-selected={true}
      tabIndex={0}
      title={tabTitle}
      aria-label={[tabTitle, activeMark?.label, activeUnreadLabel].filter(Boolean).join(": ")}
      className={`pane-tab-pill pane-active-heading is-active${activeMark ? " has-agent-kind" : ""}${savepointDropTabId === tab.id ? " is-savepoint-write-target" : ""}`}
      style={{ "--agent-kind-color": activeMark?.color.fg, opacity: dormantDescription ? 0.45 : 1 } as AgentKindStyle}
    >
      {activeMark ? <TabAgentIcon mark={activeMark} indicator={activeStatusIndicator} /> : <TabStatusIndicatorDot indicator={activeStatusIndicator} />}
      <span className="pane-active-heading-name" style={{ fontFamily: "var(--cmux-font-mono)", fontSize: "var(--cmux-font-size-xs)" }}>
        {activeTabDeclared ? `＋ ${label}（まだ）` : label}
      </span>
      {!activeTabDeclared && activeStateLabel ? <span className="pane-session-state" role="status"
        data-session-state={activePresentation ?? "unknown"}>{activeStateLabel}</span> : null}
    </div>;
  })();

  return (
    <>
    <div
      ref={barRef}
      className="pane-tabbar"
      onPointerDown={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest(".pane-tab-pill, button, input, textarea, select, [role=menu]")) return;
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
      <div className="pane-heading-row">
        <div className="pane-heading-content"
          data-savepoint-drop-workspace-id={workspaceId}
          data-savepoint-drop-pane-id={pane.id}
          data-savepoint-drop-tab-id={activeTab?.id}>
          {activeHeading}
          {/* The tab's own ×, right after its name: closes this tab only (hidden tabs stay), like Ctrl+Alt+W. */}
          {activeHeading && headerCloseButton}
          <div className="pane-heading-spacer" aria-hidden="true" />
        </div>
        {hiddenTabs.length > 0 && (
          <div style={{ position: "relative", flexShrink: 0 }}>
            <button ref={allTabsTriggerRef} type="button" className="pane-action-btn pane-hidden-tabs"
              title={paneToolbarStrings.allTabs} aria-label={paneToolbarStrings.allTabs}
              aria-haspopup="menu" aria-expanded={allTabsOpen}
              data-hidden-status={hiddenStatus ?? "idle"}
              style={{ color: hiddenStatus ? TAB_STATUS_INDICATOR_CONFIG[hiddenStatus].color : undefined }}
              onClick={(event) => {
                event.stopPropagation();
                allTabsFocusReturnRef.current?.cancel();
                allTabsFocusReturnRef.current = !allTabsOpen ? captureFocusReturn(allTabsTriggerRef.current, () => allTabsMenuRef.current) : null;
                setAllTabsOpen(open => !open);
              }}>
              {formatHiddenTabCount(hiddenTabs.length, renderMode)}
            </button>
            {isVisible && allTabsOpen && portalTarget && createPortal(<PaneTabListMenu pane={pane} workspaceId={workspaceId}
              menuRef={allTabsMenuRef} anchorRef={allTabsTriggerRef} metadataBySession={metadataBySession}
              volatileMetadataBySession={volatileMetadataBySession} attentionBySession={attentionBySession}
              seenAttentionByTab={seenAttentionByTab} getTabDisplayLabel={displayTabLabel}
              hasTerminalBuffer={hasTerminalBuffer} onSelectTab={onSelectTab} onRemoveTab={onRemoveTab}
              onTogglePin={handleToggleTabPin} onRenameTab={startEditingTab}
              onReturnFocus={() => captureFocusReturn(activeTab ? tabPillRefs.current.get(activeTab.id) ?? null : null)(allTabsMenuRef.current)}
              onLaunchDeclaredTab={handleLaunchDeclaredTab} onCloseMenu={() => {
                captureFocusReturn(allTabsTriggerRef.current)(allTabsMenuRef.current);
                allTabsFocusReturnRef.current?.cancel(); allTabsFocusReturnRef.current = null;
                setAllTabsOpen(false);
              }} />, portalTarget)}
          </div>
        )}
        {visibleActions.includes("split-right") && onSplitRight && showSplitRightButton && (
          <button type="button" className="pane-action-btn pane-tabbar-split"
            onClick={onSplitRight} title={paneToolbarStrings.splitRightAt(splitRightShortcut)} aria-label={paneToolbarStrings.splitRight}>
            <SplitRightIcon />
          </button>
        )}
        {visibleActions.includes("split-down") && onSplitDown && showSplitDownButton && (
          <button type="button" className="pane-action-btn pane-tabbar-split"
            onClick={onSplitDown} title={paneToolbarStrings.splitDownAt(splitDownShortcut)} aria-label={paneToolbarStrings.splitDown}>
            <SplitDownIcon />
          </button>
        )}
        {visibleActions.includes("zoom") && onZoomToggle && (
          <button type="button" className="pane-action-btn pane-tabbar-zoom" onClick={onZoomToggle}
            title={isZoomed ? paneToolbarStrings.restorePaneAt(zoomShortcut) : paneToolbarStrings.zoomPaneAt(zoomShortcut)}>
            {isZoomed ? <MinimizeIcon /> : <MaximizeIcon />}
          </button>
        )}
        {showHeaderMagnifier && <TerminalHistoryEntry sessionId={canSearchTerminal ? activeTab!.sessionId : null}
          visible={isVisible} searchTitle={canSearchTerminal ? terminalPaneStrings.searchTerminalTitle(searchShortcut) : terminalPaneStrings.searchUnavailable} />}
        {!activeHeading && headerCloseButton}
        {/* With no hidden tabs the name's × already closes the place; a second × would only look different. */}
        {activeHeading && hiddenTabs.length > 0 && visibleActions.includes("close") && (
          <button type="button" className="pane-action-btn pane-place-close" onClick={() => { if (!placeCloseDisabled) onClose?.(); }}
            disabled={placeCloseDisabled} aria-label={placeCloseLabel}
            title={canCloseWholePane ? placeCloseLabel : paneToolbarStrings.lastPaneCloseUnavailable}>
            <CloseIcon size={11} />
          </button>
        )}
        <div ref={kebabRef} style={{ position: "relative", flexShrink: 0 }}>
          <button ref={kebabTriggerRef} type="button" className="pane-action-btn"
            title={terminalPaneStrings.paneActions} aria-label={terminalPaneStrings.paneActions}
            aria-haspopup="menu" aria-expanded={kebabOpen}
            onClick={(event) => {
              event.stopPropagation();
              kebabFocusReturnRef.current?.cancel();
              kebabFocusReturnRef.current = !kebabOpen ? captureFocusReturn(kebabTriggerRef.current, () => kebabMenuRef.current) : null;
              setKebabOpen(open => !open);
            }}>
            <KebabIcon />
          </button>
          {isVisible && kebabOpen && portalTarget && createPortal(<div ref={kebabMenuRef} className="pane-actions-menu" role="menu"
            data-pane-focus-workspace-id={workspaceId} data-pane-focus-pane-id={pane.id}
            onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
            onKeyDown={handlePaneMenuKeyDown} onPointerDown={(event) => event.stopPropagation()}
            style={{ ...paneTabContextMenuStyle, left: kebabMenuPos?.left ?? -9999, top: kebabMenuPos?.top ?? -9999, zIndex: 130,
              maxWidth: "calc(100vw - 16px)", maxHeight: "calc(100vh - 24px)", overflowY: "auto" }}>
            {menuItems.filter((item) => item.show !== false).map((item) => item.content
              ? <div key={item.id} className="pane-history-menu-item" data-pane-action={item.id}
                  onClickCapture={(event) => {
                    if ((event.target as Element).closest("[data-terminal-magnifier]")?.getAttribute("aria-disabled") !== "true") closeKebab(false);
                  }}>{item.content}</div>
              : <PaneTabContextMenuItem key={item.id} actionId={item.id} disabled={item.disabled} title={item.title}
                  onClick={() => {
                    const returnFocus = captureFocusReturn(kebabTriggerRef.current);
                    item.run?.();
                    returnFocus(kebabMenuRef.current);
                    closeKebab(false);
                  }}>
                  {item.label}
                </PaneTabContextMenuItem>)}
          </div>, portalTarget)}
        </div>
      </div>
      {isVisible && publishPopoverOpen && agentSessionId && portalTarget && createPortal(
        <div
          ref={publishPopoverRef}
          data-pane-hover-focus-blocker="true"
          data-pane-focus-workspace-id={workspaceId} data-pane-focus-pane-id={pane.id}
          data-cmux-native-webview-occluder="true"
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
          style={{
            position: "fixed",
            top: publishPopoverPos?.top ?? -9999,
            left: publishPopoverPos?.left ?? -9999,
            zIndex: 120,
            width: "min(280px, calc(100vw - 16px))",
            maxHeight: "calc(100vh - 16px)",
            overflowY: "auto",
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
                onClick={() => closePublishPopover()}
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
        </div>, portalTarget
      )}
      </div>
      {isVisible && editingTab && (
        <PaneTabRenameEditor
          key={editingTab.id}
          label={displayTabLabel(editingTab, editingTab.id === pane.activeTabId)}
          value={editValue}
          editorRef={renameEditorRef}
          workspaceId={workspaceId}
          paneId={pane.id}
          anchor={tabPillRefs.current.get(editingTab.id)?.getBoundingClientRect() ?? barRef.current?.getBoundingClientRect()}
          onChange={setEditValue}
          onSave={() => commitTabLabel(editingTab)}
          onCancel={finishEditingTab}
        />
      )}
      {isVisible && contextMenu && portalTarget && createPortal(
        <div
          ref={contextMenuRef}
          role="menu"
          data-pane-focus-workspace-id={workspaceId} data-pane-focus-pane-id={pane.id}
          onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()}
          onClick={event => event.stopPropagation()}
          onKeyDown={handlePaneMenuKeyDown}
          style={{
            ...paneTabContextMenuStyle,
            top: contextMenuPos?.top ?? -9999,
            left: contextMenuPos?.left ?? -9999,
            maxWidth: "calc(100vw - 16px)",
            maxHeight: "calc(100vh - 16px)",
            overflowY: "auto",
          }}
        >
          <PaneTabContextMenuItem onClick={handleRenameContextTab}>
            {paneTabMenuStrings.rename}
          </PaneTabContextMenuItem>
          <PaneTabContextMenuItem
            disabled={!canResetContextTabName}
            title={!canResetContextTabName ? terminalPaneStrings.automaticName : undefined}
            onClick={handleResetContextTab}
          >
            {paneTabMenuStrings.resetName}
          </PaneTabContextMenuItem>
          <PaneTabContextMenuItem onClick={handleTogglePinContextTab}>
            {isContextTabPinned ? paneToolbarStrings.unpinTab : paneToolbarStrings.pinTab}
          </PaneTabContextMenuItem>
        </div>, portalTarget
      )}
    </>
  );
});
