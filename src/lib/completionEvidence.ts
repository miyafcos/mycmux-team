import type { LogicalSessionId } from "./logicalSessionId";

export type CompletionEvidenceSource = "ledger" | "livebrief" | "status";
export type CompletionEvidenceKind =
  | "done-marker"
  | "verdict"
  | "test-pass"
  | "test-fail"
  | "turn-ended"
  | "process-exit";

export interface CompletionEvidence {
  source: CompletionEvidenceSource;
  kind: CompletionEvidenceKind;
  logicalSessionId: LogicalSessionId;
  cycleId: string;
  observedAt: number;
  sourceRef: string;
}

export interface WorkCycle {
  logicalSessionId: LogicalSessionId;
  cycleId: string;
  startedAt: number;
  sequence: number;
}

export function startCycle(logicalSessionId: LogicalSessionId, at: number, sequence: number): WorkCycle {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error("Work-cycle sequence must be a positive safe integer");
  }
  return {
    logicalSessionId,
    cycleId: `${logicalSessionId}:${at}:${sequence}`,
    startedAt: at,
    sequence,
  };
}

export interface CompletionClassification {
  /** Contract evidence alone does not infer working or stalled activity. */
  activity: "waiting" | "completed" | "exited" | "error";
  confidence: "confirmed" | "reported" | "candidate";
  conflicts: string[];
  needsJudgment: boolean;
  verificationPassed: boolean;
}

const isTerminal = (evidence: CompletionEvidence): boolean =>
  evidence.kind === "done-marker" || evidence.kind === "verdict";

const isSourceState = (evidence: CompletionEvidence): boolean =>
  isTerminal(evidence) || evidence.kind === "turn-ended" || evidence.kind === "process-exit";

function latest(evidences: CompletionEvidence[]): CompletionEvidence | undefined {
  return evidences.reduce<CompletionEvidence | undefined>((current, evidence) =>
    current === undefined || evidence.observedAt >= current.observedAt ? evidence : current, undefined);
}

export function classify(
  evidences: CompletionEvidence[],
  currentCycle: Pick<WorkCycle, "logicalSessionId" | "cycleId">,
): CompletionClassification {
  const current = evidences.filter((evidence) =>
    evidence.logicalSessionId === currentCycle.logicalSessionId
    && evidence.cycleId === currentCycle.cycleId);
  const ledger = latest(current.filter((evidence) => evidence.source === "ledger" && isSourceState(evidence)));
  const livebrief = latest(current.filter((evidence) => evidence.source === "livebrief" && isSourceState(evidence)));
  const testResult = latest(current.filter((evidence) =>
    evidence.kind === "test-pass" || evidence.kind === "test-fail"));
  const runtimeState = latest(current.filter((evidence) =>
    evidence.kind === "turn-ended" || evidence.kind === "process-exit"));
  // A later turn-ended records the runtime becoming idle; it must not erase a
  // prior terminal report from the same source and cycle.
  const ledgerTerminal = latest(current.filter((evidence) => evidence.source === "ledger" && isTerminal(evidence)));
  const livebriefTerminal = latest(current.filter((evidence) => evidence.source === "livebrief" && isTerminal(evidence)));
  const terminal = latest([ledgerTerminal, livebriefTerminal].filter((evidence): evidence is CompletionEvidence => evidence !== undefined));
  const ledgerVerdict = latest(current.filter((evidence) =>
    evidence.source === "ledger" && evidence.kind === "verdict"));
  const ledgerDoneMarker = latest(current.filter((evidence) =>
    evidence.source === "ledger" && evidence.kind === "done-marker"));
  const statusFailure = testResult?.kind === "test-fail";
  const conflicts: string[] = [];
  if (ledgerTerminal !== undefined && livebrief !== undefined && livebriefTerminal === undefined) {
    conflicts.push("ledger completion conflicts with livebrief non-terminal evidence");
  }
  if (livebriefTerminal !== undefined && ledger !== undefined && ledgerTerminal === undefined) {
    conflicts.push("livebrief completion conflicts with ledger non-terminal evidence");
  }
  if (statusFailure && (ledgerTerminal !== undefined || livebriefTerminal !== undefined)) {
    conflicts.push("terminal completion evidence conflicts with test failure");
  }
  const needsJudgment = conflicts.length > 0;
  const verificationPassed = testResult?.kind === "test-pass";
  if (statusFailure && (terminal === undefined || testResult.observedAt > terminal.observedAt)) {
    return { activity: "error", confidence: "candidate", conflicts, needsJudgment, verificationPassed };
  }
  if (terminal !== undefined
    && ledgerTerminal !== undefined
    && ledgerDoneMarker !== undefined
    && ledgerVerdict !== undefined) {
    return { activity: "completed", confidence: "confirmed", conflicts, needsJudgment, verificationPassed };
  }
  if (terminal !== undefined) {
    return { activity: "completed", confidence: "reported", conflicts, needsJudgment, verificationPassed };
  }
  if (runtimeState?.kind === "process-exit") {
    return { activity: "exited", confidence: "candidate", conflicts, needsJudgment, verificationPassed };
  }
  return { activity: "waiting", confidence: "candidate", conflicts, needsJudgment, verificationPassed };
}
