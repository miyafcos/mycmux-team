import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ModelTable } from "../../src/components/ailog/ModelTable";
import type { ModelsReport } from "../../src/lib/ailog";

const row = (model: string, modelClass: "unknown" | "local" | "flat") => ({
  model, family: model, sessions: 1, turns: 1, userMessages: 1, costUsd: 12, ingestCostUsd: 6, generateCostUsd: 6, sharePct: 100,
  input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, cacheHitRate: 0, outputDensity: 1, durationMs: 1,
  avgTurnMs: 1, avgRework: 0, toolErrorRate: 0, abandonedRate: 0, firstUsedAt: 0, lastUsedAt: 0, byEffort: [], modelClass,
});
const report = {
  range: { from: 0, to: 1, label: "all" }, granularity: "raw", rows: [row("gpt-5.5", "unknown"), row("ollama/llama3", "local"), row("fugu-ultra", "flat")], series: [], mixedSessions: 0, handoffs: [], byWorkTag: [], overlapping: false, totalSessions: 3, priceSource: "default",
  priceCoverage: { priced: { models: [], tokens: 0 }, local: { models: ["ollama/llama3"], tokens: 1 }, internal: { models: [], tokens: 0 }, flat: { models: ["fugu-ultra"], tokens: 1 }, unknown: { models: ["gpt-5.5"], tokens: 1 }, coveredTokenRatio: 2 / 3 }, costNote: "",
} satisfies ModelsReport;

describe("ModelTable price classes", () => {
  it("renders unknown, local, and flat cost cells without warning chips", () => {
    const html = renderToStaticMarkup(<ModelTable report={report} excludeSynthetic={false} selection={null} onSelect={() => {}} />);
    expect(html).toContain('title="単価未公表のため除外"');
    expect(html).toContain('title="ローカル実行 — 費用なし"');
    expect(html).toContain('title="定額プラン — 従量費用なし"');
    expect(html).not.toContain("単価未設定");
  });
});
