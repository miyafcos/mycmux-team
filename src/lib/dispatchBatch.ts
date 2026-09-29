import type { LogicalSessionId } from "./logicalSessionId";
import type { CompletionClassification } from "./completionEvidence";

export type DispatchRecipient = {
  logicalSessionId: LogicalSessionId;
  instructionRef: string;
  label?: string;
};
export type AssignmentState = "open" | "received" | "waived" | "cancelled" | "failed";

export interface DispatchAssignment extends DispatchRecipient {
  id: string;
  state: AssignmentState;
  evidenceRefs: string[];
  needsJudgment: boolean;
  reflectedInSummaryRevision: number | null;
}

export interface DispatchBatch {
  id: string;
  status: "open" | "sealed";
  assignments: DispatchAssignment[];
  deadlineAt?: number;
  transitionRevision: number;
  publishedSummaryRevision: number;
  nextAssignmentSequence: number;
}

export interface AssignmentRoute {
  assignmentId: string;
  instructionRef: string;
}

export interface TransitionResult {
  batch: DispatchBatch;
  applied: boolean;
}

function makeAssignments(
  batchId: string,
  recipients: DispatchRecipient[],
  firstSequence: number,
): DispatchAssignment[] {
  return recipients.map((recipient, index) => ({
    ...recipient,
    id: `${batchId}:${firstSequence + index}`,
    state: "open",
    evidenceRefs: [],
    needsJudgment: false,
    reflectedInSummaryRevision: null,
  }));
}

export function createBatch(
  recipients: DispatchRecipient[],
  opts: { batchId: string; deadlineAt?: number },
): DispatchBatch {
  const assignments = makeAssignments(opts.batchId, recipients, 1);
  return {
    id: opts.batchId,
    status: "open",
    deadlineAt: opts.deadlineAt,
    transitionRevision: 0,
    publishedSummaryRevision: 0,
    nextAssignmentSequence: assignments.length + 1,
    assignments,
  };
}

export function addAssignments(batch: DispatchBatch, recipients: DispatchRecipient[]): DispatchBatch {
  if (batch.status === "sealed" || recipients.length === 0) return batch;
  const additions = makeAssignments(batch.id, recipients, batch.nextAssignmentSequence);
  return {
    ...batch,
    assignments: [...batch.assignments, ...additions],
    nextAssignmentSequence: batch.nextAssignmentSequence + additions.length,
  };
}

export function sealBatch(batch: DispatchBatch): DispatchBatch {
  return batch.status === "sealed" ? batch : { ...batch, status: "sealed" };
}

function transition(
  batch: DispatchBatch,
  route: AssignmentRoute,
  state: AssignmentState,
  options: { evidenceRef?: string; needsJudgment?: boolean } = {},
): TransitionResult {
  const index = batch.assignments.findIndex((assignment) =>
    assignment.id === route.assignmentId && assignment.instructionRef === route.instructionRef);
  if (index === -1) return { batch, applied: false };

  const current = batch.assignments[index];
  const evidenceRefs = options.evidenceRef && !current.evidenceRefs.includes(options.evidenceRef)
    ? [...current.evidenceRefs, options.evidenceRef]
    : current.evidenceRefs;
  const nextState = current.state === "open" ? state : current.state;
  const needsJudgment = current.needsJudgment || options.needsJudgment === true;
  if (nextState === current.state
    && evidenceRefs === current.evidenceRefs
    && needsJudgment === current.needsJudgment) {
    return { batch, applied: true };
  }

  const assignments = [...batch.assignments];
  assignments[index] = {
    ...current,
    state: nextState,
    evidenceRefs,
    needsJudgment,
    reflectedInSummaryRevision: null,
  };
  return {
    applied: true,
    batch: { ...batch, assignments, transitionRevision: batch.transitionRevision + 1 },
  };
}

export function recordEvidence(
  batch: DispatchBatch,
  route: AssignmentRoute,
  evidenceRef: string,
  needsJudgment = false,
): TransitionResult {
  return transition(batch, route, "received", { evidenceRef, needsJudgment });
}

export function recordCompletionEvidence(
  batch: DispatchBatch,
  route: AssignmentRoute,
  evidenceRef: string,
  classification: Pick<CompletionClassification, "needsJudgment">,
): TransitionResult {
  return recordEvidence(batch, route, evidenceRef, classification.needsJudgment);
}

export function recordWaive(batch: DispatchBatch, route: AssignmentRoute): TransitionResult {
  return transition(batch, route, "waived");
}

export function recordCancel(batch: DispatchBatch, route: AssignmentRoute): TransitionResult {
  return transition(batch, route, "cancelled");
}

export function recordFailure(batch: DispatchBatch, route: AssignmentRoute): TransitionResult {
  return transition(batch, route, "failed", { needsJudgment: true });
}

/** Publish all newly settled assignments in one new summary revision. */
export function publishSummary(batch: DispatchBatch): DispatchBatch {
  const hasUnreflected = batch.assignments.some((assignment) =>
    assignment.state !== "open" && assignment.reflectedInSummaryRevision === null);
  if (!hasUnreflected) return batch;
  const revision = batch.publishedSummaryRevision + 1;
  return {
    ...batch,
    publishedSummaryRevision: revision,
    assignments: batch.assignments.map((assignment) =>
      assignment.state !== "open" && assignment.reflectedInSummaryRevision === null
        ? { ...assignment, reflectedInSummaryRevision: revision }
        : assignment),
  };
}

export interface DispatchCoverage {
  target: number;
  received: number;
  settled: number;
  reflected: number;
  missing: number;
  needsJudgment: number;
  /** This is the only completion barrier; partial:false does not mean everyone completed. */
  complete: boolean;
  partial: boolean;
}

export function coverage(batch: DispatchBatch, now: number): DispatchCoverage {
  const received = batch.assignments.filter((assignment) => assignment.state === "received").length;
  const settled = batch.assignments.filter((assignment) => assignment.state !== "open").length;
  const reflected = batch.assignments.filter((assignment) =>
    assignment.reflectedInSummaryRevision !== null
    && assignment.reflectedInSummaryRevision <= batch.publishedSummaryRevision).length;
  const needsJudgment = batch.assignments.filter((assignment) =>
    assignment.state === "failed" || assignment.needsJudgment).length;
  const complete = batch.assignments.every((assignment) => assignment.state !== "open");
  return {
    target: batch.assignments.length,
    received,
    settled,
    reflected,
    missing: batch.assignments.length - received,
    needsJudgment,
    complete,
    partial: !complete && batch.deadlineAt !== undefined && now > batch.deadlineAt,
  };
}
