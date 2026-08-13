import { create } from "zustand";

import { getPtyMetadataSnapshot, getSessionScrollback, type PtyMetadataSnapshot, type SessionAttentionKind, type SessionUiState } from "../lib/ipc";
import { fingerprintDormancySemanticState } from "../lib/agentDormancy";
import { detectPromptShape } from "../lib/promptShape";
import { resolveStallVerdict } from "../lib/stallVerdict";
import type { SessionActivity } from "../lib/sessionStatusSignals";
import type { PaneTab } from "../types";
import { hasTerminalBuffer } from "../components/terminal/XTermWrapper";
import {
  getQueuedInputPreview,
  readTail,
  TAB_SWEEP_IDLE_MS,
  TAB_SWEEP_TAIL_LINES,
} from "../components/layout/tabSweep";
import { processStatusReasonForTab } from "../components/layout/socketCommands";
import { usePaneMetadataStore, useWorkspaceListStore } from "./workspaceStore";
import { useSessionAttentionStore } from "./sessionAttentionStore";

export const STALL_CHECK_INTERVAL_MS = 30_000;
export const STALL_STAGE_TWO_LIMIT = 5;

export type StallReason = "no_output" | "queued_input" | "silent" | "pty_dead";

export interface StallEntry {
  sessionId: string;
  reason: StallReason;
  since: number;
  detail?: string;
}

export interface StallStageOneSession {
  sessionId: string;
  type: PaneTab["type"];
  attentionKind?: SessionAttentionKind;
  attentionUiState?: SessionUiState;
  lastLogAt?: number;
  screenStatusAt?: number;
  agentStatusAt?: number;
  processStatusReason: string | null;
  hasLivePty: boolean;
  hasTerminalBuffer: boolean;
  processActivity?: SessionActivity;
}

export interface StallStageOneCandidate {
  sessionId: string;
  since: number;
  ptyDead: boolean;
  processActivity: SessionActivity;
}

interface ScreenObservation {
  endOffset: number;
  semanticFingerprint: string | null;
  screenAdvanced: boolean;
  lastActivityAt: number;
}

export function observeScreenActivity(
  previous: ScreenObservation | undefined,
  endOffset: number,
  semanticFingerprint: string | null,
  now: number,
): ScreenObservation {
  const screenAdvanced = previous !== undefined && (
    previous.semanticFingerprint === null || semanticFingerprint === null
      ? previous.endOffset !== endOffset
      : previous.semanticFingerprint !== semanticFingerprint
  );
  return {
    endOffset,
    semanticFingerprint,
    screenAdvanced,
    lastActivityAt: !previous || screenAdvanced ? now : previous.lastActivityAt,
  };
}

interface StallStoreState {
  entries: Record<string, StallEntry>;
  replaceEntries: (entries: Record<string, StallEntry>) => void;
}

export const useStallStore = create<StallStoreState>((set) => ({
  entries: {},
  replaceEntries: (entries) => set((state) => state.entries === entries ? state : { entries }),
}));

export function latestStallActivityAt(session: Pick<StallStageOneSession, "lastLogAt" | "screenStatusAt" | "agentStatusAt">): number {
  return Math.max(session.lastLogAt ?? 0, session.screenStatusAt ?? 0, session.agentStatusAt ?? 0);
}

export function selectStallCandidates(
  sessions: readonly StallStageOneSession[],
  now: number,
): StallStageOneCandidate[] {
  const candidates: StallStageOneCandidate[] = [];
  for (const session of sessions) {
    if (session.type === "browser" || session.type === "online") continue;
    if (session.attentionKind && session.attentionKind !== "none") continue;
    if (session.attentionUiState && session.attentionUiState !== "idle") continue;
    const since = latestStallActivityAt(session);
    if (session.processStatusReason === "no_live_pty_session") {
      candidates.push({ sessionId: session.sessionId, since, ptyDead: true, processActivity: session.processActivity ?? "unknown" });
      continue;
    }
    if (!session.hasLivePty && !session.hasTerminalBuffer) continue;
    if (now - since < TAB_SWEEP_IDLE_MS) continue;
    candidates.push({ sessionId: session.sessionId, since, ptyDead: false, processActivity: session.processActivity ?? "unknown" });
  }
  return candidates;
}

export function classifyStallCandidate(
  candidate: StallStageOneCandidate,
  tail: readonly string[],
  screenAdvanced = false,
  screenSilentMs = 0,
): StallEntry | null {
  const queuedInput = getQueuedInputPreview(tail);
  const verdict = resolveStallVerdict({
    processActivity: candidate.processActivity ?? "unknown",
    queuedInput: Boolean(queuedInput),
    screenAdvanced,
    screenSilentMs,
    promptShape: detectPromptShape(tail),
    ptyAlive: !candidate.ptyDead,
  }, TAB_SWEEP_IDLE_MS);
  if (verdict.state === "waiting" && verdict.reason === "queued_input") {
    return {
      sessionId: candidate.sessionId,
      reason: "queued_input",
      since: candidate.since,
      detail: Array.from(queuedInput!).slice(0, 120).join(""),
    };
  }
  if (verdict.state === "stalled" && verdict.reason === "pty_dead") {
    return { sessionId: candidate.sessionId, reason: "pty_dead", since: candidate.since };
  }
  if (verdict.state === "stalled" && verdict.reason === "silent") {
    return { sessionId: candidate.sessionId, reason: "silent", since: candidate.since };
  }
  return null;
}

function stageTwoSlice(candidates: readonly StallStageOneCandidate[], cursor: number): StallStageOneCandidate[] {
  const tailCandidates = candidates.filter((candidate) => !candidate.ptyDead);
  if (tailCandidates.length <= STALL_STAGE_TWO_LIMIT) return tailCandidates;
  const selected: StallStageOneCandidate[] = [];
  for (let offset = 0; offset < STALL_STAGE_TWO_LIMIT; offset += 1) {
    selected.push(tailCandidates[(cursor + offset) % tailCandidates.length]);
  }
  return selected;
}

function sessionMap(): Map<string, PaneTab> {
  const tabs = new Map<string, PaneTab>();
  for (const workspace of useWorkspaceListStore.getState().workspaces) {
    for (const pane of workspace.panes) {
      for (const tab of pane.tabs) tabs.set(tab.sessionId, tab);
    }
  }
  return tabs;
}

function clearEntriesWithCurrentActivity(): void {
  const metadataState = usePaneMetadataStore.getState();
  const attention = useSessionAttentionStore.getState().attentionBySession;
  const current = useStallStore.getState().entries;
  let changed = false;
  const next: Record<string, StallEntry> = {};
  for (const [sessionId, entry] of Object.entries(current)) {
    const metadata = metadataState.metadata[sessionId];
    const activityAt = latestStallActivityAt({
      lastLogAt: metadataState.lastLogAt[sessionId],
      screenStatusAt: metadata?.screenStatusAt,
      agentStatusAt: metadata?.agentStatusAt,
    });
    if (
      activityAt > entry.since
      || (attention[sessionId]?.kind && attention[sessionId]?.kind !== "none")
      || (attention[sessionId]?.uiState && attention[sessionId]?.uiState !== "idle")
    ) {
      changed = true;
      continue;
    }
    next[sessionId] = entry;
  }
  if (changed) useStallStore.getState().replaceEntries(next);
}

export function connectStallStore(): () => void {
  let intervalId: number | undefined;
  let disposed = false;
  let tickRunning = false;
  let roundRobinCursor = 0;
  const screenObservations = new Map<string, ScreenObservation>();

  const tick = async (): Promise<void> => {
    if (disposed || tickRunning || document.visibilityState !== "visible") return;
    tickRunning = true;
    try {
      let processMetadata: PtyMetadataSnapshot = {};
      let processMetadataAvailable = true;
      try {
        processMetadata = await getPtyMetadataSnapshot();
      } catch {
        processMetadataAvailable = false;
      }
      if (disposed) return;

      const metadataState = usePaneMetadataStore.getState();
      const attentionBySession = useSessionAttentionStore.getState().attentionBySession;
      const statusSignalsBySession = useSessionAttentionStore.getState().statusSignalsBySession;
      const sessions = [...sessionMap().values()].map((tab) => {
        const metadata = metadataState.metadata[tab.sessionId];
        const processStatusReason = processStatusReasonForTab(
          tab.type,
          processMetadata[tab.sessionId],
          processMetadataAvailable,
        );
        return {
          sessionId: tab.sessionId,
          type: tab.type,
          attentionKind: attentionBySession[tab.sessionId]?.kind,
          attentionUiState: attentionBySession[tab.sessionId]?.uiState,
          lastLogAt: metadataState.lastLogAt[tab.sessionId],
          screenStatusAt: metadata?.screenStatusAt,
          agentStatusAt: metadata?.agentStatusAt,
          processStatusReason,
          hasLivePty: processStatusReason !== "no_live_pty_session" && processStatusReason !== "snapshot_unavailable",
          hasTerminalBuffer: hasTerminalBuffer(tab.sessionId),
          processActivity: statusSignalsBySession[tab.sessionId]?.activity ?? "unknown",
        } satisfies StallStageOneSession;
      });
      const candidates = selectStallCandidates(sessions, Date.now());
      const selected = stageTwoSlice(candidates, roundRobinCursor);
      const tailCandidateCount = candidates.filter((candidate) => !candidate.ptyDead).length;
      if (tailCandidateCount > STALL_STAGE_TWO_LIMIT) {
        roundRobinCursor = (roundRobinCursor + STALL_STAGE_TWO_LIMIT) % tailCandidateCount;
      } else {
        roundRobinCursor = 0;
      }

      const selectedIds = new Set(selected.map((candidate) => candidate.sessionId));
      const previous = useStallStore.getState().entries;
      const next: Record<string, StallEntry> = {};
      for (const candidate of candidates) {
        if (candidate.ptyDead) {
          const entry = classifyStallCandidate(candidate, []);
          if (entry) next[candidate.sessionId] = entry;
        } else if (!selectedIds.has(candidate.sessionId) && previous[candidate.sessionId]) {
          next[candidate.sessionId] = previous[candidate.sessionId];
        }
      }
      const confirmed = await Promise.all(selected.map(async (candidate) => {
        try {
          const [tail, scrollback] = await Promise.all([
            readTail(candidate.sessionId, TAB_SWEEP_TAIL_LINES),
            getSessionScrollback(candidate.sessionId),
          ]);
          const lines = new TextDecoder().decode(scrollback.data).split(/\r?\n/u);
          let semanticFingerprint: string | null = null;
          try {
            semanticFingerprint = await fingerprintDormancySemanticState(lines);
          } catch {
            semanticFingerprint = null;
          }
          const previous = screenObservations.get(candidate.sessionId);
          const observation = observeScreenActivity(previous, scrollback.endOffset, semanticFingerprint, Date.now());
          const screenAdvanced = observation.screenAdvanced;
          screenObservations.set(candidate.sessionId, observation);
          return classifyStallCandidate(
            candidate,
            tail,
            screenAdvanced,
            Math.max(0, Date.now() - observation.lastActivityAt),
          );
        } catch {
          return null;
        }
      }));
      for (const entry of confirmed) {
        if (entry) next[entry.sessionId] = entry;
      }
      if (!disposed) {
        useStallStore.getState().replaceEntries(next);
        clearEntriesWithCurrentActivity();
      }
    } catch (error) {
      console.warn("[stall] Detection tick failed", error);
    } finally {
      tickRunning = false;
    }
  };

  const stopInterval = (): void => {
    if (intervalId !== undefined) window.clearInterval(intervalId);
    intervalId = undefined;
  };
  const startInterval = (): void => {
    stopInterval();
    if (document.visibilityState !== "visible") return;
    void tick();
    intervalId = window.setInterval(() => void tick(), STALL_CHECK_INTERVAL_MS);
  };
  const onVisibilityChange = (): void => startInterval();
  const unsubscribeMetadata = usePaneMetadataStore.subscribe(clearEntriesWithCurrentActivity);
  const unsubscribeAttention = useSessionAttentionStore.subscribe(clearEntriesWithCurrentActivity);

  document.addEventListener("visibilitychange", onVisibilityChange);
  startInterval();
  return () => {
    disposed = true;
    stopInterval();
    document.removeEventListener("visibilitychange", onVisibilityChange);
    unsubscribeMetadata();
    unsubscribeAttention();
    useStallStore.getState().replaceEntries({});
  };
}
