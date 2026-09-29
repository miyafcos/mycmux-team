import { onlineStrings } from "../components/online/onlineStrings";
import { focusController } from "./focusController";
import { isSessionAlive, joinSavepointSummary, writeToSession } from "./ipc";
import {
  resolveLiveSavepointTargetKind,
  sanitizeSavepointHandoffDraft,
} from "./savepointHandoff";
import { usePaneMetadataStore } from "../stores/paneMetadataStore";
import type { SavepointPasteDropTarget } from "../stores/savepointDragStore";
import { useToastStore } from "../stores/toastStore";
import { useWorkspaceLayoutStore } from "../stores/workspaceLayoutStore";
import { useWorkspaceListStore } from "../stores/workspaceListStore";

const SESSION_READY_TIMEOUT_MS = 2_500;
const SESSION_READY_POLL_MS = 75;

export function resolveLiveAgentTarget(
  workspaceId: string,
  paneId: string,
  tabId?: string,
): SavepointPasteDropTarget | null {
  const workspace = useWorkspaceListStore.getState().getWorkspace(workspaceId);
  const pane = workspace?.panes.find((candidate) => candidate.id === paneId);
  if (!pane) return null;
  const tab = tabId
    ? pane.tabs.find((candidate) => candidate.id === tabId)
    : (pane.tabs.find((candidate) => candidate.id === pane.activeTabId) ?? pane.tabs[0]);
  if (!tab) return null;
  const metadata = usePaneMetadataStore.getState().metadata[tab.sessionId];
  const targetKind = resolveLiveSavepointTargetKind(tab, metadata?.agentKind);
  if (!targetKind) return null;
  return {
    mode: "paste",
    workspaceId,
    paneId,
    tabId: tab.id,
    sessionId: tab.sessionId,
    targetKind,
  };
}

function revalidateLiveAgentTarget(
  target: SavepointPasteDropTarget,
): SavepointPasteDropTarget | null {
  const latest = resolveLiveAgentTarget(target.workspaceId, target.paneId, target.tabId);
  return latest?.sessionId === target.sessionId ? latest : null;
}

function isApprovalWaiting(sessionId: string): boolean {
  return usePaneMetadataStore.getState().metadata[sessionId]?.agentStatus === "waiting";
}

async function waitForSessionAlive(sessionId: string): Promise<boolean> {
  const deadline = Date.now() + SESSION_READY_TIMEOUT_MS;
  do {
    if (await isSessionAlive(sessionId)) return true;
    await new Promise<void>((resolve) => window.setTimeout(resolve, SESSION_READY_POLL_MS));
  } while (Date.now() < deadline);
  return false;
}

export async function commitSavepointPaste(
  bundleDir: string,
  target: SavepointPasteDropTarget,
  preparingToastId?: string,
): Promise<void> {
  let openingToastId = preparingToastId;
  try {
    const initialTarget = revalidateLiveAgentTarget(target);
    if (!initialTarget) {
      useToastStore.getState().pushToast(onlineStrings.dragDropTargetGone, "warning");
      return;
    }
    if (isApprovalWaiting(initialTarget.sessionId)) {
      useToastStore.getState().pushToast(onlineStrings.dragDropApprovalBlocked, "warning");
      return;
    }
    openingToastId ??= useToastStore
      .getState()
      .pushToast(onlineStrings.dragDropPreparingDraft, "info");

    const joined = await joinSavepointSummary(bundleDir);
    const latestTarget = revalidateLiveAgentTarget(initialTarget);
    if (!latestTarget) {
      useToastStore.getState().pushToast(onlineStrings.dragDropTargetGone, "warning");
      return;
    }
    if (isApprovalWaiting(latestTarget.sessionId)) {
      useToastStore.getState().pushToast(onlineStrings.dragDropApprovalBlocked, "warning");
      return;
    }

    useWorkspaceListStore.getState().setActiveWorkspace(latestTarget.workspaceId);
    useWorkspaceLayoutStore.getState().setActivePaneTab(
      latestTarget.workspaceId,
      latestTarget.paneId,
      latestTarget.tabId,
    );
    focusController.request("drag", { sessionId: latestTarget.sessionId, focus: false });

    if (!(await waitForSessionAlive(latestTarget.sessionId))) {
      useToastStore.getState().pushToast(onlineStrings.dragDropTargetNotReady, "warning");
      return;
    }
    const readyTarget = revalidateLiveAgentTarget(latestTarget);
    if (!readyTarget || isApprovalWaiting(readyTarget.sessionId)) {
      useToastStore.getState().pushToast(onlineStrings.dragDropTargetGone, "warning");
      return;
    }

    const draft = sanitizeSavepointHandoffDraft(onlineStrings.joinPrompt(joined.handoff_path));
    await writeToSession(readyTarget.sessionId, draft);
    // The only keyboard-focus move of this flow, and it happens after the draft
    // is in place. The activation above deliberately runs with `focus: false` so
    // the operator is not yanked away and then dragged back once the up-to-2.5s
    // liveness wait finishes. Focus has to land here though: the draft is typed
    // without a trailing Enter, so the operator's Enter must reach this pane.
    focusController.focusSessionSoon(readyTarget.sessionId);
    useToastStore.getState().pushToast(
      joined.cwd_missing
        ? onlineStrings.dragDropPastedCwdMissing
        : onlineStrings.dragDropPasted,
      joined.cwd_missing ? "warning" : "info",
    );
  } catch (error) {
    console.error("[mycmux] failed to paste dropped savepoint", error);
    useToastStore.getState().pushToast(
      onlineStrings.dragDropErrorPrefix + String(error),
      "error",
    );
  } finally {
    if (openingToastId) useToastStore.getState().dismissToast(openingToastId);
  }
}
