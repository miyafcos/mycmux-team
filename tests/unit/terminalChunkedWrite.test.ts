import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/ipc", () => ({
  writeToSession: vi.fn(),
}));

import { writeToSession } from "../../src/lib/ipc";
import { chunkedWrite, computeSafeChunkEnd } from "../../src/components/terminal/terminalCache";
import { __resetToastStoreForTests } from "../../src/stores/toastStore";

const mockedWriteToSession = vi.mocked(writeToSession);

async function flushPromises(): Promise<void> {
  // enqueueSessionWrite chains each write onto the previous one's promise, so
  // a paste split into many chunks needs proportionally more microtask ticks
  // to fully drain before the mock call list reflects every write.
  for (let i = 0; i < 100; i += 1) {
    await Promise.resolve();
  }
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

describe("chunkedWrite surrogate-pair safety", () => {
  beforeEach(() => {
    mockedWriteToSession.mockReset();
    mockedWriteToSession.mockResolvedValue(undefined);
  });

  afterEach(() => {
    __resetToastStoreForTests();
  });

  it("keeps a chunk boundary from splitting a surrogate pair", () => {
    // "😀" is U+1F600, encoded as the surrogate pair 0xD83D 0xDE00.
    const emoji = "😀";
    // Build a string where the emoji's high surrogate lands exactly at
    // index 1024 (the PASTE_CHUNK boundary), i.e. the pair straddles the cut.
    const prefix = "a".repeat(1023);
    const suffix = "b".repeat(50);
    const input = prefix + emoji + suffix;
    expect(input.charCodeAt(1023)).toBe(emoji.charCodeAt(0));
    expect(isHighSurrogate(input.charCodeAt(1023))).toBe(true);

    const end = computeSafeChunkEnd(input, 0, 1024);
    // The naive boundary (1024) would land between the surrogates; the safe
    // boundary must pull back to 1023 so the pair stays together in the next chunk.
    expect(end).toBe(1023);
    expect(isHighSurrogate(input.charCodeAt(end - 1))).toBe(false);
  });

  it("leaves a chunk boundary alone when it does not split a pair", () => {
    const input = "a".repeat(2000);
    expect(computeSafeChunkEnd(input, 0, 1024)).toBe(1024);
  });

  it("does not shrink to an empty chunk in the degenerate single-unit case", () => {
    const input = "😀";
    // start === end - 1, so pulling back would produce an empty chunk; must not shrink.
    expect(computeSafeChunkEnd(input, 0, 1)).toBe(1);
  });

  it("reassembles a large paste with an emoji straddling the chunk boundary intact, with no chunk ending in an unpaired high surrogate", async () => {
    const emoji = "😀";
    const prefix = "a".repeat(1023);
    const suffix = "b".repeat(2000);
    const input = prefix + emoji + suffix;

    chunkedWrite("session-emoji", input);
    await flushPromises();

    const sentChunks = mockedWriteToSession.mock.calls.map((call) => call[1] as string);
    expect(sentChunks.length).toBeGreaterThan(1);

    // No chunk may end with an unpaired high surrogate, and no chunk may start
    // with an unpaired low surrogate.
    for (const chunk of sentChunks) {
      const last = chunk.charCodeAt(chunk.length - 1);
      expect(isHighSurrogate(last)).toBe(false);
      const first = chunk.charCodeAt(0);
      expect(isLowSurrogate(first)).toBe(false);
    }

    expect(sentChunks.join("")).toBe(input);
  });

  it("reassembles a paste with many astral-plane characters near chunk boundaries intact", async () => {
    const emoji = "😀";
    // Sprinkle emoji so several land near / across 1024-multiple boundaries.
    let input = "";
    for (let i = 0; i < 5; i += 1) {
      input += "x".repeat(1022) + emoji;
    }
    input += "y".repeat(500);

    chunkedWrite("session-emoji-many", input);
    await flushPromises();

    const sentChunks = mockedWriteToSession.mock.calls.map((call) => call[1] as string);
    for (const chunk of sentChunks) {
      expect(isHighSurrogate(chunk.charCodeAt(chunk.length - 1))).toBe(false);
      expect(isLowSurrogate(chunk.charCodeAt(0))).toBe(false);
    }
    expect(sentChunks.join("")).toBe(input);
  });
});
