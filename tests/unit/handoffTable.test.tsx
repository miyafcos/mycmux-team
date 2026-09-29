import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { HANDOFF_SECTION_SUMMARY, HandoffPanelBody, HandoffTables } from "../../src/components/ailog/HandoffTable";

describe("handoff table presentation", () => {
  it("renders from/to/count rows", () => {
    const html = renderToStaticMarkup(
      <HandoffTables
        report={{
          range: { from: 0, to: 1, label: "test" },
          granularity: "raw",
          handoffs: [
            { from: "gpt-5.6-terra", to: "gpt-5.6-sol", count: 2 },
            { from: "gpt-5.6-sol", to: "gpt-5.6-terra", count: 1 },
          ],
        }}
      />,
    );
    expect(html).toContain("gpt-5.6-terra");
    expect(html).toContain("gpt-5.6-sol");
    expect(html).toContain("data-testid=\"ailog-handoff-row\"");
    expect(HANDOFF_SECTION_SUMMARY.length).toBeGreaterThan(0);
  });

  it("distinguishes loading, error, and idle in Japanese", () => {
    const loading = renderToStaticMarkup(
      <HandoffPanelBody report={null} loading error={null} onRetry={() => {}} />,
    );
    expect(loading).toContain("集計を読み込み中");

    const failed = renderToStaticMarkup(
      <HandoffPanelBody report={null} loading={false} error="boom" onRetry={() => {}} />,
    );
    expect(failed).toContain("読み込み失敗");
    expect(failed).toContain("boom");

    const idle = renderToStaticMarkup(
      <HandoffPanelBody report={null} loading={false} error={null} onRetry={() => {}} />,
    );
    expect(idle).toContain("この期間の記録をまだ読み込んでいません。");
    expect(idle).toContain("読み込む");
  });
});
