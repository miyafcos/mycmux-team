import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RecordView } from "../../src/components/ailog/RecordView";

describe("RecordView", () => {
  it("keeps the record information architecture and defers supporting detail", () => {
    const html = renderToStaticMarkup(<RecordView overview={null} sessions={null} series={null} rhythm={null} loading={false} usageLoading={false} usageError={null} error={null} statusPending={false} neverIndexed={false} noData={false} running={false} preset="30d" metric="ioTokens" stack="absolute" bucket="day" granularity="family" excludeSynthetic selection={null} breakdownDimension="project" breakdown={null} breakdownError={null} breakdownLoading={false} sessionSort="rework" sessionPage={0} detailKey={null} onRefresh={() => {}} onRetryUsage={() => {}} onStartIndex={() => {}} onMetric={() => {}} onStack={() => {}} onBucket={() => {}} onGranularity={() => {}} onPickDay={() => {}} onOpenDigest={() => {}} onSelect={() => {}} onBreakdownDimension={() => {}} onRefreshBreakdown={() => {}} onSessionSort={() => {}} onSessionPage={() => {}} onOpenDetail={() => {}} />);
    expect(html).toContain("トータル");
    expect(html).toContain("案件別");
    expect(html).toContain("セッション一覧");
    expect(html).toContain("稼働リズム");
    expect(html).toContain("モデル表");
    expect(html).toContain("内訳の次元");
  });
});
