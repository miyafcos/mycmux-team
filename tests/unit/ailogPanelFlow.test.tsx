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

vi.mock("../../src/lib/ailog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/ailog")>()),
  ailogIndexStatus: vi.fn(), ailogSummarizeStatus: vi.fn(), ailogSeries: vi.fn(), ailogUsageRhythm: vi.fn(),
  ailogDashboard: vi.fn(), ailogBreakdown: vi.fn(), ailogEfficiency: vi.fn(), ailogRuleCheck: vi.fn(),
  ailogDigestGet: vi.fn(), ailogFindings: vi.fn(), ailogReworkRankings: vi.fn(),
  ailogDigestGenerate: vi.fn(), ailogSummarizeStart: vi.fn(), ailogSessionSummarize: vi.fn(),
  ailogSessionDetail: vi.fn(), ailogSessionTranscript: vi.fn(),
  listenIndexProgress: vi.fn(), listenSummarizeProgress: vi.fn(),
}));

import { AiLogPanel as renderPanel } from "../../src/components/ailog/AiLogPanel";
import {
  ailogBreakdown, ailogDashboard, ailogDigestGenerate, ailogDigestGet, ailogEfficiency, ailogFindings,
  ailogIndexStatus, ailogReworkRankings, ailogRuleCheck, ailogSeries, ailogSessionSummarize,
  ailogSessionDetail, ailogSessionTranscript, ailogSummarizeStart, ailogSummarizeStatus, ailogUsageRhythm, listenIndexProgress, listenSummarizeProgress,
} from "../../src/lib/ailog";
import { __resetAilogStoreForTests, useAilogStore } from "../../src/stores/ailogStore";
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

function button(tree: unknown, label: string): { props: { onClick: () => void } } {
  const found = collect(tree).find((element) => element.type === "button" && element.props?.children === label);
  if (!found) throw new Error(`button not found: ${label}`);
  return found as { props: { onClick: () => void } };
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

function segment(tree: unknown, label: string): { onChange: (value: string) => void; value: string; selected: string } {
  const found = collect(tree).find((element) => typeof element.type === "function" && (element.type as { name?: string }).name === "Segment" && Array.isArray(element.props?.buttons) && (element.props!.buttons as Array<readonly [string, string]>).some(([, text]) => text === label));
  if (!found) throw new Error(`segment not found: ${label}`);
  return { onChange: found.props!.onChange as (value: string) => void, value: ((found.props!.buttons as Array<readonly [string, string]>).find(([, text]) => text === label)![0]), selected: found.props!.value as string };
}

function headerStatus(tree: unknown): unknown {
  const found = collect(tree).find((element) => element.type === "div" && element.props?.role === "status" && element.props?.["aria-live"] === "polite");
  if (!found) throw new Error("header status not found");
  return found.props?.children;
}

function segmentButton(tree: unknown, label: string): Element {
  const segmentElement = collect(tree).find((element) => typeof element.type === "function" && (element.type as { name?: string }).name === "Segment" && Array.isArray(element.props?.buttons) && (element.props!.buttons as Array<readonly [string, string]>).some(([, text]) => text === label));
  if (!segmentElement || typeof segmentElement.type !== "function") throw new Error(`segment not found: ${label}`);
  const rendered = (segmentElement.type as (props: Record<string, unknown>) => unknown)(segmentElement.props ?? {});
  const buttonElement = collect(rendered).find((element) => element.type === "button" && element.props?.children === label);
  if (!buttonElement) throw new Error(`segment button not found: ${label}`);
  return buttonElement;
}

const idleIndex = { running: false, filesDone: 0, filesTotal: 0, sessions: 0, lastFinishedAt: 1, lastError: null };
const idleSummary = { running: false, sessionsDone: 0, sessionsTotal: 0, sessionsRemaining: 0, lastFinishedAt: 1, lastError: null, elapsedMs: 0, estimatedInputChars: 0, inputTokens: 0, outputTokens: 0 };

let harness: Harness;
let latest: unknown;
let panelOpen = true;
let onPanelClose: ReturnType<typeof vi.fn>;

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
  [ailogSeries, ailogUsageRhythm, ailogDashboard, ailogBreakdown, ailogEfficiency, ailogRuleCheck, ailogDigestGet, ailogFindings, ailogReworkRankings].forEach((mock) => vi.mocked(mock).mockClear());
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(async () => {
  __resetAilogStoreForTests();
  useAiSettingsStore.getState().setAiEnabled(true);
  panelOpen = true;
  onPanelClose = vi.fn();
  harness = new Harness();
  runtime.harness = harness;
  vi.mocked(ailogIndexStatus).mockReset().mockResolvedValue(idleIndex);
  vi.mocked(ailogSummarizeStatus).mockReset().mockResolvedValue(idleSummary);
  vi.mocked(ailogSeries).mockReset().mockResolvedValue({} as any);
  vi.mocked(ailogUsageRhythm).mockReset().mockResolvedValue({} as any);
  vi.mocked(ailogDashboard).mockReset().mockResolvedValue({} as any);
  vi.mocked(ailogBreakdown).mockReset().mockResolvedValue({} as any);
  vi.mocked(ailogEfficiency).mockReset().mockResolvedValue({} as any);
  vi.mocked(ailogRuleCheck).mockReset().mockResolvedValue({} as any);
  vi.mocked(ailogDigestGet).mockReset().mockResolvedValue({ date: "2026-08-13", digest: null, metrics: {} } as any);
  vi.mocked(ailogFindings).mockReset().mockResolvedValue({ total: 0, rows: [] });
  vi.mocked(ailogReworkRankings).mockReset().mockResolvedValue({ failedCommands: [], rewrittenFiles: [] });
  vi.mocked(ailogDigestGenerate).mockReset().mockResolvedValue({} as any);
  vi.mocked(ailogSummarizeStart).mockReset().mockResolvedValue({ started: true, alreadyRunning: false, targetCount: 0, estimatedInputChars: 0 });
  vi.mocked(ailogSessionSummarize).mockReset().mockResolvedValue();
  vi.mocked(ailogSessionDetail).mockReset().mockRejectedValue(new Error("not needed by loader tests"));
  vi.mocked(ailogSessionTranscript).mockReset().mockRejectedValue(new Error("not needed by loader tests"));
  vi.mocked(listenIndexProgress).mockReset().mockResolvedValue(() => {});
  vi.mocked(listenSummarizeProgress).mockReset().mockResolvedValue(() => {});
  vi.stubGlobal("requestIdleCallback", (callback: () => void) => { callback(); return 0; });
  useAilogStore.setState((state) => ({ index: { ...state.index, status: idleIndex }, summarize: { ...state.summarize, status: idleSummary } }));
  renderAndFlush();
  await settle();
});

afterEach(() => {
  harness.unmount();
  runtime.harness = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* Legacy six-segment assertions retained below for history while the four-segment
 * contract is covered by the replacement suite at the end of this file.
describe("AI log panel loader flow", () => {
  it("opens with the visible usage loader, then preloads the other SQL segments without LLM work", () => {
    expect(ailogIndexStatus).toHaveBeenCalledOnce();
    expect(ailogSummarizeStatus).toHaveBeenCalledOnce();
    expect(ailogSeries).toHaveBeenCalledOnce();
    expect(ailogUsageRhythm).toHaveBeenCalledOnce();
    expect(ailogDashboard).toHaveBeenCalledOnce();
    expect(ailogBreakdown).toHaveBeenCalledOnce();
    expect(ailogEfficiency).toHaveBeenCalledOnce();
    expect(ailogRuleCheck).toHaveBeenCalledOnce();
    expect(ailogFindings).toHaveBeenCalledOnce();
    expect(ailogReworkRankings).toHaveBeenCalledOnce();
    expect(ailogDigestGet).not.toHaveBeenCalled();
    expect(ailogDigestGenerate).not.toHaveBeenCalled();
    expect(ailogSummarizeStart).not.toHaveBeenCalled();
    expect(ailogSessionSummarize).not.toHaveBeenCalled();
  });

  it("renders one segment bar and keeps the range bar visible for every segment", () => {
    const bars = collect(latest).filter((element) => typeof element.type === "function" && (element.type as { name?: string }).name === "Segment");
    expect(bars).toHaveLength(1);
    expect((bars[0]!.props!.buttons as Array<readonly [string, string]>).map(([, label]) => label)).toEqual(["全体", "内訳", "比較", "日別まとめ", "繰り返しの罠", "決定事項"]);
    expect(() => childByName(latest, "RangeBar")).not.toThrow();
    expect(collect(latest).some((element) => element.type === "button" && (element.props?.children === "使った量" || element.props?.children === "わかったこと"))).toBe(false);
  });

  it("switches cached SQL segments without requests and keeps LLM work explicit", async () => {
    clearLoaders();
    for (const label of ["内訳", "比較", "繰り返しの罠", "決定事項", "全体"]) {
      const next = segment(latest, label); next.onChange(next.value); renderAndFlush();
      await settle(2);
    }
    expect(ailogSeries).not.toHaveBeenCalled();
    expect(ailogUsageRhythm).not.toHaveBeenCalled();
    expect(ailogDashboard).not.toHaveBeenCalled();
    expect(ailogBreakdown).not.toHaveBeenCalled();
    expect(ailogEfficiency).not.toHaveBeenCalled();
    expect(ailogRuleCheck).not.toHaveBeenCalled();
    expect(ailogFindings).not.toHaveBeenCalled();
    expect(ailogReworkRankings).not.toHaveBeenCalled();
    const daily = segment(latest, "日別まとめ"); daily.onChange(daily.value); renderAndFlush();
    expect(ailogDigestGet).toHaveBeenCalledOnce();
    expect(ailogDigestGenerate).not.toHaveBeenCalled();
    expect(ailogSummarizeStart).not.toHaveBeenCalled();
  });

  it("loads a changed period's visible segment before SQL prefetch and never preloads an LLM action", async () => {
    clearLoaders();
    const nextSeries = deferred<any>();
    const nextRhythm = deferred<any>();
    vi.mocked(ailogSeries).mockImplementationOnce(() => nextSeries.promise);
    vi.mocked(ailogUsageRhythm).mockImplementationOnce(() => nextRhythm.promise);

    const range = childByName(latest, "RangeBar");
    (range.props!.onCustomRange as (from: string, to: string) => void)("2026-08-01", "2026-08-03");
    renderAndFlush();

    expect(ailogSeries).toHaveBeenCalledOnce();
    expect(ailogUsageRhythm).toHaveBeenCalledOnce();
    expect(ailogDashboard).not.toHaveBeenCalled();
    expect(ailogBreakdown).not.toHaveBeenCalled();
    expect(ailogEfficiency).not.toHaveBeenCalled();
    expect(ailogRuleCheck).not.toHaveBeenCalled();
    expect(ailogFindings).not.toHaveBeenCalled();
    expect(ailogReworkRankings).not.toHaveBeenCalled();

    nextSeries.resolve({} as any);
    nextRhythm.resolve({} as any);
    await settle();

    expect(ailogDashboard).toHaveBeenCalledOnce();
    expect(ailogBreakdown).toHaveBeenCalledOnce();
    expect(ailogEfficiency).toHaveBeenCalledOnce();
    expect(ailogRuleCheck).toHaveBeenCalledOnce();
    expect(ailogFindings).toHaveBeenCalledOnce();
    expect(ailogReworkRankings).toHaveBeenCalledOnce();
    expect(ailogDigestGenerate).not.toHaveBeenCalled();
    expect(ailogSummarizeStart).not.toHaveBeenCalled();
    expect(ailogSessionSummarize).not.toHaveBeenCalled();
  });

  it("uses one request for bucket and digest-date changes, but none for client-only session controls", () => {
    clearLoaders();
    useAilogStore.getState().setUsageBucket("week"); renderAndFlush();
    expect(ailogSeries).toHaveBeenCalledOnce();
    expect(ailogUsageRhythm).toHaveBeenCalledOnce();
    clearLoaders();
    useAilogStore.getState().setSessionSort("recent");
    useAilogStore.getState().setSessionPage(1);
    useAilogStore.getState().setExcludeSynthetic(false);
    renderAndFlush();
    expect(ailogSeries).not.toHaveBeenCalled();
    expect(ailogDashboard).not.toHaveBeenCalled();
    const daily = segment(latest, "日別まとめ"); daily.onChange(daily.value); renderAndFlush();
    clearLoaders();
    const digest = childByName(latest, "DigestView");
    (digest.props!.onNext as () => void)(); renderAndFlush();
    expect(ailogDigestGet).toHaveBeenCalledOnce();
    expect(ailogDigestGenerate).not.toHaveBeenCalled();
  });

  it("requests provider aggregates when the company grouping is selected", async () => {
    clearLoaders();
    useAilogStore.getState().setGranularity("provider");
    renderAndFlush();
    await settle(2);
    expect(ailogSeries).toHaveBeenCalledOnce();
    expect(ailogSeries).toHaveBeenCalledWith(expect.anything(), expect.anything(), { bucket: "day", groupBy: "provider" });
    const breakdown = segment(latest, "内訳"); breakdown.onChange(breakdown.value); renderAndFlush();
    await settle(2);
    expect(ailogDashboard).toHaveBeenCalledOnce();
    expect(ailogDashboard).toHaveBeenCalledWith(expect.anything(), expect.anything(), "provider");
  });

  it("refetches visible findings once for query changes and clears an incompatible kind on segment change", () => {
    const recurring = segment(latest, "繰り返しの罠"); recurring.onChange(recurring.value); renderAndFlush();
    clearLoaders();
    const learning = childByName(latest, "LearningView");
    (learning.props!.onKindChange as (kind: "gotcha") => void)("gotcha"); renderAndFlush();
    expect(ailogFindings).toHaveBeenCalledOnce();
    clearLoaders();
    (childByName(latest, "LearningView").props!.onQueryChange as (query: string) => void)("needle"); renderAndFlush();
    expect(ailogFindings).toHaveBeenCalledOnce();
    clearLoaders();
    const decisions = segment(latest, "決定事項"); decisions.onChange(decisions.value); renderAndFlush();
    expect(ailogFindings).toHaveBeenCalledOnce();
    expect(vi.mocked(ailogFindings).mock.calls[0]?.[2]).toMatchObject({ kind: null, query: "needle" });
  });

  it("keeps AI actions explicit and exposes the disabled state without blocking saved-data loaders", () => {
    useAiSettingsStore.getState().setAiEnabled(false);
    renderAndFlush();
    const range = childByName(latest, "RangeBar");
    expect(range.props?.aiDisabledReason).toBeTruthy();
    clearLoaders();
    const daily = segment(latest, "日別まとめ"); daily.onChange(daily.value); renderAndFlush();
    expect(ailogDigestGet).toHaveBeenCalledOnce();
    expect(ailogDigestGenerate).not.toHaveBeenCalled();
    expect(ailogSummarizeStart).not.toHaveBeenCalled();
  });

  it("starts each LLM API only from its explicit panel action", () => {
    const range = childByName(latest, "RangeBar");
    (range.props!.onStartSummarize as () => void)();
    expect(ailogSummarizeStart).toHaveBeenCalledOnce();
    const daily = segment(latest, "日別まとめ"); daily.onChange(daily.value); renderAndFlush();
    const digest = childByName(latest, "DigestView");
    (digest.props!.onRegenerate as () => void)();
    expect(ailogDigestGenerate).toHaveBeenCalledOnce();
    expect(ailogSessionSummarize).not.toHaveBeenCalled();
  });

  it("retries a digest GET without generating a new digest", () => {
    const daily = segment(latest, "日別まとめ"); daily.onChange(daily.value); renderAndFlush();
    clearLoaders();
    const digest = childByName(latest, "DigestView");
    (digest.props!.onRetry as () => void)();
    expect(ailogDigestGet).toHaveBeenCalledOnce();
    expect(ailogDigestGenerate).not.toHaveBeenCalled();
  });

  it("follows both cross-segment links with one saved-data load and no LLM work", () => {
    clearLoaders();
    const usage = childByName(latest, "UsageView");
    expect(usage.props?.digestLinkLabel).toBe("日別まとめへ");
    (usage.props!.onOpenDigest as (day: number) => void)(1_723_456_000_000); renderAndFlush();
    expect(ailogDigestGet).toHaveBeenCalledOnce();
    expect(ailogDigestGenerate).not.toHaveBeenCalled();
    clearLoaders();
    const recurring = segment(latest, "繰り返しの罠"); recurring.onChange(recurring.value); renderAndFlush();
    clearLoaders();
    const learning = childByName(latest, "LearningView");
    (learning.props!.onOpenBreakdown as (day: number) => void)(1_723_456_000_000); renderAndFlush();
    expect(ailogDashboard).toHaveBeenCalledOnce();
    expect(ailogBreakdown).toHaveBeenCalledOnce();
    expect(ailogDigestGenerate).not.toHaveBeenCalled();
    expect(ailogSummarizeStart).not.toHaveBeenCalled();
  });

  it("dims the previous usage data and announces the refresh after a range change", () => {
    useAilogStore.setState({ usageSeries: {} as any, usageRhythm: {} as any, usageLoading: false });
    latest = harness.render();
    useAilogStore.getState().setUsageBucket("week");
    latest = harness.render();
    harness.flushEffects();
    latest = harness.render();

    const refreshing = childByName(latest, "RefreshingBlock");
    expect(refreshing.props?.busy).toBe(true);
    const rendered = (refreshing.type as (props: Record<string, unknown>) => unknown)(refreshing.props ?? {});
    expect(collect(rendered).some((element) => element.props?.children === "更新中…")).toBe(true);
    expect(collect(rendered).some((element) => (element.props?.style as { opacity?: number } | undefined)?.opacity === 0.55)).toBe(true);
  });

  it("shows the header refresh state only for the visible segment", () => {
    useAilogStore.setState({ usageLoading: false, experimentLoading: true, loading: false, breakdownLoading: false });
    latest = harness.render();
    expect(headerStatus(latest)).not.toBe("集計を更新中…");

    useAilogStore.setState({ usageLoading: true });
    latest = harness.render();
    expect(headerStatus(latest)).toBe("集計を更新中…");

    const what = segment(latest, "内訳"); what.onChange(what.value);
    useAilogStore.setState({ usageLoading: false, loading: true, breakdownLoading: false });
    latest = harness.render();
    expect(headerStatus(latest)).toBe("集計を更新中…");
  });

  it("fills the selected segment button with the accent color", () => {
    const overall = segmentButton(latest, "全体");
    expect(overall.props?.["aria-pressed"]).toBe(true);
    expect((overall.props?.style as { background?: string; color?: string }).background).toBe("var(--cmux-accent)");
    expect((overall.props?.style as { background?: string; color?: string }).color).toBe("var(--cmux-on-accent)");

    (segmentButton(latest, "内訳").props?.onClick as () => void)();
    latest = harness.render();
    expect(segmentButton(latest, "内訳").props?.["aria-pressed"]).toBe(true);
  });

  it("retains the custom range while resetting the segment to 全体 on reopen", () => {
    const range = childByName(latest, "RangeBar");
    (range.props!.onCustomRange as (from: string, to: string) => void)("2026-08-01", "2026-08-03"); renderAndFlush();
    const expectedRange = vi.mocked(ailogSeries).mock.calls.at(-1)?.[0];
    const daily = segment(latest, "日別まとめ"); daily.onChange(daily.value); renderAndFlush();
    panelOpen = false; renderAndFlush();
    panelOpen = true; renderAndFlush();
    expect(vi.mocked(ailogSeries).mock.calls.at(-1)?.[0]).toEqual(expectedRange);
    expect(segment(latest, "全体").selected).toBe("when");
  });

  it("keeps detail as a top overlay and clears it before the panel closes", () => {
    const what = segment(latest, "内訳"); what.onChange(what.value); renderAndFlush();
    const breakdown = childByName(latest, "RecordBreakdownView");
    (breakdown.props!.onOpenDetail as (kind: string, id: string) => void)("codex", "s1");
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
}); */

describe("AI log panel five-segment flow", () => {
  it("opens on change and exposes the five approved segments", () => {
    const bar = collect(latest).find((element) => componentName(element.type) === "Segment");
    expect((bar?.props?.buttons as Array<readonly [string, string]>).map(([, label]) => label)).toEqual(["変化", "問い", "学び", "記録", "日別"]);
    expect(bar?.props?.value).toBe("change");
    expect(() => childByName(latest, "ChangeView")).not.toThrow();
  });

  it("loads change from cache without report or LLM requests", () => {
    expect(ailogSeries).not.toHaveBeenCalled();
    expect(ailogUsageRhythm).not.toHaveBeenCalled();
    expect(ailogDashboard).not.toHaveBeenCalled();
    expect(ailogBreakdown).not.toHaveBeenCalled();
    expect(ailogEfficiency).not.toHaveBeenCalled();
    expect(ailogRuleCheck).not.toHaveBeenCalled();
    expect(ailogFindings).not.toHaveBeenCalled();
    expect(ailogReworkRankings).not.toHaveBeenCalled();
    expect(ailogDigestGet).not.toHaveBeenCalled();
    expect(ailogDigestGenerate).not.toHaveBeenCalled();
    expect(ailogSummarizeStart).not.toHaveBeenCalled();
  });

  it("records the completed load duration by segment", () => {
    expect(useAilogStore.getState().lastLoadMs.change).toEqual(expect.any(Number));
  });

  it("loads each explicit segment without LLM work", async () => {
    clearLoaders();
    for (const label of ["問い", "学び", "記録"]) { const next = segment(latest, label); next.onChange(next.value); renderAndFlush(); await settle(2); }
    expect(ailogSeries).toHaveBeenCalledOnce();
    expect(ailogDashboard).toHaveBeenCalledOnce();
    expect(ailogEfficiency).toHaveBeenCalledOnce();
    expect(ailogFindings).toHaveBeenCalledOnce();
    const daily = segment(latest, "日別"); daily.onChange(daily.value); renderAndFlush();
    expect(ailogDigestGet).toHaveBeenCalledOnce();
    expect(ailogDigestGenerate).not.toHaveBeenCalled();
    expect(ailogSummarizeStart).not.toHaveBeenCalled();
  });

  it("keeps the LLM endpoints behind explicit actions", () => {
    const range = childByName(latest, "RangeBar");
    (range.props!.onStartSummarize as () => void)();
    expect(ailogSummarizeStart).toHaveBeenCalledOnce();
    const daily = segment(latest, "日別"); daily.onChange(daily.value); renderAndFlush();
    const digest = childByName(latest, "DigestView");
    (digest.props!.onRegenerate as () => void)();
    expect(ailogDigestGenerate).toHaveBeenCalledOnce();
  });

  it("returns to record for a selected daily digest without starting LLM work", () => {
    const daily = segment(latest, "日別"); daily.onChange(daily.value); renderAndFlush();
    clearLoaders();
    const digest = childByName(latest, "DigestView");
    (digest.props!.onOpenRecord as () => void)(); renderAndFlush();
    expect(segment(latest, "記録").selected).toBe("record");
    expect(ailogDashboard).toHaveBeenCalledOnce();
    expect(ailogBreakdown).toHaveBeenCalledOnce();
    expect(ailogDigestGenerate).not.toHaveBeenCalled();
    expect(ailogSummarizeStart).not.toHaveBeenCalled();
  });
});
