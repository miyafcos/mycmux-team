import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildTurnListRows,
  createTurnChipVisibilityController,
  nextTurnChipVisibilityAt,
  resolveTurnChipState,
  resolveTurnChipVisibility,
  TURN_CHIP_HIDE_DELAY_MS,
  TURN_CHIP_SHOW_DEBOUNCE_MS,
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

describe("resolveTurnChipVisibility", () => {
  it("stays hidden at the bottom before the viewport leaves", () => {
    expect(resolveTurnChipVisibility({
      isAtBottom: true,
      lastLeftBottomAt: null,
      lastReturnedBottomAt: null,
      wasVisible: false,
      now: 0,
    })).toBe(false);
  });

  it("shows after scrolling away past the debounce", () => {
    expect(resolveTurnChipVisibility({
      isAtBottom: false,
      lastLeftBottomAt: 0,
      lastReturnedBottomAt: null,
      wasVisible: false,
      now: TURN_CHIP_SHOW_DEBOUNCE_MS - 1,
    })).toBe(false);
    expect(resolveTurnChipVisibility({
      isAtBottom: false,
      lastLeftBottomAt: 0,
      lastReturnedBottomAt: null,
      wasVisible: false,
      now: TURN_CHIP_SHOW_DEBOUNCE_MS,
    })).toBe(true);
  });

  it("keeps the chip visible for the hide delay after returning to the bottom", () => {
    expect(resolveTurnChipVisibility({
      isAtBottom: true,
      lastLeftBottomAt: 0,
      lastReturnedBottomAt: 1_000,
      wasVisible: true,
      now: 1_000 + TURN_CHIP_HIDE_DELAY_MS - 1,
    })).toBe(true);
    expect(resolveTurnChipVisibility({
      isAtBottom: true,
      lastLeftBottomAt: 0,
      lastReturnedBottomAt: 1_000,
      wasVisible: true,
      now: 1_000 + TURN_CHIP_HIDE_DELAY_MS,
    })).toBe(false);
  });

  it("does not show for a bottom flicker shorter than the debounce", () => {
    expect(resolveTurnChipVisibility({
      isAtBottom: true,
      lastLeftBottomAt: 0,
      lastReturnedBottomAt: 50,
      wasVisible: false,
      now: 50,
    })).toBe(false);
  });

  it("stays visible when leaving the bottom again during the hide delay", () => {
    expect(resolveTurnChipVisibility({
      isAtBottom: false,
      lastLeftBottomAt: 1_050,
      lastReturnedBottomAt: 1_000,
      wasVisible: true,
      now: 1_050,
    })).toBe(true);
  });

  it("schedules the show debounce and hide delay", () => {
    expect(nextTurnChipVisibilityAt({
      isAtBottom: false,
      lastLeftBottomAt: 10,
      lastReturnedBottomAt: null,
      wasVisible: false,
      now: 10,
    })).toBe(10 + TURN_CHIP_SHOW_DEBOUNCE_MS);
    expect(nextTurnChipVisibilityAt({
      isAtBottom: true,
      lastLeftBottomAt: 0,
      lastReturnedBottomAt: 500,
      wasVisible: true,
      now: 500,
    })).toBe(500 + TURN_CHIP_HIDE_DELAY_MS);
  });
});

describe("createTurnChipVisibilityController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hides at the bottom, shows after scrolling away, then hides 900ms after return", () => {
    const controller = createTurnChipVisibilityController();
    expect(controller.isVisible()).toBe(false);

    controller.setAtBottom(false);
    expect(controller.isVisible()).toBe(false);

    vi.advanceTimersByTime(TURN_CHIP_SHOW_DEBOUNCE_MS - 1);
    expect(controller.isVisible()).toBe(false);

    vi.advanceTimersByTime(1);
    expect(controller.isVisible()).toBe(true);

    controller.setAtBottom(true);
    expect(controller.isVisible()).toBe(true);

    vi.advanceTimersByTime(TURN_CHIP_HIDE_DELAY_MS - 1);
    expect(controller.isVisible()).toBe(true);

    vi.advanceTimersByTime(1);
    expect(controller.isVisible()).toBe(false);
    controller.dispose();
  });

  it("does not show when isAtBottom flickers true→false→true within 100ms", () => {
    const seen: boolean[] = [];
    const controller = createTurnChipVisibilityController({
      onChange: (visible) => seen.push(visible),
    });

    controller.setAtBottom(false);
    vi.advanceTimersByTime(TURN_CHIP_SHOW_DEBOUNCE_MS - 1);
    controller.setAtBottom(true);
    vi.advanceTimersByTime(TURN_CHIP_HIDE_DELAY_MS);

    expect(controller.isVisible()).toBe(false);
    expect(seen).toEqual([]);
    controller.dispose();
  });

  it("clears the pending timer on dispose", () => {
    const controller = createTurnChipVisibilityController();
    controller.setAtBottom(false);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    controller.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stays hidden and arms no timer once disposed", () => {
    const seen: boolean[] = [];
    const controller = createTurnChipVisibilityController({
      onChange: (visible) => seen.push(visible),
    });
    controller.setAtBottom(false);
    vi.advanceTimersByTime(TURN_CHIP_SHOW_DEBOUNCE_MS);
    expect(controller.isVisible()).toBe(true);

    controller.dispose();
    expect(controller.isVisible()).toBe(false);
    expect(controller.setAtBottom(false)).toBe(false);
    expect(controller.setAtBottom(true)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(TURN_CHIP_HIDE_DELAY_MS * 2);
    expect(seen).toEqual([true]);
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
