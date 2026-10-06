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
function setLiveObservation(sessionId: string, kind: string | null, alive: boolean): void {
  liveRevisions.set(sessionId, (liveRevisions.get(sessionId) ?? 0) + 1);
  usePaneMetadataStore.getState().setLiveAgent(sessionId, kind, alive);
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
  const snapshot = await getPtyMetadataSnapshot();
  if (!isCurrent()) return;
  const owned = ownedTerminalSessions();
  for (const [id, revision] of before) {
    if (!owned.has(id) || revision !== (liveRevisions.get(id) ?? 0)) continue;
    const meta = snapshot[id];
    setLiveObservation(id, meta?.live_agent_kind ?? null, meta !== undefined);
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
  void loaded.then(() => { ready = true; schedule(); });
  return () => {
    alive = false;
    stopOwnerNavigation();
    unsubscribe();
    for (const unlisten of exits.values()) unlisten();
    exits.clear();
    exitRegistrations.clear();
  };
}

export function applyPtyMetadata(meta: PtyMetadata): void {
  const foregroundIsShell = isShellProcess(meta.process_name ?? undefined);
  const liveKind = normalizeDisplayAgentKind(meta.live_agent_kind);
  const agentActive = meta.agent_active === true || liveKind !== null;
  const processIsShell = agentActive ? false : foregroundIsShell;
  setLiveObservation(meta.session_id, meta.live_agent_kind ?? null, true);
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
