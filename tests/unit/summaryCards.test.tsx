import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SummaryCards } from "../../src/components/ailog/SummaryCards";
import type { Overview } from "../../src/lib/ailog";

const overview = {
  range: { from: 0, to: 1, label: "all" },
  totals: { sessions: 1, turns: 1, userMessages: 1, input: 100, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 1, wallMs: 1, activeMs: 1, projects: 1, models: 1 },
  comparePrevious: { sessionsPct: 0, costPct: 0, tokensPct: 0, reworkPct: 0 },
  topModels: [], mixedModelSessions: 0, topProjects: [], topTitles: [],
  rework: { avgScore: 0, toolErrorRate: 0, correctionHits: 0, churnFiles: 0, abandonedSessions: 0 },
  excludedInternal: { sessions: 0, costUsd: 0 }, cacheHitRate: 0, priceSource: "default",
  priceCoverage: { priced: { models: ["gpt-5.6-terra"], tokens: 75 }, local: { models: [], tokens: 0 }, internal: { models: [], tokens: 0 }, flat: { models: [], tokens: 0 }, unknown: { models: ["gpt-5.5"], tokens: 25 }, coveredTokenRatio: 0.75 },
  indexFreshness: { lastIndexedAt: 0, staleFiles: 0 }, costNote: "",
} satisfies Overview;

describe("SummaryCards price coverage", () => {
  it("qualifies the cost label below 100%", () => {
    expect(renderToStaticMarkup(<SummaryCards overview={overview} preset="week" />)).toContain("コスト相当 (単価既知の 75% 分)");
  });

  it("omits the qualifier at 100%", () => {
    const html = renderToStaticMarkup(<SummaryCards overview={{ ...overview, priceCoverage: { ...overview.priceCoverage, unknown: { models: [], tokens: 0 }, coveredTokenRatio: 1 } }} preset="week" />);
    expect(html).toContain("コスト相当");
    expect(html).not.toContain("単価既知の");
  });
});
