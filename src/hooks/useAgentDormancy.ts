import { useEffect } from "react";
import {
  AGENT_DORMANT_SWEEP_INTERVAL_MS,
  clearSessionFrontendActivity,
  getSessionFrontendActivity,
  observeDormancyActivity,
  readDormantThresholdMs,
  resolveDormantAction,
  resolveDormantResumeIdentity,
  resolveRenderedTabId,
  type DormancyObservation,
  type DormantSessionCandidate,
} from "../lib/agentDormancy";
import { resetShellObservation } from "../lib/agentSessionClearGuard";
import {
  getPtyMetadataSnapshot,
  getSessionScrollback,
  killSession,
  type PtyMetadataSnapshot,
} from "../lib/ipc";
import { usePaneMetadataStore } from "../stores/paneMetadataStore";
import { useSavepointDragStore } from "../stores/savepointDragStore";
import { useWorkspaceListStore } from "../stores/workspaceListStore";
import { evictTerminalCache, liveTerms } from "../components/terminal/terminalCache";

interface RuntimeDormancyTarget {
  sessionId: string;
  candidate: DormantSessionCandidate;
}

function collectRuntimeTargets(
  ptyMetadata: PtyMetadataSnapshot,
  thresholdMs: number,
): RuntimeDormancyTarget[] {
  const { activeWorkspaceId, workspaces } = useWorkspaceListStore.getState();
  const effectiveActiveWorkspaceId = activeWorkspaceId ?? workspaces[0]?.id ?? null;
  const dragSourceWorkspaceId = useSavepointDragStore.getState().item?.sourceWorkspaceId ?? null;
  const targets = new Map<string, RuntimeDormancyTarget>();

  for (const workspace of workspaces) {
    for (const pane of workspace.panes) {
      const renderedTabId = resolveRenderedTabId(pane);
      for (const tab of pane.tabs) {
        if (tab.type !== undefined && tab.type !== "terminal") continue;
        const identity = resolveDormantResumeIdentity(tab);
        const metadata = ptyMetadata[tab.sessionId];
        if (!identity || !metadata) continue;
        targets.set(tab.sessionId, {
          sessionId: tab.sessionId,
          candidate: {
            agentKind: identity.agentKind,
            resumeSessionId: identity.resumeSessionId,
            visible: (
              workspace.id === effectiveActiveWorkspaceId
              || workspace.id === dragSourceWorkspaceId
            ) && tab.id === renderedTabId,
            mounted: liveTerms.has(tab.sessionId),
            processStatus: metadata.process_status ?? null,
            lastActivityAt: 0,
            thresholdMs,
          },
        });
      }
    }
  }

  return Array.from(targets.values());
}

function findRuntimeTarget(
  sessionId: string,
  ptyMetadata: PtyMetadataSnapshot,
  thresholdMs: number,
): RuntimeDormancyTarget | null {
  return collectRuntimeTargets(ptyMetadata, thresholdMs)
    .find((target) => target.sessionId === sessionId) ?? null;
}

export function useAgentDormancy(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;

    const thresholdMs = readDormantThresholdMs();
    if (thresholdMs === 0) return;

    const observations = new Map<string, DormancyObservation>();
    let cancelled = false;
    let inFlight = false;

    const sweep = async (): Promise<void> => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        let ptyMetadata: PtyMetadataSnapshot;
        try {
          ptyMetadata = await getPtyMetadataSnapshot();
        } catch (error) {
          console.warn("[mycmux] agent dormancy metadata sweep failed", error);
          return;
        }
        if (cancelled) return;

        const targets = collectRuntimeTargets(ptyMetadata, thresholdMs);
        const retainedSessionIds = new Set(targets.map((target) => target.sessionId));
        for (const sessionId of observations.keys()) {
          if (!retainedSessionIds.has(sessionId)) observations.delete(sessionId);
        }

        for (const target of targets) {
          if (cancelled) return;
          if (
            target.candidate.visible
            || target.candidate.processStatus === "working"
          ) {
            observations.delete(target.sessionId);
            continue;
          }

          let snapshot;
          try {
            snapshot = await getSessionScrollback(target.sessionId);
          } catch {
            observations.delete(target.sessionId);
            continue;
          }
          if (cancelled) return;

          const now = Date.now();
          const observation = observeDormancyActivity(
            observations.get(target.sessionId),
            snapshot.endOffset,
            getSessionFrontendActivity(target.sessionId),
            now,
          );
          observations.set(target.sessionId, observation);
          const candidate = { ...target.candidate, lastActivityAt: observation.lastActivityAt };
          if (resolveDormantAction(candidate, now) === "none") continue;

          let latestSnapshot;
          try {
            latestSnapshot = await getSessionScrollback(target.sessionId);
          } catch {
            observations.delete(target.sessionId);
            continue;
          }
          const recheckedAt = Date.now();
          const recheckedObservation = observeDormancyActivity(
            observation,
            latestSnapshot.endOffset,
            getSessionFrontendActivity(target.sessionId),
            recheckedAt,
          );
          observations.set(target.sessionId, recheckedObservation);

          let latestMetadata: PtyMetadataSnapshot;
          try {
            latestMetadata = await getPtyMetadataSnapshot();
          } catch {
            continue;
          }
          const latestTarget = findRuntimeTarget(target.sessionId, latestMetadata, thresholdMs);
          if (!latestTarget || cancelled) {
            observations.delete(target.sessionId);
            continue;
          }
          const finalAt = Date.now();
          const finalObservation = observeDormancyActivity(
            recheckedObservation,
            latestSnapshot.endOffset,
            getSessionFrontendActivity(target.sessionId),
            finalAt,
          );
          observations.set(target.sessionId, finalObservation);
          const finalCandidate = {
            ...latestTarget.candidate,
            lastActivityAt: finalObservation.lastActivityAt,
          };
          const action = resolveDormantAction(finalCandidate, finalAt);
          if (action === "none") {
            if (finalCandidate.visible || finalCandidate.processStatus === "working") {
              observations.delete(target.sessionId);
            }
            continue;
          }
          if (action === "evictCache") {
            evictTerminalCache(target.sessionId);
            continue;
          }
          if (
            cancelled
            || finalCandidate.visible
            || finalCandidate.mounted
            || finalCandidate.processStatus === "working"
            || liveTerms.has(target.sessionId)
          ) continue;

          resetShellObservation(target.sessionId);
          evictTerminalCache(target.sessionId);
          try {
            await killSession(target.sessionId);
          } catch (error) {
            console.warn("[mycmux] agent dormancy kill failed", target.sessionId, error);
            continue;
          }
          resetShellObservation(target.sessionId);
          observations.delete(target.sessionId);
          clearSessionFrontendActivity(target.sessionId);
          usePaneMetadataStore.getState().setMetadata(target.sessionId, {
            agentStatus: "idle",
            processIsShell: true,
          });
        }
      } finally {
        inFlight = false;
      }
    };

    void sweep();
    const intervalId = window.setInterval(() => {
      void sweep();
    }, AGENT_DORMANT_SWEEP_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [enabled]);
}
