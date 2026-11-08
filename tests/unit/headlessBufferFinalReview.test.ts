import { readFileSync } from "node:fs";
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
const raw = new Uint8Array(readFileSync(new URL("../fixtures/terminal/claude-2.1.319-effort-conpty-42x40.bin", import.meta.url)));
const mac = new Uint8Array(readFileSync(new URL("../fixtures/terminal/claude-2.1.319-effort-macos-42x40.bin", import.meta.url)));
const owner = Symbol("final review");
const target = "final-target", reference = "final-reference";
const pressure = Array.from({ length: 13 }, (_, i) => `final-pressure-${i}`);
const ids = new Set([target, reference, ...pressure]);
const geometry = { cols: 42, rows: 40 };
const cases = (["lines", "screen"] as const).flatMap(reader => [false, true].map(evicted => ({ reader, evicted })));
type Reader = "lines" | "screen";
const inputTime = 1_794_013_729_920;
let now = inputTime;

function snap(data: Uint8Array | string, startOffset = 0, size = geometry): ScrollbackSnapshot {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  return { data: bytes, startOffset, endOffset: startOffset + bytes.length, sessionEpoch: 1, sizeRevision: 1, ...size };
}
const capture = (start: number, end: number) => snap(raw.subarray(start, end), start);
function read(value: ScrollbackSnapshot, reader: Reader, id = target) {
  return reader === "lines" ? getHeadlessBufferLines(id, value, 400, Date.now()) : readHeadlessBufferScreen(id, async () => value, 0);
}
function lines(value: Awaited<ReturnType<typeof read>>): string[] {
  return Array.isArray(value) ? value : value.lines.map(runs => {
    let text = ""; for (const [col, , chars] of runs) text = text.padEnd(col) + chars;
    return text.trimEnd();
  });
}
const hasFooter = (value: Awaited<ReturnType<typeof read>>) => lines(value).some(text => /Enter to confirm|Esc to|to adjust/.test(text));
async function evict() {
  for (const id of pressure) await getHeadlessBufferLines(id, snap("other"), 4, Date.now());
  expect(__headlessBufferStateForTests().entries.some(entry => entry.sessionId === target)).toBe(false);
}
const concat = (...parts: Uint8Array[]) => {
  const data = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0; for (const part of parts) { data.set(part, offset); offset += part.length; }
  return data;
};
const shimmer = encoder.encode("\x1b[38;2;208;180;255m\x1b[32;3Hlow\x1b[m\x1b[40;37H");

beforeEach(() => {
  __resetHeadlessBufferCacheForTests(); replacePtyReadOwners(owner, ids); clearSessionFrontendActivity(target);
  now = inputTime; vi.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(() => { __resetHeadlessBufferCacheForTests(); replacePtyReadOwners(owner, new Set()); clearSessionFrontendActivity(target); vi.restoreAllMocks(); });

describe("final review: recent input cannot certify a partial effect", () => {
  it.each(cases)("uses cold replay for real C=5064, S=5065, N=5463 ($reader, evicted=$evicted)", async ({ reader, evicted }) => {
    expect(raw).toHaveLength(5775);
    await read(capture(0, 4666), reader);
    markSessionFrontendActivity(target, now); now += 50;
    await read(capture(0, 5064), reader);
    if (evicted) await evict();
    now += 300_000;
    const current = capture(5065, 5463);
    const actual = await read(current, reader);
    expect(actual).toEqual(await read(current, reader, reference));
    expect(hasFooter(actual)).toBe(false);
  });

  it.each(cases)("goes cold after input, shimmer-only read, close and 300KiB spinner ($reader, evicted=$evicted)", async ({ reader, evicted }) => {
    const base = raw.subarray(0, 4666);
    await read(snap(base), reader);
    markSessionFrontendActivity(target, now); now += 50;
    const partial = concat(base, shimmer, shimmer);
    await read(snap(partial), reader);
    if (evicted) await evict();
    const frames: Uint8Array[] = [];
    for (let bytes = 0, n = 0; bytes < 300 * 1024; n++) {
      const frame = encoder.encode(`\x1b[38;2;215;119;87m\x1b[36;3H✻ Working… (${n}s · esc to interrupt)\x1b[m`);
      frames.push(frame); bytes += frame.length;
    }
    const stream = concat(partial, raw.subarray(4666, 5463), ...frames);
    now += 600_000;
    const current = snap(stream.subarray(stream.length - 256 * 1024), stream.length - 256 * 1024);
    const actual = await read(current, reader);
    expect(actual).toEqual(await read(current, reader, reference));
    expect(hasFooter(actual)).toBe(false);
  });

  it.each(cases)("settled bytes restore preservation after the two-second window ($reader, evicted=$evicted)", async ({ reader, evicted }) => {
    markSessionFrontendActivity(target, now);
    const base = concat(raw.subarray(0, 4666), shimmer);
    await read(snap(base), reader);
    now += 2001;
    await read(snap(concat(base, shimmer)), reader);
    if (evicted) await evict();
    const tail = concat(shimmer, shimmer);
    const current = snap(tail, base.length + 300 * 1024);
    const actual = await read(current, reader);
    expect(actual).toEqual(await read(snap(concat(base, shimmer, tail)), reader, reference));
    expect(hasFooter(actual)).toBe(true);
  });

  it.each([0, 1999, 2000])("keeps evidence unknown for a read starting %ims after input", async elapsed => {
    markSessionFrontendActivity(target, now); now += elapsed;
    await read(snap(concat(raw.subarray(0, 4666), shimmer)), "screen");
    now += 300_000;
    const current = snap(shimmer, 400_000);
    expect(await read(current, "screen")).toEqual(await read(current, "screen", reference));
  });

  it("uses read-start time even when IPC completes after the settling window", async () => {
    markSessionFrontendActivity(target, now); now += 50;
    let resolve!: (value: ScrollbackSnapshot) => void;
    const pending = readHeadlessBufferScreen(target, () => new Promise<ScrollbackSnapshot>(done => { resolve = done; }), 0);
    now += 3000; resolve(snap(concat(raw.subarray(0, 4666), shimmer))); await pending;
    const current = snap(shimmer, 400_000);
    expect(await read(current, "screen")).toEqual(await read(current, "screen", reference));
  });
});

describe("final review: ED only anchors a complete screen erase", () => {
  const picker = "\x1b[2J\x1b[HEffort level\x1b[8;1HEnter to confirm · Esc to cancel\x1b[9;1H";
  it.each(["", "0", "1", "3"].flatMap(parameter => cases.map(context => ({ parameter, ...context }))))(
    "uses cold replay for ED $parameter ($reader, evicted=$evicted)", async ({ parameter, reader, evicted }) => {
      const first = snap(picker, 0, { cols: 48, rows: 10 });
      await read(first, reader); if (evicted) await evict();
      const current = snap(`245m\x1b[${parameter}Jdone\r\n* Working... (1s)\r\n> `, first.endOffset + 300_000, { cols: 48, rows: 10 });
      const actual = await read(current, reader);
      expect(actual).toEqual(await read(current, reader, reference));
      expect(hasFooter(actual)).toBe(false);
      expect(headlessReplayBoundary(current.data, true)).toBeUndefined();
    });
  it.each(["2", "02"])("keeps ED %s as an absolute boundary", parameter => {
    const bytes = encoder.encode(`245m\x1b[${parameter}Jdone`);
    expect(headlessReplayBoundary(bytes, true)).toBe(4);
  });
  it.each(cases)("retains parser state when ED 2 is the first anchor ($reader, evicted=$evicted)", async ({ reader, evicted }) => {
    const first = snap("\x1b[?1049h" + picker, 0, { cols: 48, rows: 10 });
    await read(first, reader); if (evicted) await evict();
    const suffix = "\x1b[2Jdone";
    const actual = await read(snap(suffix, first.endOffset + 300_000, { cols: 48, rows: 10 }), reader);
    expect(actual).toEqual(await read(snap("\x1b[?1049h" + picker + suffix, 0, { cols: 48, rows: 10 }), reader, reference));
  });
});

describe("final review: one frame build and reversible charset gate", () => {
  it.each([{ cols: 80, rows: 40, count: 239, fits: true }, { cols: 200, rows: 60, count: 600, fits: false }])(
    "builds at most once after sizing $cols x $rows colored history", async ({ cols, rows, count, fits }) => {
      const term = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
      const state = new HeadlessCheckpointState(); state.attach(term);
      try {
        const width = fits ? 30 : cols - 1;
        const line = Array.from({ length: width }, (_, i) => `\x1b[38;2;${100 + i % 150};110;120mx`).join("");
        await new Promise<void>(resolve => term.write(Array.from({ length: count }, () => line).join("\r\n"), resolve));
        const visits = vi.spyOn(Object.getPrototypeOf(term.buffer.normal.getLine(0)!), "getCell");
        const builder = state as unknown as { buildFrame?: (...args: unknown[]) => string };
        const build = builder.buildFrame ? vi.spyOn(builder, "buildFrame") : undefined;
        const frame = state.frame(term);
        // Independent of how the builder is factored: history must not be
        // scanned again for every candidate, including an oversized viewport.
        expect(visits.mock.calls.length).toBeLessThanOrEqual(2 * Math.min(65536, cols * count) + 16);
        expect(build).toBeDefined();
        expect(build).toHaveBeenCalledTimes(fits ? 1 : 0);
        expect(frame === undefined).toBe(!fits);
      } finally { term.dispose(); }
    });

  it.each(["\x1b(B", "\x1b(0\x1b(B", "\x1b)0\x1b)B", "\x1b*0\x1b.B"])("checkpoints after the default charset is restored (%j)", async sequence => {
    await read(snap("\x1b[2J\x1b[HTITLE" + sequence), "screen"); await evict();
    expect(__headlessBufferStateForTests().checkpoints.some(entry => entry.sessionId === target)).toBe(true);
  });
  it.each(["\x1b(0", "\x1b)0\x1b(B", "\x1bH\x1b(B", "\x1b[3g\x1b(B"])("keeps active nondefault charset or custom tabs unsupported (%j)", async sequence => {
    await read(snap("TITLE" + sequence), "screen"); await evict();
    expect(__headlessBufferStateForTests().checkpoints.some(entry => entry.sessionId === target)).toBe(false);
  });
  it("creates a checkpoint for the unmodified macOS fixture", async () => {
    await read(snap(mac), "screen"); await evict();
    expect(__headlessBufferStateForTests().checkpoints.some(entry => entry.sessionId === target)).toBe(true);
  });
});

// The real close effect's 399 possible ring heads, in 32 small Windows-safe tests.
const conptyChunks = Array.from({ length: 32 }, (_, chunk) => ({
  start: 5065 + Math.floor(chunk * 399 / 32), end: 5065 + Math.floor((chunk + 1) * 399 / 32),
}));
const conptyResults: { cuts: number; ms: number }[] = [];
afterAll(() => console.info("L5_REAL_CONPTY_CHUNKS", JSON.stringify({ chunks: conptyResults.length,
  cuts: conptyResults.reduce((sum, chunk) => sum + chunk.cuts, 0), ms: Math.max(0, ...conptyResults.map(chunk => chunk.ms)) })));
describe("final review: every cut of real ConPTY partial close", () => {
  it.each(conptyChunks)(
    "is cold and has no old footer at ring heads $start-$end", async ({ start, end }) => {
      const started = performance.now();
      for (let cut = start; cut < end; cut++) {
        __resetHeadlessBufferCacheForTests(); clearSessionFrontendActivity(target);
        now = inputTime; markSessionFrontendActivity(target, now); now += 50;
        await read(capture(0, 5064), "screen"); await evict();
        now += 300_000;
        const current = capture(cut, 5463);
        const actual = await read(current, "screen");
        expect(actual).toEqual(await read(current, "screen", reference));
        expect(hasFooter(actual)).toBe(false);
      }
      conptyResults.push({ cuts: end - start, ms: performance.now() - started });
    }, 10_000);
});
