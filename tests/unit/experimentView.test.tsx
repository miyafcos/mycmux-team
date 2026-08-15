import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { EfficiencyReport, RuleCheckReport } from "../../src/lib/ailog";
import { ExperimentView } from "../../src/components/ailog/ExperimentView";

const row = { key: "high", sessions: 2, turns: 10, avgSessionCost: 1, avgRework: 0.2, cacheHitRate: 0.5, outputDensity: 20, abandonedRate: 0 };
const report: EfficiencyReport = {
  range: { from: 0, to: 1, label: "all" }, byModel: [], byEffort: [row, { ...row, key: "low" }], bySubagent: [row, { ...row, key: "main" }], byCompaction: [row, { ...row, key: "none" }],
  turnQuantiles: [ { quantile: "Q1", minTurns: 1, maxTurns: 2, sessions: 2, avgCost: 1, avgRework: 0.1 }, { quantile: "Q2", minTurns: 3, maxTurns: 4, sessions: 2, avgCost: 2, avgRework: 0.2 } ], priceSource: "default", priceCoverage: { priced: { models: [], tokens: 0 }, local: { models: [], tokens: 0 }, internal: { models: [], tokens: 0 }, flat: { models: [], tokens: 0 }, unknown: { models: [], tokens: 0 }, coveredTokenRatio: 1 }, interpretationNote: "note", costNote: "cost",
};
const rules: RuleCheckReport = { range: report.range, largeContext: { count: 0, sessions: [] }, compacted: { count: 0, sessions: [] } };

describe("ExperimentView", () => {
  it("renders the target-named sections and API interpretation note when comparisons exist", () => {
    const html = renderToStaticMarkup(<ExperimentView report={report} rules={rules} loading={false} error={null} onOpenDetail={() => {}} />);
    expect(html).toContain(">effort</h2>");
    expect(html).toContain(">サブエージェント</h2>");
    expect(html).toContain(">compact</h2>");
    expect(html).toContain(">セッションの長さ</h2>");
    expect(html).toContain("note");
    expect(html).toContain("Q1");
  });

  it("shows the exact data-insufficient text for a one-row comparison", () => {
    const html = renderToStaticMarkup(<ExperimentView report={{ ...report, byEffort: [row] }} rules={rules} loading={false} error={null} onOpenDetail={() => {}} />);
    expect(html).toContain("データ不足 (比較対象が揃っていません)");
  });

});
