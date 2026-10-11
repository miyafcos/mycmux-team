import { useWorkspaceListStore } from "../stores/workspaceListStore";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useToastStore } from "../stores/toastStore";
import { withTerminalDeadline } from "./terminalDeadline";
import { codexRestoreNoticeRevision, codexRestoreNoticeEpoch, invalidateCodexRestoreNotice, publishCodexRestoreNoticeEpoch, codexRestoreNoticeActive } from "./codexRestoreLifecycle";

let noticeRegistration: Promise<void> | undefined;
let noticeReady = false;
let invalidationRegistration: Promise<void> | undefined;
let invalidationReady = false;
let publicationRegistration: Promise<void> | undefined;
let publicationReady = false;
const delivered = new Set<string>();
type Notice = { session_id: string; session_epoch: number; generation: string; tab_id: string; reason: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pendingEpochSync = new Map<string, () => void>();
const epochSynchronizations = new Map<string, { revision: number; pending: Promise<void> }>();
const listenersReady = () => noticeReady && invalidationReady && publicationReady;
function flushEpochSync(): void {
  if (!listenersReady()) return;
  const pending = [...pendingEpochSync.values()]; pendingEpochSync.clear();
  for (const synchronize of pending) synchronize();
}

/** A late attachment subscription may have missed publication; no launch wait. */
export function synchronizeCodexRestoreNoticeEpoch(id: string, attachment: Promise<void>, stillOwned: () => boolean = () => true): void {
  if (codexRestoreNoticeEpoch(id) !== null) return;
  const synchronize = () => {
    const revision = codexRestoreNoticeRevision(id); // attachment deduplication only
    if (!stillOwned() || codexRestoreNoticeEpoch(id) !== null
      || epochSynchronizations.get(id)?.revision === revision) return;
    const pending = attachment.then(() => {
      if (!stillOwned() || codexRestoreNoticeEpoch(id) !== null || !listenersReady()) return;
      // Begin may arrive while subscriptions / attachment completion are pending.
      // Bind only the authoritative lookup; never rebase an outstanding reply.
      const lookupRevision = codexRestoreNoticeRevision(id);
      return withTerminalDeadline(invoke<number | null>("get_codex_restore_epoch", { sessionId: id }), "Codex attachment epoch sync")
      .then(epoch => {
        if (lookupRevision === codexRestoreNoticeRevision(id) && stillOwned() && codexRestoreNoticeEpoch(id) === null && listenersReady()
          && epoch !== null && Number.isSafeInteger(epoch)) publishCodexRestoreNoticeEpoch(id, epoch);
      });
    }).catch(() => {}).finally(() => {
        if (epochSynchronizations.get(id)?.pending === pending) epochSynchronizations.delete(id);
      });
    epochSynchronizations.set(id, { revision, pending });
  };
  if (listenersReady()) synchronize(); else pendingEpochSync.set(id, synchronize);
}

/** Notifications have no metadata, identity, save or quit side effects. */
export async function ensureCodexRestoreNoticeListener(): Promise<void> {
  if (!publicationRegistration) {
    const pending = listen<{ session_id: string; session_epoch: number | null }>("codex-restore-published", event => {
      publishCodexRestoreNoticeEpoch(event.payload.session_id, event.payload.session_epoch);
    }).then(() => { publicationReady = true; flushEpochSync(); });
    publicationRegistration = withTerminalDeadline(pending, "Codex restore publication registration").catch(() => {});
    void pending.catch(() => { publicationRegistration = undefined; publicationReady = false; });
  }
  if (!invalidationRegistration) {
    const pending = listen<{ session_id: string }>("codex-restore-invalidated", event => {
      invalidateCodexRestoreNotice(event.payload.session_id);
    }).then(() => { invalidationReady = true; flushEpochSync(); });
    invalidationRegistration = withTerminalDeadline(pending, "Codex restore lifecycle registration").catch(() => {});
    void pending.catch(() => { invalidationRegistration = undefined; invalidationReady = false; });
  }
  if (!noticeRegistration) {
    // One listener per window, registered before the restore can emit. Its
    // lifetime is the frontend lifetime, including background-only launches.
    const pending = listen<Notice>("codex-restore-notice", async event => {
      const notice = event.payload;
      const synchronization = epochSynchronizations.get(notice.session_id)?.pending;
      if (synchronization && codexRestoreNoticeEpoch(notice.session_id) === null) await synchronization;
      const ownsTab = () => useWorkspaceListStore.getState().workspaces.some(workspace => workspace.panes.some(pane =>
        pane.tabs.some(tab => tab.sessionId === notice.session_id && tab.id === notice.tab_id)));
      if (!invalidationReady || !publicationReady || !codexRestoreNoticeActive(notice.session_id, notice.session_epoch)
        || !Number.isSafeInteger(notice.session_epoch) || !uuid.test(notice.generation) || !ownsTab()) return;
      const identity = `${notice.session_id}:${notice.session_epoch}:${notice.generation}`;
      if (delivered.has(identity)) return;
      // Cross-window replacement cannot be inferred from the frontend's local
      // attach queue. Ask native which instance currently owns this PTY id.
      const revision = codexRestoreNoticeRevision(notice.session_id);
      const epoch = await invoke<number | null>("get_codex_restore_epoch", { sessionId: notice.session_id }).catch(() => null);
      if (revision !== codexRestoreNoticeRevision(notice.session_id) || !invalidationReady || !publicationReady
        || !codexRestoreNoticeActive(notice.session_id, notice.session_epoch)
        || epoch !== notice.session_epoch || !ownsTab() || delivered.has(identity)) return;
      delivered.add(identity);
      useToastStore.getState().pushToast(event.payload.reason === "report-unavailable"
        ? "Codex の復元結果を記録できないため、シェルに戻りました。"
        : "タブの復元: 前回の Codex の会話を復元できなかったため、新しい会話を開始しました", "warning");
    }).then(() => { noticeReady = true; flushEpochSync(); });
    // Keep the one raw attempt alive after timeout so late success installs
    // only one listener. Launch callers share a promise that always settles.
    noticeRegistration = withTerminalDeadline(pending, "Codex restore notice registration").catch(() => {});
    void pending.catch(() => { noticeRegistration = undefined; noticeReady = false; });
  }
  await Promise.all([publicationRegistration, invalidationRegistration, noticeRegistration]);
}

export function consumeCodexRestoreReason(pty: string): void {
  const store = useWorkspaceListStore.getState();
  if (!store.workspaces.some(ws => ws.panes.some(p => p.tabs.some(t => t.sessionId === pty && t.codexRestoreReason)))) return;
  // Runtime-only property; never touch persistent launch_env.
  for (const workspace of store.workspaces) {
    const panes = workspace.panes.map(pane => {
      const tabs = pane.tabs.map(tab => {
        if (tab.sessionId !== pty || !tab.codexRestoreReason) return tab;
        const next = { ...tab }; delete next.codexRestoreReason; return next;
      });
      return tabs.some((tab, index) => tab !== pane.tabs[index]) ? { ...pane, tabs } : pane;
    });
    if (panes.some((pane, index) => pane !== workspace.panes[index])) store._updateWorkspacePanes(workspace.id, panes);
  }
}
