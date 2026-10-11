import { useEffect, useRef, useState } from "react";
import { getPtyMetadataSnapshot, getWindowFragments } from "../../lib/ipc";
import { usePaneMetadataStore } from "../../stores/paneMetadataStore";
import type { Workspace } from "../../types";
import {
  delegationParentsFromFragments, delegationReadWithTimeout, mergeDelegationParent,
  processParentState, localParentState, rememberDelegationFragments, rebaseDelegationParentClock, type DelegationParent,
} from "./delegationModel";

/** Observation only. Seat creation never waits for this read or starts one. */
export function useDelegationParents(workspaces: readonly Workspace[]): Record<string, DelegationParent> {
  const currentWorkspaces = useRef(workspaces);
  currentWorkspaces.current = workspaces;
  const ids = [...new Set(workspaces.flatMap(workspace => workspace.panes.flatMap(pane => pane.tabs
    .flatMap(tab => tab.delegatedByTabId ? [tab.delegatedByTabId] : []))))].sort();
  const key = JSON.stringify(ids);
  const initialParent = (tabId: string, now: number): DelegationParent =>
    ({ tabId, label: tabId, alive: false, state: "unknown", unknownSince: now, firstObservedAt: now });
  const now = Date.now();
  const [parents, setParents] = useState<Record<string, DelegationParent>>(() =>
    Object.fromEntries(ids.map(id => [id, initialParent(id, now)])));
  // Synchronize new wanted IDs and rollback epochs before returning the first
  // frame. These retained epochs survive failures, hung reads and later renders.
  const current = Object.fromEntries(ids.map(id => [id, parents[id]
    ? rebaseDelegationParentClock(parents[id], now) : initialParent(id, now)]));
  if (Object.keys(parents).length !== ids.length || ids.some(id => current[id] !== parents[id])) {
    setParents(current);
  }
  useEffect(() => {
    if (key === "[]") return;
    const wanted = JSON.parse(key) as string[];
    let alive = true, inFlight = false, warned = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      const requestedAt = Date.now();
      try {
        const [fragments, processes] = await delegationReadWithTimeout(Promise.all([getWindowFragments(), getPtyMetadataSnapshot()]));
        if (!alive) return;
        rememberDelegationFragments(fragments);
        const peer = delegationParentsFromFragments(fragments, processes, requestedAt);
        const local = currentWorkspaces.current.flatMap(workspace => workspace.panes.flatMap(pane => pane.tabs));
        setParents(previous => Object.fromEntries(wanted.map(id => {
          const tab = local.find(tab => tab.id === id);
          const sessionId = tab?.sessionId ?? peer[id]?.sessionId ?? previous[id]?.sessionId;
          const process = sessionId ? processes[sessionId] : undefined;
          // Missing location is unknown; a known missing PTY is confirmed death.
          const state = !sessionId ? "unknown"
            : !tab && !peer[id] && process ? "unknown" : processParentState(process);
          const next: DelegationParent = {
            tabId: id, sessionId, label: tab?.label || tab?.displayName || peer[id]?.label || previous[id]?.label || id,
            state, alive: state === "alive", checkedAt: process?.observed_at || requestedAt,
            agentSessionId: process?.agent_session_trusted === false ? undefined : process?.agent_session_id ?? process?.claude_session_id,
            processStartedAt: process?.agent_started_at ?? undefined,
          };
          let merged = mergeDelegationParent(previous[id], next);
          // Receiving a response does not make its old process observation newer.
          const observation = sessionId ? usePaneMetadataStore.getState().volatileMetadata[sessionId] : undefined;
          const localState = localParentState(observation);
          if (tab && localState !== "unknown") merged = mergeDelegationParent(merged, {
            tabId: id, sessionId, label: next.label, state: localState, alive: localState === "alive",
            checkedAt: observation?.liveAgentObservedAt, firstObservedAt: observation?.liveAgentChangedAt,
            agentSessionId: observation?.liveAgentSessionId, processStartedAt: observation?.liveAgentStartedAt,
            identityUnknownSince: observation?.liveAgentIdentityUnknownSince,
            startUnknownSince: observation?.liveAgentStartUnknownSince,
          });
          return [id, merged];
        })));
        warned = false;
      } catch (error) {
        if (alive) {
          setParents(previous => Object.fromEntries(wanted.map(id => [id, mergeDelegationParent(previous[id], {
            ...previous[id], tabId: id, label: previous[id]?.label || id, state: "unknown", alive: false,
            checkedAt: previous[id]?.checkedAt, unknownSince: previous[id]?.unknownSince ?? requestedAt,
          })])));
          if (!warned) { console.warn("[dashboard] Failed to read delegation parents:", error); warned = true; }
        }
      } finally { inFlight = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [key]);
  return current;
}
