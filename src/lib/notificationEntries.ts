import { getAgent } from "./agents";
import type { PaneMetadata } from "../stores/paneMetadataStore";
import type { Workspace } from "../types";

export interface NotificationEntry {
  workspaceId: string;
  workspaceName: string;
  paneId: string;
  tabId: string;
  sessionId: string;
  count: number;
  kind: "waiting";
  label: string;
}

/**
 * The single source of truth for "what is the bell reporting".
 *
 * Counting straight out of the metadata map instead would include sessions
 * this window no longer owns — a torn-out workspace, or a late notification
 * that landed after its tab was closed. Those orphans light the badge while
 * the panel, which walks live tabs, shows "No notifications".
 */
export function collectNotificationEntries(
  workspaces: readonly Workspace[],
  metadata: Record<string, PaneMetadata>,
): NotificationEntry[] {
  const entries: NotificationEntry[] = [];
  for (const workspace of workspaces) {
    for (const pane of workspace.panes) {
      for (const tab of pane.tabs) {
        const meta = metadata[tab.sessionId];
        const count = meta?.notificationCount ?? 0;
        if (!meta || count <= 0) continue;
        entries.push({
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          paneId: pane.id,
          tabId: tab.id,
          sessionId: tab.sessionId,
          count,
          kind: "waiting",
          label: tab.label
            ?? meta.processTitle
            ?? meta.cwd?.split("/").pop()
            ?? getAgent(tab.agentId)?.name
            ?? "Shell",
        });
      }
    }
  }
  return entries.sort((a, b) => b.count - a.count);
}

export function countNotifications(
  workspaces: readonly Workspace[],
  metadata: Record<string, PaneMetadata>,
): number {
  return collectNotificationEntries(workspaces, metadata)
    .reduce((sum, entry) => sum + entry.count, 0);
}
