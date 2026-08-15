import { create } from "zustand";

import type { LiveSessionBrief, SemanticEventEnvelope } from "../lib/livebrief";
import { onSessionStatusChanged, type SessionStatusChangedPayload } from "../lib/ipc";
import type { CompletionClassification } from "../lib/completionEvidence";

export type ReportReceiveMode = "immediate" | "batch" | "quiet";
export type MachineReportState = "waiting" | "stopped" | "needsReview";

/**
 * Keep the report vocabulary aligned with CompletionEvidence without creating
 * synthetic LogicalSessionId/WorkCycle values. Batch routing owns that later.
 */
export function machineStateForActivity(
  activity: CompletionClassification["activity"],
): MachineReportState | null {
  if (activity === "waiting") return "waiting";
  if (activity === "exited") return "stopped";
  if (activity === "error") return "needsReview";
  return null;
}

export interface MachineReportCard {
  id: string;
  /** Runtime identity only. Never reinterpret this as a LogicalSessionId. */
  ptySessionId: string;
  sourceEventId: string;
  /** Status/ended events are rendered as a source row because no transcript row exists. */
  syntheticSource: boolean;
  observedAt: number;
  state: MachineReportState;
  detail: string;
  source: "livebrief" | "status";
  /** Reserved for a future sealed DispatchBatch connection; no batch logic exists here. */
  batchId?: string;
}

interface ReportInboxState {
  cardsById: Record<string, MachineReportCard>;
  cardIds: string[];
  receiveModeBySession: Record<string, ReportReceiveMode | undefined>;
  ingestLiveBriefs: (briefs: readonly LiveSessionBrief[]) => void;
  ingestSemanticEvents: (ptySessionId: string, events: readonly SemanticEventEnvelope[]) => void;
  ingestStatusEvent: (payload: SessionStatusChangedPayload) => void;
  setReceiveMode: (ptySessionId: string, mode: ReportReceiveMode) => void;
  reset: () => void;
}

function putCard(
  state: Pick<ReportInboxState, "cardsById" | "cardIds">,
  card: MachineReportCard,
): Pick<ReportInboxState, "cardsById" | "cardIds"> {
  if (state.cardsById[card.id]) return state;
  return {
    cardsById: { ...state.cardsById, [card.id]: card },
    cardIds: [card.id, ...state.cardIds],
  };
}

function semanticCard(
  ptySessionId: string,
  event: SemanticEventEnvelope,
): MachineReportCard | null {
  if (event.kind.type === "error") {
    return {
      id: `livebrief:${ptySessionId}:${event.eventId}`,
      ptySessionId,
      sourceEventId: event.eventId,
      syntheticSource: false,
      observedAt: event.occurredAt,
      state: machineStateForActivity("error")!,
      detail: event.kind.text,
      source: "livebrief",
    };
  }
  if (event.kind.type === "testResult" && event.kind.fail > 0) {
    return {
      id: `livebrief:${ptySessionId}:${event.eventId}`,
      ptySessionId,
      sourceEventId: event.eventId,
      syntheticSource: false,
      observedAt: event.occurredAt,
      state: machineStateForActivity("error")!,
      detail: `テスト結果: ${event.kind.fail}件失敗、${event.kind.pass}件成功`,
      source: "livebrief",
    };
  }
  return null;
}

function statusCard(payload: SessionStatusChangedPayload): MachineReportCard | null {
  const source = `status:${payload.server_epoch}:${payload.session_id}:${payload.session_revision}`;
  if (payload.status.lifecycle === "exited") {
    return {
      id: source,
      ptySessionId: payload.session_id,
      sourceEventId: source,
      syntheticSource: true,
      observedAt: payload.status.attention.state_since,
      state: machineStateForActivity("exited")!,
      detail: "プロセス終了を検知しました",
      source: "status",
    };
  }
  if (payload.status.attention.kind === "done") {
    return {
      id: source,
      ptySessionId: payload.session_id,
      sourceEventId: source,
      syntheticSource: true,
      observedAt: payload.status.attention.state_since,
      state: machineStateForActivity("waiting")!,
      detail: "処理終了を検知しました。待機中です",
      source: "status",
    };
  }
  if (payload.status.attention.kind === "error" || payload.status.attention.kind === "rate_limited") {
    return {
      id: source,
      ptySessionId: payload.session_id,
      sourceEventId: source,
      syntheticSource: true,
      observedAt: payload.status.attention.state_since,
      state: machineStateForActivity("error")!,
      detail: payload.status.attention.detail ?? "状態の確認が必要です",
      source: "status",
    };
  }
  return null;
}

export const useReportInboxStore = create<ReportInboxState>((set) => ({
  cardsById: {},
  cardIds: [],
  receiveModeBySession: {},
  ingestLiveBriefs: (briefs) => set((state) => {
    let next: Pick<ReportInboxState, "cardsById" | "cardIds"> = state;
    for (const brief of briefs) {
      if (brief.operationalState !== "ended") continue;
      next = putCard(next, {
        id: `livebrief-ended:${brief.serviceEpoch}:${brief.ptySessionId}:${brief.briefRevision}`,
        ptySessionId: brief.ptySessionId,
        sourceEventId: `livebrief-ended:${brief.serviceEpoch}:${brief.ptySessionId}:${brief.briefRevision}`,
        syntheticSource: true,
        observedAt: brief.updatedAt,
        state: machineStateForActivity("waiting")!,
        detail: "エージェントのターン終了を検知しました。待機中です",
        source: "livebrief",
      });
    }
    return next === state ? state : next;
  }),
  ingestSemanticEvents: (ptySessionId, events) => set((state) => {
    let next: Pick<ReportInboxState, "cardsById" | "cardIds"> = state;
    for (const event of events) {
      const card = semanticCard(ptySessionId, event);
      if (card) next = putCard(next, card);
    }
    return next === state ? state : next;
  }),
  ingestStatusEvent: (payload) => set((state) => {
    const card = statusCard(payload);
    return card ? putCard(state, card) : state;
  }),
  setReceiveMode: (ptySessionId, mode) => set((state) => {
    if (state.receiveModeBySession[ptySessionId] === mode) return state;
    return { receiveModeBySession: { ...state.receiveModeBySession, [ptySessionId]: mode } };
  }),
  reset: () => set({ cardsById: {}, cardIds: [], receiveModeBySession: {} }),
}));

let statusSubscriberCount = 0;
let statusUnlisten: (() => void) | undefined;
let statusListenPending: Promise<(() => void)> | undefined;

/**
 * The dashboard consumes the already-published status feed; it never starts a
 * timer or asks for a second snapshot. The existing attention store remains
 * the canonical consumer of snapshots and notification state.
 */
export function connectReportInboxStatusFeed(): () => void {
  statusSubscriberCount += 1;
  if (statusSubscriberCount === 1) {
    statusListenPending = onSessionStatusChanged((payload) => useReportInboxStore.getState().ingestStatusEvent(payload));
    void statusListenPending.then((dispose) => {
      if (statusSubscriberCount === 0) dispose();
      else statusUnlisten = dispose;
    }).catch(() => {});
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    statusSubscriberCount = Math.max(0, statusSubscriberCount - 1);
    if (statusSubscriberCount > 0) return;
    statusUnlisten?.();
    statusUnlisten = undefined;
    statusListenPending = undefined;
  };
}

export function __resetReportInboxStoreForTests(): void {
  statusUnlisten?.();
  statusUnlisten = undefined;
  statusListenPending = undefined;
  statusSubscriberCount = 0;
  useReportInboxStore.getState().reset();
}
