import type { AgentSessionKind, Pane, PaneTab, Workspace } from "../types";
import { usePaneMetadataStore, type PaneMetadata } from "./paneMetadataStore";
import { useWorkspaceListStore } from "./workspaceListStore";

const CLOSED_PANE_LIMIT = 10;

/**
 * Closing a whole workspace is a single gesture, so it must not be able to
 * evict the entire close history recorded by every other gesture (pane close,
 * tab-pill ×, tab sweep). A workspace close records at most half the stack;
 * the other half stays reachable by pressing Ctrl+Shift+T past the workspace's
 * own entries.
 */
export const CLOSED_WORKSPACE_BULK_LIMIT = Math.floor(CLOSED_PANE_LIMIT / 2);

/** Where a closed pane/tab came from, so reopen can land it back home. */
export interface ClosedPaneOrigin {
  workspaceId?: string | null;
  /** Display/fallback only — the id is what reopen matches on. */
  workspaceName?: string | null;
}

export interface ClosedPaneEntry {
  cwd: string | null;
  label: string | null;
  agentKind: AgentSessionKind | null;
  agentSessionId: string | null;
  /** Source workspace id; absent when it could not be resolved at close time. */
  workspaceId?: string;
  /** Source workspace name captured at close time (display/fallback). */
  workspaceName?: string;
}

const closedPanes: ClosedPaneEntry[] = [];

function pushClosedEntry(entry: ClosedPaneEntry): void {
  closedPanes.push(entry);
  if (closedPanes.length > CLOSED_PANE_LIMIT) {
    closedPanes.splice(0, closedPanes.length - CLOSED_PANE_LIMIT);
  }
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

function resolveClosedAgentSession(
  pane: Pane,
  tab: PaneTab | undefined,
  metadata: Record<string, PaneMetadata>,
): Pick<ClosedPaneEntry, "agentKind" | "agentSessionId"> {
  const tabMetadata = tab ? metadata[tab.sessionId] : undefined;
  const canUsePaneFallback = !tab || tab.id === pane.activeTabId || tab.sessionId === pane.sessionId;
  const paneMetadata = canUsePaneFallback ? metadata[pane.sessionId] : undefined;
  const legacyClaudeSessionId = firstNonEmpty(
    tabMetadata?.claudeSessionId,
    tab?.claudeSessionId,
    paneMetadata?.claudeSessionId,
    canUsePaneFallback ? pane.claudeSessionId : undefined,
  );
  const agentKind = tabMetadata?.agentKind
    ?? tab?.agentKind
    ?? paneMetadata?.agentKind
    ?? (canUsePaneFallback ? pane.agentKind : undefined)
    ?? (legacyClaudeSessionId ? "claude" : null);
  const agentSessionId = firstNonEmpty(
    tabMetadata?.agentSessionId,
    tab?.agentSessionId,
    paneMetadata?.agentSessionId,
    canUsePaneFallback ? pane.agentSessionId : undefined,
    agentKind === "claude" ? legacyClaudeSessionId : undefined,
  );
  return agentKind && agentSessionId
    ? { agentKind, agentSessionId }
    : { agentKind: null, agentSessionId: null };
}

/**
 * Resolve the origin workspace. Callers that already hold the workspace pass it
 * explicitly (workspace close pushes entries for a workspace that is about to
 * disappear); everyone else — pane close, tab-pill ×, tab sweep — gets it
 * looked up from the live store so no close path has to be threaded manually.
 */
function resolveOrigin(pane: Pane, origin?: ClosedPaneOrigin): Pick<
  ClosedPaneEntry,
  "workspaceId" | "workspaceName"
> {
  let workspaceId = origin?.workspaceId ?? null;
  let workspaceName = origin?.workspaceName ?? null;
  if (!workspaceId) {
    const owner = useWorkspaceListStore
      .getState()
      .workspaces.find((workspace) => workspace.panes.some((candidate) => candidate.id === pane.id));
    if (owner) {
      workspaceId = owner.id;
      workspaceName = workspaceName ?? owner.name;
    }
  }
  if (!workspaceId) return {};
  return workspaceName ? { workspaceId, workspaceName } : { workspaceId };
}

export function pushClosedPane(pane: Pane, origin?: ClosedPaneOrigin): void {
  const activeTab = pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? pane.tabs[0];
  const metadata = usePaneMetadataStore.getState().metadata;
  const activeMetadata = activeTab ? metadata[activeTab.sessionId] : undefined;
  const paneMetadata = metadata[pane.sessionId];

  const agentSession = resolveClosedAgentSession(pane, activeTab, metadata);

  pushClosedEntry({
    cwd: firstNonEmpty(activeMetadata?.cwd, paneMetadata?.cwd, activeTab?.cwd, pane.cwd),
    label: firstNonEmpty(activeTab?.label, pane.label),
    ...agentSession,
    ...resolveOrigin(pane, origin),
  });
}

export function pushClosedTab(pane: Pane, tab: PaneTab, origin?: ClosedPaneOrigin): void {
  const metadata = usePaneMetadataStore.getState().metadata;
  const agentSession = resolveClosedAgentSession(pane, tab, metadata);
  pushClosedEntry({
    cwd: firstNonEmpty(
      tab.cwd,
      metadata[tab.sessionId]?.cwd,
      pane.cwd,
      metadata[pane.sessionId]?.cwd,
    ),
    label: tab.label ?? pane.label ?? null,
    ...agentSession,
    ...resolveOrigin(pane, origin),
  });
}

export interface ClosedWorkspaceTabRef {
  pane: Pane;
  tab: PaneTab;
}

function isRestorableTab(tab: PaneTab): boolean {
  // Reopen always relaunches a terminal, so browser/online tabs are not
  // restorable and are never recorded.
  return tab.type === undefined || tab.type === "terminal";
}

/**
 * Pick which tabs of a closing workspace get recorded, in **push order**:
 * index 0 is pushed first, so the last element ends up on top of the LIFO
 * stack and is what the first Ctrl+Shift+T brings back.
 *
 * Ranking (most recently used first, before the order is reversed for push):
 *   1. the focused pane (the one holding `activeSessionId`) — its focused tab,
 *      then its active tab,
 *   2. each remaining pane's active tab in layout order,
 *   3. the remaining background tabs in (pane, tab) order.
 * The list is then truncated to `limit` — see CLOSED_WORKSPACE_BULK_LIMIT.
 */
export function selectClosedWorkspaceTabs(
  workspace: Workspace,
  activeSessionId?: string | null,
  limit: number = CLOSED_WORKSPACE_BULK_LIMIT,
): ClosedWorkspaceTabRef[] {
  if (limit <= 0) return [];
  const focusedPane = activeSessionId
    ? workspace.panes.find(
        (pane) =>
          pane.sessionId === activeSessionId
          || pane.tabs.some((tab) => tab.sessionId === activeSessionId),
      )
    : undefined;
  const panesByRecency = focusedPane
    ? [focusedPane, ...workspace.panes.filter((pane) => pane.id !== focusedPane.id)]
    : workspace.panes;

  const ranked: ClosedWorkspaceTabRef[] = [];
  const seen = new Set<string>();
  const take = (pane: Pane, tab: PaneTab | undefined): void => {
    if (!tab || seen.has(tab.id) || !isRestorableTab(tab)) return;
    seen.add(tab.id);
    ranked.push({ pane, tab });
  };

  for (const pane of panesByRecency) {
    const focusedTab = pane === focusedPane && activeSessionId
      ? pane.tabs.find((tab) => tab.sessionId === activeSessionId)
      : undefined;
    take(pane, focusedTab);
    take(pane, pane.tabs.find((tab) => tab.id === pane.activeTabId));
  }
  for (const pane of panesByRecency) {
    for (const tab of pane.tabs) take(pane, tab);
  }

  return ranked.slice(0, limit).reverse();
}

/**
 * Record a whole workspace's panes/tabs before it is removed. Returns how many
 * entries were pushed.
 */
export function pushClosedWorkspace(
  workspace: Workspace,
  activeSessionId?: string | null,
): number {
  const selection = selectClosedWorkspaceTabs(workspace, activeSessionId);
  const origin: ClosedPaneOrigin = { workspaceId: workspace.id, workspaceName: workspace.name };
  for (const { pane, tab } of selection) {
    pushClosedTab(pane, tab, origin);
  }
  return selection.length;
}

export function peekClosedPane(): ClosedPaneEntry | null {
  return closedPanes[closedPanes.length - 1] ?? null;
}

export function popClosedPane(): ClosedPaneEntry | null {
  return closedPanes.pop() ?? null;
}

export function getClosedPaneCount(): number {
  return closedPanes.length;
}
