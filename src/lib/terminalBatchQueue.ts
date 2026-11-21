export const TERMINAL_BATCH_RETAINED_MAX_BYTES = 2 * 1024 * 1024;
const COMPACT_CONSUMED_ENTRIES = 1024;

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

export class TerminalBatchQueue<T extends ByteSizedFrontendBatch> {
  private bytes = 0;
  private items: (T | undefined)[] = [];
  private head = 0;

  constructor(initial: readonly T[] = []) {
    for (const item of initial) this.push(item);
  }

  get length(): number { return this.items.length - this.head; }
  get retainedBytes(): number { return this.bytes; }

  push(item: T): void {
    this.items.push(item);
    this.bytes += Math.max(0, item.batch.bytes);
  }

  unshift(item: T): void {
    if (this.head > 0) this.items[--this.head] = item;
    else this.items.unshift(item);
    this.bytes += Math.max(0, item.batch.bytes);
  }

  shift(): T | undefined {
    if (!this.length) return;
    const item = this.items[this.head]!;
    this.items[this.head++] = undefined;
    this.bytes -= Math.max(0, item.batch.bytes);
    if (!this.length) {
      this.items.length = 0;
      this.head = 0;
    } else if (this.head >= COMPACT_CONSUMED_ENTRIES && this.head >= this.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return item;
  }

  drain(): T[] {
    const items = (this.head ? this.items.slice(this.head) : this.items) as T[];
    this.items = [];
    this.head = 0;
    this.bytes = 0;
    return items;
  }

  trim(maxBytes = TERMINAL_BATCH_RETAINED_MAX_BYTES): T[] | undefined {
    if (this.bytes <= maxBytes) return;
    const dropped: T[] = [];
    while (this.bytes > maxBytes && this.length) dropped.push(this.shift()!);
    return dropped;
  }
}

export function trimOldestBatchesToByteCap<T extends ByteSizedFrontendBatch>(
  batches: readonly T[],
  maxBytes = TERMINAL_BATCH_RETAINED_MAX_BYTES,
): TrimmedFrontendBatches<T> {
  const queue = new TerminalBatchQueue(batches);
  const totalBytes = queue.retainedBytes;
  const dropped = queue.trim(maxBytes) ?? [];
  const retainedBytes = queue.retainedBytes;

  return {
    retained: queue.drain(),
    dropped,
    retainedBytes,
    droppedBytes: totalBytes - retainedBytes,
    needsScrollbackResync: dropped.length > 0,
  };
}
