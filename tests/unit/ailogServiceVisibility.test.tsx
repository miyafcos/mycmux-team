// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Overview, SeriesReport, SessionsReport } from "../../src/lib/ailog";
vi.mock("../../src/components/ailog/AilogOrientation", () => ({ AilogOrientation: () => null }));
vi.mock("../../src/components/ailog/SummaryCards", () => ({ SummaryCards: () => null }));
vi.mock("../../src/components/ailog/UsageTotals", () => ({ UsageTotals: ({ totals }: { totals: { sessions: number } }) => <span data-test-total>{totals.sessions}</span> }));
vi.mock("../../src/components/ailog/UsageModelTable", () => ({ UsageModelTable: ({ report }: { report: SeriesReport }) => <div data-test-models>{report.buckets.flatMap(bucket => bucket.groups.map(group => group.group + ":" + group.sessions)).join(",")}</div> }));
vi.mock("../../src/components/ailog/SessionTable", () => ({ SessionTable: ({ report }: { report: SessionsReport }) => <div data-test-sessions>{report.rows.map(row => row.sessionId).join(",")}</div> }));
import { EmptyState } from "../../src/components/ailog/ui";
import { UsageView } from "../../src/components/ailog/UsageView";
import { ailogServiceNames } from "../../src/lib/agentServiceVisibility";
import { agentServiceVisibilityStrings as T } from "../../src/lib/agentServiceVisibilityStrings";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useAgentServiceDetectionStore } from "../../src/stores/agentServiceDetectionStore";
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  useSettingsStore.setState({ agentServiceVisibility: {} });
  useAgentServiceDetectionStore.setState({ detection: { status: "idle" } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
describe("AI-log presentation without record filtering (T10)", () => {
  it("builds empty copy from visible historical names, including the all-hidden fallback", async () => {
    await act(async () => root.render(<EmptyState kind="not-indexed" />));
    expect(host.textContent).toContain(T.ailogEmptyBody(["Claude", "Codex", "Grok"]));
    await act(async () => useSettingsStore.getState().setAgentServiceVisible("codex", false));
    expect(host.textContent).toContain(T.ailogEmptyBody(["Claude", "Grok"]));
    expect(host.textContent).not.toContain("Codex");
    await act(async () => { useSettingsStore.getState().setAgentServiceVisible("claude", false); useSettingsStore.getState().setAgentServiceVisible("grok", false); });
    expect(host.textContent).toContain(T.ailogEmptyBody([]));
    expect(ailogServiceNames(target => target === "claude-codex")).toEqual([]);
  });
  it("updates the actual CLI tooltip while passing every count and session through unchanged", async () => {
    const range = { from: 100, to: 200, label: "sample" };
    const series: SeriesReport = { range, bucket: "day", groupBy: "kind", buckets: [{ bucket: 100, sessions: 9, turns: 9, costUsd: 0, groups: ["claude", "codex", "grok"].map(group => ({ group, sessions: 3, turns: 3, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 })) }], priceSource: "", priceCoverage: {} as SeriesReport["priceCoverage"], costNote: "" };
    const overview = { range, totals: { sessions: 9 } } as Overview;
    const sessions = { range, rows: [{ sessionId: "claude-record" }, { sessionId: "codex-record" }, { sessionId: "grok-record" }] } as SessionsReport;
    const fn = vi.fn();
    const props: ComponentProps<typeof UsageView> = {
      overview, series, sessions, previousTotalsStatus: "ready", models: null, modelsLoading: false, modelsError: null, onRetryModels: fn, rhythm: null, loading: false, usageLoading: false, usageError: null, error: null, statusPending: false, neverIndexed: false, noData: false, running: false,
      preset: "all", metric: "sessions", stack: "absolute", bucket: "day", seriesAxis: "kind", excludeSynthetic: false,
      selection: null, breakdownDimension: "project", breakdown: null, breakdownError: null, breakdownLoading: false, sessionSort: "recent", sessionPage: 0,
      sessionQuery: "", sessionAppliedQuery: "", sessionAppliedSort: "recent", sessionAppliedPage: 0, sessionLoading: false, sessionError: null,
      pivot: null, pivotRowBy: "kind", pivotColBy: "model", pivotLoading: false, pivotError: null, detailKey: null,
      onRefresh: fn, onRetryUsage: fn, onStartIndex: fn, onMetric: fn, onStack: fn, onBucket: fn, onSeriesAxis: fn, onPickDay: fn, onSelect: fn, onBreakdownDimension: fn, onRefreshBreakdown: fn,
      onPivotRowBy: fn, onPivotColBy: fn, onRetryPivot: fn, onSessionSort: fn, onSessionPage: fn, onSessionQuery: fn, onRetrySessions: fn, onOpenDetail: fn,
    };
    await act(async () => root.render(<UsageView {...props} />));
    expect(host.querySelectorAll('button[title="Claude Code / Codex / Grok"]')).toHaveLength(3);
    const records = host.querySelector("[data-test-models]")!.textContent;
    const sessionIds = host.querySelector("[data-test-sessions]")!.textContent;
    await act(async () => useSettingsStore.getState().setAgentServiceVisible("codex", false));
    expect(host.querySelectorAll('button[title="Claude Code / Grok"]')).toHaveLength(3);
    expect(host.querySelectorAll('button[title="Claude Code / Codex / Grok"]')).toHaveLength(0);
    expect(host.querySelector("[data-test-total]")!.textContent).toBe("9");
    expect(host.querySelector("[data-test-models]")!.textContent).toBe(records);
    expect(host.querySelector("[data-test-sessions]")!.textContent).toBe(sessionIds);
    expect(sessionIds).toContain("codex-record");
  });
});
