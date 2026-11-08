import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScrollbackSnapshot } from "../../src/lib/ipc";
import { clearSessionFrontendActivity, markSessionFrontendActivity } from "../../src/lib/agentDormancy";
import { replacePtyReadOwners } from "../../src/lib/ptyReadGeneration";
import { __headlessBufferStateForTests, __resetHeadlessBufferCacheForTests, getHeadlessBufferLines,
  readHeadlessBufferLines, readHeadlessBufferScreen } from "../../src/components/terminal/headlessBuffer";

const encoder = new TextEncoder();
const owner = Symbol("follow-up review");
const target = "followup-target", reference = "followup-reference";
const pressure = Array.from({ length: 13 }, (_, i) => `followup-pressure-${i}`);
const ids = new Set([target, reference, ...pressure]);
const inputTime = 1_794_013_729_920;
const raw = new Uint8Array(readFileSync(new URL("../fixtures/terminal/claude-2.1.319-effort-conpty-42x40.bin", import.meta.url)));
let now = inputTime;
type Reader = "lines" | "screen";

function snapshot(data: string | Uint8Array, startOffset = 0, cols = 30, rows = 8): ScrollbackSnapshot {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  return { data: bytes, startOffset, endOffset: startOffset + bytes.length, sessionEpoch: 1, sizeRevision: 1, cols, rows };
}
const capture = (start: number, end: number) => snapshot(raw.subarray(start, end), start, 42, 40);
function read(value: ScrollbackSnapshot, reader: Reader, id = target) {
  return reader === "lines" ? readHeadlessBufferLines(id, async () => value, 400)
    : readHeadlessBufferScreen(id, async () => value, 0);
}
async function evict() {
  for (const id of pressure) await read(snapshot("other"), "lines", id);
  expect(__headlessBufferStateForTests().entries.some(entry => entry.sessionId === target)).toBe(false);
}
function hasCheckpoint() {
  return __headlessBufferStateForTests().checkpoints.some(entry => entry.sessionId === target);
}
const hasFooter = (lines: string[]) => lines.some(line => /Enter to confirm|Esc to|to adjust/.test(line));

beforeEach(() => {
  __resetHeadlessBufferCacheForTests(); replacePtyReadOwners(owner, ids); clearSessionFrontendActivity(target);
  now = inputTime; vi.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(() => {
  __resetHeadlessBufferCacheForTests(); replacePtyReadOwners(owner, new Set()); clearSessionFrontendActivity(target); vi.restoreAllMocks();
});

describe("follow-up review: prefetched snapshot request time", () => {
  it.each([false, true])("keeps a snapshot requested at 1990ms unknown when handed over at 2010ms (lines, evicted=%s)", async evicted => {
    await read(capture(0, 4666), "lines");
    now += 100; markSessionFrontendActivity(target, now);
    const requestedAt = now + 1990;
    now += 2010;
    await getHeadlessBufferLines(target, capture(0, 5064), 400, requestedAt);
    if (evicted) await evict();
    now += 300_000;
    const current = capture(5065, 5463);
    const actual = await readHeadlessBufferLines(target, async () => current, 400);
    expect(actual).toEqual(await readHeadlessBufferLines(reference, async () => current, 400));
    expect(hasFooter(actual)).toBe(false);
  });

  it.each([false, true])("retains the existing gate for a snapshot requested at 2010ms (lines, evicted=%s)", async evicted => {
    await read(capture(0, 4666), "lines");
    now += 100; markSessionFrontendActivity(target, now);
    const requestedAt = now + 2010;
    now += 2030;
    await getHeadlessBufferLines(target, capture(0, 5064), 400, requestedAt);
    if (evicted) await evict();
    now += 300_000;
    const current = capture(5065, 5463);
    const actual = await readHeadlessBufferLines(target, async () => current, 400);
    // This control checks the accepted two-second policy, not whether a close
    // effect taking longer than two seconds has actually finished painting.
    expect(actual).not.toEqual(await readHeadlessBufferLines(reference, async () => current, 400));
    expect(hasFooter(actual)).toBe(true);
  });
});

const title = "\x1b[2J\x1b[HTITLE\r\n";
const unsupported = [
  { name: "S1 DECSC saves DEC charset", first: "\x1b(0\x1b7\x1b(Bline", next: "\x1b8qqq" },
  { name: "CSI s saves DEC charset", first: "\x1b(0\x1b[s\x1b(Bline", next: "\x1b[uqqq" },
  { name: "1048h saves DEC charset", first: "\x1b(0\x1b[?1048h\x1b(Bline", next: "\x1b[?1048lqqq" },
  { name: "S2 1049h saves DEC charset", first: "\x1b(0\x1b[?1049h\x1b(BALT", next: "\x1b[?1049lqqq" },
  { name: "S5 DECSTR in alternate leaves saved normal charset", first: "\x1b(0\x1b[?1049h\x1b[!pALT", next: "\x1b[?1049lqqq" },
  { name: "S3 slash designation is ignored by xterm", first: "\x1b+0\x1b/B", next: "\x1boqqq" },
  { name: "S4 SO remains active after G1 returns to ASCII", first: "\x1b)0\x0e\x1b)B", next: "\x1b)0qqq" },
  { name: "S4' SO without a designation", first: "\x0e", next: "\x1b)0qqq" },
  ...["n", "o", "|", "}", "~"].map(final => ({ name: `locking shift ESC ${final}`, first: `\x1b${final}`, next: "qqq" })),
];
describe.each(["lines", "screen"] as const)("follow-up review: charset checkpoints (%s)", reader => {
  it.each(unsupported)("rejects $name before eviction", async ({ first, next }) => {
    await read(snapshot(title + first), reader); await evict();
    expect(hasCheckpoint()).toBe(false);
    const full = snapshot(title + first + next);
    expect(await read(full, reader)).toEqual(await read(full, reader, reference));
  });

  it.each([
    { name: "C1 DEC graphics returns to ASCII", first: "\x1b(0x\x1b(B" },
    { name: "SI returns to G0", first: "\x0f" },
  ])("keeps $name checkpointable and exact", async ({ first }) => {
    await read(snapshot(title + first), reader); await evict();
    expect(hasCheckpoint()).toBe(true);
    const full = snapshot(title + first + "qqq");
    expect(await read(full, reader)).toEqual(await read(full, reader, reference));
  });
});

it.each([
  { file: "claude-2.1.319-effort-macos-42x40.bin", sha256: "848cb12aa608f9224e33fb7d3e0adbed295f6c08ea00243f76a6ef27e29e3f2b" },
  { file: "claude-2.1.319-effort-conpty-42x40.bin", sha256: "644814a21a9c3f3b057777ce5270c57c24bd0f647cb057bc06667302e925ecbd" },
])("preserves the captured bytes of $file", ({ file, sha256 }) => {
  const bytes = readFileSync(new URL(`../fixtures/terminal/${file}`, import.meta.url));
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha256);
});
