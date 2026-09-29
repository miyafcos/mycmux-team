import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Effect = () => void | (() => void);

class Harness {
  private state: unknown[] = [];
  private effects: Array<{ deps: unknown[]; cleanup?: () => void; pending?: Effect }> = [];
  private refs: Array<{ current: unknown }> = [];
  private callbacks: Array<{ deps: unknown[]; callback: unknown }> = [];
  private stateIndex = 0;
  private effectIndex = 0;
  private refIndex = 0;
  private callbackIndex = 0;

  useState<T>(initial: T | (() => T)): [T, (next: T | ((current: T) => T)) => void] {
    const index = this.stateIndex++;
    if (!(index in this.state)) this.state[index] = typeof initial === "function" ? (initial as () => T)() : initial;
    return [this.state[index] as T, (next) => { this.state[index] = typeof next === "function" ? (next as (current: T) => T)(this.state[index] as T) : next; }];
  }

  useEffect(effect: Effect, deps: unknown[]) {
    const index = this.effectIndex++;
    const previous = this.effects[index];
    const unchanged = previous && previous.deps.length === deps.length && deps.every((value, depIndex) => Object.is(value, previous.deps[depIndex]));
    if (!unchanged) this.effects[index] = { deps, cleanup: previous?.cleanup, pending: effect };
  }

  useRef<T>(initial: T): { current: T } {
    const index = this.refIndex++;
    if (!this.refs[index]) this.refs[index] = { current: initial };
    return this.refs[index] as { current: T };
  }

  useCallback<T>(callback: T, deps: unknown[]): T {
    const index = this.callbackIndex++;
    const previous = this.callbacks[index];
    if (previous && previous.deps.length === deps.length && deps.every((value, depIndex) => Object.is(value, previous.deps[depIndex]))) return previous.callback as T;
    this.callbacks[index] = { deps, callback };
    return callback;
  }

  render() {
    this.stateIndex = 0;
    this.effectIndex = 0;
    this.refIndex = 0;
    this.callbackIndex = 0;
    return renderPanel({ open: panelOpen, visible: true, onClose: onPanelClose });
  }

  flushEffects() {
    this.effects.forEach((entry) => {
      if (!entry.pending) return;
      entry.cleanup?.();
      const cleanup = entry.pending();
      entry.cleanup = typeof cleanup === "function" ? cleanup : undefined;
      entry.pending = undefined;
    });
  }

  unmount() {
    this.effects.forEach((entry) => entry.cleanup?.());
    this.effects = [];
    this.refs = [];
    this.callbacks = [];
    this.state = [];
  }
}

const runtime = vi.hoisted(() => ({ harness: null as Harness | null }));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: <T,>(initial: T | (() => T)) => runtime.harness!.useState(initial),
  useEffect: (effect: Effect, deps: unknown[]) => runtime.harness!.useEffect(effect, deps),
  useLayoutEffect: (effect: Effect, deps: unknown[]) => runtime.harness!.useEffect(effect, deps),
  useRef: <T,>(initial: T) => runtime.harness!.useRef(initial),
  useCallback: <T,>(callback: T, deps: unknown[]) => runtime.harness!.useCallback(callback, deps),
  memo: <T,>(component: T) => component,
}));

vi.mock("../../src/stores/ailogStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/stores/ailogStore")>();
  const hook = Object.assign(<T,>(selector?: (state: ReturnType<typeof actual.useAilogStore.getState>) => T) => {
    const state = actual.useAilogStore.getState();
    return selector ? selector(state) : state;
  }, actual.useAilogStore);
  return { ...actual, useAilogStore: hook };
});

vi.mock("zustand/react/shallow", () => ({ useShallow: <T,>(selector: T) => selector }));

vi.mock("../../src/stores/aiSettingsStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/stores/aiSettingsStore")>();
  const hook = Object.assign(<T,>(selector: (state: ReturnType<typeof actual.useAiSettingsStore.getState>) => T) => selector(actual.useAiSettingsStore.getState()), actual.useAiSettingsStore);
  return { ...actual, useAiSettingsStore: hook };
});

vi.mock("../../src/stores/useAilogJobStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/stores/useAilogJobStore")>();
  const hook = Object.assign(<T,>(selector?: (state: ReturnType<typeof actual.useAilogJobStore.getState>) => T) => {
    const state = actual.useAilogJobStore.getState();
    return selector ? selector(state) : state;
  }, actual.useAilogJobStore);
  return { ...actual, useAilogJobStore: hook };
});

vi.mock("../../src/lib/ailog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/ailog")>()),
  ailogIndexStart: vi.fn(), ailogIndexStatus: vi.fn(), ailogSummarizeStatus: vi.fn(), ailogSeries: vi.fn(), ailogUsageRhythm: vi.fn(),
  ailogOverview: vi.fn(), ailogModels: vi.fn(), ailogBreakdown: vi.fn(), ailogPivot: vi.fn(), ailogReworkRankings: vi.fn(),
  ailogDigestGenerate: vi.fn(), ailogSummarizeStart: vi.fn(), ailogSessionSummarize: vi.fn(),
  ailogSessionDetail: vi.fn(), ailogSessionTranscript: vi.fn(), ailogSessions: vi.fn(),
  listenIndexProgress: vi.fn(), listenSummarizeProgress: vi.fn(),
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AiLogPanel as renderPanel, bucketInputRange } from "../../src/components/ailog/AiLogPanel";
import { WorkTagTable } from "../../src/components/ailog/WorkTagTable";
import type { ModelsReport } from "../../src/lib/ailog";
import {
  ailogBreakdown, ailogOverview, ailogModels, ailogDigestGenerate, ailogPivot, ailogReworkRankings,
  ailogIndexStart, ailogIndexStatus, ailogSeries, ailogSessionSummarize,
  ailogSessionDetail, ailogSessionTranscript, ailogSessions, ailogSummarizeStart, ailogSummarizeStatus, ailogUsageRhythm, listenIndexProgress, listenSummarizeProgress,
  type IndexProgress,
} from "../../src/lib/ailog";
import { __resetAilogStoreForTests, useAilogStore } from "../../src/stores/ailogStore";
import { __resetAilogJobStoreForTests, useAilogJobStore } from "../../src/stores/useAilogJobStore";
import { useAiSettingsStore } from "../../src/stores/aiSettingsStore";

type Element = { props?: Record<string, unknown>; type?: unknown };

function collect(value: unknown, into: Element[] = []): Element[] {
  if (Array.isArray(value)) value.forEach((child) => collect(child, into));
  else if (value && typeof value === "object" && "props" in value) {
    const element = value as Element;
    into.push(element);
    collect(element.props?.children, into);
  }
  return into;
}

function childByName(tree: unknown, name: string): Element {
  const found = collect(tree).find((element) => componentName(element.type)?.replace(/\d+$/, "") === name);
  if (!found) throw new Error(`component not found: ${name}`);
  return found;
}

function componentName(type: unknown): string | undefined {
  if (typeof type === "function") return (type as { name?: string }).name;
  if (type && typeof type === "object") {
    const memo = type as { displayName?: string; type?: { name?: string; displayName?: string; render?: { name?: string } } };
    return memo.displayName ?? memo.type?.displayName ?? memo.type?.name ?? memo.type?.render?.name;
  }
  return undefined;
}

function overlay(tree: unknown, label: string): Element {
  const found = collect(tree).find((element) => typeof element.type === "function" && (element.type as { name?: string }).name === "OverlayShell" && element.props?.ariaLabel === label);
  if (!found) throw new Error(`overlay not found: ${label}`);
  return found;
}

function headerStatus(tree: unknown): string {
  const found = collect(tree).find((element) => element.type === "div" && element.props?.role === "status" && element.props?.["aria-live"] === "polite");
  if (!found) throw new Error("header status not found");
  const children = found.props?.children;
  return Array.isArray(children) ? children.join("") : String(children ?? "");
}

const idleIndex = { running: false, filesDone: 0, filesTotal: 0, sessions: 0, lastFinishedAt: 1, lastError: null };
const idleSummary = { running: false, sessionsDone: 0, sessionsTotal: 0, sessionsRemaining: 0, lastFinishedAt: 1, lastError: null, elapsedMs: 0, estimatedInputChars: 0, inputTokens: 0, outputTokens: 0 };
const doneProgress: IndexProgress = { phase: "done", filesDone: 12, filesTotal: 340, sessions: 4, bytesDone: 0, bytesTotal: 0, elapsedMs: 10 };
const emptyOverview = {
  range: { from: 0, to: 1, label: "test" },
  totals: { sessions: 0, turns: 0, userMessages: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0, wallMs: 0, activeMs: 0, projects: 0, models: 0 },
  comparePrevious: { sessionsPct: null, costPct: null, tokensPct: null, reworkPct: null },
  topModels: [], mixedModelSessions: 0, topProjects: [], topTitles: [],
  rework: { avgScore: 0, toolErrorRate: 0, correctionHits: 0, churnFiles: 0, abandonedSessions: 0 },
  excludedInternal: { sessions: 0, costUsd: 0 }, cacheHitRate: 0, priceSource: "test",
  priceCoverage: { priced: { models: [], tokens: 0 }, local: { models: [], tokens: 0 }, internal: { models: [], tokens: 0 }, flat: { models: [], tokens: 0 }, reported: { models: [], tokens: 0 }, unknown: { models: [], tokens: 0 }, coveredTokenRatio: 1 },
  indexFreshness: { lastIndexedAt: 1, staleFiles: 0 }, timings: { sqlMs: 0, rowsScanned: 0, buildMs: 0, path: "rollup" }, costNote: "",
};

let harness: Harness;
let latest: unknown;
let panelOpen = true;
let onPanelClose: ReturnType<typeof vi.fn>;
let indexProgressHandler: ((progress: IndexProgress) => void) | undefined;

function renderAndFlush() {
  latest = harness.render();
  harness.flushEffects();
}

async function settle(rounds = 40) {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
    latest = harness.render();
    harness.flushEffects();
  }
}

function clearLoaders() {
  [ailogSeries, ailogUsageRhythm, ailogOverview, ailogModels, ailogBreakdown, ailogPivot].forEach((mock) => vi.mocked(mock).mockClear());
}

beforeEach(async () => {
  __resetAilogStoreForTests();
  __resetAilogJobStoreForTests();
  useAiSettingsStore.getState().setAiEnabled(true);
  panelOpen = true;
  onPanelClose = vi.fn();
  indexProgressHandler = undefined;
  harness = new Harness();
  runtime.harness = harness;
  vi.mocked(ailogIndexStart).mockReset().mockResolvedValue({ started: true, alreadyRunning: false });
  vi.mocked(ailogIndexStatus).mockReset().mockResolvedValue(idleIndex);
  vi.mocked(ailogSummarizeStatus).mockReset().mockResolvedValue(idleSummary);
  vi.mocked(ailogSeries).mockReset().mockResolvedValue({} as any);
  vi.mocked(ailogUsageRhythm).mockReset().mockResolvedValue({} as any);
  vi.mocked(ailogOverview).mockReset().mockResolvedValue(emptyOverview as any);
  vi.mocked(ailogModels).mockReset().mockResolvedValue({ byWorkTag: [] } as any);
  vi.mocked(ailogBreakdown).mockReset().mockResolvedValue({} as any);
  vi.mocked(ailogPivot).mockReset().mockResolvedValue({} as any);
  vi.mocked(ailogReworkRankings).mockReset().mockResolvedValue({ failedCommands: [], rewrittenFiles: [] } as any);
  vi.mocked(ailogDigestGenerate).mockReset().mockResolvedValue({} as any);
  vi.mocked(ailogSummarizeStart).mockReset().mockResolvedValue({ started: true, alreadyRunning: false, targetCount: 0, estimatedInputChars: 0 });
  vi.mocked(ailogSessionSummarize).mockReset().mockResolvedValue();
  vi.mocked(ailogSessionDetail).mockReset().mockRejectedValue(new Error("not needed by loader tests"));
  vi.mocked(ailogSessionTranscript).mockReset().mockRejectedValue(new Error("not needed by loader tests"));
  vi.mocked(ailogSessions).mockReset().mockResolvedValue({ range: { from: 0, to: 1, label: "test" }, rows: [], total: 0, priceSource: "test", costNote: "" });
  vi.mocked(listenIndexProgress).mockReset().mockImplementation(async (handler) => {
    indexProgressHandler = handler;
    return () => {};
  });
  vi.mocked(listenSummarizeProgress).mockReset().mockResolvedValue(() => {});
  vi.stubGlobal("window", { setTimeout: () => 0, clearTimeout: () => {} });
  vi.stubGlobal("requestIdleCallback", (callback: () => void) => { callback(); return 0; });
  renderAndFlush();
  await settle();
});

afterEach(() => {
  harness.unmount();
  runtime.harness = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AI log panel single-view flow", () => {
  it("turns a selected chart bucket into its full day, week, or month range", () => {
    const augustThirdJst = Date.UTC(2026, 7, 3) - 9 * 60 * 60 * 1000;
    expect(bucketInputRange(augustThirdJst, "day")).toEqual({ from: "2026-08-03", to: "2026-08-03" });
    expect(bucketInputRange(augustThirdJst, "week")).toEqual({ from: "2026-08-03", to: "2026-08-09" });
    expect(bucketInputRange(augustThirdJst, "month")).toEqual({ from: "2026-08-03", to: "2026-08-31" });
  });

  it("opens onto the usage surface with no segment bar", () => {
    expect(() => childByName(latest, "UsageView")).not.toThrow();
    expect(() => childByName(latest, "RangeBar")).not.toThrow();
    expect(() => childByName(latest, "IndexBadge")).not.toThrow();
    expect(() => childByName(latest, "PanelMenu")).not.toThrow();
    expect(collect(latest).some((element) => componentName(element.type) === "Segment")).toBe(false);
    expect(collect(latest).some((element) => element.type === "button" && (element.props?.children === "変化" || element.props?.children === "問い" || element.props?.children === "学び" || element.props?.children === "記録" || element.props?.children === "日別"))).toBe(false);
  });

  it("starts incremental index once on open", () => {
    expect(ailogIndexStart).toHaveBeenCalledOnce();
    expect(ailogIndexStart).toHaveBeenCalledWith(false);
    expect(useAilogJobStore.getState().index.autoStarted).toBe(true);
    expect(useAilogJobStore.getState().lastAutoStartedAt).toBeGreaterThan(0);
  });

  it("does not start another index when reopened inside 60 seconds", async () => {
    expect(ailogIndexStart).toHaveBeenCalledOnce();
    panelOpen = false;
    renderAndFlush();
    panelOpen = true;
    renderAndFlush();
    await settle();
    expect(ailogIndexStart).toHaveBeenCalledOnce();
  });

  it("never starts LLM work from the open path", () => {
    expect(ailogSummarizeStart).not.toHaveBeenCalled();
    expect(ailogDigestGenerate).not.toHaveBeenCalled();
    expect(ailogSessionSummarize).not.toHaveBeenCalled();
  });

  it("reloads aggregates when index-progress reports done", async () => {
    expect(indexProgressHandler).toEqual(expect.any(Function));
    useAilogJobStore.setState((state) => ({ index: { ...state.index, status: { ...idleIndex, running: true } } }));
    renderAndFlush();
    clearLoaders();
    indexProgressHandler!(doneProgress);
    await settle();
    expect(ailogSeries).toHaveBeenCalled();
    expect(ailogUsageRhythm).toHaveBeenCalled();
    expect(ailogOverview).toHaveBeenCalled();
    expect(ailogModels).toHaveBeenCalled();
    expect(ailogBreakdown).toHaveBeenCalled();
    expect(ailogPivot).toHaveBeenCalled();
    expect(ailogReworkRankings).not.toHaveBeenCalled();
    expect(ailogSummarizeStart).not.toHaveBeenCalled();
    expect(ailogDigestGenerate).not.toHaveBeenCalled();
    expect(ailogSessionSummarize).not.toHaveBeenCalled();
  });

  it("loads usage reports on open and keeps LLM endpoints behind explicit actions", () => {
    expect(ailogSeries).toHaveBeenCalledOnce();
    expect(ailogUsageRhythm).toHaveBeenCalledOnce();
    expect(ailogOverview).toHaveBeenCalled();
    expect(ailogModels).toHaveBeenCalledOnce();
    expect(ailogBreakdown).toHaveBeenCalledOnce();
    expect(ailogPivot).toHaveBeenCalledOnce();
    expect(ailogReworkRankings).not.toHaveBeenCalled();
    const menu = childByName(latest, "PanelMenu");
    (menu.props!.onStartSummarize as () => void)();
    expect(ailogSummarizeStart).toHaveBeenCalledOnce();
    expect(ailogDigestGenerate).not.toHaveBeenCalled();
  });

  it("uses one request for bucket changes, but none for client-only session controls", async () => {
    clearLoaders();
    useAilogStore.getState().setUsageBucket("week"); renderAndFlush();
    await settle();
    expect(ailogSeries).toHaveBeenCalledOnce();
    expect(ailogUsageRhythm).toHaveBeenCalledOnce();
    clearLoaders();
    useAilogStore.getState().setSessionSort("recent");
    useAilogStore.getState().setSessionPage(1);
    useAilogStore.getState().setExcludeSynthetic(false);
    renderAndFlush();
    expect(ailogSeries).not.toHaveBeenCalled();
    expect(ailogOverview).not.toHaveBeenCalled();
  });

  it("requests provider aggregates when the company grouping is selected", async () => {
    clearLoaders();
    useAilogStore.getState().setUsageSeriesAxis("provider");
    renderAndFlush();
    await settle();
    expect(ailogSeries).toHaveBeenCalledOnce();
    expect(ailogSeries).toHaveBeenCalledWith(expect.anything(), expect.anything(), { bucket: "day", groupBy: "provider" });
  });

  it("keeps the previous usage data readable during a section refresh", async () => {
    useAilogStore.setState({ usageSeries: {} as any, usageRhythm: {} as any, usageLoading: false });
    vi.mocked(ailogSeries).mockImplementationOnce(() => new Promise(() => {}));
    latest = harness.render();
    useAilogStore.getState().setUsageBucket("week");
    renderAndFlush();
    await settle(4);

    const usage = childByName(latest, "UsageView");
    expect(usage.props?.usageLoading).toBe(true);
    expect(collect(latest).some((element) => (element.props?.style as { opacity?: number } | undefined)?.opacity === 0.55)).toBe(false);
  });

  it("lets the overview finish before starting below-the-fold reports", async () => {
    clearLoaders();
    let finishOverview: ((value: any) => void) | undefined;
    vi.mocked(ailogOverview).mockImplementationOnce(() => new Promise((resolve) => { finishOverview = resolve; }));

    const load = useAilogStore.getState().loadUsage({ force: true });
    await Promise.resolve();
    expect(ailogOverview).toHaveBeenCalledOnce();
    expect(ailogSeries).not.toHaveBeenCalled();
    expect(ailogBreakdown).not.toHaveBeenCalled();
    expect(ailogPivot).not.toHaveBeenCalled();

    finishOverview!(emptyOverview);
    await load;
    expect(ailogSeries).toHaveBeenCalledOnce();
    expect(ailogBreakdown).toHaveBeenCalledOnce();
    expect(ailogPivot).toHaveBeenCalledOnce();
  });

  it("shows the header refresh state while usage reports reload", () => {
    useAilogStore.setState({ usageLoading: false, loading: false, breakdownLoading: false });
    latest = harness.render();
    expect(headerStatus(latest)).not.toContain("集計を読み込み中…");

    useAilogStore.setState({ usageLoading: true });
    latest = harness.render();
    expect(headerStatus(latest)).toContain("直前の集計を表示したまま更新中…");
  });

  it("keeps detail as a top overlay and clears it before the panel closes", () => {
    const usage = childByName(latest, "UsageView");
    (usage.props!.onOpenDetail as (kind: string, id: string) => void)("codex", "s1");
    renderAndFlush();
    expect(overlay(latest, "AIログ分析").props?.closeOnEscape).toBe(false);
    const detail = overlay(latest, "セッション詳細");
    (detail.props!.onClose as () => void)();
    renderAndFlush();
    expect(useAilogStore.getState().detailKey).toBeNull();
    expect(() => overlay(latest, "セッション詳細")).toThrow("overlay not found");
    (overlay(latest, "AIログ分析").props!.onClose as () => void)();
    panelOpen = false; renderAndFlush();
    expect(onPanelClose).toHaveBeenCalledOnce();
    expect(useAilogStore.getState().detailKey).toBeNull();
  });

  it("loads numeric detail before the conversation transcript", async () => {
    vi.mocked(ailogSessionDetail).mockResolvedValue({} as any);
    vi.mocked(ailogSessionTranscript).mockResolvedValue({ messages: [], truncated: false, omittedCount: 0 });
    await useAilogStore.getState().openDetail("codex", "s-lazy");
    expect(ailogSessionDetail).toHaveBeenCalledOnce();
    expect(ailogSessionTranscript).not.toHaveBeenCalled();

    await useAilogStore.getState().loadTranscript("codex", "s-lazy");
    expect(ailogSessionTranscript).toHaveBeenCalledOnce();
  });

  it("refreshes session search without reloading the overview", async () => {
    clearLoaders();
    vi.mocked(ailogSessions).mockClear();
    useAilogStore.getState().setSessionQuery("品質ループ");
    await useAilogStore.getState().refreshSessions();
    expect(ailogSessions).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ query: "品質ループ" }),
      expect.objectContaining({ limit: 100, offset: 0 }),
    );
    expect(ailogOverview).not.toHaveBeenCalled();
  });

  it("forwards store.models to UsageView so the work-tag table can render them", () => {
    const sentinel = {
      range: { from: 0, to: 1, label: "sentinel" },
      granularity: "raw",
      rows: [],
      series: [],
      mixedSessions: 0,
      handoffs: [],
      byWorkTag: [
        {
          workTag: "sentinel-models-wire",
          sessionCount: 3,
          perModel: [{ model: "gpt-5.6-terra", sessions: 3, turns: 6, costUsd: 1.5, ingestCost: 0, generateCost: 1.5, avgRework: 0 }],
        },
      ],
      overlapping: false,
      totalSessions: 3,
      priceSource: "test",
      priceCoverage: {
        priced: { models: [], tokens: 0 },
        local: { models: [], tokens: 0 },
        internal: { models: [], tokens: 0 },
        flat: { models: [], tokens: 0 },
        reported: { models: [], tokens: 0 },
        unknown: { models: [], tokens: 0 },
        coveredTokenRatio: 1,
      },
      costNote: "",
    };
    useAilogStore.setState({ models: sentinel as any, loading: false, dashboardError: null });
    latest = harness.render();
    const usage = childByName(latest, "UsageView");
    expect(usage.props?.models).toBe(sentinel);
    const html = renderToStaticMarkup(createElement(WorkTagTable, { report: usage.props!.models as ModelsReport }));
    expect(html).toContain("sentinel-models-wire");
    expect(html).toContain("work-tag-row");
  });
});
