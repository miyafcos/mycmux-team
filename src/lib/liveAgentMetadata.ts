import { listen } from "@tauri-apps/api/event";
import { codexRestoreNoticeEpoch, invalidateCodexRestoreNotice, publishCodexRestoreNoticeEpoch, ptyExitConfirmed } from "./codexRestoreLifecycle";
import { getPtyMetadataSnapshot, onPtyExit, type PtyMetadata } from "./ipc";
import { usePaneMetadataStore } from "../stores/paneMetadataStore";
import { agentSessionIdentityKey, useWorkspaceListStore } from "../stores/workspaceListStore";
import { confirmAgentSessionClear } from "./agentSessionClearGuard";
import { isShellProcess } from "./notificationStatus";
import { connectAgentResumeOwnerNavigation } from "./agentResumeOwner";
import { normalizeDisplayAgentKind } from "./agentDisplayKind";
import type { AgentSessionKind } from "../types";

// An in-flight snapshot must never replace a newer monitor or exit observation.
const liveRevisions = new Map<string, number>();
function currentOwner(meta: PtyMetadata): boolean {
  if (ptyExitConfirmed(meta.session_id, meta.session_epoch)) return false;
  const owner = codexRestoreNoticeEpoch(meta.session_id);
  return owner === undefined || (owner !== null && owner === meta.session_epoch);
}
function setLiveObservation(sessionId: string, kind: string | null, alive: boolean, meta?: PtyMetadata, requestedAt = Date.now()): void {
  if (meta && !currentOwner(meta)) return;
  if (meta?.session_epoch !== undefined && codexRestoreNoticeEpoch(sessionId) === undefined) publishCodexRestoreNoticeEpoch(sessionId, meta.session_epoch);
  liveRevisions.set(sessionId, (liveRevisions.get(sessionId) ?? 0) + 1);
  usePaneMetadataStore.getState().setLiveAgent(sessionId, kind, alive, {
    observedAt: meta?.observed_at ?? requestedAt,
    agentSessionId: meta?.agent_session_trusted === false ? undefined : meta?.agent_session_id ?? meta?.claude_session_id,
    startedAt: meta?.agent_started_at ?? undefined,
  });
}

export function ownedTerminalSessions(): Set<string> {
  return new Set(useWorkspaceListStore.getState().workspaces.flatMap(workspace =>
    workspace.panes.flatMap(pane => pane.tabs
      .filter(tab => tab.type === undefined || tab.type === "terminal")
      .map(tab => tab.sessionId))));
}

export async function hydrateLiveAgents(
  sessionIds: Iterable<string>,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const before = new Map(Array.from(sessionIds, id => [id, liveRevisions.get(id) ?? 0]));
  const requestedAt = Date.now();
  const snapshot = await getPtyMetadataSnapshot();
  if (!isCurrent()) return;
  const owned = ownedTerminalSessions();
  for (const [id, revision] of before) {
    if (!owned.has(id) || revision !== (liveRevisions.get(id) ?? 0)) continue;
    const meta = snapshot[id];
    if (meta && !currentOwner(meta)) continue;
    if (meta && !meta.process_name && !normalizeDisplayAgentKind(meta.live_agent_kind)) {
      usePaneMetadataStore.getState().setVolatileMetadata(id, { ptyAlive: true, liveAgentObservationKnown: false });
    } else setLiveObservation(id, meta?.live_agent_kind ?? null, meta !== undefined, meta, requestedAt);
  }
}

/** One startup snapshot and one coalesced snapshot per adoption of new sessions.
 * Watching ownership also covers native tearout/dock without changing its protocol.
 */
export function connectLiveAgentHydration(loaded: Promise<unknown>): () => void {
  const stopOwnerNavigation = connectAgentResumeOwnerNavigation();
  let alive = true;
  let ready = false;
  let queued = false;
  let owned = new Set<string>();
  const pending = new Set<string>();
  const lifecycleStops: Array<() => void> = [];
  const adoptOwner = (id: string, epoch: number | null): void => {
    if (!alive || !ownedTerminalSessions().has(id)) return;
    publishCodexRestoreNoticeEpoch(id, epoch);
    liveRevisions.set(id, (liveRevisions.get(id) ?? 0) + 1);
    const ended = ptyExitConfirmed(id, epoch);
    usePaneMetadataStore.setState(state => ({ volatileMetadata: { ...state.volatileMetadata,
      [id]: { liveAgentKind: null, ptyAlive: epoch !== null && !ended, liveAgentObservationKnown: ended } } }));
  };
  const lifecycleReady = Promise.all([
    listen<{ session_id: string }>("codex-restore-invalidated", event => {
      invalidateCodexRestoreNotice(event.payload.session_id); adoptOwner(event.payload.session_id, null);
    }),
    listen<{ session_id: string; session_epoch: number | null }>("codex-restore-published", event => adoptOwner(event.payload.session_id, event.payload.session_epoch)),
  ]).then(stops => { if (alive) lifecycleStops.push(...stops); else stops.forEach(stop => stop()); }).catch(() => {});
  const exits = new Map<string, () => void>();
  const exitRegistrations = new Map<string, object>();
  const schedule = (): void => {
    if (!ready || queued || pending.size === 0) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (!alive) return;
      const ids = new Set(pending);
      pending.clear();
      void hydrateLiveAgents(ids, () => alive).catch(error =>
        console.warn("[marks] Failed to hydrate live PTY metadata:", error));
    });
  };
  const reconcile = (): void => {
    const next = ownedTerminalSessions();
    for (const id of owned) {
      if (!next.has(id)) {
        exits.get(id)?.();
        exits.delete(id);
        exitRegistrations.delete(id);
        pending.delete(id);
        // Invalidate snapshots from before removal, including a same-id re-adoption.
        liveRevisions.set(id, (liveRevisions.get(id) ?? 0) + 1);
      }
    }
    for (const id of next) {
      if (owned.has(id)) continue;
      pending.add(id);
      const registration = {};
      exitRegistrations.set(id, registration);
      void onPtyExit(id, () => {
        if (alive && exitRegistrations.get(id) === registration) setLiveObservation(id, null, false);
      }).then(unlisten => {
        if (alive && exitRegistrations.get(id) === registration) exits.set(id, unlisten);
        else unlisten();
      }).catch(error => console.warn("[marks] Failed to listen for PTY exit:", error));
    }
    owned = next;
    schedule();
  };
  const unsubscribe = useWorkspaceListStore.subscribe(reconcile);
  reconcile();
  void Promise.all([loaded, lifecycleReady]).then(() => { ready = true; schedule(); });
  return () => {
    alive = false;
    stopOwnerNavigation();
    lifecycleStops.forEach(stop => stop());
    unsubscribe();
    for (const unlisten of exits.values()) unlisten();
    exits.clear();
    exitRegistrations.clear();
  };
}

export function applyPtyMetadata(meta: PtyMetadata): void {
  if (!currentOwner(meta)) return;
  const foregroundIsShell = isShellProcess(meta.process_name ?? undefined);
  const liveKind = normalizeDisplayAgentKind(meta.live_agent_kind);
  const agentActive = meta.agent_active === true || liveKind !== null;
  const processIsShell = agentActive ? false : foregroundIsShell;
  if (!meta.process_name && !liveKind && meta.live_agent_kind !== undefined) {
    liveRevisions.set(meta.session_id, (liveRevisions.get(meta.session_id) ?? 0) + 1);
    usePaneMetadataStore.getState().setVolatileMetadata(meta.session_id, { ptyAlive: true, liveAgentObservationKnown: false });
  } else setLiveObservation(meta.session_id, meta.live_agent_kind ?? null, true, meta);
  // Display identity never depends on winning a persistence/session-id claim.
  const resumeActive = meta.agent_session_trusted !== false && agentActive && (meta.agent_kind === "claude" || meta.agent_kind === "claude-codex"
    || meta.agent_kind === "codex" || meta.agent_kind === "grok")
    && (meta.live_agent_kind === undefined || liveKind === meta.agent_kind);
  const paneMetadataStore = usePaneMetadataStore.getState();
  const workspaceListStore = useWorkspaceListStore.getState();
  const clearSuppressed = paneMetadataStore.metadata[meta.session_id]?.agentStatus === "waiting";
  if (confirmAgentSessionClear(meta.session_id, processIsShell, agentActive, clearSuppressed)) {
    paneMetadataStore.clearAgentSessionId(meta.session_id);
    paneMetadataStore.clearClaudeSessionId(meta.session_id);
    // Also clear the persisted Pane/Tab fields so the next save doesn't
    // ressurect a stale agent session for a pane that's now back in shell.
    workspaceListStore.setPaneAgentSessionFromMetadata(meta.session_id, null);
  }
  const sessionPayload = resumeActive && (meta.claude_session_id || meta.agent_session_id)
    ? {
        claudeSessionId: meta.claude_session_id ?? undefined,
        agentKind: (meta.agent_kind as AgentSessionKind | undefined) ?? undefined,
        agentSessionId: meta.agent_session_id ?? undefined,
      }
    : null;
  const sessionClaim = sessionPayload
    ? workspaceListStore.setPaneAgentSessionFromMetadata(meta.session_id, sessionPayload)
    : null;
  const sessionClaimAccepted = sessionClaim?.accepted ?? true;
  if (sessionClaim?.conflict) {
    const currentMeta = paneMetadataStore.metadata[meta.session_id];
    const currentMetaKey = agentSessionIdentityKey(
      currentMeta?.agentKind,
      currentMeta?.agentSessionId,
      currentMeta?.claudeSessionId,
    );
    if (currentMetaKey === sessionClaim.conflict.key) {
      paneMetadataStore.clearAgentSessionId(meta.session_id);
      paneMetadataStore.clearClaudeSessionId(meta.session_id);
    }
  }
  paneMetadataStore.setMetadata(meta.session_id, {
    cwd: meta.cwd || undefined,
    gitBranch: meta.git_branch,
    processIsShell,
    backendProcessStatus: meta.process_status,
    claudeSessionId: sessionClaimAccepted && resumeActive ? meta.claude_session_id ?? undefined : undefined,
    agentKind: sessionClaimAccepted && resumeActive ? meta.agent_kind ?? undefined : undefined,
    agentSessionId: sessionClaimAccepted && resumeActive ? meta.agent_session_id ?? undefined : undefined,
  });
  paneMetadataStore.setVolatileMetadata(meta.session_id, {
    processTitle: meta.process_name ?? undefined,
    backendLastOutputAt: meta.last_output_at,
  });
  // The workspace claim is intentionally applied before pane metadata.
  // Otherwise a rejected duplicate can re-enter persistence via toConfig's
  // paneMetadataStore fallback.
}
