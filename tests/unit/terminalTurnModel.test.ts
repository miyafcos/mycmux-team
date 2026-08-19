import { describe, expect, it } from "vitest";

import {
  findTurnIndexForViewport,
  pickJumpTarget,
  shouldMarkTurn,
  splitSubmits,
  turnLabelFrom,
  type TurnMarkData,
} from "../../src/components/terminal/terminalTurnModel";

function mark(line: number, label = `t${line}`, at = line * 1000): TurnMarkData {
  return { line, label, at };
}

describe("splitSubmits", () => {
  it("returns no submits when the chunk has no line ending", () => {
    expect(splitSubmits("hello")).toEqual({ count: 0, segments: [] });
  });

  it("splits on CR and LF and coalesces CRLF", () => {
    expect(splitSubmits("hello\rworld\n")).toEqual({
      count: 2,
      segments: ["hello", "world"],
    });
    expect(splitSubmits("hello\r\nworld\r\n")).toEqual({
      count: 2,
      segments: ["hello", "world"],
    });
  });

  it("counts a bare enter as one empty segment", () => {
    expect(splitSubmits("\r")).toEqual({ count: 1, segments: [""] });
  });
});

describe("turnLabelFrom", () => {
  it("strips controls, normalizes space, and slices", () => {
    expect(turnLabelFrom("  hello\x07  world  ")).toBe("hello world");
    expect(turnLabelFrom("あ".repeat(250))).toBe("あ".repeat(200));
  });

  it("keeps a Japanese prompt after slice at the requested max", () => {
    expect(turnLabelFrom("実装して確認して", 4)).toBe("実装して");
  });
});

describe("shouldMarkTurn", () => {
  it("rejects empty, single-character, same-line, and 250ms bursts", () => {
    expect(shouldMarkTurn({ label: "", currentLine: 3, now: 1000 })).toBe(false);
    expect(shouldMarkTurn({ label: "y", currentLine: 3, now: 1000 })).toBe(false);
    expect(shouldMarkTurn({ label: "ん", currentLine: 3, now: 1000 })).toBe(false);
    expect(shouldMarkTurn({
      label: "実装して",
      currentLine: 4,
      now: 1100,
      last: { line: 4, at: 1000 },
    })).toBe(false);
    expect(shouldMarkTurn({
      label: "実装して",
      currentLine: 5,
      now: 1200,
      last: { line: 4, at: 1000 },
    })).toBe(false);
    expect(shouldMarkTurn({
      label: "実装して",
      currentLine: 5,
      now: 1300,
      last: { line: 4, at: 1000 },
    })).toBe(true);
  });
});

describe("findTurnIndexForViewport", () => {
  const marks = [mark(10), mark(20), mark(30)];

  it("returns -1 when the viewport is above the first marker", () => {
    expect(findTurnIndexForViewport(marks, 9)).toBe(-1);
  });

  it("returns the exact match when the viewport sits on a marker", () => {
    expect(findTurnIndexForViewport(marks, 20)).toBe(1);
  });

  it("returns the last marker when the viewport is just below it", () => {
    expect(findTurnIndexForViewport(marks, 31)).toBe(2);
  });

  it("returns empty as -1", () => {
    expect(findTurnIndexForViewport([], 0)).toBe(-1);
  });
});

describe("pickJumpTarget", () => {
  const marks = [mark(10, "a"), mark(20, "b"), mark(30, "c")];

  it("moves to the previous and next turn", () => {
    expect(pickJumpTarget(marks, 1, -1)?.label).toBe("a");
    expect(pickJumpTarget(marks, 1, 1)?.label).toBe("c");
  });

  it("starts at the first mark when jumping next from above all marks", () => {
    expect(pickJumpTarget(marks, -1, 1)?.label).toBe("a");
    expect(pickJumpTarget(marks, -1, -1)).toBeNull();
  });

  it("stays put at the ends", () => {
    expect(pickJumpTarget(marks, 0, -1)).toBeNull();
    expect(pickJumpTarget(marks, 2, 1)).toBeNull();
  });
});
