import { describe, expect, it } from "vitest";
import { getVirtualRowRange } from "../../src/hooks/useVirtualRows";

describe("getVirtualRowRange", () => {
  it("returns an empty range for an empty table", () => {
    expect(getVirtualRowRange(0, 28, 0, 420)).toEqual({
      start: 0,
      end: 0,
      paddingTop: 0,
      paddingBottom: 0,
    });
  });

  it("keeps an overscanned range at the top", () => {
    expect(getVirtualRowRange(100, 28, 0, 84, 2)).toEqual({
      start: 0,
      end: 5,
      paddingTop: 0,
      paddingBottom: 2660,
    });
  });

  it("uses spacers around the visible middle window", () => {
    expect(getVirtualRowRange(100, 28, 280, 84, 2)).toEqual({
      start: 8,
      end: 15,
      paddingTop: 224,
      paddingBottom: 2380,
    });
  });

  it("clamps the window at the final row", () => {
    expect(getVirtualRowRange(10, 28, 260, 84, 2)).toEqual({
      start: 7,
      end: 10,
      paddingTop: 196,
      paddingBottom: 0,
    });
  });

  it.each([
    ["compact", 31],
    ["relaxed", 39],
  ])("uses the computed %s density row height", (_density, rowHeight) => {
    const range = getVirtualRowRange(100, rowHeight, rowHeight * 10, rowHeight * 3, 2);

    expect(range).toEqual({
      start: 8,
      end: 15,
      paddingTop: rowHeight * 8,
      paddingBottom: rowHeight * 85,
    });
  });

  it("keeps a visible range after the row count shrinks", () => {
    expect(getVirtualRowRange(10, 28, 2800, 84, 2)).toEqual({
      start: 7,
      end: 10,
      paddingTop: 196,
      paddingBottom: 0,
    });
  });
});
