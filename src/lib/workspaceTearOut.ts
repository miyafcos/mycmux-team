import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { flushSync } from "react-dom";
import { openWorkspaceWindow, publishWindowFragment, type DetachedPaneOrigin } from "./ipc";
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

/**
 * Tear-out (Phase 3b): move a workspace into a brand new OS window.
 *
 * The whole point is that the PTY sessions survive, so this path must **not**
 * go through `AppShell`'s close-workspace handler — that one calls
 * `killSession` for every tab. A move is detach + reattach:
 *
 * 1. serialize the workspace exactly the way persistence would,
 * 2. hand it to the new window (Rust queues it as a pending adoption),
 * 3. drop it from this window's stores, evicting the cached terminals and
 *    clearing focus bookkeeping so nothing keeps writing into a session this
 *    window no longer owns,
 * 4. the new window mounts it, `create_session` sees a live session and takes
 *    the reattach branch (`pty/manager.rs`) — no respawn, no lost scrollback.
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
  const listStore = useWorkspaceListStore.getState();
  const workspace = listStore.workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) return null;

  const serialized = toTransferConfig(workspace);
  const config = placement.detachedFrom
    ? detachedWorkspaceConfig(serialized, placement.detachedFrom)
    : serialized;
  if (!config || config.panes.length === 0) return null;


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
  const id = crypto.randomUUID();
  let label: string | undefined, prepared = false, removed = false, retrying = false, liveSessions: string[] = [];
  const name = workspace.panes.flatMap(pane => pane.tabs).map(tab => tab.label).filter(Boolean).join("\u3001") || workspace.name;
  const location = "\u5143\u306e\u30ef\u30fc\u30af\u30b9\u30da\u30fc\u30b9\u306e\u30bf\u30d6";
  const confirm = async () => {
    if (!removed && !placement.restoreSource) return;
    rememberTearoutDormantSessions(terminalTransferSessions([config]), liveSessions);
    const attachments = expectTearoutAttachments(liveSessions);
    try {
      restoreSource();
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error("tearout_restore_attachment_timeout")), 5000);
        attachments.ready.then(() => { window.clearTimeout(timer); resolve(); }, error => { window.clearTimeout(timer); reject(error); });
      });
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
    for (const sessionId of sessionIdsInWorkspace(workspace)) {
      evictTerminalCache(sessionId); focusController.clearSession(sessionId);
    }
    removed = true; flushSync(() => useWorkspaceListStore.getState().removeWorkspace(workspaceId));
    await publishWindowFragment(buildWindowFragment("transfer"));
    const token = await sendTearoutWorkspaces(label, [config], liveSessions, selection.session);
    await invoke("tearout_phase", { id, phase: "received" });
    await invoke("tearout_phase", { id, phase: "cleaned" });
    // A finalization failure cannot undo an already acknowledged owner.
    void emitTo(label, "mycmux://tearout-finalize", { token }).catch(() => {});
    for (const sessionId of sessionIdsInWorkspace(workspace)) usePaneMetadataStore.getState().removeMetadata(sessionId);
    recordPerf("detach.source.removed", workspaceId);
    return label;
  } catch (error) {
    restoringTearoutOperation();
    const progress = recoveryProgress(name, location);
    const reason = error instanceof Error ? error.message : String(error);
    const recover = async () => {
      if (label) await invoke("tearout_retire", { label });
      if (prepared && !retrying) await invoke("tearout_phase", { id, phase: "rolled_back" });
      await confirm();
    };
    const visit = () => visitTearoutLocation(selection.workspace ?? workspaceId, selection.session);
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
