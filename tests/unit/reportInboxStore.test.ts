import { afterEach, describe, expect, it } from "vitest";

import type { LiveSessionBrief, SemanticEventEnvelope } from "../../src/lib/livebrief";
import type { SessionStatusChangedPayload } from "../../src/lib/ipc";
import { createBatch, sealBatch } from "../../src/lib/dispatchBatch";
import { logicalSessionId } from "../../src/lib/logicalSessionId";
import {
  __resetReportInboxStoreForTests,
  machineStateForActivity,
  reportBatchAiContext,
  reportBatchCoverage,
  useReportInboxStore,
} from "../../src/stores/reportInboxStore";

const SESSION = "pty-1";
const NOW = Date.parse("2026-08-15T12:00:00.000Z");

function event(eventId: string, kind: SemanticEventEnvelope["kind"]): SemanticEventEnvelope {
  return { eventId, sourceRevision: 1, occurredAt: 1_000, sourceByteStart: 10, sourceByteEnd: 20, kind };
}

function brief(overrides: Partial<LiveSessionBrief> = {}): LiveSessionBrief {
  return {
    ptySessionId: SESSION,
    agentSessionId: "agent-1",
    agentKind: "codex",
    ptyInstanceId: "instance-1",
    ptyGeneration: 1,
    sourceRevision: 1,
    ptyInputRevision: 1,
    task: null,
    latestInstruction: null,
    taskSourceEventIds: [],
    activityKind: null,
    activityText: null,
    activitySourceEventId: null,
    checkpoint: null,
    checkpointEvidenceEventIds: [],
    pendingInputKind: null,
    pendingPrompt: null,
    pendingOptions: [],
    promptEventId: null,
    promptHash: null,
    eventSeq: 1,
    operationalState: "running",
    telemetryHealth: "live",
    lastEventAt: 1_000,
    lastSuccessfulReadAt: 1_000,
    updatedAt: 1_000,
    serviceEpoch: "epoch-1",
    briefRevision: 1,
    ...overrides,
  };
}

function status(overrides: Partial<SessionStatusChangedPayload> = {}): SessionStatusChangedPayload {
  return {
    v: 2,
    kind: "event",
    event: "status.changed",
    server_epoch: "server-1",
    seq: 1,
    session_id: SESSION,
    session_revision: 1,
    status: {
      session_epoch: 1,
      lifecycle: "alive",
      attention: { attention_id: null, kind: "none", detail: null, state_since: 1_000 },
      ui_state: "idle",
    },
    ...overrides,
  };
}

function registerBatch(batchId: string, recipients = [{ logicalSessionId: "tab-1", ptySessionId: SESSION, label: "対象1" }]) {
  const batch = sealBatch(createBatch(recipients.map((recipient) => ({
    logicalSessionId: logicalSessionId(recipient.logicalSessionId),
    instructionRef: recipient.ptySessionId,
    label: recipient.label,
  })), { batchId }));
  useReportInboxStore.getState().registerSealedDispatchBatch({
    batch,
    commandKind: "plain",
    members: recipients.map((recipient) => ({
      logicalSessionId: logicalSessionId(recipient.logicalSessionId),
      ptySessionId: recipient.ptySessionId,
      label: recipient.label,
      delivery: { state: "confirmed", detail: "送達確認済み" },
    })),
  });
  return batch;
}

afterEach(() => __resetReportInboxStoreForTests());

describe("reportInboxStore", () => {
  it("uses CompletionEvidence activity vocabulary without creating a synthetic work cycle", () => {
    expect(machineStateForActivity("waiting")).toBe("waiting");
    expect(machineStateForActivity("exited")).toBe("stopped");
    expect(machineStateForActivity("error")).toBe("needsReview");
    expect(machineStateForActivity("completed")).toBeNull();
  });

  it("records an error immediately but never calls a passing test complete", () => {
    useReportInboxStore.getState().ingestSemanticEvents(SESSION, [
      event("test-pass", { type: "testResult", pass: 12, fail: 0 }),
      event("error-1", { type: "error", fingerprint: "f-1", text: "検証に失敗しました" }),
      event("test-fail", { type: "testResult", pass: 11, fail: 1 }),
    ]);

    const cards = useReportInboxStore.getState().cardIds.map((id) => useReportInboxStore.getState().cardsById[id]);
    expect(cards).toHaveLength(2);
    expect(cards.map((card) => card.sourceEventId)).toEqual(["test-fail", "error-1"]);
    expect(cards.every((card) => card.state === "needsReview")).toBe(true);
    expect(cards[0]).not.toHaveProperty("coverage");
    expect(cards[0]).not.toHaveProperty("summaryRevision");
  });

  it("labels a turn-ended brief as waiting, not completed", () => {
    useReportInboxStore.getState().ingestLiveBriefs([brief({ operationalState: "ended" })]);
    const [id] = useReportInboxStore.getState().cardIds;
    expect(useReportInboxStore.getState().cardsById[id]).toMatchObject({
      ptySessionId: SESSION,
      source: "livebrief",
      state: "waiting",
      sourceEventId: "livebrief-ended:epoch-1:pty-1:1",
      syntheticSource: true,
    });
  });

  it("labels process exit as stopped and a status error as needs review", () => {
    useReportInboxStore.getState().ingestStatusEvent(status({
      status: {
        session_epoch: 1,
        lifecycle: "exited",
        attention: { attention_id: null, kind: "none", detail: null, state_since: 2_000 },
        ui_state: "idle",
      },
    }));
    useReportInboxStore.getState().ingestStatusEvent(status({
      seq: 2,
      session_revision: 2,
      status: {
        session_epoch: 1,
        lifecycle: "alive",
        attention: { attention_id: "error-1", kind: "error", detail: "接続を確認してください", state_since: 3_000 },
        ui_state: "error",
      },
    }));

    const cards = useReportInboxStore.getState().cardIds.map((id) => useReportInboxStore.getState().cardsById[id]);
    expect(cards.map((card) => card.state)).toEqual(["needsReview", "stopped"]);
  });

  it("projects every coverage number from the sealed batch, never from delivery confirmation", () => {
    registerBatch("batch-coverage", [
      { logicalSessionId: "tab-1", ptySessionId: "pty-1", label: "対象1" },
      { logicalSessionId: "tab-2", ptySessionId: "pty-2", label: "対象2" },
    ]);
    const before = useReportInboxStore.getState().dispatchBatchesById["batch-coverage"]!;
    expect(reportBatchCoverage(before, NOW)).toMatchObject({
      target: 2, received: 0, reflected: 0, missing: 2, needsJudgment: 0,
    });

    useReportInboxStore.getState().ingestLiveBriefs([brief({ operationalState: "ended" })]);
    const after = useReportInboxStore.getState().dispatchBatchesById["batch-coverage"]!;
    expect(reportBatchCoverage(after, NOW)).toMatchObject({
      target: 2, received: 1, reflected: 1, missing: 1, needsJudgment: 0,
    });
    expect(after.batch.publishedSummaryRevision).toBe(1);
    expect(after.membersByAssignmentId[after.batch.assignments[0].id].classification.activity).toBe("waiting");
    expect(reportBatchAiContext(after)).toContain("エージェントのターン終了を検知しました。待機中です");
  });

  it("increments the summary revision for a late receipt without changing sealed membership", () => {
    registerBatch("batch-late", [
      { logicalSessionId: "tab-1", ptySessionId: "pty-1", label: "対象1" },
      { logicalSessionId: "tab-2", ptySessionId: "pty-2", label: "対象2" },
    ]);
    useReportInboxStore.getState().ingestBatchCompletionEvidence("batch-late", "pty-1", {
      source: "livebrief", kind: "turn-ended", observedAt: NOW, sourceRef: "turn-1",
    });
    useReportInboxStore.getState().ingestBatchCompletionEvidence("batch-late", "pty-2", {
      source: "status", kind: "process-exit", observedAt: NOW + 1, sourceRef: "exit-2",
    });
    const report = useReportInboxStore.getState().dispatchBatchesById["batch-late"]!;
    expect(report.batch.assignments).toHaveLength(2);
    expect(report.batch.publishedSummaryRevision).toBe(2);
    expect(reportBatchCoverage(report, NOW)).toMatchObject({ received: 2, reflected: 2, missing: 0 });
  });

  it("updates a uniquely routed batch when a later machine failure contradicts an earlier receipt", () => {
    registerBatch("batch-follow-up");
    useReportInboxStore.getState().ingestLiveBriefs([brief({ operationalState: "ended" })]);
    useReportInboxStore.getState().ingestSemanticEvents(SESSION, [
      event("test-fail-after-receipt", { type: "testResult", pass: 4, fail: 1 }),
    ]);
    const report = useReportInboxStore.getState().dispatchBatchesById["batch-follow-up"]!;
    const member = report.membersByAssignmentId[report.batch.assignments[0].id];
    expect(report.batch.publishedSummaryRevision).toBe(2);
    expect(member.classification.activity).toBe("error");
    expect(reportBatchCoverage(report, NOW).needsJudgment).toBe(1);
  });

  it("rejects a sealed registration with ambiguous duplicate PTY recipients", () => {
    const batch = sealBatch(createBatch([
      { logicalSessionId: logicalSessionId("tab-1"), instructionRef: SESSION, label: "対象1" },
      { logicalSessionId: logicalSessionId("tab-2"), instructionRef: SESSION, label: "対象2" },
    ], { batchId: "batch-ambiguous" }));
    useReportInboxStore.getState().registerSealedDispatchBatch({
      batch,
      commandKind: "plain",
      members: [
        { logicalSessionId: logicalSessionId("tab-1"), ptySessionId: SESSION, label: "対象1", delivery: { state: "pending", detail: "待機" } },
        { logicalSessionId: logicalSessionId("tab-2"), ptySessionId: SESSION, label: "対象2", delivery: { state: "pending", detail: "待機" } },
      ],
    });
    expect(useReportInboxStore.getState().dispatchBatchesById["batch-ambiguous"]).toBeUndefined();
  });

  it("keeps ambiguous cross-batch evidence out of receipts and records the visible review count", () => {
    registerBatch("batch-old");
    useReportInboxStore.getState().ingestLiveBriefs([brief({ operationalState: "ended" })]);
    registerBatch("batch-new");
    useReportInboxStore.getState().ingestSemanticEvents(SESSION, [
      event("ambiguous-evidence", { type: "testResult", pass: 1, fail: 1 }),
    ]);
    const oldReport = useReportInboxStore.getState().dispatchBatchesById["batch-old"]!;
    const newReport = useReportInboxStore.getState().dispatchBatchesById["batch-new"]!;
    expect(oldReport.unattributedEvidenceRefs).toEqual([]);
    expect(newReport.unattributedEvidenceRefs).toEqual(["ambiguous-evidence"]);
    expect(reportBatchCoverage(newReport, NOW)).toMatchObject({ received: 0, missing: 1, needsJudgment: 1 });
  });

  it("keeps test-pass and turn-ended out of task-complete wording and surfaces evidence conflicts", () => {
    registerBatch("batch-evidence");
    useReportInboxStore.getState().ingestBatchCompletionEvidence("batch-evidence", SESSION, {
      source: "status", kind: "test-pass", observedAt: NOW, sourceRef: "test-pass",
    });
    let report = useReportInboxStore.getState().dispatchBatchesById["batch-evidence"]!;
    let member = report.membersByAssignmentId[report.batch.assignments[0].id];
    expect(member.classification.activity).toBe("waiting");

    useReportInboxStore.getState().ingestBatchCompletionEvidence("batch-evidence", SESSION, {
      source: "ledger", kind: "done-marker", observedAt: NOW + 1, sourceRef: "done",
    });
    useReportInboxStore.getState().ingestBatchCompletionEvidence("batch-evidence", SESSION, {
      source: "livebrief", kind: "turn-ended", observedAt: NOW + 2, sourceRef: "turn-ended",
    });
    report = useReportInboxStore.getState().dispatchBatchesById["batch-evidence"]!;
    member = report.membersByAssignmentId[report.batch.assignments[0].id];
    expect(member.classification.conflicts).toContain("ledger completion conflicts with livebrief non-terminal evidence");
    expect(reportBatchCoverage(report, NOW).needsJudgment).toBe(1);
  });
});
