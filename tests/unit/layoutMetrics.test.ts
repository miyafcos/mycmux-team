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

  it("balances all columns when a new column is added", () => {
    expect(reconcileColumnWidths(
      [["a"], ["b"]],
      [2, 5],
      [["a"], ["b"], ["new"]],
    )).toEqual([1, 1, 1]);
  });

  it("keeps outer widths when a new pane is added within an existing column", () => {
    expect(reconcileColumnWidths(
      [["a"], ["b"]],
      [2, 5],
      [["a", "new"], ["b"]],
    )).toEqual([2, 5]);
  });

  it("balances all columns when a pane moves into another previous column", () => {
    expect(reconcileColumnWidths(
      [["a", "b"], ["c"]],
      [2, 5],
      [["a"], ["b", "c"]],
    )).toEqual([1, 1]);
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
