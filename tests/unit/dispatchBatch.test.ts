import { describe, expect, it } from "vitest";
import {
  addAssignments,
  coverage,
  createBatch,
  publishSummary,
  recordCancel,
  recordCompletionEvidence,
  recordEvidence,
  recordFailure,
  recordWaive,
  sealBatch,
  type AssignmentRoute,
  type DispatchRecipient,
} from "../../src/lib/dispatchBatch";
import { logicalSessionId } from "../../src/lib/logicalSessionId";
import { classify, startCycle, type CompletionEvidence } from "../../src/lib/completionEvidence";

const recipient = (session: string, instructionRef: string): DispatchRecipient => ({
  logicalSessionId: logicalSessionId(session),
  instructionRef,
});
const route = (assignmentId: string, instructionRef: string): AssignmentRoute => ({
  assignmentId,
  instructionRef,
});

describe("dispatchBatch", () => {
  it("counts receipts separately from settled assignments and exposes the completion barrier", () => {
    let batch = createBatch([
      recipient("a", "i:1"),
      recipient("b", "i:2"),
      recipient("c", "i:3"),
      recipient("d", "i:4"),
    ], { batchId: "b", deadlineAt: 10 });
    batch = recordEvidence(batch, route("b:1", "i:1"), "done").batch;
    batch = recordWaive(batch, route("b:2", "i:2")).batch;
    batch = recordCancel(batch, route("b:3", "i:3")).batch;
    batch = recordFailure(batch, route("b:4", "i:4")).batch;
    expect(coverage(batch, 11)).toEqual({
      target: 4,
      received: 1,
      settled: 4,
      reflected: 0,
      missing: 3,
      needsJudgment: 1,
      complete: true,
      partial: false,
    });
  });

  it("keeps complete independent from the deadline partial flag", () => {
    const open = createBatch([recipient("a", "i:1")], { batchId: "b", deadlineAt: 10 });
    expect(coverage(open, 9)).toMatchObject({ complete: false, partial: false });
    expect(coverage(open, 11)).toMatchObject({ complete: false, partial: true });
    const waived = recordWaive(open, route("b:1", "i:1")).batch;
    expect(coverage(waived, 11)).toMatchObject({ received: 0, settled: 1, complete: true, partial: false });
  });

  it("prevents membership changes after sealing", () => {
    const open = createBatch([recipient("a", "i:1")], { batchId: "b" });
    expect(addAssignments(open, [recipient("b", "i:2")]).assignments.map((value) => value.id)).toEqual(["b:1", "b:2"]);
    const sealed = sealBatch(open);
    expect(addAssignments(sealed, [recipient("b", "i:2")])).toBe(sealed);
  });

  it("requires explicit collision-free batch ids", () => {
    const recipients = [recipient("same", "i:1")];
    expect(createBatch(recipients, { batchId: "first" }).assignments[0].id).toBe("first:1");
    expect(createBatch(recipients, { batchId: "second" }).assignments[0].id).toBe("second:1");
  });

  it("routes evidence by assignment and instruction and reports rejected routes", () => {
    const batch = createBatch([
      recipient("same", "instruction:1"),
      recipient("same", "instruction:2"),
    ], { batchId: "b" });
    expect(recordEvidence(batch, route("unknown", "instruction:1"), "done")).toEqual({ batch, applied: false });
    expect(recordEvidence(batch, route("b:2", "instruction:1"), "done")).toEqual({ batch, applied: false });
    const once = recordEvidence(batch, route("b:2", "instruction:2"), "done");
    expect(once.applied).toBe(true);
    expect(once.batch.assignments[0].evidenceRefs).toEqual([]);
    expect(once.batch.assignments[1].evidenceRefs).toEqual(["done"]);
    const duplicate = recordEvidence(once.batch, route("b:2", "instruction:2"), "done");
    expect(duplicate).toEqual({ batch: once.batch, applied: true });
  });

  it("separates transition revisions from published summary revisions", () => {
    let batch = createBatch([
      recipient("a", "i:1"),
      recipient("b", "i:2"),
    ], { batchId: "b" });
    batch = recordEvidence(batch, route("b:1", "i:1"), "first").batch;
    expect(batch).toMatchObject({ transitionRevision: 1, publishedSummaryRevision: 0 });
    expect(coverage(batch, 0).reflected).toBe(0);
    batch = publishSummary(batch);
    expect(batch.publishedSummaryRevision).toBe(1);
    expect(coverage(batch, 0).reflected).toBe(1);
    batch = recordEvidence(batch, route("b:2", "i:2"), "late").batch;
    expect(batch).toMatchObject({ transitionRevision: 2, publishedSummaryRevision: 1 });
    expect(coverage(batch, 0).reflected).toBe(1);
    batch = publishSummary(batch);
    expect(batch.publishedSummaryRevision).toBe(2);
    expect(coverage(batch, 0).reflected).toBe(2);
  });

  it("routes completion conflicts into needs judgment once per assignment", () => {
    const sessionId = logicalSessionId("a");
    const cycle = startCycle(sessionId, 1, 1);
    const completionEvidence = (
      source: CompletionEvidence["source"],
      kind: CompletionEvidence["kind"],
      observedAt: number,
    ): CompletionEvidence => ({
      source,
      kind,
      logicalSessionId: sessionId,
      cycleId: cycle.cycleId,
      observedAt,
      sourceRef: `${source}:${kind}`,
    });
    const classification = classify([
      completionEvidence("ledger", "done-marker", 1),
      completionEvidence("ledger", "verdict", 2),
      completionEvidence("livebrief", "turn-ended", 1),
    ], cycle);
    expect(classification.needsJudgment).toBe(true);
    const batch = createBatch([{ logicalSessionId: sessionId, instructionRef: "i:1" }], { batchId: "b" });
    const conflicted = recordCompletionEvidence(
      batch,
      route("b:1", "i:1"),
      "completion:1",
      classification,
    ).batch;
    const duplicate = recordCompletionEvidence(
      conflicted,
      route("b:1", "i:1"),
      "completion:1",
      classification,
    ).batch;
    expect(coverage(duplicate, 0).needsJudgment).toBe(1);
  });
});
