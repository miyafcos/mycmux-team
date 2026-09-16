import { describe, expect, it } from "vitest";
import { reconcileSplitLayoutMetrics } from "../../src/lib/layoutMetrics";

/**
 * Since 2026-09-16 an axis only remembers the dividers the user dragged. These
 * cases carry no pins, so every split and every close spreads the survivors
 * evenly again; an axis that neither gained nor lost an item is left alone.
 */

function widths(
  previousColumns: string[][],
  previousWidths: number[] | undefined,
  nextColumns: string[][],
): number[] | undefined {
  return reconcileSplitLayoutMetrics(
    previousColumns,
    { columnWidths: previousWidths },
    nextColumns,
  ).columnWidths;
}

function heights(
  previousColumns: string[][],
  previousRows: number[][] | undefined,
  nextColumns: string[][],
): number[][] | undefined {
  return reconcileSplitLayoutMetrics(
    previousColumns,
    { rowHeightsPerCol: previousRows },
    nextColumns,
  ).rowHeightsPerCol;
}

function expectSizes(actual: number[] | undefined, expected: number[]): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((size, index) => expect(actual?.[index]).toBeCloseTo(size, 12));
}

describe("column widths", () => {
  it("balances the survivors when a column is removed", () => {
    expectSizes(widths([["a"], ["b"], ["c"]], [2, 3, 5], [["a"], ["c"]]), [0.5, 0.5]);
  });

  it("balances the axis when columns are reordered", () => {
    expectSizes(
      widths([["a"], ["b"], ["c"]], [2, 3, 5], [["c"], ["a"], ["b"]]),
      [1 / 3, 1 / 3, 1 / 3],
    );
  });

  it("balances all survivors when one survivor has no positive width", () => {
    expectSizes(widths([["a"], ["b"], ["c"]], [2, 3, 0], [["a"], ["c"]]), [0.5, 0.5]);
  });

  it("balances the axis when a new column is appended", () => {
    expectSizes(widths([["a"], ["b"]], [2, 5], [["a"], ["b"], ["new"]]), [1 / 3, 1 / 3, 1 / 3]);
  });

  it("balances the axis when a column is inserted between two others", () => {
    expectSizes(widths([["a"], ["b"]], [2, 5], [["a"], ["new"], ["b"]]), [1 / 3, 1 / 3, 1 / 3]);
  });

  it("balances the axis when a new column leads it", () => {
    expectSizes(widths([["a"], ["b"]], [2, 5], [["new"], ["a"], ["b"]]), [1 / 3, 1 / 3, 1 / 3]);
  });

  it("splits evenly while the workspace still has no stored widths", () => {
    expectSizes(widths([["a"]], undefined, [["a"], ["new"]]), [0.5, 0.5]);
  });

  it("balances columns that share no pane with the previous layout", () => {
    expectSizes(widths([["a"]], [3], [["x"], ["y"]]), [0.5, 0.5]);
  });

  it("keeps outer widths when a new pane is added within an existing column", () => {
    expect(widths([["a"], ["b"]], [2, 5], [["a", "new"], ["b"]])).toEqual([2, 5]);
  });

  it("keeps both widths when a pane moves into the next column", () => {
    expect(widths([["a", "b"], ["c"]], [2, 5], [["a"], ["b", "c"]])).toEqual([2, 5]);
  });
});

describe("row heights per column", () => {
  it("balances the survivors when a row is removed", () => {
    expect(heights([["a", "b", "c"]], [[1, 2, 3]], [["a", "c"]])).toEqual([[0.5, 0.5]]);
  });

  it("balances the axis when rows are reordered", () => {
    expect(heights([["a", "b", "c"]], [[1, 2, 3]], [["c", "a"]])).toEqual([[0.5, 0.5]]);
  });

  it("balances a column when a new row is added", () => {
    const result = heights([["a", "b"]], [[1, 2]], [["a", "new", "b"]]);
    expect(result).toHaveLength(1);
    expectSizes(result?.[0], [1 / 3, 1 / 3, 1 / 3]);
  });

  it("balances only the column receiving a pane from another column", () => {
    const result = heights(
      [["a", "b"], ["c", "d"]],
      [[1, 2], [3, 4]],
      [["a"], ["c", "b", "d"]],
    );
    expect(result?.[0]).toEqual([1]);
    expectSizes(result?.[1], [1 / 3, 1 / 3, 1 / 3]);
  });

  it("balances a column when its previous height data is inconsistent", () => {
    expect(heights([["a", "b"]], [[9]], [["a"]])).toEqual([[1]]);
  });
});
