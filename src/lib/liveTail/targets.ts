import { getPtyMetadataSnapshot, getSessionOutputSnapshot, getWindowFragments, type PtyMetadataSnapshot } from "../ipc";
import { otherWindowWorkspaces } from "../socketTabWindows";
import { useWorkspaceListStore } from "../../stores/workspaceListStore";
import { usePaneMetadataStore } from "../../stores/paneMetadataStore";
import { trustedLiveTailStatus } from "./status";
import type { LiveTailTarget } from "../../stores/liveTailStore";

export async function loadLiveTailOutputs(): Promise<Record<string, number | null>> {
  // Cached metadata is display history, never fresh evidence of PTY silence.
  return getSessionOutputSnapshot().catch(() => ({}));
}

export async function loadLiveTailTargets(): Promise<LiveTailTarget[]> {
  const [processes, fragments] = await Promise.all([
    getPtyMetadataSnapshot().catch(() => ({} as PtyMetadataSnapshot)),
    getWindowFragments().catch(() => []),
  ]);
  const { workspaces } = useWorkspaceListStore.getState();
  const { metadata, volatileMetadata } = usePaneMetadataStore.getState();
  const targets: LiveTailTarget[] = [];
  function add(identity: Omit<LiveTailTarget, "status" | "waitingForReply">) {
    const id = identity.sessionId;
    const meta = metadata[id];
    const status = trustedLiveTailStatus(id) ?? "unknown";
    const nativeKind = processes[id]?.live_agent_kind;
    const observedKind = volatileMetadata[id]?.liveAgentKind;
    const agentKind = nativeKind !== undefined ? nativeKind
      : observedKind !== undefined ? observedKind : meta?.agentKind ?? identity.agentKind;
    targets.push({ ...identity, agentKind, status, waitingForReply: status === "waiting" });
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
