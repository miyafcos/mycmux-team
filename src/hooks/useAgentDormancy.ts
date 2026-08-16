import { useEffect, useState } from "react";
import {
  AGENT_DORMANCY_SETTINGS_EVENT,
  AGENT_DORMANT_SWEEP_INTERVAL_MS,
  DORMANCY_HISTORY_SCAN_LINES,
  clearSessionFrontendActivity,
  fingerprintDormancySemanticState,
  getSessionFrontendActivity,
  hasFreshAgentWork,
  hasWorkingScreenEvidence,
  isEffectivelyWorking,
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
import { attentionCategory, useSessionAttentionStore } from "../stores/sessionAttentionStore";
import { useWorkspaceListStore } from "../stores/workspaceListStore";
import { getHeadlessBufferLines } from "../components/terminal/headlessBuffer";
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
  const effectiveActiveWorkspaceId = workspaces.some((workspace) => workspace.id === activeWorkspaceId)
    ? activeWorkspaceId
    : workspaces[0]?.id ?? null;
  const dragSourceWorkspaceId = useSavepointDragStore.getState().item?.sourceWorkspaceId ?? null;
  const paneMetadata = usePaneMetadataStore.getState().metadata;
  const { attentionBySession, seenAttentionByTab } = useSessionAttentionStore.getState();
  const targets = new Map<string, RuntimeDormancyTarget>();

  for (const workspace of workspaces) {
    for (const pane of workspace.panes) {
      const renderedTabId = resolveRenderedTabId(pane);
      for (const tab of pane.tabs) {
        if (tab.type !== undefined && tab.type !== "terminal") continue;
        const identity = resolveDormantResumeIdentity(tab);
        const metadata = ptyMetadata[tab.sessionId];
        if (!identity || !metadata) continue;
        const mounted = liveTerms.has(tab.sessionId);
        const tabMetadata = paneMetadata[tab.sessionId];
        const visible = (
          workspace.id === effectiveActiveWorkspaceId
          || workspace.id === dragSourceWorkspaceId
        ) && tab.id === renderedTabId;
        const hasAttention = tabMetadata?.agentStatus === "waiting"
          || (tabMetadata?.notificationCount ?? 0) > 0
          || (tabMetadata?.workDoneCount ?? 0) > 0
          || attentionCategory(
            tab.id,
            attentionBySession[tab.sessionId],
            seenAttentionByTab,
          ) !== null;
        const rateLimited = attentionBySession[tab.sessionId]?.kind === "rate_limited";
        const existing = targets.get(tab.sessionId);
        if (existing) {
          existing.candidate.visible ||= visible;
          existing.candidate.mounted ||= mounted;
          existing.candidate.hasAttention ||= hasAttention;
          existing.candidate.rateLimited ||= rateLimited;
          existing.candidate.agentStatusFresh ||= mounted;
          continue;
        }
        targets.set(tab.sessionId, {
          sessionId: tab.sessionId,
          candidate: {
            agentKind: identity.agentKind,
            resumeSessionId: identity.resumeSessionId,
            visible,
            mounted,
            processStatus: metadata.process_status ?? null,
            processName: metadata.process_name ?? null,
            processStatusAt: metadata.process_status_at ?? null,
            agentStatus: tabMetadata?.agentStatus ?? null,
            agentStatusFresh: mounted,
            hasAttention,
            rateLimited,
            screenWorking: false,
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

async function observeRuntimeTarget(
  target: RuntimeDormancyTarget,
  snapshot: Awaited<ReturnType<typeof getSessionScrollback>>,
  previous: DormancyObservation | undefined,
  now: number,
): Promise<{ candidate: DormantSessionCandidate; observation: DormancyObservation }> {
  const lines = await getHeadlessBufferLines(
    target.sessionId,
    snapshot,
    DORMANCY_HISTORY_SCAN_LINES,
  );
  const semanticFingerprint = await fingerprintDormancySemanticState(lines);
  const observation = observeDormancyActivity(
    previous,
    snapshot.endOffset,
    target.candidate.processStatusAt,
    semanticFingerprint,
    getSessionFrontendActivity(target.sessionId),
    now,
  );
  return {
    observation,
    candidate: {
      ...target.candidate,
      screenWorking: hasWorkingScreenEvidence(lines),
      lastActivityAt: observation.lastActivityAt,
    },
  };
}

export function useAgentDormancy(enabled: boolean): void {
  const [thresholdMs, setThresholdMs] = useState(readDormantThresholdMs);

  useEffect(() => {
    const refreshThreshold = (): void => setThresholdMs(readDormantThresholdMs());
    window.addEventListener(AGENT_DORMANCY_SETTINGS_EVENT, refreshThreshold);
    window.addEventListener("storage", refreshThreshold);
    return () => {
      window.removeEventListener(AGENT_DORMANCY_SETTINGS_EVENT, refreshThreshold);
      window.removeEventListener("storage", refreshThreshold);
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;

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
            || target.candidate.hasAttention
            || hasFreshAgentWork(target.candidate)
            || isEffectivelyWorking(target.candidate)
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
          let observed;
          try {
            observed = await observeRuntimeTarget(
              target,
              snapshot,
              observations.get(target.sessionId),
              now,
            );
          } catch {
            observations.delete(target.sessionId);
            continue;
          }
          observations.set(target.sessionId, observed.observation);
          const { candidate } = observed;
          if (resolveDormantAction(candidate, now) === "none") continue;

          let latestSnapshot;
          try {
            latestSnapshot = await getSessionScrollback(target.sessionId);
          } catch {
            observations.delete(target.sessionId);
            continue;
          }
          const recheckedAt = Date.now();
          let rechecked;
          try {
            rechecked = await observeRuntimeTarget(
              target,
              latestSnapshot,
              observed.observation,
              recheckedAt,
            );
          } catch {
            observations.delete(target.sessionId);
            continue;
          }
          observations.set(target.sessionId, rechecked.observation);
          if (resolveDormantAction(rechecked.candidate, recheckedAt) === "none") continue;

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
          let finalSnapshot;
          try {
            finalSnapshot = await getSessionScrollback(target.sessionId);
          } catch {
            observations.delete(target.sessionId);
            continue;
          }
          const finalAt = Date.now();
          let finalObserved;
          try {
            finalObserved = await observeRuntimeTarget(
              latestTarget,
              finalSnapshot,
              rechecked.observation,
              finalAt,
            );
          } catch {
            observations.delete(target.sessionId);
            continue;
          }
          observations.set(target.sessionId, finalObserved.observation);

          let finalMetadata: PtyMetadataSnapshot;
          try {
            finalMetadata = await getPtyMetadataSnapshot();
          } catch {
            continue;
          }
          const finalTarget = findRuntimeTarget(target.sessionId, finalMetadata, thresholdMs);
          if (!finalTarget || cancelled) {
            observations.delete(target.sessionId);
            continue;
          }
          let killSnapshot;
          try {
            killSnapshot = await getSessionScrollback(target.sessionId);
          } catch {
            observations.delete(target.sessionId);
            continue;
          }
          const killCheckedAt = Date.now();
          let killObserved;
          try {
            killObserved = await observeRuntimeTarget(
              finalTarget,
              killSnapshot,
              finalObserved.observation,
              killCheckedAt,
            );
          } catch {
            observations.delete(target.sessionId);
            continue;
          }
          observations.set(target.sessionId, killObserved.observation);
          const killTarget = findRuntimeTarget(target.sessionId, finalMetadata, thresholdMs);
          if (!killTarget || cancelled) {
            observations.delete(target.sessionId);
            continue;
          }
          const finalCandidate = {
            ...killObserved.candidate,
            ...killTarget.candidate,
            screenWorking: killObserved.candidate.screenWorking,
            lastActivityAt: killObserved.observation.lastActivityAt,
          };
          const action = resolveDormantAction(finalCandidate, killCheckedAt);
          if (action === "none") {
            if (
              finalCandidate.visible
              || finalCandidate.hasAttention
              || finalCandidate.rateLimited
              || finalCandidate.screenWorking
              || hasFreshAgentWork(finalCandidate)
              || isEffectivelyWorking(finalCandidate)
            ) {
              observations.delete(target.sessionId);
            }
            continue;
          }
          if (action === "evictCache") {
            evictTerminalCache(target.sessionId);
            continue;
          }
          let preKillMetadata: PtyMetadataSnapshot;
          try {
            preKillMetadata = await getPtyMetadataSnapshot();
          } catch {
            continue;
          }
          const preKillTarget = findRuntimeTarget(target.sessionId, preKillMetadata, thresholdMs);
          const preKillCandidate = preKillTarget ? {
            ...finalCandidate,
            ...preKillTarget.candidate,
            screenWorking: finalCandidate.screenWorking,
            lastActivityAt: finalCandidate.lastActivityAt,
          } : null;
          if (
            !preKillCandidate
            || preKillCandidate.processStatusAt !== finalCandidate.processStatusAt
            || resolveDormantAction(preKillCandidate, Date.now()) !== "kill"
          ) {
            observations.delete(target.sessionId);
            continue;
          }
          let preKillSnapshot;
          try {
            preKillSnapshot = await getSessionScrollback(target.sessionId);
          } catch {
            observations.delete(target.sessionId);
            continue;
          }
          if (
            preKillSnapshot.endOffset !== killSnapshot.endOffset
            || (getSessionFrontendActivity(target.sessionId) ?? 0) > killCheckedAt
          ) {
            observations.delete(target.sessionId);
            continue;
          }
          if (
            cancelled
            || preKillCandidate.visible
            || preKillCandidate.mounted
            || isEffectivelyWorking(preKillCandidate)
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
  }, [enabled, thresholdMs]);
}
