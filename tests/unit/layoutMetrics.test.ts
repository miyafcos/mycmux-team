import { describe, expect, it } from "vitest";
import {
  reconcileColumnWidths,
  reconcileRowHeightsPerCol,
} from "../../src/lib/layoutMetrics";

describe("reconcileColumnWidths", () => {
  it("keeps survivor proportions when a column is removed", () => {
    expect(reconcileColumnWidths(
      [["a"], ["b"], ["c"]],
      [2, 3, 5],
      [["a"], ["c"]],
    )).toEqual([2, 5]);
  });

  it("keeps widths with their columns when columns are reordered", () => {
    expect(reconcileColumnWidths(
      [["a"], ["b"], ["c"]],
      [2, 3, 5],
      [["c"], ["a"], ["b"]],
    )).toEqual([5, 2, 3]);
  });

  it("balances all survivors when one survivor has no positive width", () => {
    expect(reconcileColumnWidths(
      [["a"], ["b"], ["c"]],
      [2, 3, 0],
      [["a"], ["c"]],
    )).toEqual([1, 1]);
  });

  // A split used to rebalance every column, so each one threw away the widths
  // the user had dragged. It now only cuts the column the drop landed in.
  it("cuts a new column out of the neighbour it was dropped against", () => {
    expect(reconcileColumnWidths(
      [["a"], ["b"]],
      [2, 5],
      [["a"], ["b"], ["new"]],
    )).toEqual([2, 2.5, 2.5]);
  });

  it("charges a column inserted between two others to its left neighbour", () => {
    expect(reconcileColumnWidths(
      [["a"], ["b"]],
      [2, 5],
      [["a"], ["new"], ["b"]],
    )).toEqual([1, 1, 5]);
  });

  it("charges a leading new column to the neighbour on its right", () => {
    expect(reconcileColumnWidths(
      [["a"], ["b"]],
      [2, 5],
      [["new"], ["a"], ["b"]],
    )).toEqual([1, 1, 5]);
  });

  it("splits evenly while the workspace still has no stored widths", () => {
    expect(reconcileColumnWidths(
      [["a"]],
      undefined,
      [["a"], ["new"]],
    )).toEqual([0.5, 0.5]);
  });

  it("balances columns that share no pane with the previous layout", () => {
    expect(reconcileColumnWidths(
      [["a"]],
      [3],
      [["x"], ["y"]],
    )).toEqual([1, 1]);
  });

  it("keeps outer widths when a new pane is added within an existing column", () => {
    expect(reconcileColumnWidths(
      [["a"], ["b"]],
      [2, 5],
      [["a", "new"], ["b"]],
    )).toEqual([2, 5]);
  });

  it("keeps both widths when a pane moves into the next column", () => {
    expect(reconcileColumnWidths(
      [["a", "b"], ["c"]],
      [2, 5],
      [["a"], ["b", "c"]],
    )).toEqual([2, 5]);
  });
});

describe("reconcileRowHeightsPerCol", () => {
  it("keeps survivor proportions when a row is removed", () => {
    expect(reconcileRowHeightsPerCol(
      [["a", "b", "c"]],
      [[1, 2, 3]],
      [["a", "c"]],
    )).toEqual([[1, 3]]);
  });

  it("keeps heights with their panes when rows are reordered", () => {
    expect(reconcileRowHeightsPerCol(
      [["a", "b", "c"]],
      [[1, 2, 3]],
      [["c", "a"]],
    )).toEqual([[3, 1]]);
  });

  it("balances a column when a new row is added", () => {
    expect(reconcileRowHeightsPerCol(
      [["a", "b"]],
      [[1, 2]],
      [["a", "new", "b"]],
    )).toEqual([[1, 1, 1]]);
  });

  it("balances only the column receiving a pane from another column", () => {
    expect(reconcileRowHeightsPerCol(
      [["a", "b"], ["c", "d"]],
      [[1, 2], [3, 4]],
      [["a"], ["c", "b", "d"]],
    )).toEqual([[1], [1, 1, 1]]);
  });

  it("balances a column when its previous height data is inconsistent", () => {
    expect(reconcileRowHeightsPerCol(
      [["a", "b"]],
      [[9]],
      [["a"]],
    )).toEqual([[1]]);
  });
});
