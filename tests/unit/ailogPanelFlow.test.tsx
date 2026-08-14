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
  useRef: <T,>(initial: T) => runtime.harness!.useRef(initial),
  useCallback: <T,>(callback: T, deps: unknown[]) => runtime.harness!.useCallback(callback, deps),
}));

vi.mock("../../src/stores/ailogStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/stores/ailogStore")>();
  const hook = Object.assign(() => actual.useAilogStore.getState(), actual.useAilogStore);
  return { ...actual, useAilogStore: hook };
});

vi.mock("../../src/stores/aiSettingsStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/stores/aiSettingsStore")>();
  const hook = Object.assign(<T,>(selector: (state: ReturnType<typeof actual.useAiSettingsStore.getState>) => T) => selector(actual.useAiSettingsStore.getState()), actual.useAiSettingsStore);
  return { ...actual, useAiSettingsStore: hook };
});

vi.mock("../../src/lib/ailog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/ailog")>()),
  ailogIndexStatus: vi.fn(), ailogSummarizeStatus: vi.fn(), ailogSeries: vi.fn(), ailogUsageRhythm: vi.fn(),
  ailogDashboard: vi.fn(), ailogBreakdown: vi.fn(), ailogGetPrices: vi.fn(), ailogEfficiency: vi.fn(), ailogRuleCheck: vi.fn(),
  ailogDigestGet: vi.fn(), ailogFindings: vi.fn(), ailogReworkRankings: vi.fn(),
  ailogDigestGenerate: vi.fn(), ailogSummarizeStart: vi.fn(), ailogSessionSummarize: vi.fn(),
  ailogSessionDetail: vi.fn(), ailogSessionTranscript: vi.fn(),
  listenIndexProgress: vi.fn(), listenSummarizeProgress: vi.fn(),
}));

import { AiLogPanel as renderPanel } from "../../src/components/ailog/AiLogPanel";
import {
  ailogBreakdown, ailogDashboard, ailogDigestGenerate, ailogDigestGet, ailogEfficiency, ailogFindings,
  ailogGetPrices, ailogIndexStatus, ailogReworkRankings, ailogRuleCheck, ailogSeries, ailogSessionSummarize,
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
  const found = collect(tree).find((element) => typeof element.type === "function" && (element.type as { name?: string }).name === name);
  if (!found) throw new Error(`component not found: ${name}`);
  return found;
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

function clearLoaders() {
  [ailogSeries, ailogUsageRhythm, ailogDashboard, ailogBreakdown, ailogGetPrices, ailogEfficiency, ailogRuleCheck, ailogDigestGet, ailogFindings, ailogReworkRankings].forEach((mock) => vi.mocked(mock).mockClear());
}

beforeEach(() => {
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
  vi.mocked(ailogGetPrices).mockReset().mockResolvedValue([]);
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
  useAilogStore.setState((state) => ({ index: { ...state.index, status: idleIndex }, summarize: { ...state.summarize, status: idleSummary } }));
  renderAndFlush();
});

afterEach(() => {
  harness.unmount();
  runtime.harness = null;
  vi.restoreAllMocks();
});

describe("AI log panel loader flow", () => {
  it("opens with status and the visible usage loader only", () => {
    expect(ailogIndexStatus).toHaveBeenCalledOnce();
    expect(ailogSummarizeStatus).toHaveBeenCalledOnce();
    expect(ailogSeries).toHaveBeenCalledOnce();
    expect(ailogUsageRhythm).toHaveBeenCalledOnce();
    expect(ailogDashboard).not.toHaveBeenCalled();
    expect(ailogDigestGet).not.toHaveBeenCalled();
    expect(ailogFindings).not.toHaveBeenCalled();
    expect(ailogDigestGenerate).not.toHaveBeenCalled();
    expect(ailogSummarizeStart).not.toHaveBeenCalled();
    expect(ailogSessionSummarize).not.toHaveBeenCalled();
  });

  it("loads exactly the selected segment without starting LLM work", () => {
    clearLoaders();
    const what = segment(latest, "何に"); what.onChange(what.value); renderAndFlush();
    expect(ailogDashboard).toHaveBeenCalledOnce();
    expect(ailogBreakdown).toHaveBeenCalledOnce();
    expect(ailogGetPrices).toHaveBeenCalledOnce();
    clearLoaders();
    const how = segment(latest, "使い方で変わる？"); how.onChange(how.value); renderAndFlush();
    expect(ailogEfficiency).toHaveBeenCalledOnce();
    expect(ailogRuleCheck).toHaveBeenCalledOnce();
    clearLoaders();
    button(latest, "わかったこと").props.onClick(); renderAndFlush();
    expect(ailogDigestGet).toHaveBeenCalledOnce();
    clearLoaders();
    const recurring = segment(latest, "何度も起きてること"); recurring.onChange(recurring.value); renderAndFlush();
    expect(ailogFindings).toHaveBeenCalledOnce();
    expect(ailogReworkRankings).toHaveBeenCalledOnce();
    clearLoaders();
    const decisions = segment(latest, "決めたこと"); decisions.onChange(decisions.value); renderAndFlush();
    expect(ailogFindings).toHaveBeenCalledOnce();
    expect(ailogReworkRankings).not.toHaveBeenCalled();
    expect(ailogDigestGenerate).not.toHaveBeenCalled();
    expect(ailogSummarizeStart).not.toHaveBeenCalled();
  });

  it("uses one request for bucket and digest-date changes, but none for client-only session controls", () => {
    clearLoaders();
    useAilogStore.getState().setUsageBucket("week"); renderAndFlush();
    expect(ailogSeries).toHaveBeenCalledOnce();
    expect(ailogUsageRhythm).toHaveBeenCalledOnce();
    clearLoaders();
    useAilogStore.getState().setSessionSort("recent");
    useAilogStore.getState().setSessionPage(1);
    useAilogStore.getState().setTopN("model", 3);
    renderAndFlush();
    expect(ailogSeries).not.toHaveBeenCalled();
    expect(ailogDashboard).not.toHaveBeenCalled();
    button(latest, "わかったこと").props.onClick(); renderAndFlush();
    clearLoaders();
    const digest = childByName(latest, "DigestView");
    (digest.props!.onNext as () => void)(); renderAndFlush();
    expect(ailogDigestGet).toHaveBeenCalledOnce();
    expect(ailogDigestGenerate).not.toHaveBeenCalled();
  });

  it("refetches visible findings once for query changes and clears an incompatible kind on segment change", () => {
    button(latest, "わかったこと").props.onClick(); renderAndFlush();
    const recurring = segment(latest, "何度も起きてること"); recurring.onChange(recurring.value); renderAndFlush();
    clearLoaders();
    const learning = childByName(latest, "LearningView");
    (learning.props!.onKindChange as (kind: "gotcha") => void)("gotcha"); renderAndFlush();
    expect(ailogFindings).toHaveBeenCalledOnce();
    clearLoaders();
    (childByName(latest, "LearningView").props!.onQueryChange as (query: string) => void)("needle"); renderAndFlush();
    expect(ailogFindings).toHaveBeenCalledOnce();
    clearLoaders();
    const decisions = segment(latest, "決めたこと"); decisions.onChange(decisions.value); renderAndFlush();
    expect(ailogFindings).toHaveBeenCalledOnce();
    expect(vi.mocked(ailogFindings).mock.calls[0]?.[2]).toMatchObject({ kind: null, query: "needle" });
  });

  it("keeps AI actions explicit and exposes the disabled state without blocking saved-data loaders", () => {
    useAiSettingsStore.getState().setAiEnabled(false);
    renderAndFlush();
    const range = childByName(latest, "RangeBar");
    expect(range.props?.aiDisabledReason).toBeTruthy();
    clearLoaders();
    button(latest, "わかったこと").props.onClick(); renderAndFlush();
    expect(ailogDigestGet).toHaveBeenCalledOnce();
    expect(ailogDigestGenerate).not.toHaveBeenCalled();
    expect(ailogSummarizeStart).not.toHaveBeenCalled();
  });

  it("starts each LLM API only from its explicit panel action", () => {
    const range = childByName(latest, "RangeBar");
    (range.props!.onStartSummarize as () => void)();
    expect(ailogSummarizeStart).toHaveBeenCalledOnce();
    button(latest, "わかったこと").props.onClick(); renderAndFlush();
    const digest = childByName(latest, "DigestView");
    (digest.props!.onRegenerate as () => void)();
    expect(ailogDigestGenerate).toHaveBeenCalledOnce();
    expect(ailogSessionSummarize).not.toHaveBeenCalled();
  });

  it("retries a digest GET without generating a new digest", () => {
    button(latest, "わかったこと").props.onClick(); renderAndFlush();
    clearLoaders();
    const digest = childByName(latest, "DigestView");
    (digest.props!.onRetry as () => void)();
    expect(ailogDigestGet).toHaveBeenCalledOnce();
    expect(ailogDigestGenerate).not.toHaveBeenCalled();
  });

  it("follows both cross-surface links with one saved-data load and no LLM work", () => {
    clearLoaders();
    const usage = childByName(latest, "UsageView");
    (usage.props!.onOpenDigest as (day: number) => void)(1_723_456_000_000); renderAndFlush();
    expect(ailogDigestGet).toHaveBeenCalledOnce();
    expect(ailogDigestGenerate).not.toHaveBeenCalled();
    clearLoaders();
    const recurring = segment(latest, "何度も起きてること"); recurring.onChange(recurring.value); renderAndFlush();
    clearLoaders();
    const learning = childByName(latest, "LearningView");
    (learning.props!.onOpenBreakdown as (day: number) => void)(1_723_456_000_000); renderAndFlush();
    expect(ailogDashboard).toHaveBeenCalledOnce();
    expect(ailogBreakdown).toHaveBeenCalledOnce();
    expect(ailogGetPrices).toHaveBeenCalledOnce();
    expect(ailogDigestGenerate).not.toHaveBeenCalled();
    expect(ailogSummarizeStart).not.toHaveBeenCalled();
  });

  it("retains the custom range while resetting only the panel surface and segment on reopen", () => {
    const range = childByName(latest, "RangeBar");
    (range.props!.onCustomRange as (from: string, to: string) => void)("2026-08-01", "2026-08-03"); renderAndFlush();
    const expectedRange = vi.mocked(ailogSeries).mock.calls.at(-1)?.[0];
    button(latest, "わかったこと").props.onClick(); renderAndFlush();
    panelOpen = false; renderAndFlush();
    panelOpen = true; renderAndFlush();
    expect(vi.mocked(ailogSeries).mock.calls.at(-1)?.[0]).toEqual(expectedRange);
    expect(segment(latest, "いつ・どれだけ").selected).toBe("when");
  });

  it("keeps detail as a top overlay and clears it before the panel closes", () => {
    const what = segment(latest, "何に"); what.onChange(what.value); renderAndFlush();
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
});
