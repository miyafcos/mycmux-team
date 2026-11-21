import { describe, expect, it } from "vitest";
import {
  TERMINAL_BATCH_RETAINED_MAX_BYTES,
  TerminalBatchQueue,
  trimOldestBatchesToByteCap,
} from "../../src/lib/terminalBatchQueue";

function pending(seq: number, bytes: number) {
  return {
    batch: {
      generation: 1,
      seq,
      bytes,
      data: [seq],
    },
    acked: false,
  };
}

describe("terminal batch queue cap", () => {
  it("retains all parked output beyond the backend recovery window, in FIFO order", () => {
    const batches = Array.from({ length: 1025 }, (_, seq) => ({
      acked: true, batch: { seq, generation: 1, bytes: 512, scrollbackStart: 42 + seq * 512,
        scrollbackEnd: 42 + (seq + 1) * 512, data: new Uint8Array(512).fill(seq % 251) },
    }));
    const result = trimOldestBatchesToByteCap(batches);
    expect(result.dropped).toHaveLength(0);
    expect(result.needsScrollbackResync).toBe(false);
    expect(result.retainedBytes).toBe(524800);
    const queue = new TerminalBatchQueue(result.retained);
    const first = queue.shift()!;
    queue.unshift(first);
    expect(queue.trim()).toBeUndefined();
    expect(queue.retainedBytes).toBe(result.retainedBytes);
    const restored = queue.drain();
    expect(restored.length).toBe(batches.length);
    expect(restored.every((item, index) => item === batches[index])).toBe(true);
    expect(queue.retainedBytes).toBe(0);
    expect(queue.length).toBe(0);
  });

  it("does not inspect earlier entries on each append below the limit", () => {
    const initial = Array.from({length: 2500}, (_, seq) => pending(seq, 1));
    const parked = new TerminalBatchQueue(initial);
    for (const item of initial.slice(0, 1300)) expect(parked.shift()).toBe(item);
    parked.unshift(initial[1299]);
    expect(parked.retainedBytes).toBe(1201);
    expect(parked.drain()).toEqual(initial.slice(1299));
    let reads = 0;
    const queue = new TerminalBatchQueue<{batch: {bytes: number}}>();
    for (let index = 0; index < 1024; index++) {
      queue.push({batch: {get bytes() { reads++; return 1; }}});
      expect(queue.trim()).toBeUndefined();
    }
    expect(reads).toBe(1024);
    queue.push({batch: {bytes: TERMINAL_BATCH_RETAINED_MAX_BYTES}});
    expect(queue.trim()?.length).toBe(1024);
    expect(queue.retainedBytes).toBe(TERMINAL_BATCH_RETAINED_MAX_BYTES);
    expect(queue.shift()?.batch.bytes).toBe(TERMINAL_BATCH_RETAINED_MAX_BYTES);
    expect(queue.retainedBytes).toBe(0);
  });

  it("retains batches when the byte total is under the cap", () => {
    const batches = [pending(1, 64), pending(2, 128)];

    const result = trimOldestBatchesToByteCap(batches, 256);

    expect(result.retained.map((item) => item.batch.seq)).toEqual([1, 2]);
    expect(result.dropped).toEqual([]);
    expect(result.retainedBytes).toBe(192);
    expect(result.droppedBytes).toBe(0);
    expect(result.needsScrollbackResync).toBe(false);
  });

  it("drops the oldest batches until the retained byte total fits", () => {
    const batches = [pending(1, 100), pending(2, 120), pending(3, 80)];

    const result = trimOldestBatchesToByteCap(batches, 200);

    expect(result.dropped.map((item) => item.batch.seq)).toEqual([1]);
    expect(result.retained.map((item) => item.batch.seq)).toEqual([2, 3]);
    expect(result.retainedBytes).toBe(200);
    expect(result.droppedBytes).toBe(100);
    expect(result.needsScrollbackResync).toBe(true);
  });

  it("uses the shared 2MB retained cap by default", () => {
    const overCap = TERMINAL_BATCH_RETAINED_MAX_BYTES + 1;
    const result = trimOldestBatchesToByteCap([pending(1, 1), pending(2, overCap)]);

    expect(result.dropped.map((item) => item.batch.seq)).toEqual([1, 2]);
    expect(result.retained).toEqual([]);
    expect(result.retainedBytes).toBe(0);
    expect(result.needsScrollbackResync).toBe(true);
  });
});
