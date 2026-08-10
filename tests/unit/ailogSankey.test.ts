import { describe, expect, it } from "vitest";

import { layoutSankey, type SankeyLayoutOptions } from "../../src/components/ailog/sankeyLayout";
import {
  DOMINANT_SHARE_PCT,
  OTHER_KEY,
  buildSankeyGraph,
  rollupTopN,
  titlesWithinProject,
} from "../../src/components/ailog/sankeyModel";
import type { SessionRow, WorkTagRow } from "../../src/lib/ailog";

const OPTIONS: SankeyLayoutOptions = {
  height: 520,
  padTop: 40,
  padBottom: 20,
  gap: 10,
  nodeWidth: 20,
  columnX: [0, 200, 400],
  minNodeHeight: 3,
};

function session(over: Partial<SessionRow>): SessionRow {
  return {
    kind: "claude",
    sessionId: "s1",
    title: null,
    projectLabel: null,
    gitBranch: null,
    origin: null,
    primaryModel: null,
    modelCount: 1,
    isSidechain: false,
    workTags: [],
    startedAt: null,
    endedAt: null,
    wallMs: null,
    activeMs: null,
    turnCount: 0,
    userMsgCount: 0,
    compactCount: 0,
    costUsd: 0,
    reworkScore: 0,
    ...over,
  };
}

describe("sankey layout", () => {
  it("gives node heights in proportion to their values", () => {
    const layers = [
      [
        { key: "a", label: "a", value: 300 },
        { key: "b", label: "b", value: 100 },
      ],
      [{ key: "x", label: "x", value: 400 }],
    ];
    const flows = [
      [
        { source: "a", target: "x", value: 300 },
        { source: "b", target: "x", value: 100 },
      ],
    ];
    const layout = layoutSankey(layers, flows, OPTIONS);
    const a = layout.nodes.find((node) => node.key === "a" && node.layer === 0)!;
    const b = layout.nodes.find((node) => node.key === "b" && node.layer === 0)!;
    const x = layout.nodes.find((node) => node.key === "x")!;

    // usable = 520 - 40 - 20 = 460; one gap of 10 leaves 450 to share 3:1.
    expect(a.height).toBeCloseTo(337.5, 5);
    expect(b.height).toBeCloseTo(112.5, 5);
    expect(a.height / b.height).toBeCloseTo(3, 10);
    // The single node of a column takes the whole span (no gaps to subtract).
    expect(x.height).toBeCloseTo(460, 5);
    expect(b.y).toBeCloseTo(a.y + a.height + OPTIONS.gap, 5);
  });

  it("splits a ribbon in proportion to each endpoint's own total", () => {
    const layers = [
      [{ key: "a", label: "a", value: 400 }],
      [
        { key: "x", label: "x", value: 300 },
        { key: "y", label: "y", value: 100 },
      ],
    ];
    const flows = [
      [
        { source: "a", target: "x", value: 300 },
        { source: "a", target: "y", value: 100 },
      ],
    ];
    const layout = layoutSankey(layers, flows, OPTIONS);
    const a = layout.nodes.find((node) => node.key === "a")!;
    const toX = layout.flows.find((flow) => flow.target === "x")!;
    const toY = layout.flows.find((flow) => flow.target === "y")!;

    expect(toX.h0 + toY.h0).toBeCloseTo(a.height, 5);
    expect(toX.h0 / toY.h0).toBeCloseTo(3, 10);
    // Right-hand side fills its own node exactly.
    const x = layout.nodes.find((node) => node.key === "x" && node.layer === 1)!;
    expect(toX.h1).toBeCloseTo(x.height, 5);
    // Ribbons leave the source stacked, never overlapping.
    expect(toY.y0).toBeCloseTo(toX.y0 + toX.h0, 5);
  });

  it("keeps the two bands independent when the middle column's sums disagree", () => {
    const layers = [
      [{ key: "m", label: "m", value: 100 }],
      [{ key: "t", label: "t", value: 180 }],
      [{ key: "p", label: "p", value: 180 }],
    ];
    const flows = [
      [{ source: "m", target: "t", value: 100 }],
      [{ source: "t", target: "p", value: 180 }],
    ];
    const layout = layoutSankey(layers, flows, OPTIONS);
    const t = layout.nodes.find((node) => node.key === "t")!;
    const inbound = layout.flows.find((flow) => flow.layer === 0)!;
    const outbound = layout.flows.find((flow) => flow.layer === 1)!;
    expect(inbound.h1).toBeCloseTo(t.height, 5);
    expect(outbound.h0).toBeCloseTo(t.height, 5);
  });

  it("produces no NaN when every value is zero", () => {
    const layers = [
      [
        { key: "a", label: "a", value: 0 },
        { key: "b", label: "b", value: 0 },
      ],
      [{ key: "x", label: "x", value: 0 }],
    ];
    const flows = [[{ source: "a", target: "x", value: 0 }]];
    const layout = layoutSankey(layers, flows, OPTIONS);
    for (const node of layout.nodes) {
      expect(Number.isFinite(node.height)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
      expect(node.height).toBeGreaterThanOrEqual(OPTIONS.minNodeHeight);
    }
    expect(layout.flows).toHaveLength(0);
  });

  it("survives non-finite values without emitting NaN into the path", () => {
    const layout = layoutSankey(
      [[{ key: "a", label: "a", value: Number.NaN }], [{ key: "x", label: "x", value: 10 }]],
      [[{ source: "a", target: "x", value: 10 }]],
      OPTIONS,
    );
    for (const flow of layout.flows) {
      expect(flow.path).not.toContain("NaN");
    }
    for (const node of layout.nodes) {
      expect(Number.isFinite(node.height)).toBe(true);
    }
  });
});

describe("top-N rollup", () => {
  const rows = [
    { key: "a", label: "a", value: 100 },
    { key: "b", label: "b", value: 90 },
    { key: "c", label: "c", value: 8 },
    { key: "d", label: "d", value: 2 },
    { key: "e", label: "e", value: 1 },
  ];

  it("folds the tail into one bucket that reports its count and amount", () => {
    const result = rollupTopN(rows, 2);
    expect(result.entries.map((entry) => entry.key)).toEqual(["a", "b", OTHER_KEY]);
    expect(result.otherCount).toBe(3);
    expect(result.otherValue).toBe(11);
    expect(result.otherKeys).toEqual(["c", "d", "e"]);
    const other = result.entries.at(-1)!;
    expect(other.label).toBe("その他 (3件)");
    expect(other.value).toBe(11);
    // Nothing is lost: kept + folded equals the original total.
    const total = result.entries.reduce((sum, entry) => sum + entry.value, 0);
    expect(total).toBe(rows.reduce((sum, row) => sum + row.value, 0));
  });

  it("keeps every row when the limit is at or above the row count", () => {
    expect(rollupTopN(rows, 5).otherCount).toBe(0);
    expect(rollupTopN(rows, 99).entries).toHaveLength(5);
    expect(rollupTopN(rows, Number.POSITIVE_INFINITY).entries).toHaveLength(5);
  });

  it("sorts by value before folding", () => {
    const shuffled = [...rows].reverse();
    expect(rollupTopN(shuffled, 2).entries.map((entry) => entry.key)).toEqual(["a", "b", OTHER_KEY]);
  });
});

describe("sankey graph assembly", () => {
  const byWorkTag: WorkTagRow[] = [
    {
      workTag: "implement",
      perModel: [
        { model: "opus-5", sessions: 2, turns: 10, costUsd: 60, ingestCost: 40, generateCost: 20, avgRework: 0.1 },
        { model: "<synthetic>", sessions: 1, turns: 1, costUsd: 5, ingestCost: 5, generateCost: 0, avgRework: 0 },
      ],
    },
    {
      workTag: "verify",
      perModel: [
        { model: "fable-5", sessions: 1, turns: 4, costUsd: 40, ingestCost: 30, generateCost: 10, avgRework: 0.2 },
      ],
    },
  ];

  const sessions: SessionRow[] = [
    session({ sessionId: "s1", projectLabel: "proj-a", title: "実装A", workTags: ["implement"], costUsd: 60 }),
    session({ sessionId: "s2", projectLabel: "proj-b", title: "検証B", workTags: ["verify", "implement"], costUsd: 40 }),
    session({ sessionId: "s3", projectLabel: "proj-c", title: "無タグ", workTags: [], costUsd: 7 }),
  ];

  it("excludes the synthetic model by default and reports what it hid", () => {
    const graph = buildSankeyGraph({
      byWorkTag,
      sessions,
      totalSessions: sessions.length,
      leafDimension: "project",
      excludeSynthetic: true,
      grandTotal: 105,
      topN: { model: 8, tag: 8, leaf: 8 },
    });
    expect(graph.models.map((node) => node.key)).toEqual(["opus-5", "fable-5"]);
    expect(graph.notes.syntheticCost).toBe(5);
    expect(graph.notes.syntheticExcluded).toBe(true);
    expect(graph.notes.modelBandTotal).toBe(100);
  });

  it("includes the synthetic model once the checkbox is cleared", () => {
    const graph = buildSankeyGraph({
      byWorkTag,
      sessions,
      totalSessions: sessions.length,
      leafDimension: "project",
      excludeSynthetic: false,
      grandTotal: 105,
      topN: { model: 8, tag: 8, leaf: 8 },
    });
    expect(graph.models.map((node) => node.key)).toContain("<synthetic>");
    expect(graph.notes.modelBandTotal).toBe(105);
  });

  it("double counts a multi-tag session instead of pro-rating it", () => {
    const graph = buildSankeyGraph({
      byWorkTag,
      sessions,
      totalSessions: sessions.length,
      leafDimension: "project",
      excludeSynthetic: true,
      grandTotal: 107,
      topN: { model: 8, tag: 8, leaf: 8 },
    });
    // s2 costs 40 and carries two tags, so the leaf band sums to 60 + 40 + 40.
    expect(graph.notes.leafBandTotal).toBe(140);
    const projB = graph.leaves.find((node) => node.key === "proj-b")!;
    expect(projB.value).toBe(80);
    expect(graph.notes.untaggedSessions).toBe(1);
    expect(graph.notes.untaggedCost).toBe(7);
    expect(graph.notes.bandMismatchPct).toBeGreaterThan(0);
  });

  it("names the work tag nodes in Japanese", () => {
    const graph = buildSankeyGraph({
      byWorkTag,
      sessions,
      totalSessions: sessions.length,
      leafDimension: "project",
      excludeSynthetic: true,
      grandTotal: 107,
      topN: { model: 8, tag: 8, leaf: 8 },
    });
    expect(graph.tags.map((node) => node.label).sort()).toEqual(["実装", "検証実行"].sort());
    expect(graph.tags.map((node) => node.label)).not.toContain("implement");
  });

  it("rewires flows into the その他 bucket when a layer is capped", () => {
    const graph = buildSankeyGraph({
      byWorkTag,
      sessions,
      totalSessions: sessions.length,
      leafDimension: "project",
      excludeSynthetic: true,
      grandTotal: 107,
      topN: { model: 1, tag: 8, leaf: 1 },
    });
    expect(graph.models.map((node) => node.key)).toEqual(["opus-5", OTHER_KEY]);
    expect(graph.notes.modelOther).toEqual({ count: 1, value: 40 });
    expect(graph.modelToTag.every((flow) => graph.models.some((node) => node.key === flow.source))).toBe(true);
    expect(graph.tagToLeaf.every((flow) => graph.leaves.some((node) => node.key === flow.target))).toBe(true);
    const bandTotal = graph.modelToTag.reduce((sum, flow) => sum + flow.value, 0);
    expect(bandTotal).toBe(graph.notes.modelBandTotal);
  });

  it("flags a leaf node that swallows 40% or more of the band", () => {
    const graph = buildSankeyGraph({
      byWorkTag,
      sessions,
      totalSessions: sessions.length,
      leafDimension: "project",
      excludeSynthetic: true,
      grandTotal: 107,
      topN: { model: 8, tag: 8, leaf: 8 },
    });
    expect(graph.notes.dominantLeaf?.key).toBe("proj-b");
    expect(graph.notes.dominantLeaf!.sharePct).toBeGreaterThanOrEqual(DOMINANT_SHARE_PCT);
  });

  it("reports how many sessions the fetch cap left out", () => {
    const graph = buildSankeyGraph({
      byWorkTag,
      sessions,
      totalSessions: 5_200,
      leafDimension: "project",
      excludeSynthetic: true,
      grandTotal: 107,
      topN: { model: 8, tag: 8, leaf: 8 },
    });
    expect(graph.notes.truncatedSessions).toBe(5_197);
    expect(graph.notes.fetchedSessions).toBe(3);
  });

  it("can group the third layer by title instead of project", () => {
    const graph = buildSankeyGraph({
      byWorkTag,
      sessions,
      totalSessions: sessions.length,
      leafDimension: "title",
      excludeSynthetic: true,
      grandTotal: 107,
      topN: { model: 8, tag: 8, leaf: 8 },
    });
    expect(graph.leaves.map((node) => node.key).sort()).toEqual(["実装A", "検証B"].sort());
  });

  it("breaks one project down by title for the drill-down table", () => {
    const rows = titlesWithinProject(
      [
        session({ sessionId: "a", projectLabel: "Users/miyaz", title: "作問", costUsd: 30 }),
        session({ sessionId: "b", projectLabel: "Users/miyaz", title: "作問", costUsd: 10 }),
        session({ sessionId: "c", projectLabel: "Users/miyaz", title: "組版", costUsd: 10 }),
        session({ sessionId: "d", projectLabel: "other", title: "無関係", costUsd: 99 }),
      ],
      "Users/miyaz",
    );
    expect(rows).toEqual([
      { key: "作問", sessions: 2, costUsd: 40, sharePct: 80 },
      { key: "組版", sessions: 1, costUsd: 10, sharePct: 20 },
    ]);
  });

  it("returns an empty graph rather than throwing when there is no data", () => {
    const graph = buildSankeyGraph({
      byWorkTag: [],
      sessions: [],
      totalSessions: 0,
      leafDimension: "project",
      excludeSynthetic: true,
      grandTotal: 0,
      topN: { model: 8, tag: 8, leaf: 8 },
    });
    expect(graph.models).toHaveLength(0);
    expect(graph.tags).toHaveLength(0);
    expect(graph.leaves).toHaveLength(0);
    expect(graph.notes.bandMismatchPct).toBe(0);
    expect(graph.notes.dominantLeaf).toBeNull();
  });
});
