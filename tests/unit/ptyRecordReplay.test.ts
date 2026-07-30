import { describe, expect, it } from "vitest";
import {
  PtyRecorder,
  base64ToBytes,
  parsePtyRecording,
  replayPtyRecording,
  serializePtyRecording,
} from "../../src/lib/ptyReplay";
import { createTerminalMouseModeControlFilter } from "../../src/components/terminal/terminalMouseInputFilter";

function makeRecording() {
  const times = [100, 110, 135];
  const recorder = new PtyRecorder("session-a", {
    now: () => times.shift() ?? 135,
    wallClock: () => new Date("2026-07-29T00:00:00.000Z"),
  });
  recorder.record({
    generation: 1,
    seq: 1,
    resync: false,
    scrollbackStart: 0,
    scrollbackEnd: 6,
    data: new Uint8Array([0, 0x1b, 0x5b, 0x41, 0xff, 0xfe]),
  });
  recorder.record({
    generation: 1,
    seq: 2,
    resync: false,
    scrollbackStart: 6,
    scrollbackEnd: 9,
    data: new Uint8Array([0xe3, 0x81, 0x82]),
  });
  return recorder.finish(() => new Date("2026-07-29T00:00:01.000Z"));
}

describe("PTY record and replay", () => {
  it("round-trips arbitrary PTY bytes through NDJSON", () => {
    const recording = makeRecording();
    const parsed = parsePtyRecording(serializePtyRecording(recording));

    expect(parsed).toEqual(recording);
    expect([...base64ToBytes(parsed.events[0].dataBase64)]).toEqual([
      0, 0x1b, 0x5b, 0x41, 0xff, 0xfe,
    ]);
    expect(parsed.footer).toMatchObject({ eventCount: 2, bytes: 9, valid: true, gaps: 0 });
  });

  it("marks resyncs and scrollback discontinuities as non-reproducible", () => {
    let now = 0;
    const recorder = new PtyRecorder("session-a", { now: () => now });
    recorder.record({
      generation: 1,
      seq: 1,
      resync: false,
      scrollbackStart: 0,
      scrollbackEnd: 2,
      data: new Uint8Array([1, 2]),
    });
    now += 1;
    recorder.record({
      generation: 1,
      seq: 2,
      resync: true,
      scrollbackStart: 4,
      scrollbackEnd: 5,
      data: new Uint8Array([3]),
    });

    expect(recorder.finish().footer).toMatchObject({ valid: false, gaps: 1 });
  });

  it("replays the same recording twice with identical byte, write, and render counts", async () => {
    const recording = makeRecording();

    const run = async () => {
      let now = 0;
      let bytes = 0;
      let writes = 0;
      let onRender = 0;
      const delays: number[] = [];
      const result = await replayPtyRecording(
        recording,
        async (data) => {
          bytes += data.byteLength;
          writes += 1;
          onRender += 1;
        },
        {
          now: () => now,
          sleep: async (delay) => {
            delays.push(delay);
            now += delay;
          },
          snapshot: () => ({ bytes, writes, onRender }),
        },
      );
      return { result, delays };
    };

    const first = await run();
    const second = await run();
    expect(first.result).toEqual(second.result);
    expect(first.result).toMatchObject({
      bytes: 9,
      writeCalls: 2,
      snapshot: { bytes: 9, writes: 2, onRender: 2 },
    });
    expect(first.delays).toEqual([10, 25]);
  });

  it("rejects recordings whose footer does not match the payload", () => {
    const serialized = serializePtyRecording(makeRecording()).replace('"bytes":9', '"bytes":10');
    expect(() => parsePtyRecording(serialized)).toThrow(/footer does not match/);
  });

  it("filters mouse-mode control sequences split across replay batches", () => {
    const filter = createTerminalMouseModeControlFilter();
    expect(filter("before\x1b[?10")).toBe("before");
    expect(filter("00hafter")).toBe("after");
  });
});
