import { beforeEach, describe, expect, it } from "vitest";

import type { Sha256 } from "../../src/lib/persistentLayoutProjection";
import {
  __resetGroupingRuntimeForTests,
  markDurabilityPending,
  recordPersistenceRetrySuperseded,
  recordPersistenceRetrySuccess,
  recordPersistOutcome,
  useGroupingRuntimeStore,
} from "../../src/stores/groupingRuntimeStore";

const signatureA = "a".repeat(64) as Sha256;
const signatureB = "b".repeat(64) as Sha256;
const digestA = "c".repeat(64) as Sha256;
const digestB = "d".repeat(64) as Sha256;

function pendingRequestId(): string {
  const durability = useGroupingRuntimeStore.getState().durability;
  if (durability.status !== "pending") throw new Error("durability is not pending");
  return durability.requestId;
}

describe("grouping durability generations", () => {
  beforeEach(() => __resetGroupingRuntimeForTests());

  it("does not accept a saved acknowledgement with a mismatched revision or signature", () => {
    markDurabilityPending(7, signatureA, digestA, 1);
    const revisionMismatchRequestId = pendingRequestId();
    recordPersistOutcome({
      status: "saved",
      requestId: revisionMismatchRequestId,
      savedRevision: 8,
      savedSignature: signatureA,
      savedDigest: digestA,
      leaderGeneration: 1,
    });
    expect(useGroupingRuntimeStore.getState().durability).toMatchObject({
      status: "failed",
      layoutRevision: 7,
      signature: signatureA,
    });

    markDurabilityPending(9, signatureA, digestA, 1);
    const signatureMismatchRequestId = pendingRequestId();
    recordPersistOutcome({
      status: "saved",
      requestId: signatureMismatchRequestId,
      savedRevision: 9,
      savedSignature: signatureB,
      savedDigest: digestA,
      leaderGeneration: 1,
    });
    expect(useGroupingRuntimeStore.getState().durability).toMatchObject({
      status: "failed",
      layoutRevision: 9,
      signature: signatureA,
    });
  });

  it("ignores an old acknowledgement after a newer durability generation begins", () => {
    markDurabilityPending(10, signatureA, digestA, 1);
    const oldRequestId = pendingRequestId();
    markDurabilityPending(11, signatureB, digestB, 2);
    const currentRequestId = pendingRequestId();

    recordPersistOutcome({
      status: "saved",
      requestId: oldRequestId,
      savedRevision: 10,
      savedSignature: signatureA,
      savedDigest: digestA,
      leaderGeneration: 1,
    });
    expect(useGroupingRuntimeStore.getState().durability).toMatchObject({
      status: "pending",
      requestId: currentRequestId,
      layoutRevision: 11,
      signature: signatureB,
    });

    recordPersistOutcome({
      status: "saved",
      requestId: currentRequestId,
      savedRevision: 11,
      savedSignature: signatureB,
      savedDigest: digestB,
      leaderGeneration: 2,
    });
    expect(useGroupingRuntimeStore.getState().durability).toMatchObject({
      status: "saved",
      requestId: currentRequestId,
      layoutRevision: 11,
      signature: signatureB,
    });
  });

  it("clears a failed warning only for the matching retry generation", () => {
    markDurabilityPending(12, signatureA, digestA, 3);
    const requestId = pendingRequestId();
    recordPersistOutcome({
      status: "failed",
      requestId,
      error: "disk busy",
      retryScheduled: true,
      failureGeneration: 41,
    });
    recordPersistenceRetrySuccess({
      failureGeneration: 41,
      savedRevision: 12,
      savedSignature: signatureA,
      savedDigest: digestA,
      leaderGeneration: 3,
    });
    expect(useGroupingRuntimeStore.getState().durability).toMatchObject({
      status: "saved",
      requestId,
      layoutRevision: 12,
    });
  });

  it("does not let an old retry success clear a newer failure", () => {
    markDurabilityPending(13, signatureA, digestA, 4);
    const requestId = pendingRequestId();
    recordPersistOutcome({
      status: "failed",
      requestId,
      error: "first",
      retryScheduled: true,
      failureGeneration: 51,
    });
    markDurabilityPending(14, signatureB, digestB, 4);
    const newerRequestId = pendingRequestId();
    recordPersistOutcome({
      status: "failed",
      requestId: newerRequestId,
      error: "second",
      retryScheduled: true,
      failureGeneration: 52,
    });
    recordPersistenceRetrySuccess({
      failureGeneration: 51,
      savedRevision: 13,
      savedSignature: signatureA,
      savedDigest: digestA,
      leaderGeneration: 4,
    });
    expect(useGroupingRuntimeStore.getState().durability).toMatchObject({
      status: "failed",
      requestId: newerRequestId,
      failureGeneration: 52,
    });
  });

  it("clears the matching failed generation after a newer current-world save", () => {
    markDurabilityPending(15, signatureA, digestA, 5);
    const requestId = pendingRequestId();
    recordPersistOutcome({
      status: "failed",
      requestId,
      error: "old layout failed",
      retryScheduled: true,
      failureGeneration: 61,
    });

    recordPersistenceRetrySuperseded(60);
    expect(useGroupingRuntimeStore.getState().durability).toMatchObject({
      status: "failed",
      failureGeneration: 61,
    });

    recordPersistenceRetrySuperseded(61);
    expect(useGroupingRuntimeStore.getState().durability).toMatchObject({
      status: "saved",
      requestId,
      layoutRevision: 15,
    });
  });
});
