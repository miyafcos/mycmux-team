import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetAttachEpochStateForTests,
  beginSessionAttach,
  getCurrentSessionEpoch,
  type FrontendDataBatch,
} from "../../src/lib/attachEpoch";

function batch(generation: number, seq: number): FrontendDataBatch {
  return {
    generation,
    seq,
    bytes: seq,
    data: [seq],
  };
}

function harness(sessionId = "s1") {
  const delivered: FrontendDataBatch[] = [];
  const acked: Array<{ batch: FrontendDataBatch; current: number | undefined }> = [];
  const attach = beginSessionAttach(sessionId, {
    deliver: (item) => delivered.push(item),
    ackStale: (item, current) => acked.push({ batch: item, current }),
  });

  return { attach, delivered, acked };
}

describe("attach epoch state machine", () => {
  beforeEach(() => {
    __resetAttachEpochStateForTests();
  });

  it("queues batches that arrive before epoch commit, then delivers them in order after commit", () => {
    const { attach, delivered, acked } = harness();
    const first = batch(attach.epoch, 1);
    const second = batch(attach.epoch, 2);

    attach.ingest(first);
    attach.ingest(second);

    expect(delivered).toEqual([]);
    expect(acked).toEqual([]);
    expect(getCurrentSessionEpoch("s1")).toBe(0);

    attach.commit();

    expect(getCurrentSessionEpoch("s1")).toBe(attach.epoch);
    expect(delivered).toEqual([first, second]);
    expect(acked).toEqual([]);
  });

  it("acks and drops stale batches from a pre-replace epoch without delivery", () => {
    const oldAttach = harness();
    oldAttach.attach.commit();
    const oldEpoch = oldAttach.attach.epoch;

    const nextAttach = harness();
    nextAttach.attach.commit();

    const stale = batch(oldEpoch, 1);
    oldAttach.attach.ingest(stale);

    expect(oldAttach.delivered).toEqual([]);
    expect(oldAttach.acked.map((entry) => entry.batch)).toEqual([stale]);
    expect(oldAttach.acked[0].current).toBe(nextAttach.attach.epoch);
  });

  it("rolls back a failed create_session, drains queued batches as stale, and delivers nothing", () => {
    const { attach, delivered, acked } = harness();
    const first = batch(attach.epoch, 1);
    const second = batch(attach.epoch, 2);

    attach.ingest(first);
    attach.ingest(second);
    attach.fail();

    expect(getCurrentSessionEpoch("s1")).toBe(0);
    expect(delivered).toEqual([]);
    expect(acked.map((entry) => entry.batch)).toEqual([first, second]);
    expect(acked.map((entry) => entry.current)).toEqual([undefined, undefined]);
  });

  it("acks each stale ingested batch exactly once and does not ack delivered batches", () => {
    const oldAttach = harness();
    oldAttach.attach.commit();
    const currentAttach = harness();
    currentAttach.attach.commit();

    const staleA = batch(oldAttach.attach.epoch, 1);
    const staleB = batch(oldAttach.attach.epoch, 2);
    const current = batch(currentAttach.attach.epoch, 1);

    oldAttach.attach.ingest(staleA);
    oldAttach.attach.ingest(staleB);
    currentAttach.attach.ingest(current);

    expect(oldAttach.acked.map((entry) => entry.batch.seq)).toEqual([1, 2]);
    expect(new Set(oldAttach.acked.map((entry) => entry.batch.seq)).size).toBe(2);
    expect(currentAttach.delivered).toEqual([current]);
    expect(currentAttach.acked).toEqual([]);
  });

  it("preserves ordering with interleaved stale and current batches around a commit boundary", () => {
    const oldAttach = harness();
    oldAttach.attach.commit();

    const nextAttach = harness();
    const queuedA = batch(nextAttach.attach.epoch, 1);
    const queuedB = batch(nextAttach.attach.epoch, 2);

    nextAttach.attach.ingest(queuedA);
    nextAttach.attach.ingest(queuedB);
    expect(nextAttach.delivered).toEqual([]);

    nextAttach.attach.commit();
    const staleOld = batch(oldAttach.attach.epoch, 1);
    oldAttach.attach.ingest(staleOld);
    const currentAfterCommit = batch(nextAttach.attach.epoch, 3);
    nextAttach.attach.ingest(currentAfterCommit);

    expect(nextAttach.delivered).toEqual([queuedA, queuedB, currentAfterCommit]);
    expect(oldAttach.acked.map((entry) => entry.batch)).toEqual([staleOld]);
  });
});
