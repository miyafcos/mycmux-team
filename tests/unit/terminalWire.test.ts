import { describe, expect, it } from "vitest";
import {
  decodeFrontendDataBatch,
  decodeScrollbackSnapshot,
} from "../../src/lib/terminalWire";

function writeU64(view: DataView, offset: number, value: number | bigint): void {
  view.setBigUint64(offset, BigInt(value), true);
}

describe("terminal binary wire format", () => {
  it("decodes a PTY data frame without expanding the payload into JSON numbers", () => {
    const frame = new ArrayBuffer(43);
    const bytes = new Uint8Array(frame);
    bytes.set([0x4d, 0x43, 0x58, 0x31]);
    const view = new DataView(frame);
    view.setUint32(4, 1, true);
    writeU64(view, 8, 3);
    writeU64(view, 16, 9);
    writeU64(view, 24, 100);
    writeU64(view, 32, 103);
    bytes.set([65, 66, 67], 40);

    const decoded = decodeFrontendDataBatch(frame);

    expect(decoded).toMatchObject({
      generation: 3,
      seq: 9,
      bytes: 3,
      resync: true,
      scrollbackStart: 100,
      scrollbackEnd: 103,
    });
    expect(Array.from(decoded.data as Uint8Array)).toEqual([65, 66, 67]);
  });

  it("decodes a raw scrollback snapshot", () => {
    const frame = new ArrayBuffer(26);
    const bytes = new Uint8Array(frame);
    bytes.set([0x4d, 0x43, 0x53, 0x31]);
    const view = new DataView(frame);
    writeU64(view, 8, 40);
    writeU64(view, 16, 42);
    bytes.set([10, 11], 24);

    const decoded = decodeScrollbackSnapshot(frame);

    expect(decoded.startOffset).toBe(40);
    expect(decoded.endOffset).toBe(42);
    expect(Array.from(decoded.data)).toEqual([10, 11]);
  });

  it("rejects truncated, unknown, and unsafe frames", () => {
    expect(() => decodeFrontendDataBatch(new ArrayBuffer(39))).toThrow("Truncated");

    const unknown = new ArrayBuffer(40);
    expect(() => decodeFrontendDataBatch(unknown)).toThrow("magic");

    const unsafe = new ArrayBuffer(40);
    new Uint8Array(unsafe).set([0x4d, 0x43, 0x58, 0x31]);
    new DataView(unsafe).setBigUint64(8, BigInt(Number.MAX_SAFE_INTEGER) + 1n, true);
    expect(() => decodeFrontendDataBatch(unsafe)).toThrow("safe integer");
  });
});
