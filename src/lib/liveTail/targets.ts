import { getPtyMetadataSnapshot, getSessionOutputSnapshot, getWindowFragments, type PtyMetadataSnapshot } from "../ipc";
import { otherWindowWorkspaces } from "../socketTabWindows";
import { useWorkspaceListStore } from "../../stores/workspaceListStore";
import { usePaneMetadataStore } from "../../stores/paneMetadataStore";
import { useSessionAttentionStore } from "../../stores/sessionAttentionStore";
import type { LiveTailTarget } from "../../stores/liveTailStore";

export async function loadLiveTailOutputs(): Promise<Record<string, number | null>> {
  try { return await getSessionOutputSnapshot(); } catch {
    const { metadata, volatileMetadata } = usePaneMetadataStore.getState();
    return Object.fromEntries([...new Set([...Object.keys(metadata), ...Object.keys(volatileMetadata)])]
      .map((id) => [id, volatileMetadata[id]?.backendLastOutputAt ?? metadata[id]?.backendLastOutputAt ?? null]));
  }
}

export async function loadLiveTailTargets(): Promise<LiveTailTarget[]> {
  const [processes, fragments] = await Promise.all([
    getPtyMetadataSnapshot().catch(() => ({} as PtyMetadataSnapshot)),
    getWindowFragments().catch(() => []),
  ]);
  const { workspaces } = useWorkspaceListStore.getState();
  const { metadata, volatileMetadata } = usePaneMetadataStore.getState();
  const { attentionBySession } = useSessionAttentionStore.getState();
  const targets: LiveTailTarget[] = [];
  function add(identity: Omit<LiveTailTarget, "status" | "waitingForReply">) {
    const id = identity.sessionId;
    const attention = attentionBySession[id];
    const meta = metadata[id];
    const waiting = attention?.uiState === "waiting" || attention?.kind === "input" || attention?.kind === "approval"
      || attention?.kind === "rate_limited" || (!attention && meta?.agentStatus === "waiting");
    const working = attention ? attention.uiState === "working" : meta?.agentStatus === "working"
      || meta?.processIsShell === false || processes[id]?.process_status === "working";
    targets.push({ ...identity, agentKind: processes[id]?.live_agent_kind ?? volatileMetadata[id]?.liveAgentKind ?? meta?.agentKind ?? identity.agentKind,
      status: waiting ? "waiting" : working ? "working" : "idle", waitingForReply: waiting });
  }
  for (const workspace of workspaces) {
    for (const pane of workspace.panes) {
      for (const tab of pane.tabs) {
        if ((tab.type && tab.type !== "terminal") || tab.lifecycle === "declared" || !tab.sessionId) continue;
        add({ sessionId: tab.sessionId, workspaceId: workspace.id, workspaceName: workspace.name, paneId: pane.id,
          tabId: tab.id, name: tab.displayName ?? tab.label ?? pane.label ?? tab.agentId, agentKind: tab.agentKind ?? null });
      }
    }
  }
  for (const { workspace } of otherWindowWorkspaces(fragments, new Set(workspaces.map((w) => w.id)))) {
    for (const pane of workspace.panes) {
      for (const tab of pane.tabs ?? []) {
        if ((tab.type && tab.type !== "terminal") || tab.lifecycle === "declared" || !tab.session_id || !tab.tab_id || !pane.pane_id) continue;
        add({ sessionId: tab.session_id, workspaceId: workspace.id, workspaceName: workspace.name, paneId: pane.pane_id,
          tabId: tab.tab_id, name: tab.display_name ?? tab.label ?? pane.label ?? tab.agent_id, agentKind: tab.agent_kind ?? null });
      }
    }
  }
  return targets;
}
