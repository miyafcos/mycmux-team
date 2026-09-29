import { describe, expect, it } from "vitest";
import { classify, startCycle, type CompletionEvidence } from "../../src/lib/completionEvidence";
import { logicalSessionId } from "../../src/lib/logicalSessionId";

const SESSION_ID = logicalSessionId("s");
const OTHER_SESSION_ID = logicalSessionId("other");
const CURRENT_CYCLE = startCycle(SESSION_ID, 1, 1);
const evidence = (
  source: CompletionEvidence["source"],
  kind: CompletionEvidence["kind"],
  overrides: Partial<CompletionEvidence> = {},
): CompletionEvidence => ({
  source,
  kind,
  logicalSessionId: SESSION_ID,
  cycleId: CURRENT_CYCLE.cycleId,
  observedAt: 1,
  sourceRef: `${source}:${kind}`,
  ...overrides,
});

describe("completionEvidence", () => {
  it.each([
    {
      name: "ledger completion plus ledger verdict is confirmed",
      evidences: [evidence("ledger", "done-marker"), evidence("ledger", "verdict", { observedAt: 2 })],
      expected: { activity: "completed", confidence: "confirmed", verificationPassed: false, conflicts: [], needsJudgment: false },
    },
    {
      name: "a DONE report alone is reported completion",
      evidences: [evidence("livebrief", "done-marker")],
      expected: { activity: "completed", confidence: "reported", verificationPassed: false, conflicts: [], needsJudgment: false },
    },
    {
      name: "a test pass alone is not completion",
      evidences: [evidence("status", "test-pass")],
      expected: { activity: "waiting", confidence: "candidate", verificationPassed: true, conflicts: [], needsJudgment: false },
    },
    {
      name: "a turn ending is waiting",
      evidences: [evidence("status", "turn-ended")],
      expected: { activity: "waiting", confidence: "candidate", verificationPassed: false, conflicts: [], needsJudgment: false },
    },
    {
      name: "a process exit is exited",
      evidences: [evidence("status", "process-exit")],
      expected: { activity: "exited", confidence: "candidate", verificationPassed: false, conflicts: [], needsJudgment: false },
    },
    {
      name: "a source terminal is retained after its later turn-ended event",
      evidences: [
        evidence("ledger", "done-marker"),
        evidence("ledger", "verdict", { observedAt: 2 }),
        evidence("livebrief", "done-marker", { observedAt: 3 }),
        evidence("livebrief", "turn-ended", { observedAt: 4 }),
      ],
      expected: {
        activity: "completed",
        confidence: "confirmed",
        verificationPassed: false,
        conflicts: [],
        needsJudgment: false,
      },
    },
  ])("classifies $name", ({ evidences, expected }) => {
    expect(classify(evidences, CURRENT_CYCLE)).toEqual(expected);
  });

  it("does not invent a conflict or confirmation when the other source has no record", () => {
    expect(classify([evidence("ledger", "verdict")], CURRENT_CYCLE)).toEqual({
      activity: "completed",
      confidence: "reported",
      conflicts: [],
      needsJudgment: false,
      verificationPassed: false,
    });
  });

  it("only flags an actual opposite-source contradiction in the current cycle", () => {
    expect(classify([
      evidence("livebrief", "done-marker", { observedAt: 2 }),
      evidence("ledger", "turn-ended"),
    ], CURRENT_CYCLE)).toMatchObject({
      activity: "completed",
      confidence: "reported",
      conflicts: ["livebrief completion conflicts with ledger non-terminal evidence"],
      needsJudgment: true,
    });
    expect(classify([
      evidence("ledger", "verdict", { observedAt: 2 }),
      evidence("livebrief", "done-marker"),
    ], CURRENT_CYCLE)).toMatchObject({ conflicts: [], needsJudgment: false });
    expect(classify([
      evidence("ledger", "verdict", { observedAt: 2 }),
      evidence("livebrief", "turn-ended", { cycleId: "s:old" }),
    ], CURRENT_CYCLE)).toMatchObject({ conflicts: [], needsJudgment: false });
  });

  it("keeps a true contradiction when the opposing source has no terminal evidence", () => {
    expect(classify([
      evidence("ledger", "done-marker", { observedAt: 1 }),
      evidence("livebrief", "turn-ended", { observedAt: 3 }),
    ], CURRENT_CYCLE)).toMatchObject({
      conflicts: ["ledger completion conflicts with livebrief non-terminal evidence"],
      needsJudgment: true,
    });
  });

  it("does not carry completion evidence into a later cycle", () => {
    expect(classify([
      evidence("ledger", "done-marker", { cycleId: "s:old" }),
      evidence("ledger", "verdict", { cycleId: "s:old", observedAt: 2 }),
      evidence("status", "turn-ended"),
    ], CURRENT_CYCLE)).toEqual({
      activity: "waiting",
      confidence: "candidate",
      conflicts: [],
      needsJudgment: false,
      verificationPassed: false,
    });
  });

  it("does not mix another logical session with the same cycle id", () => {
    expect(classify([
      evidence("ledger", "done-marker", { logicalSessionId: OTHER_SESSION_ID }),
      evidence("ledger", "verdict", { logicalSessionId: OTHER_SESSION_ID, observedAt: 2 }),
      evidence("status", "turn-ended"),
    ], CURRENT_CYCLE)).toEqual({
      activity: "waiting",
      confidence: "candidate",
      conflicts: [],
      needsJudgment: false,
      verificationPassed: false,
    });
  });

  it("resolves test outcomes and completion chronologically, independent of input order", () => {
    const oldFailure = evidence("status", "test-fail", { observedAt: 1 });
    const doneMarker = evidence("ledger", "done-marker", { observedAt: 2 });
    const newVerdict = evidence("ledger", "verdict", { observedAt: 3 });
    expect(classify([newVerdict, oldFailure, doneMarker], CURRENT_CYCLE)).toMatchObject({
      activity: "completed",
      confidence: "confirmed",
      verificationPassed: false,
      needsJudgment: true,
    });
    const newFailure = evidence("status", "test-fail", { observedAt: 4 });
    expect(classify([newFailure, newVerdict, doneMarker], CURRENT_CYCLE)).toMatchObject({
      activity: "error",
      confidence: "candidate",
      verificationPassed: false,
      needsJudgment: true,
    });
    const newPass = evidence("status", "test-pass", { observedAt: 5 });
    expect(classify([newPass, newFailure], CURRENT_CYCLE)).toMatchObject({
      activity: "waiting",
      verificationPassed: true,
      needsJudgment: false,
    });
  });

  it("only treats a ledger verdict paired with ledger completion as confirmed", () => {
    expect(classify([
      evidence("ledger", "done-marker", { observedAt: 1 }),
      evidence("livebrief", "verdict", { observedAt: 2 }),
    ], CURRENT_CYCLE)).toMatchObject({ activity: "completed", confidence: "reported" });
  });

  it("starts independent work cycles", () => {
    expect(startCycle(SESSION_ID, 1, 1).cycleId).not.toBe(startCycle(SESSION_ID, 1, 2).cycleId);
    expect(() => startCycle(SESSION_ID, 1, 0)).toThrow("positive safe integer");
  });
});
