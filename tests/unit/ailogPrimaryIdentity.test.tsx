// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/hooks/useElementWidth", () => ({ useElementWidth: () => ({ ref: () => {}, width: 760 }) }));
vi.mock("../../src/components/ailog/AilogOrientation", () => ({ AilogOrientation: () => null }));
vi.mock("../../src/components/ailog/SummaryCards", () => ({ SummaryCards: () => null }));
vi.mock("../../src/components/ailog/UsageTotals", () => ({ UsageTotals: () => null }));
vi.mock("../../src/components/ailog/UsageModelTable", () => ({ UsageModelTable: () => null }));
vi.mock("../../src/components/ailog/CrossTable", () => ({ CrossTable: () => null }));
vi.mock("../../src/components/ailog/ProjectTable", () => ({ ProjectTable: () => null }));
vi.mock("../../src/components/ailog/SessionTable", () => ({ SessionTable: () => null }));
vi.mock("../../src/components/ailog/ReworkRankings", () => ({ ReworkRankings: () => null }));
vi.mock("../../src/components/ailog/HandoffTable", () => ({ HandoffTable: () => null, HANDOFF_SECTION_SUMMARY: "handoffs" }));
vi.mock("../../src/components/ailog/UsageRhythmDetails", () => ({ UsageRhythmDetails: () => null }));

import type { SeriesReport } from "../../src/lib/ailog";
import { formatMoney } from "../../src/lib/ailog";
import { __resetAilogStoreForTests, useAilogStore } from "../../src/stores/ailogStore";
import { UsageView } from "../../src/components/ailog/UsageView";
import { UsageBucketChart } from "../../src/components/ailog/UsageBucketChart";
import { buildUsageModel } from "../../src/components/ailog/usageModel";

const group = { group: "raw-a", turns: 1, sessions: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 1 };
const series: SeriesReport = { range: { from: 100, to: 199, label: "30d" }, groupBy: "model_raw", bucket: "day", groups: [group], buckets: [{ bucket: 100, turns: 1, sessions: 1, costUsd: 1, groups: [group] }] };
const noop = () => {};
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  __resetAilogStoreForTests();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); __resetAilogStoreForTests(); });

describe("stable primary report rendering", () => {
  it("updates actual SVG currency labels while the USD report reference stays unchanged", () => {
    const props: ComponentProps<typeof UsageView> = {
      overview: { range: series.range, totals: {} } as ComponentProps<typeof UsageView>["overview"],
      previousTotalsStatus: "idle", models: null, sessions: null, series, rhythm: null,
      loading: false, usageLoading: false, usageError: null, error: null, statusPending: false, neverIndexed: false, noData: false, running: false,
      preset: "30d", metric: "costUsd", stack: "absolute", bucket: "day", seriesAxis: "model_raw", excludeSynthetic: false,
      selection: null, breakdownDimension: "project", breakdown: null, breakdownError: null, breakdownLoading: false,
      sessionSort: "cost", sessionPage: 0, sessionQuery: "", sessionAppliedQuery: "", sessionAppliedSort: "cost", sessionAppliedPage: 0, sessionLoading: false, sessionError: null,
      pivot: null, pivotRowBy: "model_raw", pivotColBy: "project", pivotLoading: false, pivotError: null, detailKey: null,
      onRefresh: noop, onRetryUsage: noop, onStartIndex: noop, onMetric: noop, onStack: noop, onBucket: noop, onSeriesAxis: noop, onPickDay: noop, onSelect: noop,
      onBreakdownDimension: noop, onRefreshBreakdown: noop, onPivotRowBy: noop, onPivotColBy: noop, onRetryPivot: noop, onSessionSort: noop, onSessionPage: noop, onSessionQuery: noop, onRetrySessions: noop, onOpenDetail: noop,
    };
    useAilogStore.setState({ usageSeries: series });
    act(() => root.render(<UsageView {...props} />));
    const before = container.querySelector("svg title")!.textContent;
    const oldRate = useAilogStore.getState().usdJpyRate;
    act(() => useAilogStore.getState().setUsdJpyRate(oldRate + 10));
    expect(useAilogStore.getState().usageSeries).toBe(series);
    expect(container.querySelector("svg title")!.textContent).not.toBe(before);
    expect(container.querySelector("svg title")!.textContent).toContain(formatMoney(1));
  });

  it("clears a selected bar when range or classification changes with identical bucket bounds", () => {
    const props = { model: buildUsageModel(series.buckets, "costUsd", undefined, "day", "model_raw"), metric: "costUsd" as const, mode: "absolute" as const, highlight: null, onHighlight: noop, onPickDay: noop, groupBy: "model_raw" as const, bucket: "day" as const };
    act(() => root.render(<UsageBucketChart {...props} contextKey="100:199:model_raw" />));
    const button = () => container.querySelector("svg button") as HTMLButtonElement;
    act(() => button().click());
    expect(button().getAttribute("aria-pressed")).toBe("true");
    act(() => root.render(<UsageBucketChart {...props} contextKey="100:199:model_raw" mode="share" />));
    expect(button().getAttribute("aria-pressed")).toBe("true");
    act(() => root.render(<UsageBucketChart {...props} contextKey="100:199:provider" groupBy="provider" />));
    expect(button().getAttribute("aria-pressed")).toBe("false");
    act(() => button().click());
    act(() => root.render(<UsageBucketChart {...props} contextKey="90:199:model_raw" />));
    expect(button().getAttribute("aria-pressed")).toBe("false");
  });
});
