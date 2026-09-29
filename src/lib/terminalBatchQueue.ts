export const TERMINAL_BATCH_RETAINED_MAX_BYTES = 2 * 1024 * 1024;

export type ByteSizedFrontendBatch = {
  batch: {
    bytes: number;
  };
};

export type TrimmedFrontendBatches<T> = {
  retained: T[];
  dropped: T[];
  retainedBytes: number;
  droppedBytes: number;
  needsScrollbackResync: boolean;
};

export function trimOldestBatchesToByteCap<T extends ByteSizedFrontendBatch>(
  batches: readonly T[],
  maxBytes = TERMINAL_BATCH_RETAINED_MAX_BYTES,
): TrimmedFrontendBatches<T> {
  let retainedBytes = batches.reduce(
    (total, item) => total + Math.max(0, item.batch.bytes),
    0,
  );
  const retained = [...batches];
  const dropped: T[] = [];
  let droppedBytes = 0;

  while (retainedBytes > maxBytes && retained.length > 0) {
    const item = retained.shift()!;
    const bytes = Math.max(0, item.batch.bytes);
    retainedBytes -= bytes;
    droppedBytes += bytes;
    dropped.push(item);
  }

  return {
    retained,
    dropped,
    retainedBytes,
    droppedBytes,
    needsScrollbackResync: dropped.length > 0,
  };
}
