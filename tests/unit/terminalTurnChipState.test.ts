import { describe, expect, it } from "vitest";

import {
  buildTurnListRows,
  resolveTurnChipState,
} from "../../src/components/terminal/terminalTurnChipState";
import type { TurnMarkData } from "../../src/components/terminal/terminalTurnModel";

function mark(line: number, label = `turn-${line}`, at = line * 1_000): TurnMarkData {
  return { line, label, at };
}

describe("resolveTurnChipState", () => {
  const marks = [mark(10), mark(20), mark(30)];

  it("uses the newest turn at the bottom and disables the next button", () => {
    expect(resolveTurnChipState({
      marks,
      viewportY: 20,
      isAtBottom: true,
      bufferType: "normal",
    })).toEqual({ index: 2, total: 3, canPrev: true, canNext: false });
  });

  it("clamps the viewport above the oldest mark to the first turn", () => {
    expect(resolveTurnChipState({
      marks,
      viewportY: 0,
      isAtBottom: false,
      bufferType: "normal",
    })).toEqual({ index: 0, total: 3, canPrev: false, canNext: true });
  });

  it("finds the turn at the current viewport in normal scrollback", () => {
    expect(resolveTurnChipState({
      marks,
      viewportY: 25,
      isAtBottom: false,
      bufferType: "normal",
    })).toEqual({ index: 1, total: 3, canPrev: true, canNext: true });
  });

  it("returns null for the alternate buffer or an empty mark list", () => {
    expect(resolveTurnChipState({
      marks,
      viewportY: 20,
      isAtBottom: false,
      bufferType: "alternate",
    })).toBeNull();
    expect(resolveTurnChipState({
      marks: [],
      viewportY: 20,
      isAtBottom: false,
      bufferType: "normal",
    })).toBeNull();
  });
});

describe("buildTurnListRows", () => {
  it("puts surviving marks newest first and appends unmatched transcript prompts", () => {
    const rows = buildTurnListRows(
      [mark(10, "old mark", 100), mark(20, "new mark", 200)],
      [
        { text: "trimmed history", occurredAt: 50 },
        { text: "old mark", occurredAt: 100 },
        { text: "new mark", occurredAt: 200 },
      ],
    );

    expect(rows.map(({ label, markIndex }) => ({ label, markIndex }))).toEqual([
      { label: "new mark", markIndex: 1 },
      { label: "old mark", markIndex: 0 },
      { label: "trimmed history", markIndex: null },
    ]);
  });

  it("matches normalized whitespace and an 80-character prefix of the first prompt line", () => {
    const prefix = "x".repeat(80);
    const rows = buildTurnListRows(
      [mark(10, `  ${prefix} trailing label`, 100)],
      [{ text: `${prefix} extra prompt text\nignored second line`, occurredAt: 100 }],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.markIndex).toBe(0);
  });

  it("caps the list at 200 rows while retaining the newest surviving marks", () => {
    const marks = Array.from({ length: 201 }, (_, index) => mark(index, `turn-${index}`, index));
    const rows = buildTurnListRows(marks, []);

    expect(rows).toHaveLength(200);
    expect(rows[0]?.markIndex).toBe(200);
    expect(rows[199]?.markIndex).toBe(1);
  });
});
