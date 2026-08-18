import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

vi.mock("../../src/lib/ailog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/ailog")>()),
  ailogIndexStart: vi.fn(), ailogIndexStatus: vi.fn(),
  ailogSessionDetail: vi.fn(), ailogSessionSummarize: vi.fn(), ailogSummarizeStatus: vi.fn(),
}));

import { ailogIndexStart, ailogIndexStatus, ailogSessionDetail, ailogSessionSummarize, ailogSummarizeStatus, emptyFilters } from "../../src/lib/ailog";
import { __resetAilogStoreForTests, jobDisplayError, selectionFilters, useAilogStore } from "../../src/stores/ailogStore";

const indexStatus = (lastError: string | null, running = false) => ({ running, filesDone: 0, filesTotal: 0, sessions: 0, lastFinishedAt: 1, lastError });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((res) => { resolve = res; }); return { promise, resolve }; }

describe("AI log store U0", () => {
  beforeEach(() => { __resetAilogStoreForTests(); invokeMock.mockReset().mockResolvedValue({}); vi.mocked(ailogIndexStart).mockReset(); vi.mocked(ailogIndexStatus).mockReset(); vi.mocked(ailogSessionDetail).mockReset(); vi.mocked(ailogSessionSummarize).mockReset(); vi.mocked(ailogSummarizeStatus).mockReset(); });
  afterEach(__resetAilogStoreForTests);

  it("keeps an action failure when its following status refresh succeeds", async () => {
    vi.mocked(ailogIndexStart).mockRejectedValue(new Error("start failed"));
    await useAilogStore.getState().startIndex(false);
    vi.mocked(ailogIndexStatus).mockResolvedValue(indexStatus(null));
    await useAilogStore.getState().refreshIndexStatus();
    expect(useAilogStore.getState().index.actionError).toContain("start failed");
    expect(jobDisplayError(useAilogStore.getState().index)).toContain("start failed");
  });

  it("dismisses a background failure and clears the dismissal when a new run starts", async () => {
    vi.mocked(ailogIndexStatus).mockResolvedValue(indexStatus("old failure"));
    await useAilogStore.getState().refreshIndexStatus();
    useAilogStore.getState().dismissIndexError();
    expect(jobDisplayError(useAilogStore.getState().index)).toBeNull();
    vi.mocked(ailogIndexStart).mockResolvedValue({ started: true, alreadyRunning: false });
    vi.mocked(ailogIndexStatus).mockResolvedValue(indexStatus(null, true));
    await useAilogStore.getState().startIndex(false);
    expect(useAilogStore.getState().index.dismissedError).toBeNull();
  });

  it("starts at most one individual summary while its first request is pending", async () => {
    const pending = deferred<void>();
    vi.mocked(ailogSessionSummarize).mockReturnValue(pending.promise);
    vi.mocked(ailogSessionDetail).mockResolvedValue({} as any);
    vi.mocked(ailogSummarizeStatus).mockResolvedValue({ running: false, sessionsDone: 0, sessionsTotal: 0, sessionsRemaining: 0, lastFinishedAt: 0, lastError: null, elapsedMs: 0, estimatedInputChars: 0, inputTokens: 0, outputTokens: 0 });
    const first = useAilogStore.getState().summarizeSession("codex", "same");
    await useAilogStore.getState().summarizeSession("codex", "same");
    expect(ailogSessionSummarize).toHaveBeenCalledOnce();
    pending.resolve();
    await first;
  });

  it("does not restore a detail that closed while its individual summary was running", async () => {
    const pending = deferred<void>();
    vi.mocked(ailogSessionSummarize).mockReturnValue(pending.promise);
    vi.mocked(ailogSessionDetail).mockResolvedValue({} as any);
    vi.mocked(ailogSummarizeStatus).mockResolvedValue({ running: false, sessionsDone: 0, sessionsTotal: 0, sessionsRemaining: 0, lastFinishedAt: 0, lastError: null, elapsedMs: 0, estimatedInputChars: 0, inputTokens: 0, outputTokens: 0 });
    useAilogStore.setState({ detailKey: { kind: "codex", sessionId: "stale" } });
    const run = useAilogStore.getState().summarizeSession("codex", "stale");
    useAilogStore.getState().closeDetail();
    pending.resolve();
    await run;
    expect(ailogSessionDetail).not.toHaveBeenCalled();
    expect(useAilogStore.getState().detailKey).toBeNull();
    expect(useAilogStore.getState().detail).toBeNull();
  });

  it("sends options.groupBy on refreshUsage", async () => {
    useAilogStore.getState().setUsageSeriesAxis("model_raw");
    await useAilogStore.getState().refreshUsage();
    const seriesCall = invokeMock.mock.calls.find((call) => call[0] === "ailog_series");
    expect(seriesCall?.[1]).toMatchObject({ options: { groupBy: "model_raw" } });
  });

  it("sends project groupBy directly and derives family granularity", async () => {
    useAilogStore.getState().setUsageSeriesAxis("project");
    expect(useAilogStore.getState().granularity).toBe("family");
    await useAilogStore.getState().refreshUsage();
    const seriesCall = invokeMock.mock.calls.find((call) => call[0] === "ailog_series");
    expect(seriesCall?.[1]).toMatchObject({ options: { groupBy: "project" } });
  });

  it("sends pivot rowBy/colBy and auto-switches a duplicate axis", async () => {
    useAilogStore.getState().setPivotRowBy("model_raw");
    expect(useAilogStore.getState().pivotRowBy).toBe("model_raw");
    expect(useAilogStore.getState().pivotColBy).toBe("project");
    await Promise.resolve();
    const pivotCall = invokeMock.mock.calls.find((call) => call[0] === "ailog_pivot");
    expect(pivotCall?.[1]).toMatchObject({ options: { rowBy: "model_raw", colBy: "project" } });
  });

  it("sends filters.includeSidechain rather than snake_case", async () => {
    useAilogStore.getState().setIncludeSidechain(true);
    await useAilogStore.getState().refreshUsage();
    const seriesCall = invokeMock.mock.calls.find((call) => call[0] === "ailog_series");
    const filters = (seriesCall?.[1] as { filters: Record<string, unknown> } | undefined)?.filters;
    expect(filters).toMatchObject({ includeSidechain: true });
    expect(filters).not.toHaveProperty("include_sidechain");
  });
});

describe("selectionFilters", () => {
  it("puts model and project on the filters together", () => {
    const filters = selectionFilters(emptyFilters(), {
      model: { key: "gpt-5.6-sol", label: "gpt-5.6-sol" },
      project: { key: "mycmux", label: "mycmux" },
    });
    expect(filters.models).toEqual(["gpt-5.6-sol"]);
    expect(filters.projects).toEqual(["mycmux"]);
  });

  it("puts a model-only selection on models", () => {
    const filters = selectionFilters(emptyFilters(), {
      model: { key: "gpt-5.6-sol", label: "gpt-5.6-sol" },
    });
    expect(filters.models).toEqual(["gpt-5.6-sol"]);
    expect(filters.projects).toEqual([]);
  });

  it("puts a project-only selection on projects", () => {
    const filters = selectionFilters(emptyFilters(), {
      project: { key: "mycmux", label: "mycmux" },
    });
    expect(filters.models).toEqual([]);
    expect(filters.projects).toEqual(["mycmux"]);
  });

  it("passes filters through when selection is null", () => {
    const base = emptyFilters();
    expect(selectionFilters(base, null)).toBe(base);
  });
});
