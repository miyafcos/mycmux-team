import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readPaneTail } from "../../src/components/layout/socketCommands";
import { terminalSizeCache } from "../../src/components/terminal/terminalCache";
import { __headlessBufferCacheSizeForTests, __resetHeadlessBufferCacheForTests, getHeadlessBufferLines, readHeadlessBufferLines } from "../../src/components/terminal/headlessBuffer";
import { TerminalDeadlineError } from "../../src/lib/terminalDeadline";
import type { ScrollbackSnapshot } from "../../src/lib/ipc";

const mocks = vi.hoisted(() => ({ read: vi.fn(), visible: vi.fn(), lines: vi.fn() }));
vi.mock("../../src/lib/ipc", async (original) => ({
  ...await original<typeof import("../../src/lib/ipc")>(), getSessionScrollback: mocks.read,
}));
vi.mock("../../src/components/terminal/XTermWrapper", () => ({
  hasTerminalBuffer: mocks.visible, getTerminalBufferLines: mocks.lines,
}));

const encoder = new TextEncoder();
interface Cursor { endOffset: number; sessionEpoch: number; sizeRevision: number }
interface Snapshot extends ScrollbackSnapshot {
  cols: number; rows: number; sessionEpoch: number; sizeRevision: number; isDelta: boolean;
}
let current: Snapshot;
let requests: Array<Cursor | undefined>;
let payloadBytes: number[];

function frame(cols = 120, rows = 40, label = "Working (1s)"): string {
  const wide = "A".repeat(cols - 20);
  return `\x1b[3J\x1b[2J\x1b[H\x1b[1;${rows - 2}r\x1b[${rows - 4};1H${wide}\r\nB\r\n\x1b[2A\x1b[1GW\x1b[${rows - 2};1H\x1b[2K${label}\x1b[${rows - 1};1H\x1b[2Kterminal running`;
}
function expected(cols = 120, label = "Working (1s)"): string[] {
  return [`W${"A".repeat(cols - 21)}`, "B", label, "terminal running"];
}
function replace(text: string, options: Partial<Snapshot> = {}): void {
  const data = encoder.encode(text);
  current = { data, startOffset: 0, endOffset: data.length, cols: 120, rows: 40, sessionEpoch: 17, sizeRevision: 0, isDelta: false, ...options };
}
function append(text: string): void {
  const suffix = encoder.encode(text);
  const data = new Uint8Array(current.data.length + suffix.length);
  data.set(current.data); data.set(suffix, current.data.length);
  current = { ...current, data, endOffset: current.endOffset + suffix.length };
}
function response(cursor?: Cursor): Snapshot {
  requests.push(cursor);
  const valid = cursor && cursor.sessionEpoch === current.sessionEpoch
    && cursor.sizeRevision === current.sizeRevision
    && cursor.endOffset >= current.startOffset && cursor.endOffset <= current.endOffset;
  const result = valid
    ? { ...current, data: current.data.slice(cursor.endOffset - current.startOffset), startOffset: cursor.endOffset, isDelta: true }
    : { ...current, data: current.data.slice(), isDelta: false };
  payloadBytes.push(result.data.length);
  return result;
}

beforeEach(() => {
  __resetHeadlessBufferCacheForTests(); terminalSizeCache.clear(); vi.clearAllMocks();
  mocks.visible.mockReturnValue(false); requests = []; payloadBytes = [];
  replace(frame()); mocks.read.mockImplementation(async (_id: string, cursor?: Cursor) => response(cursor));
});
afterEach(() => { vi.useRealTimers(); __resetHeadlessBufferCacheForTests(); terminalSizeCache.clear(); });

describe("stage 0 background pane reads", () => {
  it("T1 reconstructs a 120x40 positioned Codex-like frame without a renderer size cache", async () => {
    const legacy = { data: current.data, startOffset: 0, endOffset: current.endOffset };
    await expect(getHeadlessBufferLines("old-default", legacy, 40)).resolves.not.toEqual(expected());
    await expect(readPaneTail("background", 40)).resolves.toEqual(expected());
    expect(terminalSizeCache.has("background")).toBe(false);
  });

  it("T1 reconstructs at the current dimensions after a resize", async () => {
    await readPaneTail("background", 40);
    append(frame(90, 30, "Working (2s)"));
    current = { ...current, cols: 90, rows: 30, sizeRevision: 1 };
    await expect(readPaneTail("background", 40)).resolves.toEqual(expected(90, "Working (2s)"));
    await expect(getHeadlessBufferLines("full", current, 40)).resolves.toEqual(expected(90, "Working (2s)"));
    expect(payloadBytes[1]).toBe(current.data.length);
  });

  it("prefers a valid renderer cache over snapshot geometry", async () => {
    current = { ...current, cols: 80, rows: 24 };
    terminalSizeCache.set("background", { cols: 120, rows: 40 });
    await expect(readPaneTail("background", 40)).resolves.toEqual(expected());
  });

  it("falls back to snapshot geometry when renderer dimensions are invalid", async () => {
    terminalSizeCache.set("background", { cols: 0, rows: NaN });
    await expect(readPaneTail("background", 40)).resolves.toEqual(expected());
  });

  it("T2 receives only appended bytes and matches replay of the complete recording", async () => {
    await readPaneTail("background", 40);
    append("\x1b[38;1H\x1b[2KWorking (2s)");
    const actual = await readPaneTail("background", 40);
    expect(actual).toEqual(await getHeadlessBufferLines("full", current, 40));
    expect(actual).toEqual(expected(120, "Working (2s)"));
    expect(requests[1]).toEqual({ endOffset: payloadBytes[0], sessionEpoch: 17, sizeRevision: 0 });
    expect(payloadBytes[1]).toBe(encoder.encode("\x1b[38;1H\x1b[2KWorking (2s)").length);
    expect(payloadBytes[1]).toBeLessThan(current.data.length);
  });

  it("T2 preserves parser state across split control sequences in a complete recording", async () => {
    const data = encoder.encode(frame(120, 40, "Working \u2713 (3s)"));
    let offset = 0;
    let actual: string[] = [];
    for (const count of [7, 11, 129, 31, 1, 2, data.length]) {
      offset = Math.min(data.length, offset + count);
      current = { ...current, data: data.slice(0, offset), endOffset: offset };
      actual = await readPaneTail("background", 40);
    }
    expect(actual).toEqual(await getHeadlessBufferLines("full", current, 40));
    expect(actual).toEqual(expected(120, "Working \u2713 (3s)"));
    expect(payloadBytes.reduce((sum, value) => sum + value, 0)).toBe(data.length);
  });

  it("T2 rebuilds when the retained ring passes the cursor and contains a full redraw", async () => {
    await readPaneTail("background", 40);
    const end = current.endOffset;
    replace(frame(120, 40, "Working (9s)"), { startOffset: end + 100, endOffset: end + 100 + encoder.encode(frame(120, 40, "Working (9s)")).length });
    const actual = await readPaneTail("background", 40);
    expect(actual).toEqual(await getHeadlessBufferLines("full", current, 40));
    expect(actual).toEqual(expected(120, "Working (9s)"));
    expect(payloadBytes[1]).toBe(current.data.length);
  });

  it("T2 rebuilds when a recreated session has the same ID and byte offsets", async () => {
    await readPaneTail("background", 40);
    replace(frame(120, 40, "Working (7s)"), { sessionEpoch: 18 });
    const actual = await readPaneTail("background", 40);
    expect(actual).toEqual(await getHeadlessBufferLines("full", current, 40));
    expect(actual).toEqual(expected(120, "Working (7s)"));
    expect(payloadBytes[1]).toBe(current.data.length);
  });

  it("T2 accepts an empty delta while keeping a previously parsed screen", async () => {
    await readPaneTail("background", 40);
    await expect(readPaneTail("background", 40)).resolves.toEqual(expected());
    expect(payloadBytes[1]).toBe(0);
  });

  it("serializes fetching and parsing so concurrent reads use the latest cursor", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    mocks.read.mockImplementationOnce(async () => { await hold; return response(); });
    const first = readPaneTail("background", 40);
    const second = readPaneTail("background", 40);
    await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(1), { timeout: 1000 });
    release();
    expect(await first).toEqual(expected()); expect(await second).toEqual(expected());
    expect(payloadBytes).toEqual([current.data.length, 0]);
  });

  it("requests a full replay when the renderer geometry changes", async () => {
    terminalSizeCache.set("background", { cols: 120, rows: 40 });
    await readPaneTail("background", 40);
    terminalSizeCache.set("background", { cols: 90, rows: 30 });
    append(frame(90, 30, "Working (4s)"));
    await expect(readPaneTail("background", 40)).resolves.toEqual(expected(90, "Working (4s)"));
    expect(requests[1]).toBeUndefined();
    expect(payloadBytes[1]).toBe(current.data.length);
  });

  it("T2 rebuilds after a resize away and back even at unchanged final dimensions", async () => {
    await readPaneTail("background", 40);
    append(frame(120, 40, "Working (5s)")); current.sizeRevision = 2;
    await expect(readPaneTail("background", 40)).resolves.toEqual(expected(120, "Working (5s)"));
    expect(payloadBytes[1]).toBe(current.data.length);
  });

  it("does not consult scrollback for a parsed visible pane", async () => {
    mocks.visible.mockReturnValue(true); mocks.lines.mockReturnValue(["visible"]);
    await expect(readPaneTail("front", 40)).resolves.toEqual(["visible"]);
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("falls back to a full snapshot if an incompatible delta arrives", async () => {
    await readPaneTail("background", 40);
    replace(frame(120, 40, "Working (8s)"), { sessionEpoch: 18 });
    mocks.read.mockImplementationOnce(async () => ({ ...current, isDelta: true }));
    await expect(readPaneTail("background", 40)).resolves.toEqual(expected(120, "Working (8s)"));
    expect(mocks.read).toHaveBeenLastCalledWith("background");
  });

  it("starts with the complete redraw again after the parser leaves the 12-entry cache", async () => {
    await readPaneTail("background", 40);
    for (let index = 0; index < 12; index++) await readPaneTail(`other-${index}`, 40);
    await expect(readPaneTail("background", 40)).resolves.toEqual(expected());
    expect(requests.at(-1)).toBeUndefined();
    expect(payloadBytes.at(-1)).toBe(current.data.length);
  });

  it("keeps the legacy full-snapshot path working", async () => {
    terminalSizeCache.set("background", { cols: 120, rows: 40 });
    mocks.read.mockImplementation(async () => ({ data: current.data, startOffset: 0, endOffset: current.endOffset }));
    await expect(readPaneTail("background", 40)).resolves.toEqual(expected());
    append("\x1b[38;1H\x1b[2KWorking (6s)");
    await expect(readPaneTail("background", 40)).resolves.toEqual(expected(120, "Working (6s)"));
    expect(mocks.read).toHaveBeenLastCalledWith("background");
  });
});

// Include 2-, 3- and 4-byte characters alongside incomplete CSI/OSC sequences.
const utf8RecordingText = "before\r\n\x1b]0;title\x1b\\\x1b[2;1H\x1b[2KWorking \u00a2 \u65e5\u672c\ud83d\ude80 done";
const utf8Recording = encoder.encode(utf8RecordingText);
const byteSplitPoints = Array.from({ length: utf8Recording.length - 1 }, (_, index) => index + 1);
const FETCH_TIMEOUT_MS = 200; // The send-confirmation snapshot deadline is 250 ms.

function seedPartialScreenRing(): void {
  replace("retained screen\r\nWorking (1s)");
  const data = new Uint8Array(256 * 1024);
  data.set(current.data); // NUL padding leaves the positioned screen unchanged.
  current = { ...current, data, endOffset: data.length };
}

function rollPartialScreenRing(): void {
  const capacity = current.data.length;
  append("\x1b[2;1H\x1b[2KWorking (2s)");
  const discarded = current.data.length - capacity;
  current = { ...current, data: current.data.slice(discarded), startOffset: current.startOffset + discarded };
}

describe("RV0-01 bounded snapshot fetching with the real headless parser", () => {
  it.each(["resolve", "reject"] as const)("recovers after a fetch timeout and ignores a late %s", async (late) => {
    replace("old");
    const initial = current;
    await getHeadlessBufferLines("background", initial, 40);
    let resolveLate!: (snapshot: Snapshot) => void;
    let rejectLate!: (error: Error) => void;
    const held = new Promise<Snapshot>((resolve, reject) => { resolveLate = resolve; rejectLate = reject; });
    const loadA = vi.fn(() => held);
    const loadB = vi.fn(async (cursor?: Cursor) => response(cursor));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const first = readHeadlessBufferLines("background", loadA, 40).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(loadA).toHaveBeenCalledWith({ endOffset: 3, sessionEpoch: 17, sizeRevision: 0 });
    replace("old\r\nnew");
    const second = readHeadlessBufferLines("background", loadB, 40);
    await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS - 1);
    expect(loadB).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(loadB).toHaveBeenCalledOnce();
    expect(await first).toBeInstanceOf(TerminalDeadlineError);
    await vi.advanceTimersByTimeAsync(10);
    expect(await second).toEqual(["old", "new"]);
    expect(loadB).toHaveBeenCalledWith({ endOffset: 3, sessionEpoch: 17, sizeRevision: 0 });
    if (late === "resolve") {
      const data = encoder.encode("obsolete");
      resolveLate({ ...initial, data, endOffset: data.length, cols: 90, rows: 30, sessionEpoch: 99, sizeRevision: 7 });
    } else rejectLate(new Error("late fetch failure"));
    await Promise.resolve();
    vi.useRealTimers();
    const probe = vi.fn(async (cursor?: Cursor) => response(cursor));
    await expect(readHeadlessBufferLines("background", probe, 40)).resolves.toEqual(["old", "new"]);
    expect(probe).toHaveBeenCalledWith({ endOffset: 8, sessionEpoch: 17, sizeRevision: 0 });
    expect(payloadBytes).toEqual([5, 0]);
  });

  it("releases a timed-out cache pin so eviction and a full fetch can follow", async () => {
    replace("old");
    const initial = current;
    await getHeadlessBufferLines("background", initial, 40);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const failed = readHeadlessBufferLines("background", () => new Promise(() => {}), 40)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS);
    expect(await failed).toBeInstanceOf(TerminalDeadlineError);
    vi.useRealTimers();
    for (let index = 0; index < 12; index++) await getHeadlessBufferLines(`pressure-${index}`, initial, 40);
    expect(__headlessBufferCacheSizeForTests()).toBe(12);
    replace("old\r\nnew");
    const next = vi.fn(async (cursor?: Cursor) => response(cursor));
    await expect(readHeadlessBufferLines("background", next, 40)).resolves.toEqual(["old", "new"]);
    expect(next).toHaveBeenCalledWith(undefined);
  });

  it("also releases the queue when the first uncached fetch never returns", async () => {
    replace("old\r\nnew");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const first = readHeadlessBufferLines("uncached", () => new Promise(() => {}), 40)
      .catch((error: unknown) => error);
    const loadB = vi.fn(async (cursor?: Cursor) => response(cursor));
    const second = readHeadlessBufferLines("uncached", loadB, 40);
    await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS + 10);
    expect(await first).toBeInstanceOf(TerminalDeadlineError);
    expect(await second).toEqual(["old", "new"]);
    expect(loadB).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("bounds an incompatible delta and its full retry within one fetch budget", async () => {
    replace("old");
    const initial = current;
    await getHeadlessBufferLines("background", initial, 40);
    let releaseLate!: (snapshot: Snapshot) => void;
    const lateFull = new Promise<Snapshot>((resolve) => { releaseLate = resolve; });
    const loadA = vi.fn()
      .mockImplementationOnce(() => new Promise<Snapshot>((resolve) => {
        setTimeout(() => resolve({ ...initial, sessionEpoch: 99, isDelta: true }), 150);
      }))
      .mockImplementationOnce(() => lateFull);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const first = readHeadlessBufferLines("background", loadA, 40).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(150);
    expect(loadA).toHaveBeenCalledTimes(2);
    expect(loadA).toHaveBeenLastCalledWith(undefined);
    replace("old\r\nnew");
    const loadB = vi.fn(async (cursor?: Cursor) => response(cursor));
    const second = readHeadlessBufferLines("background", loadB, 40);
    await vi.advanceTimersByTimeAsync(49);
    expect(loadB).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(loadB).toHaveBeenCalledOnce();
    expect(await first).toBeInstanceOf(TerminalDeadlineError);
    await vi.advanceTimersByTimeAsync(10);
    expect(await second).toEqual(["old", "new"]);
    releaseLate({ ...initial, sessionEpoch: 99, sizeRevision: 8, cols: 90, rows: 30 });
    await Promise.resolve();
    vi.useRealTimers();
    const probe = vi.fn(async (cursor?: Cursor) => response(cursor));
    await expect(readHeadlessBufferLines("background", probe, 40)).resolves.toEqual(["old", "new"]);
    expect(probe).toHaveBeenCalledWith({ endOffset: 8, sessionEpoch: 17, sizeRevision: 0 });
  });

  it("keeps the last committed cursor and the existing error contract after a fetch rejects", async () => {
    replace("old");
    await readPaneTail("background", 40);
    mocks.read.mockRejectedValueOnce(new Error("fetch failure"));
    await expect(readPaneTail("background", 40)).rejects.toThrow("no terminal buffer for session");
    replace("old\r\nnew");
    await expect(readPaneTail("background", 40)).resolves.toEqual(["old", "new"]);
    expect(mocks.read).toHaveBeenLastCalledWith("background", { endOffset: 3, sessionEpoch: 17, sizeRevision: 0 });
  });
});

describe("RV0-02 retained raw ring is not a screen checkpoint", () => {
  it("preserves earlier screen cells across ring rollover while the cached cursor is still retained", async () => {
    seedPartialScreenRing();
    await expect(readPaneTail("background", 40)).resolves.toEqual(["retained screen", "Working (1s)"]);
    const cursor = current.endOffset;
    rollPartialScreenRing();
    expect(current.startOffset).toBeGreaterThan(0);
    expect(current.startOffset).toBeLessThan(cursor);
    await expect(readPaneTail("background", 40)).resolves.toEqual(["retained screen", "Working (2s)"]);
    expect(requests[1]?.endOffset).toBe(cursor);
    expect(payloadBytes[1]).toBe(current.startOffset);
    expect(payloadBytes[1]).toBeLessThan(current.data.length);
    // Cold replay lacks the discarded initial screen cells; the warm parser is correct.
    await expect(getHeadlessBufferLines("cold", current, 40)).resolves.toEqual(["ng (1s)", "Working (2s)"]);
  });

  it("fetches the whole retained ring after eviction, which can omit earlier screen cells in a partial-update TUI", async () => {
    seedPartialScreenRing();
    await readPaneTail("background", 40);
    rollPartialScreenRing();
    await expect(readPaneTail("background", 40)).resolves.toEqual(["retained screen", "Working (2s)"]);
    for (let index = 0; index < 12; index++) await getHeadlessBufferLines(`other-${index}`, current, 40);
    await expect(readPaneTail("background", 40)).resolves.toEqual(["ng (1s)", "Working (2s)"]);
    expect(requests.at(-1)).toBeUndefined();
    expect(payloadBytes.at(-1)).toBe(current.data.length);
    expect(__headlessBufferCacheSizeForTests()).toBe(12);
  });
});

describe("RV0-03 every byte boundary of a complete UTF-8 recording", () => {
  it("includes all internal boundaries of 2-, 3- and 4-byte characters", () => {
    let offset = 0;
    const internal: Array<{ cut: number; width: number }> = [];
    for (const character of utf8RecordingText) {
      const width = encoder.encode(character).length;
      for (let byte = 1; byte < width; byte++) internal.push({ cut: offset + byte, width });
      offset += width;
    }
    expect([...new Set(internal.map(({ width }) => width))]).toEqual([2, 3, 4]);
    expect(internal).toHaveLength(8);
    for (const { cut } of internal) {
      expect(byteSplitPoints).toContain(cut);
      expect(utf8Recording[cut] & 0xc0).toBe(0x80);
    }
  });

  it.each(byteSplitPoints)("matches a full replay after streaming the split at byte %i", async (cut) => {
    current = { ...current, data: utf8Recording, endOffset: utf8Recording.length };
    const full = await getHeadlessBufferLines("full", current, 40);
    expect(full).toEqual(["before", "Working \u00a2 \u65e5\u672c\ud83d\ude80 done"]);
    current = { ...current, data: utf8Recording.slice(0, cut), endOffset: cut };
    await readPaneTail("background", 40);
    current = { ...current, data: utf8Recording, endOffset: utf8Recording.length };
    await expect(readPaneTail("background", 40)).resolves.toEqual(full);
    expect(payloadBytes).toEqual([cut, utf8Recording.length - cut]);
    expect(requests[1]?.endOffset).toBe(cut);
    if ((utf8Recording[cut] & 0xc0) === 0x80) {
      const delta = await mocks.read.mock.results[1].value as Snapshot;
      expect(delta.isDelta).toBe(true);
      expect(delta.data[0] & 0xc0).toBe(0x80); // The actual suffix begins inside the character.
    }
  });
});
