import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { flushSync } from "react-dom";
import { openWorkspaceWindow, publishWindowFragment, isSessionAlive, type DetachedPaneOrigin } from "./ipc";
import { detachedWorkspaceConfig } from "./detachedPane";
import { windowLabel } from "./windowContext";
import { focusController } from "./focusController";
import { recordPerf } from "./perfTimeline";
import { usePaneMetadataStore, useWorkspaceListStore } from "../stores/workspaceStore";
import { evictTerminalCache } from "../components/terminal/terminalCache";
import { waitForTearoutReceiver, sendTearoutWorkspaces, visitTearoutLocation } from "./tearout/runtime";
import { beginTearoutOperation, restoringTearoutOperation, endTearoutOperation } from "./tearout/operation";
import { liveTransferSessions, terminalTransferSessions } from "./tearout/transferSessions";
import { expectTearoutAttachments, rememberTearoutDormantSessions } from "./tearout/sessionAttachment";
import { recoveryProgress, recoveryFinished, recoveryFailed, recoveryBusy } from "./tearout/recoveryNotice";
import { useToastStore } from "../stores/toastStore";
import { useUiStore } from "../stores/uiStore";
import { restoreTearoutGroup } from "./tearout/model";
import { toTransferConfig, buildWindowFragment } from "../components/layout/SocketListener";
import type { Workspace } from "../types";
import { createPaneMoveRequest, executePaneMove, type PaneMoveRequest, type WindowMoveDestination,
  type PaneMoveExecution, type PaneMoveOptions, type PaneMoveResult } from "./paneMoveOperation";

/**
 * Transfer existing sessions to a new ordinary OS window. The source is retained
 * through receiver readiness; it is removed immediately before delivery. Only a
 * receipt after live attachments and publication commits the move. Failure retires
 * the receiver before restoring the original layout; this path never kills a PTY.
 */
export function sessionIdsInWorkspace(workspace: Workspace): string[] {
  const sessionIds = new Set<string>();
  for (const pane of workspace.panes) {
    sessionIds.add(pane.sessionId);
    for (const tab of pane.tabs) {
      sessionIds.add(tab.sessionId);
    }
  }
  return Array.from(sessionIds);
}

/** Screen position for the new window, offset so it does not land exactly on top. */
export interface TearOutPlacement {
  x?: number;
  y?: number;
  detachedFrom?: DetachedPaneOrigin;
  /** Restore the layout captured before constructing a temporary transfer workspace. */
  restoreSource?: () => void;
}

export async function tearOutWorkspaceToNewWindow(
  workspaceId: string,
  placement: TearOutPlacement = {},
): Promise<string | null> {
  const request = createPaneMoveRequest({ kind: "workspace", workspaceId, label: "" }, {
    kind: "window", x: placement.x, y: placement.y, detachedFrom: placement.detachedFrom,
  });
  const result = await executePaneMove(request, { restoreSource: placement.restoreSource });
  if (result.error !== undefined) throw result.error;
  if (result.reason === "not_transferable") throw new Error("This workspace contains tabs that cannot be transferred");
  return result.status === "moved" ? result.destinationWindow ?? null : null;
}

/** Transport used only by the common move executor. */
export async function performWorkspaceWindowMove(
  request: PaneMoveRequest<WindowMoveDestination>, execution: PaneMoveExecution, options: PaneMoveOptions,
): Promise<PaneMoveResult> {
  if (request.source.kind !== "workspace") return execution.result("refused", "invalid_destination");
  const workspaceId = request.source.workspaceId;
  const placement = { ...request.destination, restoreSource: options.restoreSource };
  const listStore = useWorkspaceListStore.getState();
  const workspace = listStore.workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) return execution.result("refused", "source_missing");

  const serialized = toTransferConfig(workspace);
  const config = placement.detachedFrom
    ? detachedWorkspaceConfig(serialized, placement.detachedFrom)
    : serialized;
  if (!config || config.panes.length === 0) return execution.result("refused", "not_transferable");


  if (!beginTearoutOperation()) { recoveryBusy(); throw new Error("tearout_move_busy"); }
  const index = listStore.workspaces.findIndex(ws => ws.id === workspaceId);
  const selection = { workspace: listStore.activeWorkspaceId, session: useUiStore.getState().activePaneId,
    zoom: useUiStore.getState().zoomedPaneId };
  const restoreSource = placement.restoreSource ?? (() => {
    flushSync(() => {
      const current = useWorkspaceListStore.getState();
      if (!current.workspaces.includes(workspace)) current._replaceWorkspaces(restoreTearoutGroup(current.workspaces, workspace, workspace.panes.map(pane => pane.id), index));
      useWorkspaceListStore.setState({ activeWorkspaceId: selection.workspace });
      useUiStore.setState({ activePaneId: selection.session, zoomedPaneId: selection.zoom });
    });
  });
  const id = request.operationId;
  let label: string | undefined, prepared = false, removed = false, retrying = false, liveSessions: string[] = [];
  const name = workspace.panes.flatMap(pane => pane.tabs).map(tab => tab.label).filter(Boolean).join("\u3001") || workspace.name;
  const location = "\u5143\u306e\u30ef\u30fc\u30af\u30b9\u30da\u30fc\u30b9\u306e\u30bf\u30d6";
  const confirm = async () => {
    if (!removed && !placement.restoreSource) return;
    rememberTearoutDormantSessions(terminalTransferSessions([config]), liveSessions);
    if (retrying) for (const sessionId of liveSessions) evictTerminalCache(sessionId);
    const attachments = expectTearoutAttachments(liveSessions);
    try {
      restoreSource();
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error("tearout_restore_attachment_timeout")), 5000);
        attachments.ready.then(() => { window.clearTimeout(timer); resolve(); }, error => { window.clearTimeout(timer); reject(error); });
      });
      if (!(await Promise.all(liveSessions.map(isSessionAlive))).every(Boolean)) throw new Error("tearout_restore_session_not_alive");
      await publishWindowFragment(buildWindowFragment("transfer"));
    } finally { attachments.dispose(); }
  };
  try {
    liveSessions = await liveTransferSessions([config]);
    recordPerf("detach.request", workspaceId);
    label = await openWorkspaceWindow({ fromLabel: windowLabel(), workspaces: [config], x: placement.x, y: placement.y,
      deferredAdoption: true, ...(config.detached ? { width: 720, height: 520 } : {}) });
    await waitForTearoutReceiver(label);
    await invoke("tearout_prepare", { id, receiver: label, configs: [config] }); prepared = true;
    await invoke("tearout_phase", { id, phase: "shown" });
    await invoke("tearout_phase", { id, phase: "committed" });
    execution.assertSource();
    for (const sessionId of sessionIdsInWorkspace(workspace)) {
      evictTerminalCache(sessionId); focusController.clearSession(sessionId);
    }
    removed = true; flushSync(() => useWorkspaceListStore.getState().removeWorkspace(workspaceId));
    execution.mark("committed", label);
    await publishWindowFragment(buildWindowFragment("transfer"));
    const token = await sendTearoutWorkspaces(label, [config], liveSessions, selection.session);
    await invoke("tearout_phase", { id, phase: "received" });
    execution.mark("received", label);
    await invoke("tearout_phase", { id, phase: "cleaned" });
    execution.mark("cleaned", label);
    // A finalization failure cannot undo an already acknowledged owner.
    void emitTo(label, "mycmux://tearout-finalize", { token }).catch(() => {});
    for (const sessionId of sessionIdsInWorkspace(workspace)) usePaneMetadataStore.getState().removeMetadata(sessionId);
    recordPerf("detach.source.removed", workspaceId);
    return execution.result("moved");
  } catch (error) {
    restoringTearoutOperation();
    const progress = recoveryProgress(name, location);
    const reason = error instanceof Error ? error.message : String(error);
    const recover = async () => {
      if (label) await invoke("tearout_retire", { label });
      if (prepared && !retrying) await invoke("tearout_phase", { id, phase: "rolled_back" });
      await confirm();
      execution.mark("rolled_back");
    };
    const affectedTabs = config.panes.flatMap(pane => pane.tabs ?? []);
    const affected = affectedTabs.find(tab => tab.session_id === selection.session) ?? affectedTabs[0];
    const visit = () => {
      const owner = useWorkspaceListStore.getState().workspaces.find(ws => ws.panes.some(pane => pane.tabs.some(tab => tab.id === affected?.tab_id)));
      visitTearoutLocation(owner?.id ?? selection.workspace ?? workspaceId, affected?.session_id ?? null);
    };
    const failed = (restoreError: unknown) => recoveryFailed(name, location,
      restoreError instanceof Error ? restoreError.message : String(restoreError), () => {
        if (!beginTearoutOperation()) { recoveryBusy(); return; }
        retrying = true;
        void recover().then(() => recoveryFinished(name, location), failed).finally(endTearoutOperation);
      }, visit);
    try { await recover(); recoveryFinished(name, location, reason, undefined, visit); }
    catch (restoreError) { failed(restoreError); }
    finally { useToastStore.getState().dismissToast(progress); }
    throw Object.assign(error instanceof Error ? error : new Error(reason), { notified: true });
  } finally {
    endTearoutOperation();
    if (prepared) await invoke("tearout_forget", { id }).catch(() => {});
  }
}
