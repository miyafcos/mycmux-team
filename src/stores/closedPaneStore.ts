import type { AgentSessionKind, Pane, PaneTab } from "../types";
import { usePaneMetadataStore, type PaneMetadata } from "./paneMetadataStore";

const CLOSED_PANE_LIMIT = 10;

export interface ClosedPaneEntry {
  cwd: string | null;
  label: string | null;
  agentKind: AgentSessionKind | null;
  agentSessionId: string | null;
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

export function pushClosedPane(pane: Pane): void {
  const activeTab = pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? pane.tabs[0];
  const metadata = usePaneMetadataStore.getState().metadata;
  const activeMetadata = activeTab ? metadata[activeTab.sessionId] : undefined;
  const paneMetadata = metadata[pane.sessionId];

  const agentSession = resolveClosedAgentSession(pane, activeTab, metadata);

  pushClosedEntry({
    cwd: firstNonEmpty(activeMetadata?.cwd, paneMetadata?.cwd, activeTab?.cwd, pane.cwd),
    label: firstNonEmpty(activeTab?.label, pane.label),
    ...agentSession,
  });
}

export function pushClosedTab(pane: Pane, tab: PaneTab): void {
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
  });
}

export function popClosedPane(): ClosedPaneEntry | null {
  return closedPanes.pop() ?? null;
}

export function getClosedPaneCount(): number {
  return closedPanes.length;
}
