import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LearningView } from "../../src/components/ailog/LearningView";
import type { FindingsReport, ReworkRankingsReport } from "../../src/lib/ailog";

const findings: FindingsReport = {
  total: 1,
  rows: [{ text: "同じ確認を先に行う", kind: "gotcha", sessionId: "s1", sessionKind: "claude", date: 1_700_000_000_000, goalSummary: null, projectLabel: "alpha", costUsd: 0, repeatCount: 2 }],
};
const rankings: ReworkRankingsReport = {
  failedCommands: [{ name: "Bash", target: "cargo test", executions: 3, failures: 2, failureRate: 2 / 3 }],
  rewrittenFiles: [{ path: "src/app.ts", editCount: 5, sessionCount: 2 }],
};

function render(overrides: Partial<ComponentProps<typeof LearningView>> = {}) {
  return renderToStaticMarkup(<LearningView findings={findings} rankings={rankings} kind={null} query="" loading={false} error={null} onKindChange={() => {}} onQueryChange={() => {}} onLoadMore={() => {}} onOpenDetail={() => {}} {...overrides} />);
}

describe("LearningView", () => {
  it("renders the feed and both rankings", () => {
    const html = render();
    expect(html).toContain("同じ確認を先に行う");
    expect(html).toContain("失敗コマンド上位");
    expect(html).toContain("書き直しファイル上位");
    expect(html).toContain("src/app.ts");
  });

  it("renders the defined empty copy", () => {
    expect(render({ findings: { rows: [], total: 0 } })).toContain("該当する学びはまだありません (要約が進むと増えます)");
  });

  it("renders a repeat badge", () => {
    expect(render()).toContain("同じ罠 2 回目");
  });

  it("marks the selected kind filter", () => {
    expect(render({ kind: "gotcha" })).toContain('aria-pressed="true"');
    expect(render({ kind: "gotcha" })).toContain("ハマり");
  });
});
