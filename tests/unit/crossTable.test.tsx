import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { CrossTable } from "../../src/components/ailog/CrossTable";
import {
  OTHER_KEY,
  PIVOT_AXES,
  firstOtherAxis,
  foldNote,
  foldPivot,
  nextPivotAxes,
  selectionFromPivotCell,
} from "../../src/components/ailog/crossTableModel";
import { SERIES_AXES } from "../../src/components/ailog/usageModel";
import type { PivotReport, SeriesGroup } from "../../src/lib/ailog";

function group(name: string, over: Partial<SeriesGroup> = {}): SeriesGroup {
  return {
    group: name,
    turns: 1,
    sessions: 1,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: 0,
    ...over,
  };
}

function report(rowKeys: string[], colKeys: string[], cell: (row: string, col: string) => SeriesGroup): PivotReport {
  return {
    range: { from: 0, to: 1, label: "test" },
    rowBy: "project",
    colBy: "model",
    cols: colKeys,
    rows: rowKeys.map((key) => ({
      key,
      total: group(key),
      cells: colKeys.map((col) => cell(key, col)),
    })),
    colTotals: colKeys.map((col) => group(col)),
    grandTotal: group("total"),
    priceSource: "test",
    priceCoverage: {
      priced: { models: [], tokens: 0 },
      local: { models: [], tokens: 0 },
      internal: { models: [], tokens: 0 },
      flat: { models: [], tokens: 0 },
      reported: { models: [], tokens: 0 },
      unknown: { models: [], tokens: 0 },
      coveredTokenRatio: 1,
    },
    costNote: "",
  };
}

describe("nextPivotAxes", () => {
  it("switches the other axis when the same one is chosen", () => {
    expect(nextPivotAxes({ rowBy: "project", colBy: "model" }, { rowBy: "model" })).toEqual({
      rowBy: "model",
      colBy: "project",
    });
    expect(nextPivotAxes({ rowBy: "project", colBy: "model" }, { colBy: "project" })).toEqual({
      rowBy: "model_raw",
      colBy: "project",
    });
  });

  it("keeps a valid pair unchanged", () => {
    expect(nextPivotAxes({ rowBy: "project", colBy: "model" }, { colBy: "kind" })).toEqual({
      rowBy: "project",
      colBy: "kind",
    });
  });
});

describe("foldPivot", () => {
  it("keeps the top N rows and columns and folds the rest into 下位まとめ", () => {
    const rowKeys = ["r1", "r2", "r3", "r4"];
    const colKeys = ["c1", "c2", "c3"];
    const scores: Record<string, number> = { r1: 40, r2: 30, r3: 20, r4: 10, c1: 50, c2: 30, c3: 10 };
    const source = report(rowKeys, colKeys, (row, col) =>
      group(col, { turns: row === "r1" && col === "c1" ? 40 : 1, costUsd: scores[row] + scores[col] }),
    );
    source.rows.forEach((row) => {
      row.total = group(row.key, { costUsd: scores[row.key] });
    });
    source.colTotals = colKeys.map((col) => group(col, { costUsd: scores[col] }));

    const folded = foldPivot(source, "costUsd", 2, 2);
    expect(folded.rows.map((row) => row.key)).toEqual(["r1", "r2", OTHER_KEY]);
    expect(folded.cols).toEqual(["c1", "c2", OTHER_KEY]);
    expect(folded.foldedRows).toBe(2);
    expect(folded.foldedCols).toBe(1);
    expect(folded.foldedRowKeys).toEqual(["r3", "r4"]);
    expect(folded.foldedColKeys).toEqual(["c3"]);
    expect(foldNote(folded)).toBe("行 2 件 (r3 / r4)・列 1 件 (c3)を「下位まとめ」にまとめました");
  });

  it("names what went into 下位まとめ so a folded tier is still visible", () => {
    const rowKeys = ["only"];
    const colKeys = ["gpt-5.6-sol", "claude-opus-5", "gpt-5.6-terra", "gpt-5.5", "gpt-5.6-luna", "gpt-5.4"];
    const scores: Record<string, number> = {
      "gpt-5.6-sol": 60,
      "claude-opus-5": 50,
      "gpt-5.6-terra": 40,
      "gpt-5.5": 30,
      "gpt-5.6-luna": 20,
      "gpt-5.4": 10,
    };
    const source = report(rowKeys, colKeys, (row, col) => group(col, { costUsd: scores[col] }));
    source.rows.forEach((row) => {
      row.total = group(row.key, { costUsd: 210 });
    });
    source.colTotals = colKeys.map((col) => group(col, { costUsd: scores[col] }));

    const folded = foldPivot(source, "costUsd", 12, 4);
    expect(folded.foldedColKeys).toEqual(["gpt-5.6-luna", "gpt-5.4"]);
    expect(foldNote(folded)).toBe("列 2 件 (gpt-5.6-luna / gpt-5.4)を「下位まとめ」にまとめました");
  });

  it("caps the named list so the note stays shorter than the table", () => {
    const rowKeys = ["only"];
    const colKeys = ["c1", "c2", "c3", "c4", "c5", "c6", "c7"];
    const scores = Object.fromEntries(colKeys.map((col, index) => [col, 100 - index]));
    const source = report(rowKeys, colKeys, (row, col) => group(col, { costUsd: scores[col] }));
    source.rows.forEach((row) => {
      row.total = group(row.key, { costUsd: 1 });
    });
    source.colTotals = colKeys.map((col) => group(col, { costUsd: scores[col] }));

    const folded = foldPivot(source, "costUsd", 12, 1);
    expect(foldNote(folded)).toBe("列 6 件 (c2 / c3 / c4 / c5 ほか 2 件)を「下位まとめ」にまとめました");
  });
});

describe("CrossTable", () => {
  const source = report(
    ["alpha", "beta"],
    ["opus", "haiku"],
    (row, col) => group(col, { sessions: 1, costUsd: row === "alpha" && col === "opus" ? 2 : 1 }),
  );

  it("shows an em dash for session totals and explains why", () => {
    const html = renderToStaticMarkup(
      <CrossTable
        report={source}
        metric="sessions"
        rowBy="project"
        colBy="model"
        loading={false}
        error={null}
        selection={null}
        onRetry={() => {}}
        onRowBy={() => {}}
        onColBy={() => {}}
        onSelect={() => {}}
      />,
    );
    expect(html).toContain("—");
    expect(html).toContain("1セッションが複数モデルに跨るため合計できません");
    expect(html).not.toMatch(/>合計<\/th>[\s\S]*?>3</);
  });

  it("paints cells with a theme token mix instead of a raw hex", () => {
    const html = renderToStaticMarkup(
      <CrossTable
        report={source}
        metric="costUsd"
        rowBy="project"
        colBy="model"
        loading={false}
        error={null}
        selection={null}
        onRetry={() => {}}
        onRowBy={() => {}}
        onColBy={() => {}}
        onSelect={() => {}}
      />,
    );
    expect(html).toContain("color-mix(in srgb, var(--cmux-accent)");
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    expect(html).toContain("¥300");
  });
});

describe("axis catalog", () => {
  it("keeps SERIES_AXES a subset of PIVOT_AXES", () => {
    const pivot = new Set(PIVOT_AXES.map((axis) => axis.value));
    for (const axis of SERIES_AXES) {
      expect(pivot.has(axis.value)).toBe(true);
    }
  });

  it("falls back to project from model_raw and the other way", () => {
    expect(firstOtherAxis("project")).toBe("model_raw");
    expect(firstOtherAxis("model_raw")).toBe("project");
  });
});

describe("selectionFromPivotCell", () => {
  it("returns both project and model from a project × model_raw cell", () => {
    expect(selectionFromPivotCell("project", "model_raw", "案件A", "gpt-5.6-sol")).toEqual({
      project: { key: "案件A", label: "案件A" },
      model: { key: "gpt-5.6-sol", label: "gpt-5.6-sol" },
    });
  });

  it("returns null when either axis is 下位まとめ", () => {
    expect(selectionFromPivotCell("project", "model_raw", OTHER_KEY, "gpt-5.6-sol")).toBeNull();
    expect(selectionFromPivotCell("project", "model_raw", "案件A", OTHER_KEY)).toBeNull();
  });
});
