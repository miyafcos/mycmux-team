import { describe, expect, it } from "vitest";
import {
  TERMINAL_BATCH_RETAINED_MAX_BYTES,
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
