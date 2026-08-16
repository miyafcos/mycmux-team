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
  return renderToStaticMarkup(<LearningView findings={findings} rankings={rankings} rules={null} kind={null} query="" loading={false} error={null} onKindChange={() => {}} onQueryChange={() => {}} onLoadMore={() => {}} onOpenDetail={() => {}} onOpenRecord={() => {}} onCopyRule={() => {}} {...overrides} />);
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
    expect(render({ findings: { rows: [], total: 0 } })).toContain("この分類の記録はまだありません (要約が進むと増えます)");
  });

  it("keeps load more available when a raw page has no rows for this segment", () => {
    const html = render({ findings: { rows: [], total: 50 }, hasMore: true });
    expect(html).toContain("この分類の記録はまだありません");
    expect(html).toContain("さらに読み込む");
  });

  it("renders a repeat badge", () => {
    expect(render()).toContain("同じ罠 2 回目");
    expect(render()).toContain("要約");
    expect(render()).toContain("数えた");
  });

  it("offers a same-day record only for a dated recurring gotcha", () => {
    expect(render()).toContain("その日の記録へ");
    expect(render({ findings: { total: 1, rows: [{ ...findings.rows[0], repeatCount: 1 }] } })).not.toContain("その日の記録へ");
  });

  it("offers rule copy only in the trap section", () => {
    expect(render()).toContain("ルール文をコピー");
    expect(render({ findings: { total: 1, rows: [{ ...findings.rows[0], kind: "decision" }] } })).not.toContain("ルール文をコピー");
  });

  it("marks the selected kind filter", () => {
    expect(render({ kind: "gotcha" })).toContain('aria-pressed="true"');
    expect(render({ kind: "gotcha" })).toContain("ハマり");
  });
});
