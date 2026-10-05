import type { PaneDragItem } from "../stores/paneDragStore";
import { useWorkspaceListStore } from "../stores/workspaceListStore";
import { usePaneMetadataStore } from "../stores/paneMetadataStore";
import { useToastStore } from "../stores/toastStore";
import { publishSavepoint } from "./ipc";
import { resolvePaneHandoffEligibility, type PaneHandoffEndpoint } from "./paneHandoff";
import { commitSavepointPaste, resolveLiveAgentTarget } from "./savepointHandoffRuntime";
import { onlineStrings } from "../components/online/onlineStrings";
import type { AgentSessionKind } from "../types";

export interface PaneHandoffPinnedTarget {
  tabId: string;
  sessionId: string;
  targetAgentKind: AgentSessionKind;
}

/** Capture only handoff identity; no terminal content or launch environment travels. */
export function capturePaneHandoffSource(item: PaneDragItem): PaneHandoffEndpoint | null {
  if (item.kind === "tab-bundle") return null;
  const pane = useWorkspaceListStore.getState().getWorkspace(item.workspaceId)?.panes.find(pane => pane.id === item.paneId);
  const tab = item.kind === "tab" ? pane?.tabs.find(tab => tab.id === item.tabId)
    : pane?.tabs.find(tab => tab.id === pane.activeTabId) ?? pane?.tabs[0];
  if (!tab) return null;
  const metadata = usePaneMetadataStore.getState().metadata[tab.sessionId];
  return { workspaceId: item.workspaceId, paneId: item.paneId,
    tab: { id: tab.id, sessionId: tab.sessionId, agentId: tab.agentId, type: tab.type },
    metadata: metadata ? { agentKind: metadata.agentKind, agentSessionId: metadata.agentSessionId, cwd: metadata.cwd } : undefined };
}

export function resolvePaneHandoffContext(source: PaneHandoffEndpoint | null,
  workspaceId: string, paneId: string, pinned?: PaneHandoffPinnedTarget) {
  if (!source) return null;
  const pane = useWorkspaceListStore.getState().getWorkspace(workspaceId)?.panes.find(pane => pane.id === paneId);
  const tab = pane?.tabs.find(tab => tab.id === pane.activeTabId) ?? pane?.tabs[0];
  if (!tab) return null;
  const metadata = usePaneMetadataStore.getState().metadata[tab.sessionId];
  const eligibility = resolvePaneHandoffEligibility(source, { workspaceId, paneId, tab, metadata });
  const pasteTarget = resolveLiveAgentTarget(workspaceId, paneId, tab.id);
  if (!eligibility || !pasteTarget || pasteTarget.targetKind !== eligibility.targetAgentKind) return null;
  if (pinned && (pasteTarget.tabId !== pinned.tabId || pasteTarget.sessionId !== pinned.sessionId
    || pasteTarget.targetKind !== pinned.targetAgentKind)) return null;
  return { eligibility, pasteTarget };
}

/** Both drag paths publish the same savepoint and leave a draft without Enter. */
export async function commitPaneHandoffContext(context: ReturnType<typeof resolvePaneHandoffContext>,
  isCurrent: () => boolean = () => true): Promise<boolean> {
  if (!isCurrent()) return false;
  if (!context) {
    useToastStore.getState().pushToast(onlineStrings.dragDropTargetGone, "warning");
    return false;
  }
  const openingToastId = useToastStore.getState().pushToast(onlineStrings.dragDropPreparingDraft, "info");
  try {
    const published = await publishSavepoint({ cwd: context.eligibility.sourceCwd,
      agentKind: context.eligibility.publishAgentKind, agentSessionId: context.eligibility.sourceAgentSessionId });
    if (!isCurrent()) return false;
    return await commitSavepointPaste(published.bundle_dir, context.pasteTarget, openingToastId, isCurrent);
  } catch (error) {
    console.error("[mycmux] failed to publish pane handoff", error);
    if (isCurrent()) useToastStore.getState().pushToast(onlineStrings.dragDropErrorPrefix + String(error), "error");
    return false;
  } finally {
    useToastStore.getState().dismissToast(openingToastId);
  }
}
