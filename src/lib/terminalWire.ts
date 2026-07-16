import type { FrontendDataBatch } from "./attachEpoch";

const DATA_MAGIC = [0x4d, 0x43, 0x58, 0x31] as const; // MCX1
const SNAPSHOT_MAGIC = [0x4d, 0x43, 0x53, 0x31] as const; // MCS1
const DATA_HEADER_BYTES = 40;
const SNAPSHOT_HEADER_BYTES = 24;
const RESYNC_FLAG = 1;
const MAX_SAFE_U64 = BigInt(Number.MAX_SAFE_INTEGER);

export interface BinaryScrollbackSnapshot {
  data: Uint8Array;
  startOffset: number;
  endOffset: number;
}

function assertFrameMagic(bytes: Uint8Array, expected: readonly number[], label: string): void {
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[index] !== expected[index]) {
      throw new Error(`Invalid ${label} frame magic`);
    }
  }
}

function readSafeU64(view: DataView, offset: number, label: string): number {
  const value = view.getBigUint64(offset, true);
  if (value > MAX_SAFE_U64) {
    throw new Error(`${label} exceeds JavaScript's safe integer range`);
  }
  return Number(value);
}

export function decodeFrontendDataBatch(buffer: ArrayBuffer): FrontendDataBatch {
  if (buffer.byteLength < DATA_HEADER_BYTES) {
    throw new Error("Truncated PTY data frame");
  }
  const bytes = new Uint8Array(buffer);
  assertFrameMagic(bytes, DATA_MAGIC, "PTY data");
  const view = new DataView(buffer);
  const payload = new Uint8Array(buffer, DATA_HEADER_BYTES);
  return {
    generation: readSafeU64(view, 8, "PTY generation"),
    seq: readSafeU64(view, 16, "PTY sequence"),
    bytes: payload.byteLength,
    resync: (view.getUint32(4, true) & RESYNC_FLAG) !== 0,
    scrollbackStart: readSafeU64(view, 24, "PTY scrollback start"),
    scrollbackEnd: readSafeU64(view, 32, "PTY scrollback end"),
    data: payload,
  };
}

export function decodeScrollbackSnapshot(buffer: ArrayBuffer): BinaryScrollbackSnapshot {
  if (buffer.byteLength < SNAPSHOT_HEADER_BYTES) {
    throw new Error("Truncated PTY scrollback frame");
  }
  const bytes = new Uint8Array(buffer);
  assertFrameMagic(bytes, SNAPSHOT_MAGIC, "PTY scrollback");
  const view = new DataView(buffer);
  return {
    startOffset: readSafeU64(view, 8, "PTY scrollback start"),
    endOffset: readSafeU64(view, 16, "PTY scrollback end"),
    data: new Uint8Array(buffer, SNAPSHOT_HEADER_BYTES),
  };
}
