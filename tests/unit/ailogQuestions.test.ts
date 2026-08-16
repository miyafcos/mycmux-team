import { describe, expect, it } from "vitest";
import { buildQuestionCards } from "../../src/components/ailog/questionModel";
import type { EfficiencyReport, EfficiencyRow, QuantileRow } from "../../src/lib/ailog";

const row = (key: string, sessions = 8, avgRework = 10, avgSessionCost = 10, abandonedRate = 0.1): EfficiencyRow => ({ key, sessions, turns: sessions * 4, avgSessionCost, avgRework, cacheHitRate: 0, outputDensity: 0, abandonedRate });
const quantile = (quantileName: string, sessions = 8, avgRework = 10, avgCost = 10): QuantileRow => ({ quantile: quantileName, minTurns: 1, maxTurns: 10, sessions, avgCost, avgRework });

function report(overrides: Partial<EfficiencyReport> = {}): EfficiencyReport {
  return {
    range: { from: 0, to: 1, label: "test" },
    byModel: [row("gpt", 8, 8), row("other", 8, 10)],
    byEffort: [row("low"), row("high", 8, 8, 11)],
    bySubagent: [row("main"), row("subagent", 8, 8, 8)],
    byCompaction: [row("not-compacted"), row("compacted", 8, 12, 12, 0.12)],
    turnQuantiles: [quantile("Q1"), quantile("Q4", 8, 12, 12)],
    priceSource: "test", priceCoverage: { coveredSessions: 0, totalSessions: 0, coveredTokenRatio: 0 }, interpretationNote: "", costNote: "", ...overrides,
  };
}

describe("buildQuestionCards", () => {
  it("makes all five decisions from the pure report model", () => {
    const cards = buildQuestionCards(report());
    expect(cards.map((card) => card.id)).toEqual(["subagent", "effort", "length", "compaction", "model"]);
    expect(cards.map((card) => card.answer)).toEqual(["得している", "得している", "損している", "損している", "得している"]);
    expect(cards.find((card) => card.id === "model")?.modelKey).toBe("gpt");
  });

  it("treats the 15 percent boundary as a decision and a smaller delta as no difference", () => {
    expect(buildQuestionCards(report({ bySubagent: [row("main"), row("subagent", 8, 8.5, 8.5)] }))[0].answer).toBe("得している");
    expect(buildQuestionCards(report({ bySubagent: [row("main"), row("subagent", 8, 8.501, 8.501)] }))[0].answer).toBe("差がない");
  });

  it("requires eight sessions on both sides and states the missing count", () => {
    const card = buildQuestionCards(report({ bySubagent: [row("main", 7), row("subagent", 8, 8, 8)] }))[0];
    expect(card.answer).toBe("まだ判断できない");
    expect(card.evidence).toContain("あと 1 セッション必要 (今 7 / 8)");
  });
});
