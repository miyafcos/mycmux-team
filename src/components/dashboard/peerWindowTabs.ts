import type { WindowTabIndex, WindowTabIndexTab } from "../../lib/ipc";
import type { Pane, PaneTab, Workspace } from "../../types";

export interface PeerWindowTab {
  windowLabel: string;
  pending: boolean;
  workspace: Workspace;
  pane: Pane;
  tab: PaneTab;
  ptyAlive: boolean;
  liveAgentKind: string | null;
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Failed/malformed responses never replace the last usable index. */
export function parsePeerWindowTabIndex(value: unknown): WindowTabIndex[] | null {
  if (!Array.isArray(value)) return null;
  const optionalStrings = ["label", "label_source", "display_name", "display_name_source", "type", "preset_id", "cwd",
    "agent_kind", "agent_session_id", "claude_session_id", "source_kind", "source_path", "lifecycle",
    "delegated_by_tab_id", "delegated_by_agent_session_id", "live_agent_kind"];
  const validTab = (tab: unknown) => record(tab)
    && ["tab_id", "session_id", "agent_id"].every(key => typeof tab[key] === "string")
    && typeof tab.pty_alive === "boolean"
    && optionalStrings.every(key => tab[key] == null || typeof tab[key] === "string")
    && (tab.delegated_at == null || (typeof tab.delegated_at === "number" && Number.isFinite(tab.delegated_at)))
    && (tab.command_argv == null || (Array.isArray(tab.command_argv) && tab.command_argv.length <= 1 && tab.command_argv.every(arg => typeof arg === "string")))
    && (tab.launch_env == null || (record(tab.launch_env) && (tab.launch_env.MYCMUX_LAUNCH_TARGET == null || typeof tab.launch_env.MYCMUX_LAUNCH_TARGET === "string")));
  return value.every(entry => record(entry) && typeof entry.window_label === "string" && typeof entry.pending === "boolean"
    && Array.isArray(entry.workspaces) && entry.workspaces.every(workspace => record(workspace)
      && typeof workspace.id === "string" && typeof workspace.name === "string" && Array.isArray(workspace.panes)
      && workspace.panes.every(pane => record(pane) && typeof pane.id === "string" && Array.isArray(pane.tabs) && pane.tabs.every(validTab))))
    ? value as WindowTabIndex[] : null;
}

export function paneTabFromWindowIndex(tab: WindowTabIndexTab): PaneTab {
  return {
    id: tab.tab_id, sessionId: tab.session_id, agentId: tab.agent_id,
    label: tab.label ?? undefined, labelSource: tab.label_source ?? undefined,
    displayName: tab.display_name ?? undefined, displayNameSource: tab.display_name_source ?? undefined,
    type: tab.type ?? undefined, presetId: tab.preset_id ?? undefined, cwd: tab.cwd ?? undefined,
    agentKind: tab.agent_kind ?? undefined, agentSessionId: tab.agent_session_id ?? undefined,
    claudeSessionId: tab.claude_session_id ?? undefined,
    sourceKind: tab.source_kind ?? undefined, sourcePath: tab.source_path ?? undefined,
    commandArgv: tab.command_argv?.slice(0, 1),
    launchEnv: typeof tab.launch_env?.MYCMUX_LAUNCH_TARGET === "string"
      ? { MYCMUX_LAUNCH_TARGET: tab.launch_env.MYCMUX_LAUNCH_TARGET } : undefined,
    lifecycle: tab.lifecycle ?? undefined, delegatedByTabId: tab.delegated_by_tab_id ?? undefined,
    delegatedByAgentSessionId: tab.delegated_by_agent_session_id ?? undefined, delegatedAt: tab.delegated_at ?? undefined,
  };
}

/** Keep the entire location; local IDs and published copies have priority. */
export function canonicalPeerWindowTabs(index: readonly WindowTabIndex[], local: readonly Workspace[]): PeerWindowTab[] {
  const seen = new Set(local.flatMap(workspace => workspace.panes.flatMap(pane => pane.tabs.map(tab => tab.id))));
  const result: PeerWindowTab[] = [];
  for (const entry of [...index].sort((a, b) => Number(a.pending) - Number(b.pending))) {
    if (entry.window_label === "main" && !entry.pending) continue;
    for (const sourceWorkspace of entry.workspaces) {
      const workspace: Workspace = { id: sourceWorkspace.id, name: sourceWorkspace.name,
        gridTemplateId: "1x1", status: "running", createdAt: 0, panes: [] };
      for (const sourcePane of sourceWorkspace.panes) {
        const pane: Pane = { id: sourcePane.id, agentId: "", sessionId: "", activeTabId: "", tabs: [] };
        for (const sourceTab of sourcePane.tabs) {
          if (seen.has(sourceTab.tab_id)) continue;
          seen.add(sourceTab.tab_id);
          const tab = paneTabFromWindowIndex(sourceTab);
          pane.tabs.push(tab);
          result.push({ windowLabel: entry.window_label, pending: entry.pending, workspace, pane, tab,
            ptyAlive: sourceTab.pty_alive, liveAgentKind: sourceTab.live_agent_kind ?? null });
        }
        if (pane.tabs.length) {
          pane.agentId = pane.tabs[0].agentId; pane.sessionId = pane.tabs[0].sessionId; pane.activeTabId = pane.tabs[0].id;
          workspace.panes.push(pane);
        }
      }
    }
  }
  return result;
}
