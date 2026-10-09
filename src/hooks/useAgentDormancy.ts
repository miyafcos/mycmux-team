import { useEffect, useState } from "react";
import {
  AGENT_DORMANCY_SETTINGS_EVENT,
  AGENT_DORMANT_SWEEP_INTERVAL_MS,
  DORMANCY_HISTORY_SCAN_LINES,
  clearSessionFrontendActivity,
  classifyDormancyNotifications,
  countDormancySeats,
  evaluateDormancy,
  fingerprintDormancySemanticState,
  getSessionFrontendActivity,
  hasFreshAgentWork,
  hasBlockingDormancyAttention,
  hasWorkingScreenEvidence,
  isEffectivelyWorking,
  observeDormancyActivity,
  readDormantThresholdMs,
  resolveDormantResumeIdentity,
  resolveRenderedTabId,
  type DormancyObservation,
  type DormantSessionCandidate,
  type DormancyPressureSample,
} from "../lib/agentDormancy";
import { resetShellObservation } from "../lib/agentSessionClearGuard";
import {
  getPtyMetadataSnapshot,
  getAvailableMemoryMiB,
  getWindowFragments,
  saveAgentDormancyRecord,
  getSessionScrollback,
  killSession,
  type PtyMetadataSnapshot,
  type DormancyRecordReceipt,
} from "../lib/ipc";
import { usePaneMetadataStore } from "../stores/paneMetadataStore";
import { useSavepointDragStore } from "../stores/savepointDragStore";
import { attentionCategory, useSessionAttentionStore } from "../stores/sessionAttentionStore";
import { useWorkspaceListStore } from "../stores/workspaceListStore";
import { getHeadlessBufferLines } from "../components/terminal/headlessBuffer";
import { evictTerminalCache, liveTerms } from "../components/terminal/terminalCache";
import { useSettingsStore } from "../stores/settingsStore";
import { useAskQuestionStore } from "../stores/askQuestionStore";
import { useToastStore } from "../stores/toastStore";
import { getTabDisplayLabel } from "../lib/tabDisplayLabel";
import { openTabSweepInDashboard } from "../components/layout/tabSweep";
import { AGENT_DORMANCY_REVIEW_EVENT, matchesDormancyApproval, useAgentDormancyStore, type AgentDormancyProposal } from "../stores/agentDormancyStore";

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
        if ((metadata.agent_kind && metadata.agent_kind !== identity.agentKind)
          || (metadata.agent_session_id && metadata.agent_session_id !== identity.resumeSessionId)) continue;
        const mounted = liveTerms.has(tab.sessionId);
        const tabMetadata = paneMetadata[tab.sessionId];
        const visible = (
          workspace.id === effectiveActiveWorkspaceId
          || workspace.id === dragSourceWorkspaceId
        ) && tab.id === renderedTabId;
        const canonical = attentionBySession[tab.sessionId];
        const question = useAskQuestionStore.getState().bySession[tab.sessionId];
        const notificationState = classifyDormancyNotifications({
          attentionKind: canonical?.kind,
          unseenCompletion: attentionCategory(tab.id, canonical, seenAttentionByTab) === "done",
          notificationCount: tabMetadata?.notificationCount ?? 0,
          workDoneCount: tabMetadata?.workDoneCount ?? 0,
          waiting: canonical?.uiState === "working" || canonical?.uiState === "waiting" || tabMetadata?.agentStatus === "waiting",
          hasQuestion: Boolean(question && (question.screen !== null || question.stopReason !== null)),
        });
        const hasAttention = notificationState !== "none";
        const rateLimited = attentionBySession[tab.sessionId]?.kind === "rate_limited";
        const existing = targets.get(tab.sessionId);
        if (existing) {
          existing.candidate.visible ||= visible;
          existing.candidate.mounted ||= mounted;
          existing.candidate.hasAttention ||= hasAttention;
          if (notificationState === "blocking" || (notificationState === "completion_only" && existing.candidate.notificationState !== "blocking")) {
            existing.candidate.notificationState = notificationState;
          }
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
            notificationState,
            allowUnreadCompletion: useSettingsStore.getState().dormancyAllowUnreadCompletion,
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
  const pressureSettings = useSettingsStore((state) => state.dormancyPressureSettings);
  const allowCompletion = useSettingsStore((state) => state.dormancyAllowUnreadCompletion);

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
    let requested = false;
    let sample: DormancyPressureSample = { availableMemoryMiB: null, paneCount: 0 };
    const savedRecords = new Map<string, DormancyRecordReceipt>();
    const actionFor = (candidate: DormantSessionCandidate, now: number, sessionId: string) => {
      const receipt = savedRecords.get(sessionId);
      return evaluateDormancy({ ...candidate, completionTranscriptSaved: Boolean(receipt
        && receipt.agentKind === candidate.agentKind && receipt.agentSessionId === candidate.resumeSessionId
        && receipt.ptySessionId === sessionId && receipt.bytes > 0) }, now, sample, pressureSettings).action;
    };

    const sweep = async (): Promise<void> => {
      if (cancelled) return;
      if (inFlight) { requested = true; return; }
      inFlight = true;
      savedRecords.clear();
      const approvals = { ...useAgentDormancyStore.getState().approvals };
      const proposals: AgentDormancyProposal[] = [];
      try {
        const [memory, fragments] = await Promise.allSettled([getAvailableMemoryMiB(), getWindowFragments()]);
        sample = {
          availableMemoryMiB: memory.status === "fulfilled" ? memory.value : null,
          paneCount: countDormancySeats(useWorkspaceListStore.getState().workspaces,
            fragments.status === "fulfilled" && Array.isArray(fragments.value) ? fragments.value : []),
        };
        if (cancelled) return;
        useAgentDormancyStore.getState().setSample(sample);
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
            || hasBlockingDormancyAttention(target.candidate)
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
          const decision = evaluateDormancy(candidate, now, sample, pressureSettings);
          if (decision.action === "none") continue;
          const tabOwner = useWorkspaceListStore.getState().workspaces.flatMap((workspace) => workspace.panes.flatMap((pane) =>
            pane.tabs.filter((tab) => tab.sessionId === target.sessionId).map((tab) => ({ tab, workspace }))))[0];
          const proposal: AgentDormancyProposal = {
            sessionId: target.sessionId, resumeSessionId: candidate.resumeSessionId!,
            agentKind: candidate.agentKind as "claude" | "codex",
            label: tabOwner ? getTabDisplayLabel(tabOwner.tab) : target.sessionId,
            workspaceName: tabOwner?.workspace.name ?? "", lastActivityAt: candidate.lastActivityAt,
            processStatusAt: candidate.processStatusAt, idleMinutes: Math.floor((now - candidate.lastActivityAt) / 60_000),
            stage: decision.stage,
          };
          if (decision.requiresConfirmation && !matchesDormancyApproval(approvals[target.sessionId], proposal, now)) {
            proposals.push(proposal);
            continue;
          }
          if (decision.action === "saveTranscript") {
            try {
              const receipt = await saveAgentDormancyRecord(target.sessionId, proposal.agentKind, proposal.resumeSessionId);
              if (cancelled) return;
              savedRecords.set(target.sessionId, receipt);
            } catch (error) {
              console.warn("[mycmux] completed conversation could not be saved for dormancy", target.sessionId, error);
              continue;
            }
          }

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
          if (actionFor(rechecked.candidate, recheckedAt, target.sessionId) === "none") continue;

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
          const action = actionFor(finalCandidate, killCheckedAt, target.sessionId);
          if (action === "none") {
            if (
              finalCandidate.visible
              || hasBlockingDormancyAttention(finalCandidate)
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
            || actionFor(preKillCandidate, Date.now(), target.sessionId) !== "kill"
            || (decision.requiresConfirmation && !matchesDormancyApproval(approvals[target.sessionId], {
              ...proposal, resumeSessionId: preKillCandidate.resumeSessionId!,
              agentKind: preKillCandidate.agentKind as "claude" | "codex",
              lastActivityAt: preKillCandidate.lastActivityAt, processStatusAt: preKillCandidate.processStatusAt,
            }, Date.now()))
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
          // The final read can deliver attention or a workspace activation.
          // Recollect synchronous state after that last await before stopping.
          const currentTarget = findRuntimeTarget(target.sessionId, preKillMetadata, thresholdMs);
          const currentCandidate = currentTarget ? { ...preKillCandidate, ...currentTarget.candidate,
            screenWorking: preKillCandidate.screenWorking, lastActivityAt: preKillCandidate.lastActivityAt } : null;
          if (
            cancelled
            || !currentCandidate
            || actionFor(currentCandidate, Date.now(), target.sessionId) !== "kill"
            || liveTerms.has(target.sessionId)
          ) continue;

          if (currentCandidate.notificationState === "completion_only") {
            const receipt = savedRecords.get(target.sessionId);
            const state = useSessionAttentionStore.getState();
            const current = state.attentionBySession[target.sessionId];
            const tabIds = useWorkspaceListStore.getState().workspaces.flatMap((workspace) => workspace.panes.flatMap((pane) =>
              pane.tabs.filter((tab) => tab.sessionId === target.sessionId).map((tab) => tab.id)));
            if (!receipt || !state.preserveDormantCompletion(target.sessionId, tabIds, receipt,
              current?.kind === "done" ? current.attentionId : null)) {
              console.warn("[mycmux] unread completion could not be preserved; keeping the process", target.sessionId);
              continue;
            }
          }

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
        if (!cancelled) {
          const previousIds = new Set(useAgentDormancyStore.getState().proposals.map((entry) => entry.sessionId));
          useAgentDormancyStore.getState().setProposals(proposals);
          useAgentDormancyStore.getState().finishApprovals(Object.keys(approvals));
          if (proposals.some((entry) => !previousIds.has(entry.sessionId))) {
            useToastStore.getState().pushToast(`休止候補が${proposals.length}件あります。確認するまでプロセスは終了しません`, "info", undefined,
              [{ label: "候補を確認", run: openTabSweepInDashboard }], undefined, "system");
          }
        }
        inFlight = false;
        if (requested && !cancelled) { requested = false; void sweep(); }
      }
    };

    void sweep();
    const reviewRequested = () => { void sweep(); };
    window.addEventListener(AGENT_DORMANCY_REVIEW_EVENT, reviewRequested);
    const intervalId = window.setInterval(() => {
      void sweep();
    }, AGENT_DORMANT_SWEEP_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.removeEventListener(AGENT_DORMANCY_REVIEW_EVENT, reviewRequested);
      useAgentDormancyStore.getState().setProposals([]);
    };
  }, [enabled, thresholdMs, pressureSettings, allowCompletion]);
}
