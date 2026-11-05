// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", async original => ({ ...(await original<typeof import("@tauri-apps/api/core")>()), invoke }));
import { UsageView } from "../../src/components/ailog/UsageView";
import { TranscriptFeedback } from "../../src/components/ailog/TranscriptFeedback";
import { transcriptFailure } from "../../src/lib/ailogTranscript";
import { __resetAilogStoreForTests, useAilogStore, AILOG_RESOURCE_CACHE_LIMIT, AILOG_PERIOD_CACHE_LIMIT } from "../../src/stores/ailogStore";
import { overview, series, breakdown, pivot, models, sessions, handoffs, rework, rhythm, reports, viewProps } from "../helpers/ailogPlanAFixtures";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  __resetAilogStoreForTests();
  invoke.mockReset().mockImplementation((command: string) => Promise.resolve(reports[command] ?? {}));
  useAilogStore.setState({ preset: "custom", customFrom: "2026-10-01", customTo: "2026-10-03",
    overview, usageSeries: series(), breakdown, pivot, models, sessions, handoffs, reworkRankings: rework,
    usageRhythm: rhythm, loading: false, usageLoading: false });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); __resetAilogStoreForTests(); vi.unstubAllGlobals(); });
async function mount(extra = {}) { await act(async () => root.render(<UsageView {...viewProps(extra)} />)); }
function named(name: string) { return [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === name)!; }
async function click(name: string) { await act(async () => named(name).click()); }
function defer<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

describe("plan A navigation and retained reports", () => {
  it("keeps all main sections flat and makes every heading switch with zero IPC", async () => {
    await mount();
    invoke.mockClear();
    for (const name of ["比較", "セッション", "手戻り", "モデル切替", "活動時間", "内訳"]) {
      await click(name);
      expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(name);
      expect(host.querySelector("details")).toBeNull();
    }
    expect(invoke).not.toHaveBeenCalled();
    expect(host.querySelectorAll('[role="tab"]')).toHaveLength(6);
    const source = readFileSync(resolve(__dirname, "../../src/components/ailog/UsageView.tsx"), "utf8");
    expect(source).not.toMatch(/DeferredDetails|<details|UsageGrass/);
  });
  it("supports arrows, Home and End, and remembers the last heading in the AI log store", async () => {
    await mount();
    const key = async (name: string, code: string) => { await act(async () => named(name).dispatchEvent(new KeyboardEvent("keydown", { key: code, bubbles: true }))); };
    await key("内訳", "End"); expect(useAilogStore.getState().activeSection).toBe("activity");
    expect(document.activeElement?.textContent).toBe("活動時間");
    await key("活動時間", "ArrowRight"); expect(useAilogStore.getState().activeSection).toBe("breakdown");
    await key("内訳", "ArrowLeft"); expect(useAilogStore.getState().activeSection).toBe("activity");
    await key("活動時間", "Home"); expect(useAilogStore.getState().activeSection).toBe("breakdown");
    expect(invoke).not.toHaveBeenCalled();
  });
  it("renders stacked bars with selected-day details, filtering, keyboard movement and numeric rows", async () => {
    const pick = vi.fn(); await mount({ onPickDay: pick });
    expect(host.querySelector('[data-usage-daily] svg rect')).not.toBeNull();
    expect(host.querySelector("[data-usage-grass]")).toBeNull();
    const bar = host.querySelector<HTMLButtonElement>('[data-daily-index="0"]')!;
    await act(async () => bar.click());
    expect(host.textContent).toContain("の内訳");
    expect(named("この日に絞り込む").disabled).toBe(false);
    await click("この日に絞り込む"); expect(pick).toHaveBeenCalledOnce();
    await act(async () => bar.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(host.querySelector('[data-daily-index="1"]')?.getAttribute("aria-pressed")).toBe("true");
    await click("期間全体に戻す");
    expect(host.querySelector('[data-daily-index][aria-pressed="true"]')).toBeNull();
    expect(host.querySelector('[aria-label="日別の数値"] table')).not.toBeNull();
    expect(host.querySelector('[aria-label="日別の数値"] [aria-expanded]')).toBeNull();
    expect(host.textContent).toContain("いちばん多い項目");
    for (const word of ["記録のある日", "連続", "最長", "最多"]) expect(host.textContent).toContain(word);
    expect(host.textContent).toContain("途中の1日");
  });
  it("limits every default table to five columns and keeps auxiliary model metrics in visible row details", async () => {
    await mount();
    const check = () => { for (const row of host.querySelectorAll("thead tr")) expect(row.children.length).toBeLessThanOrEqual(5); };
    check(); await click("詳細"); expect(host.textContent).toContain("キャッシュ読み"); expect(host.textContent).toContain("延べセッション");
    for (const dimension of ["project", "branch", "effort", "origin", "title", "agent"] as const) {
      useAilogStore.setState({ breakdownAxis: dimension, breakdownDimension: dimension,
        breakdown: { ...breakdown, dimension } });
      await mount();
      expect(host.querySelector("#ailog-projects thead tr"), dimension).not.toBeNull();
      check();
    }
    useAilogStore.setState({ breakdownAxis: "work" }); await mount();
    expect(host.querySelector("#ailog-purpose thead tr")).not.toBeNull(); check();
    useAilogStore.setState({ reworkRankings: { ...rework, rewrittenFiles: [{ path: "sample.ts", editCount: 4, sessionCount: 1 }] } });
    for (const section of ["比較", "セッション", "手戻り", "モデル切替", "活動時間"]) {
      await click(section); check();
      if (section === "手戻り") expect(host.querySelectorAll("#ailog-learning thead")).toHaveLength(2);
      if (section === "モデル切替") expect(host.querySelector("#ailog-handoffs thead")).not.toBeNull();
      if (section === "セッション") { await click("詳細"); expect(host.textContent).toContain("ターン（期間内）"); }
    }
    await click("内訳"); useAilogStore.setState({ breakdownAxis: "usage" }); await mount();
    const groupingButtons = [...host.querySelectorAll<HTMLButtonElement>('[aria-label="まとめ方"] button')];
    for (const button of groupingButtons) {
      await act(async () => button.click()); await mount({ series: { ...series(), groupBy: useAilogStore.getState().usageSeriesAxis } });
      expect(host.querySelector("#ailog-compare thead")).not.toBeNull(); check();
    }
  });
  it("uses the already prefetched default project breakdown without clearing it or fetching again", async () => {
    await mount(); invoke.mockClear();
    await click("案件");
    expect(host.querySelector("#ailog-projects")?.textContent).toContain("stage1-project");
    expect(invoke).not.toHaveBeenCalled();
  });
  it("keeps the activity metric above its bars and does not silently switch an unsupported metric", async () => {
    await mount(); await click("活動時間");
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('[aria-label="活動時間の指標"] button')].find(button => button.textContent === "ターン数")!.click());
    const activity = host.querySelector('[aria-label="活動時間の指標"]')!;
    const buttons = [...activity.querySelectorAll<HTMLButtonElement>("button")];
    const cost = buttons.find(button => button.textContent === "コスト相当")!; const count = buttons.find(button => button.textContent === "セッション数")!;
    expect(cost.disabled).toBe(true); expect(count.disabled).toBe(true);
    expect(cost.title).toContain("集計がありません");
    await act(async () => cost.click());
    expect(buttons.find(button => button.textContent === "ターン数")!.getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelectorAll('[data-rhythm-slot]')).toHaveLength(31);
  });
  it("keeps the old overview, chart and tables dimmed in their places after changing the requested period", async () => {
    const old = useAilogStore.getState(); useAilogStore.getState().setPreset("7d");
    const next = useAilogStore.getState();
    for (const field of ["overview", "usageSeries", "breakdown", "pivot", "models", "sessions", "reworkRankings", "handoffs", "usageRhythm"] as const) expect(next[field]).toBe(old[field]);
    await mount();
    expect(host.querySelector('[data-ailog-refreshing="true"] [data-ailog-headlines]')).not.toBeNull();
    expect(host.querySelector('[data-ailog-refreshing="true"] [data-usage-daily]')).not.toBeNull();
    expect(host.textContent).toContain("更新中");
  });
  it("loads the same period in three phases, independently of the selected heading", async () => {
    const first = defer<unknown>(); const second = defer<unknown>();
    invoke.mockImplementation((command: string) => command === "ailog_overview" ? first.promise : command === "ailog_series" ? second.promise : Promise.resolve(reports[command] ?? {}));
    const load = useAilogStore.getState().loadUsage();
    expect(invoke.mock.calls.map(call => call[0])).toEqual(["ailog_overview", "ailog_series"]);
    first.resolve({ ...overview, previousTotals: overview.totals }); second.resolve(series());
    await load;
    const commands = invoke.mock.calls.map(call => call[0]);
    const phaseTwo = ["ailog_models", "ailog_sessions", "ailog_breakdown", "ailog_pivot"];
    const phaseThree = ["ailog_rework_rankings", "ailog_model_handoffs", "ailog_usage_rhythm"];
    expect(commands.slice(2, 6).sort()).toEqual(phaseTwo.sort());
    expect(commands.slice(6).sort()).toEqual(phaseThree.sort());
    const ranges = invoke.mock.calls.map(call => call[1].range);
    expect(ranges.every(value => JSON.stringify(value) === JSON.stringify(ranges[0]))).toBe(true);
  });
  it("bounds cached searches and periods while retaining the most recent results", async () => {
    for (let index = 0; index <= AILOG_RESOURCE_CACHE_LIMIT; index++) {
      useAilogStore.getState().setSessionQuery("sample-" + index); await useAilogStore.getState().refreshSessions();
    }
    const count = invoke.mock.calls.length;
    await useAilogStore.getState().refreshSessions(); expect(invoke.mock.calls).toHaveLength(count);
    useAilogStore.getState().setSessionQuery("sample-0"); await useAilogStore.getState().refreshSessions(); expect(invoke.mock.calls).toHaveLength(count + 1);
    invoke.mockClear();
    for (let index = 1; index <= AILOG_PERIOD_CACHE_LIMIT + 1; index++) {
      useAilogStore.getState().setCustomRange("2025-" + String(index).padStart(2, "0") + "-01", "2025-" + String(index).padStart(2, "0") + "-02");
      await useAilogStore.getState().refreshUsage();
    }
    const periods = invoke.mock.calls.length;
    await useAilogStore.getState().refreshUsage(); expect(invoke.mock.calls).toHaveLength(periods);
    useAilogStore.getState().setCustomRange("2025-01-01", "2025-01-02"); await useAilogStore.getState().refreshUsage();
    expect(invoke.mock.calls).toHaveLength(periods + 1);
  });
});

describe("transcript recovery reasons", () => {
  it.each(["not_found", "unsupported_kind", "identity_mismatch", "access_denied", "invalid_record"])("does not offer retry for the permanent %s reason", code => {
    const html = renderToStaticMarkup(<TranscriptFeedback error={{ code, retryable: false, message: "記録を確認できません", technical: "fixture" }} onRetry={vi.fn()} />);
    expect(html).not.toContain("再試行"); expect(html).toContain("技術情報");
    expect(transcriptFailure({ code, retryable: false, message: "fixture" }).retryable).toBe(false);
  });
  it("offers a working retry only for a transient failure", async () => {
    const retry = vi.fn(); await act(async () => root.render(<TranscriptFeedback error={{ code: "timeout", retryable: true, message: "控えの読み込みに時間がかかっています", technical: "fixture" }} onRetry={retry} />));
    await click("再試行"); expect(retry).toHaveBeenCalledOnce();
  });
});


describe("round 2 approved regression cases", () => {
  it.each([["", ""], ["2026-10-01", ""], ["", "2026-10-03"]])("002 leaves no refreshing flags for incomplete custom dates %s / %s", async (from, to) => {
    useAilogStore.setState({ preset: "30d" });
    useAilogStore.getState().setPreset("custom");
    useAilogStore.getState().setCustomRange(from, to);
    await useAilogStore.getState().loadUsage();
    await mount();
    expect(host.querySelectorAll('[data-ailog-refreshing="true"]')).toHaveLength(0);
    expect(useAilogStore.getState().overview).toBe(overview);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("003 keeps first and last days selected at keyboard boundaries while clicks can clear", async () => {
    await mount();
    const bars = [...host.querySelectorAll<HTMLButtonElement>("[data-daily-index]")];
    const key = async (bar: HTMLButtonElement, value: string) => act(async () => bar.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true })));
    await key(bars[0], "End");
    for (const value of ["ArrowRight", "End", "End"]) {
      await key(bars.at(-1)!, value); expect(bars.at(-1)!.getAttribute("aria-pressed")).toBe("true");
    }
    await key(bars.at(-1)!, "Home");
    for (const value of ["ArrowLeft", "Home", "Home"]) {
      await key(bars[0], value); expect(bars[0].getAttribute("aria-pressed")).toBe("true");
    }
    await act(async () => bars[0].click());
    expect(bars[0].getAttribute("aria-pressed")).toBe("false");
  });

  it("004 remembers the activity metric across heading changes", async () => {
    await mount(); await click("活動時間");
    const total = [...host.querySelectorAll<HTMLButtonElement>('[aria-label="活動時間の指標"] button')].find(button => button.textContent === "総トークン")!;
    await act(async () => total.click());
    expect(useAilogStore.getState().usageRhythmMetric).toBe("totalTokens");
    await click("内訳"); await click("活動時間");
    expect(host.querySelector('[aria-label="活動時間の指標"] [aria-pressed="true"]')?.textContent).toBe("総トークン");
  });

  it("005 shows a bounded daily numeric table immediately and names each bar with date and total", async () => {
    await mount();
    const numbers = host.querySelector<HTMLElement>('[aria-label="日別の数値"]')!;
    expect(numbers.querySelectorAll("tbody tr").length).toBeGreaterThan(0);
    expect(Number.parseInt(numbers.style.maxHeight)).toBeLessThanOrEqual(240);
    expect(numbers.style.overflow).toBe("auto");
    expect(numbers.querySelector("[aria-expanded]")).toBeNull();
    expect([...host.querySelectorAll("button")].some(button => button.textContent === "日別の数値")).toBe(false);
    for (const bar of host.querySelectorAll("[data-daily-index]")) {
      expect(bar.getAttribute("aria-label")).toMatch(/2026.*合計/);
      expect(bar.getAttribute("title")).toMatch(/2026.*合計/s);
    }
  });

  it("016 identifies the current grouping beside the daily legend", async () => {
    await mount(); expect(host.querySelector("[data-usage-grouping]")?.textContent).toContain("モデル");
    await mount({ series: { ...series(), groupBy: "provider" }, seriesAxis: "provider" });
    expect(host.querySelector("[data-usage-grouping]")?.textContent).toContain("会社");
  });

  it("017 never raises refreshing flags when returning to cached breakdown and grouping axes", async () => {
    await useAilogStore.getState().loadUsage();
    useAilogStore.getState().setBreakdownDimension("branch"); await useAilogStore.getState().loadUsage();
    useAilogStore.getState().setUsageSeriesAxis("provider"); await useAilogStore.getState().loadUsage();
    invoke.mockClear();
    const flagged: string[] = [];
    const stop = useAilogStore.subscribe(state => {
      for (const name of ["loading", "usageLoading", "modelsLoading", "breakdownLoading", "pivotLoading", "sessionLoading", "usageRhythmLoading", "reworkRankingsLoading", "handoffsLoading"] as const) if (state[name]) flagged.push(name);
    });
    try {
      useAilogStore.getState().setUsageSeriesAxis("model_raw"); await useAilogStore.getState().loadUsage();
      useAilogStore.getState().setBreakdownDimension("project"); await useAilogStore.getState().loadUsage();
      await mount();
      expect(flagged).toEqual([]);
      expect(host.querySelectorAll('[data-ailog-refreshing="true"]')).toHaveLength(0);
      expect(invoke).not.toHaveBeenCalled();
    } finally { stop(); }
  });

  it("018 reloads rework rankings when the selected model changes", async () => {
    await useAilogStore.getState().loadUsage();
    invoke.mockClear();
    useAilogStore.getState().setSelection({ model: { key: "sample-model", label: "sample-model" } });
    await useAilogStore.getState().loadUsage();
    const requests = invoke.mock.calls.filter(([command]) => command === "ailog_rework_rankings");
    expect(requests).toHaveLength(1);
    expect(requests[0][1]).toMatchObject({ filters: { models: ["sample-model"] } });
  });

  it("022 omits repeated breakdown periods only when they match the period band", async () => {
    useAilogStore.setState({ breakdownAxis: "project" }); await mount();
    expect(host.querySelectorAll("#ailog-projects [data-report-range-to]")).toHaveLength(0);
    await mount({ breakdown: { ...breakdown, range: { ...breakdown.range, to: breakdown.range.to + 1 } } });
    expect(host.querySelectorAll("#ailog-projects [data-report-range-to]")).toHaveLength(1);
    useAilogStore.setState({ breakdownAxis: "work" }); await mount();
    expect(host.querySelectorAll("#ailog-purpose [data-report-range-to]")).toHaveLength(0);
  });
});


it("015 shows dashes for non-additive sessions in folded columns, rows and row details", async () => {
  const cell = pivot.rows[0].cells[0];
  const report = { ...pivot, cols: ["sample-a", "sample-b", "sample-c", "sample-d", "sample-e"],
    colTotals: Array.from({ length: 5 }, () => ({ ...cell })),
    rows: Array.from({ length: 13 }, (_, index) => ({ key: "sample-row-" + index,
      total: { ...cell }, cells: Array.from({ length: 5 }, () => ({ ...cell })) })) };
  useAilogStore.setState({ activeSection: "comparison" });
  await mount({ pivot: report, metric: "sessions" });
  const table = host.querySelector<HTMLTableElement>("#ailog-cross table")!;
  expect(table.tHead!.rows[0].cells[4].textContent).toContain("下位まとめ");
  const rows = [...table.tBodies[0].rows];
  expect(rows).toHaveLength(14);
  for (const row of rows) expect(row.cells[4].textContent).toBe("—");
  const foldedRow = rows.find(row => row.cells[0].textContent?.startsWith("下位まとめ"))!;
  expect(foldedRow).toBeTruthy();
  for (const cell of [...foldedRow.cells].slice(1)) expect(cell.textContent).toBe("—");
  expect(rows[0].cells[1].textContent).not.toBe("—");
  await act(async () => foldedRow.querySelector<HTMLButtonElement>("button")!.click());
  const values = [...host.querySelectorAll('[aria-label="比較の行詳細"] dd')];
  expect(values).toHaveLength(5);
  for (const value of values) expect(value.textContent).toBe("—");
});


it("031 gives the daily numeric scroller a named region while preserving its height and spacing", async () => {
  await mount();
  const region = host.querySelector<HTMLElement>('[role="region"][aria-label="日別の数値"]')!;
  expect(region).not.toBeNull();
  expect(region.tabIndex).toBe(0);
  expect(region.style.maxHeight).toBe("144px");
  expect(region.style.overflow).toBe("auto");
  expect(region.parentElement?.style.marginTop).toBe("8px");
  expect(region.querySelector("table")).not.toBeNull();
});

it("034 excludes non-additive folded cells from heat colours and from their maximum", async () => {
  const baseCell = pivot.rows[0].cells[0];
  const cell = (sessions: number) => ({ ...baseCell, sessions });
  const report = { ...pivot, cols: ["sample-a", "sample-b", "sample-c", "sample-d", "sample-e"],
    colTotals: [34, 33, 33, 8, 8].map(cell),
    rows: Array.from({ length: 25 }, (_, index) => ({
      key: "sample-row-" + String(index).padStart(2, "0"),
      total: cell(index === 0 ? 10 : 1),
      cells: (index === 0 ? [10, 9, 9, 8, 8] : [1, 1, 1, 0, 0]).map(cell),
    })) };
  useAilogStore.setState({ activeSection: "comparison" });
  await mount({ pivot: report, metric: "sessions" });
  const table = host.querySelector<HTMLTableElement>("#ailog-cross table")!;
  const rows = [...table.tBodies[0].rows];
  const foldedRow = rows.find(row => row.cells[0].textContent?.startsWith("下位まとめ"))!;
  expect(foldedRow).toBeTruthy();
  for (const row of rows) {
    expect(row.cells[4].textContent).toBe("—");
    expect(row.cells[4].getAttribute("style") ?? "").not.toContain("color-mix");
  }
  for (const cell of [...foldedRow.cells].slice(1)) {
    expect(cell.textContent).toBe("—");
    expect(cell.getAttribute("style") ?? "").not.toContain("color-mix");
  }
  // Folded column 16 and folded row 13 both exceed the largest valid cell 10.
  // Its colour must still use 10 as the maximum, reaching the existing 40% cap.
  expect(rows[0].cells[1].textContent).toContain("10");
  expect(rows[0].cells[1].getAttribute("style")).toContain("color-mix");
  expect(rows[0].cells[1].getAttribute("style")).toContain("40%");
});
