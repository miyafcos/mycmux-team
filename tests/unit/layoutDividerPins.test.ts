import { describe, expect, it } from "vitest";

import {
  applyAxisDrag,
  balancedAxis,
  normalizeDividerPins,
  reconcileSplitLayoutMetrics,
  settleAxis,
  type SplitInsertHint,
} from "../../src/lib/layoutMetrics";

/**
 * The scenarios the layout rule was approved on (S1-S7), replayed through the
 * real reconciler. Each step lists the axis as a percentage of the whole plus
 * the pin state of every divider; the numbers come from the reference run of
 * the approved design and are compared after normalising the axis to 1.
 *
 * Horizontal scenarios give every pane its own column, so the axis under test
 * is columnWidths; the vertical one puts every pane in a single column, so the
 * axis is that column's rowHeightsPerCol. Drag sizes are pixels, the way
 * allotment reports them.
 */

type ScenarioOp =
  | { kind: "drag"; sizes: number[] }
  | { kind: "insert"; sourceId: string; insertedId: string; side: "before" | "after" }
  | { kind: "remove"; removedId: string };

interface ScenarioStep {
  label: string;
  op: ScenarioOp;
  ids: string[];
  percent: number[];
  pins: boolean[];
}

interface Scenario {
  key: string;
  title: string;
  vertical: boolean;
  start: string[];
  steps: ScenarioStep[];
}

const SCENARIOS: Scenario[] = [
  {
    key: "S1",
    title: "S1 横: 右端を 3 回割ってから 2 つ閉じる",
    vertical: false,
    start: ["A"],
    steps: [
      {
        label: "A を右に割る",
        op: { kind: "insert", sourceId: "A", insertedId: "B", side: "after" },
        ids: ["A", "B"],
        percent: [50, 50],
        pins: [false],
      },
      {
        label: "B を右に割る",
        op: { kind: "insert", sourceId: "B", insertedId: "C", side: "after" },
        ids: ["A", "B", "C"],
        percent: [33.33333333333333, 33.33333333333333, 33.333333333333336],
        pins: [false, false],
      },
      {
        label: "C を右に割る",
        op: { kind: "insert", sourceId: "C", insertedId: "D", side: "after" },
        ids: ["A", "B", "C", "D"],
        percent: [25, 25, 25, 25],
        pins: [false, false, false],
      },
      {
        label: "B を閉じる",
        op: { kind: "remove", removedId: "B" },
        ids: ["A", "C", "D"],
        percent: [33.33333333333333, 33.33333333333333, 33.333333333333336],
        pins: [false, false],
      },
      {
        label: "C を閉じる",
        op: { kind: "remove", removedId: "C" },
        ids: ["A", "D"],
        percent: [50, 50],
        pins: [false],
      },
    ],
  },
  {
    key: "S2",
    title: "S2 横: A を手で 70% に広げてから右を割る → A を閉じる",
    vertical: false,
    start: ["A", "B"],
    steps: [
      {
        label: "A|B の線を動かして A=70%",
        op: { kind: "drag", sizes: [840, 360] },
        ids: ["A", "B"],
        percent: [70, 30.000000000000004],
        pins: [true],
      },
      {
        label: "B を右に割る",
        op: { kind: "insert", sourceId: "B", insertedId: "C", side: "after" },
        ids: ["A", "B", "C"],
        percent: [70, 15.000000000000002, 15.000000000000002],
        pins: [true, false],
      },
      {
        label: "C を右に割る",
        op: { kind: "insert", sourceId: "C", insertedId: "D", side: "after" },
        ids: ["A", "B", "C", "D"],
        percent: [70, 9.999999999999998, 10.000000000000009, 9.999999999999998],
        pins: [true, false, false],
      },
      {
        label: "B を閉じる",
        op: { kind: "remove", removedId: "B" },
        ids: ["A", "C", "D"],
        percent: [70, 15.000000000000002, 15.000000000000002],
        pins: [true, false],
      },
      {
        label: "A を閉じる",
        op: { kind: "remove", removedId: "A" },
        ids: ["C", "D"],
        percent: [50, 50],
        pins: [false],
      },
    ],
  },
  {
    key: "S3",
    title: "S3 横: A を手で 30% に狭めてから右を割る",
    vertical: false,
    start: ["A", "B"],
    steps: [
      {
        label: "A|B の線を動かして A=30%",
        op: { kind: "drag", sizes: [360, 840] },
        ids: ["A", "B"],
        percent: [30, 70],
        pins: [true],
      },
      {
        label: "B を右に割る",
        op: { kind: "insert", sourceId: "B", insertedId: "C", side: "after" },
        ids: ["A", "B", "C"],
        percent: [30, 34.99999999999999, 35.00000000000001],
        pins: [true, false],
      },
      {
        label: "A を右に割る",
        op: { kind: "insert", sourceId: "A", insertedId: "D", side: "after" },
        ids: ["A", "D", "B", "C"],
        percent: [15, 15, 34.99999999999999, 35.00000000000001],
        pins: [false, true, false],
      },
    ],
  },
  {
    key: "S4",
    title: "S4 横 3 列: A|B を動かして A=50% → C を閉じる → B を右に割る (離した直後にすぐ整える)",
    vertical: false,
    start: ["A", "B", "C"],
    steps: [
      {
        label: "A|B の線を動かして A=50%",
        op: { kind: "drag", sizes: [600, 200, 400] },
        ids: ["A", "B", "C"],
        percent: [50, 25, 25],
        pins: [true, false],
      },
      {
        label: "C を閉じる",
        op: { kind: "remove", removedId: "C" },
        ids: ["A", "B"],
        percent: [50, 50],
        pins: [true],
      },
      {
        label: "B を右に割る",
        op: { kind: "insert", sourceId: "B", insertedId: "D", side: "after" },
        ids: ["A", "B", "D"],
        percent: [50, 25, 25],
        pins: [true, false],
      },
    ],
  },
  {
    key: "S5",
    title: "S5 縦 (1 列の中の段): 上の段を手で 50% にしてから下を割る",
    vertical: true,
    start: ["a", "b", "c"],
    steps: [
      {
        label: "a|b の線を動かして a=50%",
        op: { kind: "drag", sizes: [450, 150, 300] },
        ids: ["a", "b", "c"],
        percent: [50, 25, 25],
        pins: [true, false],
      },
      {
        label: "c を下に割る",
        op: { kind: "insert", sourceId: "c", insertedId: "d", side: "after" },
        ids: ["a", "b", "c", "d"],
        percent: [50, 16.666666666666664, 16.666666666666664, 16.666666666666675],
        pins: [true, false, false],
      },
      {
        label: "c を閉じる",
        op: { kind: "remove", removedId: "c" },
        ids: ["a", "b", "d"],
        percent: [50, 25, 25],
        pins: [true, false],
      },
    ],
  },
  {
    key: "S6",
    title: "S6 横 3 列: 両側の線を手で動かした列を閉じる",
    vertical: false,
    start: ["A", "B", "C"],
    steps: [
      {
        label: "A|B の線を動かして A=30%",
        op: { kind: "drag", sizes: [360, 440, 400] },
        ids: ["A", "B", "C"],
        percent: [30, 34.99999999999999, 35.00000000000001],
        pins: [true, false],
      },
      {
        label: "B|C の線を動かして C=30%",
        op: { kind: "drag", sizes: [360, 480, 360] },
        ids: ["A", "B", "C"],
        percent: [30, 40, 30.000000000000004],
        pins: [true, true],
      },
      {
        label: "B を閉じる",
        op: { kind: "remove", removedId: "B" },
        ids: ["A", "C"],
        percent: [50, 50],
        pins: [false],
      },
    ],
  },
  {
    key: "S7",
    title: "S7 横: A を手で 70% に広げてから B を左に分割",
    vertical: false,
    start: ["A", "B"],
    steps: [
      {
        label: "A|B の線を動かして A=70%",
        op: { kind: "drag", sizes: [840, 360] },
        ids: ["A", "B"],
        percent: [70, 30.000000000000004],
        pins: [true],
      },
      {
        label: "B を左に割る",
        op: { kind: "insert", sourceId: "B", insertedId: "D", side: "before" },
        ids: ["A", "D", "B"],
        percent: [70, 15.000000000000002, 15.000000000000002],
        pins: [true, false],
      },
    ],
  },
];

interface AxisRun {
  ids: string[];
  sizes: number[];
  pins: boolean[];
}

function columnsOf(ids: string[], vertical: boolean): string[][] {
  return vertical ? [[...ids]] : ids.map((id) => [id]);
}

function normalized(sizes: number[]): number[] {
  const total = sizes.reduce((sum, size) => sum + size, 0);
  return sizes.map((size) => size / total);
}

function applyStep(state: AxisRun, vertical: boolean, op: ScenarioOp): AxisRun {
  if (op.kind === "drag") {
    return { ids: [...state.ids], ...applyAxisDrag(state.sizes, op.sizes, state.pins) };
  }
  const nextIds = [...state.ids];
  let hint: SplitInsertHint | undefined;
  if (op.kind === "insert") {
    const sourceIndex = nextIds.indexOf(op.sourceId);
    nextIds.splice(op.side === "after" ? sourceIndex + 1 : sourceIndex, 0, op.insertedId);
    hint = { insertedPaneId: op.insertedId, sourcePaneId: op.sourceId, side: op.side };
  } else {
    nextIds.splice(nextIds.indexOf(op.removedId), 1);
  }
  const metrics = reconcileSplitLayoutMetrics(
    columnsOf(state.ids, vertical),
    vertical
      ? { rowHeightsPerCol: [state.sizes], rowDividerPinsPerCol: [state.pins] }
      : { columnWidths: state.sizes, columnDividerPins: state.pins },
    columnsOf(nextIds, vertical),
    hint,
  );
  return vertical
    ? { ids: nextIds, sizes: metrics.rowHeightsPerCol![0], pins: metrics.rowDividerPinsPerCol![0] }
    : { ids: nextIds, sizes: metrics.columnWidths!, pins: metrics.columnDividerPins! };
}

describe("approved divider-pin scenarios", () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.key} ${scenario.title}`, () => {
      let state: AxisRun = { ids: [...scenario.start], ...balancedAxis(scenario.start.length) };
      for (const step of scenario.steps) {
        state = applyStep(state, scenario.vertical, step.op);
        expect(state.ids, `${step.label}: order`).toEqual(step.ids);
        expect(state.pins, `${step.label}: pins`).toEqual(step.pins);
        const actual = normalized(state.sizes);
        expect(actual, `${step.label}: size count`).toHaveLength(step.percent.length);
        actual.forEach((size, index) => {
          expect(size, `${step.label}: size[${index}]`).toBeCloseTo(step.percent[index] / 100, 9);
        });
      }
    });
  }
});

describe("settleAxis", () => {
  it("spreads free dividers evenly between the pinned ones", () => {
    const settled = settleAxis([null, 0.6, null, null], [false, true, false, false]);
    expect(settled.pins).toEqual([false, true, false, false]);
    expect(settled.sizes).toHaveLength(5);
    [0.3, 0.3, 0.4 / 3, 0.4 / 3, 0.4 / 3].forEach((size, index) => {
      expect(settled.sizes[index]).toBeCloseTo(size, 12);
    });
  });

  it("forgets a pin that sits outside the axis", () => {
    const settled = settleAxis([1.4, null], [true, false]);
    expect(settled.pins).toEqual([false, false]);
    settled.sizes.forEach((size) => expect(size).toBeCloseTo(1 / 3, 12));
  });

  it("forgets the later pin when two remembered positions cross", () => {
    const settled = settleAxis([0.8, 0.5], [true, true]);
    expect(settled.pins).toEqual([true, false]);
    [0.8, 0.1, 0.1].forEach((size, index) => {
      expect(settled.sizes[index]).toBeCloseTo(size, 12);
    });
  });

  it("forgets a pin that leaves an item with no room at all", () => {
    // The free divider before the pinned one rounds onto it, so the first item
    // ends up with a size of zero and the pin around it has to go.
    const settled = settleAxis([null, Number.MIN_VALUE], [false, true]);
    expect(settled.pins).toEqual([false, false]);
    settled.sizes.forEach((size) => expect(size).toBeCloseTo(1 / 3, 12));
  });
});

describe("normalizeDividerPins", () => {
  it("treats saved data without pins as nothing dragged", () => {
    expect(normalizeDividerPins(undefined, 3)).toEqual([false, false]);
  });

  it("rejects a pin list of the wrong length", () => {
    expect(normalizeDividerPins([true], 3)).toEqual([false, false]);
  });

  it("rejects a pin list holding something other than booleans", () => {
    expect(normalizeDividerPins([true, "yes"] as unknown as boolean[], 3)).toEqual([false, false]);
  });

  it("keeps a pin list that matches the axis", () => {
    expect(normalizeDividerPins([true, false], 3)).toEqual([true, false]);
  });
});

describe("applyAxisDrag", () => {
  it("pins every divider that moved by a pixel or more", () => {
    expect(applyAxisDrag([1, 1, 1], [600, 200, 400], [false, false])).toEqual({
      sizes: [0.5, 0.25, 0.25],
      pins: [true, false],
    });
  });

  it("leaves a divider free when it moved less than a pixel", () => {
    const drag = applyAxisDrag([400, 400, 400], [400.4, 399.6, 400], [false, false]);
    expect(drag.pins).toEqual([false, false]);
  });

  it("keeps dividers that were already pinned", () => {
    const drag = applyAxisDrag([0.3, 0.35, 0.35], [360, 480, 360], [true, false]);
    expect(drag.pins).toEqual([true, true]);
    expect(drag.sizes[0]).toBeCloseTo(0.3, 12);
    expect(drag.sizes[2]).toBeCloseTo(0.3, 12);
  });

  it("balances the axis only when the dragged sizes describe nothing at all", () => {
    expect(applyAxisDrag([1, 1], [0, 0], [true])).toEqual(balancedAxis(2));
    expect(applyAxisDrag([1, 1], [400, Number.NaN], [true])).toEqual(balancedAxis(2));
    expect(applyAxisDrag([1, 1], [-100, 900], [true])).toEqual(balancedAxis(2));
  });

  it("leaves a pane that was dragged shut exactly where the pointer left it", () => {
    // Settling here would re-open the pane the user just closed, and it would
    // move the ones they never touched to do it.
    const drag = applyAxisDrag([400, 400, 400], [0, 700, 500], [false, false]);
    expect(drag.sizes).toEqual([0, 0.5833333333333334, 0.4166666666666667]);
    expect(drag.pins).toEqual([false, true]);
  });

  it("keeps the other dividers on an axis where a pane was dragged shut", () => {
    const drag = applyAxisDrag([300, 300, 600], [0, 600, 600], [false, true]);
    expect(drag.pins).toEqual([false, true]);
  });

  it("still remembers a divider dragged out of a shut pane", () => {
    // The axis already held a shut pane when the drag began, which used to
    // make every divider on it unreadable and so unpinnable.
    const drag = applyAxisDrag([0, 1200], [300, 900], [false]);
    expect(drag.pins).toEqual([true]);
    expect(drag.sizes).toEqual([0.25, 0.75]);
  });
});

describe("reconcileSplitLayoutMetrics", () => {
  it("forgets both axes when the survivors changed their relative order", () => {
    const metrics = reconcileSplitLayoutMetrics(
      [["a"], ["b"], ["c"]],
      { columnWidths: [0.5, 0.25, 0.25], columnDividerPins: [true, false] },
      [["c"], ["a"], ["b"]],
    );
    expect(metrics.columnDividerPins).toEqual([false, false]);
    metrics.columnWidths?.forEach((width) => expect(width).toBeCloseTo(1 / 3, 12));
  });

  it("keeps the column axis untouched when a pane only moves between columns", () => {
    const metrics = reconcileSplitLayoutMetrics(
      [["a", "b"], ["c"]],
      { columnWidths: [0.7, 0.3], columnDividerPins: [true] },
      [["a"], ["b", "c"]],
    );
    expect(metrics.columnDividerPins).toEqual([true]);
    expect(metrics.columnWidths?.[0]).toBeCloseTo(0.7, 12);
    expect(metrics.columnWidths?.[1]).toBeCloseTo(0.3, 12);
  });

  it("starts a brand new column with nothing remembered", () => {
    const metrics = reconcileSplitLayoutMetrics(
      [["a", "b"]],
      { rowHeightsPerCol: [[0.7, 0.3]], rowDividerPinsPerCol: [[true]] },
      [["a", "b"], ["new", "other"]],
    );
    expect(metrics.rowDividerPinsPerCol).toEqual([[true], [false]]);
    expect(metrics.rowHeightsPerCol?.[1]).toEqual([0.5, 0.5]);
  });

  it("charges a hintless insert to the neighbour before it", () => {
    const metrics = reconcileSplitLayoutMetrics(
      [["a"], ["b"]],
      { columnWidths: [0.7, 0.3], columnDividerPins: [true] },
      [["a"], ["b"], ["new"]],
    );
    expect(metrics.columnDividerPins).toEqual([true, false]);
    expect(metrics.columnWidths?.[0]).toBeCloseTo(0.7, 12);
    expect(metrics.columnWidths?.[1]).toBeCloseTo(0.15, 12);
    expect(metrics.columnWidths?.[2]).toBeCloseTo(0.15, 12);
  });

  it("charges a hintless leading insert to the neighbour after it", () => {
    const metrics = reconcileSplitLayoutMetrics(
      [["a"], ["b"]],
      { columnWidths: [0.7, 0.3], columnDividerPins: [true] },
      [["new"], ["a"], ["b"]],
    );
    expect(metrics.columnDividerPins).toEqual([false, true]);
    expect(metrics.columnWidths?.[0]).toBeCloseTo(0.35, 12);
    expect(metrics.columnWidths?.[1]).toBeCloseTo(0.35, 12);
    expect(metrics.columnWidths?.[2]).toBeCloseTo(0.3, 12);
  });

  it("returns nothing at all for a workspace with no columns", () => {
    expect(reconcileSplitLayoutMetrics([["a"]], {}, [])).toEqual({
      columnWidths: undefined,
      rowHeightsPerCol: undefined,
      columnDividerPins: undefined,
      rowDividerPinsPerCol: undefined,
    });
  });
});
