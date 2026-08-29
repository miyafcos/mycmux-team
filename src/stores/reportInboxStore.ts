import { create } from "zustand";

import type { LiveSessionBrief, SemanticEventEnvelope } from "../lib/livebrief";
import { onSessionStatusChanged, type SessionStatusChangedPayload } from "../lib/ipc";
import {
  classify,
  startCycle,
  type CompletionClassification,
  type CompletionEvidence,
  type WorkCycle,
} from "../lib/completionEvidence";
import {
  coverage,
  publishSummary,
  recordCompletionEvidence,
  type DispatchBatch,
  type DispatchCoverage,
} from "../lib/dispatchBatch";
import type { LogicalSessionId } from "../lib/logicalSessionId";
import type { ComposerCommandKind } from "./composerStore";

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
}

/** Delivery confirmation is diagnostic only; it is never a report receipt. */
export type ReportDispatchDeliveryState = "pending" | "confirmed" | "unconfirmed" | "failed" | "blocked";

export interface ReportDispatchDelivery {
  state: ReportDispatchDeliveryState;
  detail: string;
}

export interface ReportBatchRecipient {
  logicalSessionId: LogicalSessionId;
  ptySessionId: string;
  label: string;
  delivery: ReportDispatchDelivery;
}

export interface ReportBatchMember extends ReportBatchRecipient {
  assignmentId: string;
  cycle: WorkCycle;
  evidences: readonly CompletionEvidence[];
  evidenceNotes: readonly { sourceRef: string; detail: string }[];
  classification: CompletionClassification;
}

/** Runtime bindings sit beside, never inside, the sealed DispatchBatch contract. */
export interface ReportDispatchBatch {
  batch: DispatchBatch;
  commandKind: ComposerCommandKind;
  membersByAssignmentId: Record<string, ReportBatchMember>;
  /** Machine evidence that matched multiple batch cycles and was not guessed. */
  unattributedEvidenceRefs: readonly string[];
}

export interface ReportDispatchBatchRegistration {
  batch: DispatchBatch;
  commandKind: ComposerCommandKind;
  members: readonly ReportBatchRecipient[];
}

interface ReportInboxState {
  cardsById: Record<string, MachineReportCard>;
  cardIds: string[];
  dispatchBatchesById: Record<string, ReportDispatchBatch | undefined>;
  ingestLiveBriefs: (briefs: readonly LiveSessionBrief[]) => void;
  ingestSemanticEvents: (ptySessionId: string, events: readonly SemanticEventEnvelope[]) => void;
  ingestStatusEvent: (payload: SessionStatusChangedPayload) => void;
  registerSealedDispatchBatch: (registration: ReportDispatchBatchRegistration) => void;
  updateDispatchDelivery: (batchId: string, ptySessionId: string, delivery: ReportDispatchDelivery) => void;
  ingestBatchCompletionEvidence: (
    batchId: string,
    ptySessionId: string,
    evidence: Omit<CompletionEvidence, "logicalSessionId" | "cycleId">,
  ) => void;
  reset: () => void;
}

type ReportInboxData = Pick<ReportInboxState, "cardsById" | "cardIds" | "dispatchBatchesById">;

function putCard(
  state: ReportInboxData,
  card: MachineReportCard,
): ReportInboxData {
  if (state.cardsById[card.id]) return state;
  return applyCardEvidence({
    cardsById: { ...state.cardsById, [card.id]: card },
    cardIds: [card.id, ...state.cardIds],
    dispatchBatchesById: state.dispatchBatchesById,
  }, card);
}

function completionEvidenceForCard(card: MachineReportCard): Omit<CompletionEvidence, "logicalSessionId" | "cycleId"> | null {
  if (card.state === "waiting") {
    return { source: card.source, kind: "turn-ended", observedAt: card.observedAt, sourceRef: card.sourceEventId };
  }
  if (card.state === "stopped") {
    return { source: card.source, kind: "process-exit", observedAt: card.observedAt, sourceRef: card.sourceEventId };
  }
  if (card.state === "needsReview" && card.detail.startsWith("テスト結果:")) {
    return { source: card.source, kind: "test-fail", observedAt: card.observedAt, sourceRef: card.sourceEventId };
  }
  return null;
}

function updateReportWithEvidence(
  report: ReportDispatchBatch,
  assignmentId: string,
  evidence: Omit<CompletionEvidence, "logicalSessionId" | "cycleId">,
  detail = "",
): ReportDispatchBatch {
  const member = report.membersByAssignmentId[assignmentId];
  if (!member) return report;
  const completeEvidence: CompletionEvidence = {
    ...evidence,
    logicalSessionId: member.logicalSessionId,
    cycleId: member.cycle.cycleId,
  };
  if (member.evidences.some((item) => item.sourceRef === completeEvidence.sourceRef)) return report;
  const evidences = [...member.evidences, completeEvidence];
  const evidenceNotes = [...member.evidenceNotes, { sourceRef: completeEvidence.sourceRef, detail }];
  const classification = classify(evidences, member.cycle);
  const route = { assignmentId, instructionRef: member.ptySessionId };
  const transition = recordCompletionEvidence(
    report.batch,
    route,
    completeEvidence.sourceRef,
    { needsJudgment: classification.needsJudgment || classification.activity === "error" },
  );
  if (!transition.applied) return report;
  return {
    ...report,
    batch: publishSummary(transition.batch),
    membersByAssignmentId: {
      ...report.membersByAssignmentId,
      [assignmentId]: { ...member, evidences, evidenceNotes, classification },
    },
  };
}

function applyCardEvidence(state: ReportInboxData, card: MachineReportCard): ReportInboxData {
  const evidence = completionEvidenceForCard(card);
  if (!evidence) return state;
  const matches = Object.values(state.dispatchBatchesById)
    .filter((report): report is ReportDispatchBatch => report !== undefined)
    .flatMap((report) => Object.values(report.membersByAssignmentId)
      .filter((member) => member.ptySessionId === card.ptySessionId)
      .map((member) => ({ report, assignmentId: member.assignmentId })));
  // A runtime event cannot safely be attributed when multiple batch assignments
  // target the same session. Leave it uncovered and surface that fact instead
  // of guessing which command cycle owns the evidence.
  if (matches.length !== 1) {
    if (matches.length === 0) return state;
    const currentCandidates = matches.filter(({ report, assignmentId }) =>
      report.batch.assignments.some((assignment) => assignment.id === assignmentId && assignment.state === "open"));
    const reportsToMark = currentCandidates.length > 0 ? currentCandidates : matches;
    const dispatchBatchesById = { ...state.dispatchBatchesById };
    let changed = false;
    for (const { report } of reportsToMark) {
      if (report.unattributedEvidenceRefs.includes(card.sourceEventId)) continue;
      dispatchBatchesById[report.batch.id] = {
        ...report,
        unattributedEvidenceRefs: [...report.unattributedEvidenceRefs, card.sourceEventId],
      };
      changed = true;
    }
    return changed ? { ...state, dispatchBatchesById } : state;
  }
  const [{ report, assignmentId }] = matches;
  const updated = updateReportWithEvidence(report, assignmentId, evidence, card.detail);
  if (updated === report) return state;
  return {
    ...state,
    dispatchBatchesById: { ...state.dispatchBatchesById, [updated.batch.id]: updated },
  };
}

function reportFromRegistration(registration: ReportDispatchBatchRegistration): ReportDispatchBatch | null {
  if (registration.batch.status !== "sealed") return null;
  const membersByAssignmentId: Record<string, ReportBatchMember> = {};
  const ptySessionIds = new Set<string>();
  for (const [index, assignment] of registration.batch.assignments.entries()) {
    const recipient = registration.members[index];
    if (!recipient
      || recipient.logicalSessionId !== assignment.logicalSessionId
      || recipient.ptySessionId !== assignment.instructionRef
      || ptySessionIds.has(recipient.ptySessionId)) return null;
    ptySessionIds.add(recipient.ptySessionId);
    const cycle = startCycle(recipient.logicalSessionId, Date.now(), index + 1);
    membersByAssignmentId[assignment.id] = {
      ...recipient,
      assignmentId: assignment.id,
      cycle,
      evidences: [],
      evidenceNotes: [],
      classification: classify([], cycle),
    };
  }
  return registration.members.length === registration.batch.assignments.length
    ? { batch: registration.batch, commandKind: registration.commandKind, membersByAssignmentId, unattributedEvidenceRefs: [] }
    : null;
}

export function reportBatchCoverage(report: ReportDispatchBatch, now = Date.now()): DispatchCoverage {
  const current = coverage(report.batch, now);
  return { ...current, needsJudgment: current.needsJudgment + report.unattributedEvidenceRefs.length };
}

/** The count line is assembled mechanically before this text reaches the AI. */
export function reportBatchAiContext(report: ReportDispatchBatch): string {
  const current = reportBatchCoverage(report);
  const deliveryLines = Object.values(report.membersByAssignmentId)
    .flatMap((member) => [
      `${member.label}: delivery=${member.delivery.state}; evidence=${member.evidences.length}`,
      ...member.evidences.map((evidence, index) => `${member.label}: ${member.evidenceNotes[index]?.detail || `${evidence.source}/${evidence.kind}`}`),
    ]);
  return [
    `dispatch batch ${report.batch.id}`,
    `command kind ${report.commandKind}`,
    `coverage target=${current.target} received=${current.received} reflected=${current.reflected} missing=${current.missing} needsJudgment=${current.needsJudgment}`,
    ...deliveryLines,
  ].join("\n");
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
  dispatchBatchesById: {},
  ingestLiveBriefs: (briefs) => set((state) => {
    let next: ReportInboxData = state;
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
    let next: ReportInboxData = state;
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
  registerSealedDispatchBatch: (registration) => set((state) => {
    if (state.dispatchBatchesById[registration.batch.id]) return state;
    const report = reportFromRegistration(registration);
    if (!report) return state;
    return { dispatchBatchesById: { ...state.dispatchBatchesById, [report.batch.id]: report } };
  }),
  updateDispatchDelivery: (batchId, ptySessionId, delivery) => set((state) => {
    const report = state.dispatchBatchesById[batchId];
    if (!report) return state;
    const matches = Object.values(report.membersByAssignmentId)
      .filter((candidate) => candidate.ptySessionId === ptySessionId);
    if (matches.length !== 1) return state;
    const [member] = matches;
    if (!member || (member.delivery.state === delivery.state && member.delivery.detail === delivery.detail)) return state;
    const updated: ReportDispatchBatch = {
      ...report,
      membersByAssignmentId: {
        ...report.membersByAssignmentId,
        [member.assignmentId]: { ...member, delivery },
      },
    };
    return { dispatchBatchesById: { ...state.dispatchBatchesById, [batchId]: updated } };
  }),
  ingestBatchCompletionEvidence: (batchId, ptySessionId, evidence) => set((state) => {
    const report = state.dispatchBatchesById[batchId];
    if (!report) return state;
    const matches = Object.values(report.membersByAssignmentId)
      .filter((candidate) => candidate.ptySessionId === ptySessionId);
    if (matches.length !== 1) return state;
    const [member] = matches;
    if (!member) return state;
    const updated = updateReportWithEvidence(report, member.assignmentId, evidence);
    if (updated === report) return state;
    return { dispatchBatchesById: { ...state.dispatchBatchesById, [batchId]: updated } };
  }),
  reset: () => set({ cardsById: {}, cardIds: [], dispatchBatchesById: {} }),
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
