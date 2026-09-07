import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetHeadlessBufferCacheForTests,
  getHeadlessBufferLines,
} from "../../src/components/terminal/headlessBuffer";

const encoder = new TextEncoder();

beforeEach(() => {
  __resetHeadlessBufferCacheForTests();
});

afterEach(() => {
  __resetHeadlessBufferCacheForTests();
});

describe("headless terminal scrollback extraction", () => {
  it("returns ANSI-free non-empty logical lines and joins wrapped rows", async () => {
    const wrapped = "w".repeat(90);
    const data = encoder.encode(`\x1b[31mfirst\x1b[0m\r\n\r\n${wrapped}\r\nlast`);

    await expect(
      getHeadlessBufferLines("session", { data, startOffset: 0, endOffset: data.byteLength }, 80),
    ).resolves.toEqual(["first", wrapped, "last"]);
  });

  it("renders at the pane's real size so cursor-relative redraws land on the right rows", async () => {
    // A TUI draws a 100-column row, a second row, then moves the cursor up two
    // rows and overwrites the first character of the first row.
    const wide = "A".repeat(100);
    const data = encoder.encode(`${wide}\r\nB\r\n\x1b[2AX\r\n`);
    const snapshot = { data, startOffset: 0, endOffset: data.byteLength };

    // At the real width the overwrite hits the first row.
    await expect(getHeadlessBufferLines("wide", snapshot, 10, { cols: 120, rows: 30 }))
      .resolves.toEqual([`X${"A".repeat(99)}`, "B"]);
    // Replayed into the 80-column default the same bytes corrupt the wrapped row instead.
    await expect(getHeadlessBufferLines("narrow", snapshot, 10))
      .resolves.not.toEqual([`X${"A".repeat(99)}`, "B"]);
  });

  it("re-renders from the start when the size changes for a cached session", async () => {
    const wide = "C".repeat(100);
    const data = encoder.encode(`${wide}\r\nD\r\n\x1b[2AY\r\n`);
    const snapshot = { data, startOffset: 0, endOffset: data.byteLength };
    await getHeadlessBufferLines("resize", snapshot, 10);
    await expect(getHeadlessBufferLines("resize", snapshot, 10, { cols: 120, rows: 30 }))
      .resolves.toEqual([`Y${"C".repeat(99)}`, "D"]);
    // Invalid sizes fall back to the default geometry instead of throwing.
    await expect(getHeadlessBufferLines("resize", snapshot, 10, { cols: 0, rows: -1 })).resolves.toBeTruthy();
  });
});
