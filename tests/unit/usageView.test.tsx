import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UsageView } from "../../src/components/ailog/UsageView";

describe("UsageView", () => {
  it("keeps the usage information architecture and defers supporting detail", () => {
    const html = renderToStaticMarkup(<UsageView overview={null} sessions={null} series={null} rhythm={null} loading={false} usageLoading={false} usageError={null} error={null} statusPending={false} neverIndexed={false} noData={false} running={false} preset="30d" metric="ioTokens" stack="absolute" bucket="day" seriesAxis="model" excludeSynthetic selection={null} breakdownDimension="project" breakdown={null} breakdownError={null} breakdownLoading={false} pivot={null} pivotRowBy="project" pivotColBy="model" pivotLoading={false} pivotError={null} sessionSort="rework" sessionPage={0} detailKey={null} onRefresh={() => {}} onRetryUsage={() => {}} onStartIndex={() => {}} onMetric={() => {}} onStack={() => {}} onBucket={() => {}} onSeriesAxis={() => {}} onPickDay={() => {}} onSelect={() => {}} onBreakdownDimension={() => {}} onRefreshBreakdown={() => {}} onPivotRowBy={() => {}} onPivotColBy={() => {}} onRetryPivot={() => {}} onSessionSort={() => {}} onSessionPage={() => {}} onOpenDetail={() => {}} />);
    expect(html).toContain("トータル");
    expect(html).toContain("クロス集計");
    expect(html).toContain("案件別");
    expect(html).toContain("セッション一覧");
    expect(html).toContain("詳細");
    expect(html).not.toContain("稼働リズム");
    expect(html).not.toContain("モデル表");
    expect(html).not.toContain("内訳の次元");
  });
});
