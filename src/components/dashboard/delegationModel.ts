import type { WindowFragment, PtyMetadataSnapshot } from "../../lib/ipc";
import { normalizeDisplayAgentKind } from "../../lib/agentDisplayKind";
import type { PaneVolatileMetadata } from "../../stores/paneMetadataStore";
import type { PaneTab, Workspace } from "../../types";
import { observationClockRolledBack } from "../../lib/observationClock";

export type DelegationParentState = "unknown" | "alive" | "ended";
export interface DelegationParent {
  tabId: string; label: string; alive: boolean;
  state?: DelegationParentState; checkedAt?: number; firstObservedAt?: number; sessionId?: string;
  agentSessionId?: string; processStartedAt?: number;
  unknownSince?: number; identityUnknownSince?: number; startUnknownSince?: number;
}
export const DELEGATION_PARENT_TTL_MS = 120_000;
export const DELEGATION_QUERY_TIMEOUT_MS = 5_000;

export function localParentState(observation: PaneVolatileMetadata | undefined): DelegationParentState {
  if (!observation || observation.liveAgentObservationKnown === false) return "unknown";
  if (observation.ptyAlive === false) return "ended";
  if (observation.ptyAlive !== true || observation.liveAgentKind === undefined) return "unknown";
  return normalizeDisplayAgentKind(observation.liveAgentKind) ? "alive" : "ended";
}
export function processParentState(process: PtyMetadataSnapshot[string] | undefined): DelegationParentState {
  if (!process) return "ended"; // Only for a known PTY in a successful running-PTY snapshot.
  if (normalizeDisplayAgentKind(process.live_agent_kind)) return "alive";
  return process.process_name ? "ended" : "unknown";
}

/** The only display decision: current existence, liveness, same conversation, bounded uncertainty. */
export function resolveDelegationState(child: Pick<PaneTab, "delegatedByTabId" | "delegatedByAgentSessionId" | "delegatedAt">,
  parent: DelegationParent | undefined, now: number): DelegationParentState {
  if (!child.delegatedByTabId) return "ended";
  const uncertain = (since?: number): DelegationParentState =>
    since !== undefined && now - since >= DELEGATION_PARENT_TTL_MS ? "ended" : "unknown";
  if (!parent) return "unknown"; // The observation owner records the initial epoch, not the child age.
  const state = parent.state ?? (parent.alive ? "alive" : "ended");
  if (state === "ended") return "ended";
  if (state === "unknown") return uncertain(parent.unknownSince ?? parent.firstObservedAt);
  if (parent.checkedAt !== undefined && now - parent.checkedAt >= DELEGATION_PARENT_TTL_MS) {
    return uncertain(parent.unknownSince ?? parent.checkedAt);
  }
  if (child.delegatedByAgentSessionId) {
    return parent.agentSessionId ? parent.agentSessionId === child.delegatedByAgentSessionId ? "alive" : "ended"
      : uncertain(parent.identityUnknownSince ?? parent.unknownSince ?? parent.firstObservedAt);
  }
  if (child.delegatedAt === undefined) return uncertain(parent.firstObservedAt ?? parent.unknownSince);
  if (parent.processStartedAt === undefined) {
    return uncertain(parent.startUnknownSince ?? parent.unknownSince ?? parent.firstObservedAt);
  }
  // sysinfo process.start_time() * 1000 has one-second precision. The whole
  // possible birth second must precede creation; a same-second agent is not proof.
  return parent.processStartedAt + 1000 <= child.delegatedAt ? "alive" : "ended";
}

/** Rebase once in the hook's retained state, so a future epoch cannot extend every render. */
export function rebaseDelegationParentClock(parent: DelegationParent, now: number): DelegationParent {
  const fields = ["checkedAt", "firstObservedAt", "unknownSince", "identityUnknownSince", "startUnknownSince"] as const;
  if (!fields.some(field => observationClockRolledBack(parent[field], now))) return parent;
  const next = { ...parent };
  for (const field of fields) if (next[field] !== undefined && next[field]! > now) next[field] = now;
  if (observationClockRolledBack(parent.checkedAt, now) && (parent.state ?? (parent.alive ? "alive" : "ended")) === "alive") {
    next.state = "unknown";
    next.alive = false;
    next.unknownSince = now;
  }
  return next;
}

export function mergeDelegationParent(previous: DelegationParent | undefined, next: DelegationParent, now = Date.now()): DelegationParent {
  previous = previous ? rebaseDelegationParentClock(previous, now) : undefined;
  next = rebaseDelegationParentClock(next, now);
  const state = next.state ?? (next.alive ? "alive" : "ended");
  const oldState = previous?.state ?? (previous ? previous.alive ? "alive" : "ended" : "unknown");
  if (state === "unknown" && oldState === "ended") return previous!;
  if (previous?.checkedAt !== undefined && oldState !== "unknown"
    && (next.checkedAt === undefined || next.checkedAt < previous.checkedAt)) return previous;
  const at = next.checkedAt;
  return {
    ...next,
    firstObservedAt: previous?.firstObservedAt ?? next.firstObservedAt ?? at ?? next.unknownSince,
    unknownSince: state === "unknown" ? previous?.unknownSince ?? next.unknownSince ?? at : undefined,
    identityUnknownSince: next.agentSessionId ? undefined : next.identityUnknownSince ?? previous?.identityUnknownSince ?? at,
    startUnknownSince: next.processStartedAt !== undefined ? undefined : next.startUnknownSince ?? previous?.startUnknownSince ?? at,
  };
}

export async function delegationReadWithTimeout<T>(read: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([read, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("delegation observation timed out")), DELEGATION_QUERY_TIMEOUT_MS);
    })]);
  } finally { clearTimeout(timer); }
}

/** Published workspaces win over pending adoption copies; a tab has one owner. */
export function canonicalFragmentTabs(fragments: readonly WindowFragment[]) {
  const workspaces = new Set<string>(), tabs = new Set<string>();
  return [...fragments].sort((a, b) => Number(Boolean(a.pending)) - Number(Boolean(b.pending)))
    .flatMap(fragment => fragment.workspaces.flatMap(workspace => {
      if (workspaces.has(workspace.id)) return [];
      workspaces.add(workspace.id);
      return workspace.panes.flatMap(pane => (pane.tabs ?? []).filter(tab => {
        if (!tab.tab_id || tabs.has(tab.tab_id)) return false;
        tabs.add(tab.tab_id);
        return true;
      }));
    }));
}

// Facts already read by the dashboard; creating a seat never initiates a read.
let knownPeerTabs: ReturnType<typeof canonicalFragmentTabs> = [];
export function rememberDelegationFragments(fragments: readonly WindowFragment[]): void {
  knownPeerTabs = canonicalFragmentTabs(fragments);
}
export function delegationForCaller(workspaces: readonly Workspace[],
  observations: Record<string, PaneVolatileMetadata | undefined>, anchorSessionId: string | undefined,
  anchorTabId?: string): Pick<PaneTab, "delegatedByTabId" | "delegatedByAgentSessionId" | "delegatedAt"> {
  if (!anchorSessionId && !anchorTabId) return {};
  const local = anchorSessionId ? workspaces.flatMap(workspace => workspace.panes.flatMap(pane => pane.tabs))
    .find(tab => tab.sessionId === anchorSessionId && (tab.type === undefined || tab.type === "terminal")) : undefined;
  const peer = anchorSessionId ? knownPeerTabs.find(tab => tab.session_id === anchorSessionId && (tab.type == null || tab.type === "terminal")) : undefined;
  const id = local?.id ?? peer?.tab_id ?? anchorTabId;
  if (!id) return { delegatedAt: Date.now() };
  const observation = anchorSessionId ? observations[anchorSessionId] : undefined;
  return {
    delegatedByTabId: id,
    delegatedByAgentSessionId: observation?.liveAgentObservationKnown === false
      || (observation?.liveAgentObservedAt !== undefined && Date.now() - observation.liveAgentObservedAt >= DELEGATION_PARENT_TTL_MS)
      ? undefined : observation?.liveAgentSessionId,
    delegatedAt: Date.now(),
  };
}

export function delegationParentsFromFragments(fragments: readonly WindowFragment[], processes: PtyMetadataSnapshot,
  requestedAt = Date.now()): Record<string, DelegationParent> {
  return Object.fromEntries(canonicalFragmentTabs(fragments).map(tab => {
    const process = tab.session_id ? processes[tab.session_id] : undefined;
    const state = tab.session_id ? processParentState(process) : "unknown";
    return [tab.tab_id!, {
      tabId: tab.tab_id!, sessionId: tab.session_id ?? undefined,
      label: tab.label || tab.display_name || normalizeDisplayAgentKind(process?.live_agent_kind) || tab.agent_id,
      alive: state === "alive", state, checkedAt: process?.observed_at || requestedAt,
      agentSessionId: process?.agent_session_trusted === false ? undefined : process?.agent_session_id ?? process?.claude_session_id,
      processStartedAt: process?.agent_started_at ?? undefined,
    }];
  }));
}
