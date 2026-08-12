import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps } from "react";
import { describe, expect, it } from "vitest";

import { DigestView } from "../../src/components/ailog/DigestView";
import type { DigestReport } from "../../src/lib/ailog";

const report: DigestReport = {
  date: "2026-08-12",
  digest: {
    date: "2026-08-12",
    createdAt: 1,
    promptVersion: 1,
    modelUsed: "gpt-5.6-luna",
    content: {
      headline: "実装を完遂した日",
      wins: ["goal を完遂した"],
      biggestRework: { exists: true, text: "goal の手戻りがあった" },
      valueNote: "コストに対して成果物を得た",
      suggestion: "明日は同じ確認を先に行う",
      confidence: "high",
    },
  },
  metrics: {
    sessions: 2,
    costUsd: 3.5,
    turns: 10,
    averageRework: 0.2,
    outcomes: { done: 1, partial: 1, abandoned: 0, unclear: 0 },
    previousSessions: 1,
    previousCostUsd: 2,
    previousTurns: 5,
    costPct: 75,
  },
};

function render(overrides: Partial<ComponentProps<typeof DigestView>> = {}) {
  return renderToStaticMarkup(
    <DigestView
      report={report}
      loading={false}
      generating={false}
      onPrevious={() => {}}
      onNext={() => {}}
      onRegenerate={() => {}}
      {...overrides}
    />,
  );
}

describe("DigestView", () => {
  it("shows saved digest content", () => {
    const html = render();
    expect(html).toContain("実装を完遂した日");
    expect(html).toContain("完遂 1");
    expect(html).toContain("最大の手戻り");
    expect(html).toContain("再生成");
  });

  it("shows the defined empty copy", () => {
    expect(render({ report: { ...report, digest: null } })).toContain("この日の要約はまだありません");
  });

  it("shows generation progress", () => {
    expect(render({ generating: true })).toContain("生成中…");
  });

  it("notes low confidence", () => {
    const low: DigestReport = { ...report, digest: { ...report.digest!, content: { ...report.digest!.content, confidence: "low" } } };
    expect(render({ report: low })).toContain("低確度 (素材が少ない日)");
  });
});
