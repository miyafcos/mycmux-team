import type { AgentSessionKind, Pane } from "../types";
import { usePaneMetadataStore } from "./paneMetadataStore";

const CLOSED_PANE_LIMIT = 10;

export interface ClosedPaneEntry {
  cwd: string | null;
  label: string | null;
  agentKind: AgentSessionKind | null;
  agentSessionId: string | null;
}

const closedPanes: ClosedPaneEntry[] = [];

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

export function pushClosedPane(pane: Pane): void {
  const activeTab = pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? pane.tabs[0];
  const metadata = usePaneMetadataStore.getState().metadata;
  const activeMetadata = activeTab ? metadata[activeTab.sessionId] : undefined;
  const paneMetadata = metadata[pane.sessionId];

  const agentKind = activeMetadata?.agentKind
    ?? paneMetadata?.agentKind
    ?? activeTab?.agentKind
    ?? pane.agentKind
    ?? (firstNonEmpty(activeTab?.claudeSessionId, pane.claudeSessionId) ? "claude" : null);
  const rawAgentSessionId = firstNonEmpty(
    activeMetadata?.agentSessionId,
    paneMetadata?.agentSessionId,
    activeTab?.agentSessionId,
    pane.agentSessionId,
    activeMetadata?.claudeSessionId,
    paneMetadata?.claudeSessionId,
    activeTab?.claudeSessionId,
    pane.claudeSessionId,
  );
  const agentSessionId = agentKind ? rawAgentSessionId : null;

  closedPanes.push({
    cwd: firstNonEmpty(activeMetadata?.cwd, paneMetadata?.cwd, activeTab?.cwd, pane.cwd),
    label: firstNonEmpty(activeTab?.label, pane.label),
    agentKind,
    agentSessionId,
  });

  if (closedPanes.length > CLOSED_PANE_LIMIT) {
    closedPanes.splice(0, closedPanes.length - CLOSED_PANE_LIMIT);
  }
}

export function popClosedPane(): ClosedPaneEntry | null {
  return closedPanes.pop() ?? null;
}

export function getClosedPaneCount(): number {
  return closedPanes.length;
}
