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
});
