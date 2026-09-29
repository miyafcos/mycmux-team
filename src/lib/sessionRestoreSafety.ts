import { makeSessionId } from "./constants";
import type {
  AgentSessionMapping,
  PaneConfig,
  PaneTabConfig,
  WorkspaceConfig,
} from "./ipc";

function tabSessionId(tab: PaneTabConfig): string | null {
  return tab.agent_session_id ?? tab.claude_session_id ?? null;
}

function paneSessionId(pane: PaneConfig): string | null {
  return pane.agent_session_id ?? pane.claude_session_id ?? null;
}

function addOwner(
  owners: Map<string, Set<string>>,
  agentSessionId: string | null,
  mappingKeys: Array<string | null>,
): void {
  if (!agentSessionId) return;
  const keys = owners.get(agentSessionId) ?? new Set<string>();
  for (const key of mappingKeys) {
    if (key) keys.add(key);
  }
  owners.set(agentSessionId, keys);
}

/**
 * Keep persisted session ownership authoritative over launcher cache recovery.
 * A cache entry may fill a missing ID, but it must never copy an ID that is
 * already owned by another persisted pane/tab.
 */
export function filterConflictingAgentMappings(
  configs: WorkspaceConfig[],
  mappings: Record<string, AgentSessionMapping>,
): Record<string, AgentSessionMapping> {
  const owners = new Map<string, Set<string>>();

  for (const workspace of configs) {
    for (const pane of workspace.panes) {
      if (!pane.pane_id) continue;
      const paneKey = makeSessionId(workspace.id, pane.pane_id);
      const tabs = pane.tabs ?? [];
      const activeTab = tabs.find((tab) => tab.tab_id === pane.active_tab_id) ?? tabs[0];
      const activeTabKey = activeTab?.tab_id
        ? makeSessionId(workspace.id, `${pane.pane_id}-${activeTab.tab_id}`)
        : null;

      addOwner(owners, paneSessionId(pane), [paneKey, activeTabKey]);
      for (const tab of tabs) {
        if (!tab.tab_id) continue;
        const tabKey = makeSessionId(workspace.id, `${pane.pane_id}-${tab.tab_id}`);
        addOwner(
          owners,
          tabSessionId(tab),
          tab.tab_id === activeTab?.tab_id ? [tabKey, paneKey] : [tabKey],
        );
      }
    }
  }

  return Object.fromEntries(
    Object.entries(mappings).filter(([mappingKey, mapping]) => {
      const explicitOwners = owners.get(mapping.session_id);
      return !explicitOwners || explicitOwners.has(mappingKey);
    }),
  );
}

export interface PersistedSelectionCandidate {
  workspaceId?: string | null;
  paneId?: string | null;
  tabId?: string | null;
}

export interface PersistedSelection {
  workspaceId: string | null;
  paneId: string | null;
  tabId: string | null;
}

function selectionInWorkspace(
  workspace: WorkspaceConfig,
  candidate: PersistedSelectionCandidate,
): PersistedSelection | null {
  if (candidate.workspaceId && candidate.workspaceId !== workspace.id) return null;
  if (!candidate.paneId) return null;
  const pane = workspace.panes.find((item) => item.pane_id === candidate.paneId);
  if (!pane) return null;
  const tabs = pane.tabs ?? [];
  const tab = candidate.tabId
    ? tabs.find((item) => item.tab_id === candidate.tabId)
    : tabs.find((item) => item.tab_id === pane.active_tab_id) ?? tabs[0];
  if (!tab?.tab_id) return null;
  return { workspaceId: workspace.id, paneId: pane.pane_id ?? null, tabId: tab.tab_id };
}

/** Resolve active IDs only against panes/tabs that are actually persisted. */
export function resolvePersistedSelection(
  configs: WorkspaceConfig[],
  preferred: PersistedSelectionCandidate,
  fallback: PersistedSelectionCandidate = {},
): PersistedSelection {
  const preferredWorkspace = configs.find((item) => item.id === preferred.workspaceId);
  const fallbackWorkspace = configs.find((item) => item.id === fallback.workspaceId);
  if (preferredWorkspace) {
    const preferredSelection = selectionInWorkspace(preferredWorkspace, preferred);
    if (preferredSelection) return preferredSelection;
  }
  if (fallbackWorkspace) {
    const fallbackSelection = selectionInWorkspace(fallbackWorkspace, fallback);
    if (fallbackSelection) return fallbackSelection;
  }

  const workspace = preferredWorkspace ?? fallbackWorkspace ?? configs[0];
  if (!workspace) return { workspaceId: null, paneId: null, tabId: null };

  const pane = workspace.panes[0];
  const tabs = pane?.tabs ?? [];
  const tab = tabs.find((item) => item.tab_id === pane?.active_tab_id) ?? tabs[0];
  return {
    workspaceId: workspace.id,
    paneId: pane?.pane_id ?? null,
    tabId: tab?.tab_id ?? null,
  };
}
