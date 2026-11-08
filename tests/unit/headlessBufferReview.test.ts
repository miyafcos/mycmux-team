import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error Published headless ESM has no adjacent declarations.
import { Terminal as PublishedTerminal } from "@xterm/headless/lib-headless/xterm-headless.mjs";
import type { ScrollbackSnapshot } from "../../src/lib/ipc";
import { clearSessionFrontendActivity, markSessionFrontendActivity } from "../../src/lib/agentDormancy";
import { replacePtyReadOwners } from "../../src/lib/ptyReadGeneration";
import { HeadlessCheckpointState, headlessReplayBoundary } from "../../src/components/terminal/headlessCheckpoint";
import { __headlessBufferStateForTests, __resetHeadlessBufferCacheForTests, getHeadlessBufferLines,
  readHeadlessBufferScreen } from "../../src/components/terminal/headlessBuffer";

const Terminal = PublishedTerminal as typeof import("@xterm/headless").Terminal;
const encoder = new TextEncoder();
const owner = Symbol("L5 review");
const id = "review-dialog";
const pressure = Array.from({ length: 13 }, (_, i) => `review-pressure-${i}`);
const ids = new Set([id, "review-reference", ...pressure]);
const size = { cols: 48, rows: 10 };
const footer = "Enter to confirm / Esc to cancel";
const initial = `\x1b[2J\x1b[HEffort level\x1b[3;1Hmedium\x1b[4;1Hxhigh\x1b[8;1H${footer}\x1b[9;1H`;
type Reader = "lines" | "screen";
type Residency = "resident" | "evicted";

function snapshot(text: string | Uint8Array, startOffset = 0, geometry = size): ScrollbackSnapshot {
  const data = typeof text === "string" ? encoder.encode(text) : text;
  return { data, startOffset, endOffset: startOffset + data.length, sessionEpoch: 1, sizeRevision: 1, ...geometry };
}
async function read(value: ScrollbackSnapshot, reader: Reader, sessionId = id) {
  return reader === "lines" ? getHeadlessBufferLines(sessionId, value, 400, Date.now())
    : readHeadlessBufferScreen(sessionId, async () => value, 0);
}
async function evict(): Promise<void> {
  for (const sessionId of pressure) await getHeadlessBufferLines(sessionId, snapshot("other"), 40, Date.now());
  expect(__headlessBufferStateForTests().entries.some(entry => entry.sessionId === id)).toBe(false);
}
async function seed(residency: Residency, reader: Reader, text = initial): Promise<ScrollbackSnapshot> {
  const first = snapshot(text);
  await read(first, reader);
  if (residency === "evicted") await evict();
  return first;
}
const gap = (text: string | Uint8Array, first: ScrollbackSnapshot, geometry = size) => snapshot(text, first.endOffset + 256 * 1024, geometry);

function evidence(name: string, value: unknown): void {
  if (process.env.MYCMUX_L5_REVIEW_EVIDENCE === "1") writeFileSync(
    new URL(`../../.dispatch/out/review-${name}.json`, import.meta.url), JSON.stringify(value) + "\n");
}

beforeEach(() => { __resetHeadlessBufferCacheForTests(); replacePtyReadOwners(owner, ids); clearSessionFrontendActivity(id); });
afterEach(() => { __resetHeadlessBufferCacheForTests(); replacePtyReadOwners(owner, new Set()); clearSessionFrontendActivity(id); vi.restoreAllMocks(); });

describe("L5 review: discard unsafe old picker cells", () => {
  it.each((["resident", "evicted"] as const).flatMap(residency => (["lines", "screen"] as const).flatMap(reader =>
    [false, true].map(alternate => ({ residency, reader, alternate })))))(
    "discards old picker after input in a gap ($residency, $reader, alternate=$alternate)", async ({ residency, reader, alternate }) => {
      const first = await seed(residency, reader, (alternate ? "\x1b[?1049h" : "") + initial);
      markSessionFrontendActivity(id, 100);
      const current = gap("\x1b[2;1H* Working...", first);
      expect(await read(current, reader)).toEqual(await read(current, reader, "review-reference"));
    });

  it.each((["resident", "evicted"] as const).flatMap(residency => (["lines", "screen"] as const).map(reader => ({ residency, reader }))))(
    "discards old picker after a size revision in a gap ($residency, $reader)", async ({ residency, reader }) => {
      const first = await seed(residency, reader, "\x1b[?1049h" + initial);
      const current = { ...gap("\x1b[2;1H* Working...", first, { cols: 50, rows: 11 }), sizeRevision: 2 };
      expect(await read(current, reader)).toEqual(await read(current, reader, "review-reference"));
    });

  it.each(["resident", "evicted"] as const)("does not refresh the input proof on an empty delta (%s)", async residency => {
    const first = await seed("resident", "screen", "\x1b[?1049h" + initial);
    markSessionFrontendActivity(id, 200);
    await read({ ...first, data: new Uint8Array(), startOffset: first.endOffset, isDelta: true }, "screen");
    if (residency === "evicted") await evict();
    const current = gap("\x1b[2;1H* Working...", first);
    expect(await read(current, "screen")).toEqual(await read(current, "screen", "review-reference"));
  });

  it.each(["resident", "evicted"] as const)("does not refresh the size proof on an empty resized poll (%s)", async residency => {
    const first = await seed("resident", "screen", "\x1b[?1049h" + initial);
    await read({ ...first, data: new Uint8Array(), startOffset: first.endOffset, sizeRevision: 2, isDelta: true }, "screen");
    if (residency === "evicted") await evict();
    const current = { ...gap("\x1b[2;1H* Working...", first), sizeRevision: 2 };
    expect(await read(current, "screen")).toEqual(await read(current, "screen", "review-reference"));
  });

  it.each(["resident", "evicted"] as const)("uses a cold parser for relative-only redraws across a gap (%s)", async residency => {
    const first = await seed(residency, "screen", "\x1b[?1049h" + initial);
    const current = gap("\x1b[1A\r\x1b[2K\x1b[32m* Working...\x1b[0m\x1b[1B\r", first);
    expect(await read(current, "screen")).toEqual(await read(current, "screen", "review-reference"));
  });

  it.each(["\x1b[H", "\x1b[2;3H", "\x1b[2;3f", "\x1b[2J", "\x1bc", "\x1b[?47h", "\x1b[?1047l", "\x1b[?1049h", "\x1b[?1049l"])(
    "skips SGR and relative sequences until the absolute anchor %j", anchor => {
      const prefix = "35;255mgh\x1b[31mx\x1b[1A";
      expect(headlessReplayBoundary(encoder.encode(prefix + anchor + "text"), true)).toBe(encoder.encode(prefix).length);
    });
});

const redraws = [
  { name: "original positioned redraw", frame: "\x1b[4;1H\x1b[38;2;175;135;255mxhigh\x1b[0m" },
  { name: "ConPTY per-cell RGB and bold redraw", frame: "\x1b[4;1H" + [..."xhigh"].map((char, i) =>
    `\x1b[${i % 2 ? 22 : 1};38;2;${175 + i};135;255m${char}`).join("") + "\x1b[0m\x1b[9;1H" },
];
describe.each(redraws)("L5 review: $name at every byte boundary", ({ frame }) => {
  it.each(Array.from({ length: encoder.encode(frame).length }, (_, cut) => cut))(
    "restores the exact screen and footer when the retained ring starts at byte %i", async cut => {
      const first = await seed("evicted", "screen", initial + frame);
      const current = gap(encoder.encode(frame.repeat(3)).subarray(cut), first);
      expect(await read(current, "screen")).toEqual(await read(snapshot(initial + frame.repeat(4)), "screen", "review-reference"));
    });
});

describe("L5 review: checkpoint restoration and bounds", () => {
  it("homes the alternate cursor before writing its first row", async () => {
    const first = snapshot("normal text\x1b[?1049h\x1b[HTITLE\x1b[4;1Hchoice");
    const expected = await read(first, "screen");
    await evict();
    expect(await read(first, "screen")).toEqual(expected);
  });

  it("reuses a restored frame without scanning cells after a zero-byte read", async () => {
    const first = await seed("evicted", "screen");
    const scan = vi.spyOn(HeadlessCheckpointState.prototype, "frame");
    await read(first, "screen");
    expect(scan).toHaveBeenCalledTimes(1); // One other parser was evicted to restore ours.
    // Leave only our parser cached, then add thirteen others: two evictions,
    // but only the newly created pressure parser may need a frame scan.
    for (const sessionId of pressure) replacePtyReadOwners(owner, new Set([id, "review-reference", sessionId]));
    replacePtyReadOwners(owner, ids);
    scan.mockClear();
    await evict();
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it("retains more than half of the readable rows for per-cell colored output", async () => {
    const line = Array.from({ length: 30 }, (_, i) => `\x1b[38;2;${100 + i};${110 + i};${120 + i}mx`).join("");
    const first = snapshot(Array.from({ length: 239 }, () => line).join("\r\n"), 0, { cols: 80, rows: 40 });
    const before = await getHeadlessBufferLines(id, first, 400, Date.now());
    await evict();
    const after = await getHeadlessBufferLines(id, first, 400, Date.now());
    evidence("colored-history", { before: before.length, after: after.length });
    expect(before).toHaveLength(239);
    expect(after.length).toBeGreaterThan(before.length / 2);
    expect(after).toEqual(before.slice(-after.length));
  });

  it.each(["\x1b(0", "\x1b)0", "\x1bH", "\x88", "\x1b[3g"])("does not checkpoint custom character sets or tab stops (%j)", async sequence => {
    await seed("evicted", "screen", initial + sequence);
    expect(__headlessBufferStateForTests().checkpoints.some(entry => entry.sessionId === id)).toBe(false);
  });

  it("restores DECKPAM application keypad mode", async () => {
    const term = new Terminal({ ...size, allowProposedApi: true });
    const restored = new Terminal({ ...size, allowProposedApi: true });
    const state = new HeadlessCheckpointState(); state.attach(term);
    try {
      await new Promise<void>(resolve => term.write("\x1b=keypad", resolve));
      const frame = state.frame(term);
      expect(frame).toBeTypeOf("string");
      await new Promise<void>(resolve => restored.write(frame!, resolve));
      expect(restored.modes.applicationKeypadMode).toBe(term.modes.applicationKeypadMode);
    } finally { term.dispose(); restored.dispose(); }
  });

  it("scans only the last escape tail rather than the printable chunk prefix", () => {
    const state = new HeadlessCheckpointState();
    const iterate = String.prototype[Symbol.iterator];
    let visited = 0;
    const spy = vi.spyOn(String.prototype, Symbol.iterator).mockImplementation(function* (this: string) {
      for (const char of iterate.call(this)) { visited++; yield char; }
    });
    let pending: string | undefined;
    try { state.rawTail.push("p".repeat(256 * 1024) + "\x1b[31"); pending = state.rawTail.pending; }
    finally { spy.mockRestore(); }
    expect(pending).toBe("\x1b[31");
    expect(visited).toBeLessThanOrEqual(4);
  });
});

// Mothership capture: Claude Code 2.1.319, macOS PTY, 42x40, logged out.
// Only raw.bin[start:effort] is checked in; see the adjacent fixture README.
const effortBytes = new Uint8Array(readFileSync(new URL("../fixtures/terminal/claude-2.1.319-effort-macos-42x40.bin", import.meta.url)));
const macChunks = Array.from({ length: 32 }, (_, chunk) => ({
  start: Math.floor(chunk * effortBytes.length / 32), end: Math.floor((chunk + 1) * effortBytes.length / 32),
}));
const macResults: { matched: number; cold: number; unsafe: number; ms: number }[] = [];
afterAll(() => {
  const total = macResults.reduce((sum, chunk) => ({ matched: sum.matched + chunk.matched, cold: sum.cold + chunk.cold,
    unsafe: sum.unsafe + chunk.unsafe, ms: Math.max(sum.ms, chunk.ms) }), { matched: 0, cold: 0, unsafe: 0, ms: 0 });
  if (process.env.MYCMUX_L5_FINAL_EVIDENCE === "1") writeFileSync(new URL("../../.dispatch/out/review3/mac-chunks.json", import.meta.url),
    JSON.stringify({ chunks: macResults.length, cuts: total.matched + total.cold + total.unsafe, ...total }) + "\n");
  console.info("L5_REAL_EFFORT_CHUNKS", JSON.stringify({ chunks: macResults.length, ...total }));
});
describe("L5 review: captured macOS effort screen", () => {
  it.each(macChunks)("counts ring heads $start-$end and rejects unsafe relative-only preservation", async ({ start, end }) => {
    expect(effortBytes).toHaveLength(1368);
    const started = performance.now();
    let matched = 0, cold = 0, unsafe = 0;
    const first = snapshot(effortBytes, 0, { cols: 42, rows: 40 });
    const expected = await read(first, "screen", "review-reference");
    for (let cut = start; cut < end; cut++) {
      __resetHeadlessBufferCacheForTests();
      await read(first, "screen");
      const current = snapshot(effortBytes.subarray(cut), first.endOffset + 256 * 1024 + cut, { cols: 42, rows: 40 });
      const actual = await read(current, "screen");
      if (JSON.stringify(actual) === JSON.stringify(expected)) matched++;
      else {
        const reference = await read(current, "screen", "review-reference");
        if (JSON.stringify(actual) === JSON.stringify(reference)) cold++; else unsafe++;
      }
    }
    macResults.push({ matched, cold, unsafe, ms: performance.now() - started });
    expect(matched + cold).toBe(end - start);
    expect(unsafe).toBe(0);
  }, 10_000);
});
