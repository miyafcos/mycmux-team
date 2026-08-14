import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/ailog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/ailog")>()),
  ailogIndexStart: vi.fn(), ailogIndexStatus: vi.fn(), ailogDigestGenerate: vi.fn(), ailogDigestGet: vi.fn(),
  ailogFindings: vi.fn(), ailogReworkRankings: vi.fn(), ailogSessionDetail: vi.fn(), ailogSessionSummarize: vi.fn(), ailogSummarizeStatus: vi.fn(),
}));

import { ailogDigestGenerate, ailogDigestGet, ailogFindings, ailogIndexStart, ailogIndexStatus, ailogReworkRankings, ailogSessionDetail, ailogSessionSummarize, ailogSummarizeStatus } from "../../src/lib/ailog";
import { __resetAilogStoreForTests, jobDisplayError, useAilogStore } from "../../src/stores/ailogStore";

const indexStatus = (lastError: string | null, running = false) => ({ running, filesDone: 0, filesTotal: 0, sessions: 0, lastFinishedAt: 1, lastError });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((res) => { resolve = res; }); return { promise, resolve }; }

describe("AI log store U0", () => {
  beforeEach(() => { __resetAilogStoreForTests(); vi.mocked(ailogIndexStart).mockReset(); vi.mocked(ailogIndexStatus).mockReset(); vi.mocked(ailogDigestGenerate).mockReset(); vi.mocked(ailogDigestGet).mockReset(); vi.mocked(ailogFindings).mockReset(); vi.mocked(ailogReworkRankings).mockReset(); vi.mocked(ailogSessionDetail).mockReset(); vi.mocked(ailogSessionSummarize).mockReset(); vi.mocked(ailogSummarizeStatus).mockReset(); });
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

  it("hands digest busy ownership to a new date immediately", async () => {
    const pending = deferred<any>();
    vi.mocked(ailogDigestGenerate).mockReturnValue(pending.promise);
    vi.mocked(ailogDigestGet).mockResolvedValue({ date: "2026-08-12", digest: null, reason: null, parseError: null });
    const run = useAilogStore.getState().generateDigest();
    expect(useAilogStore.getState().digestGenerating).toBe(true);
    useAilogStore.getState().setDigestDate("2026-08-13");
    expect(useAilogStore.getState().digestGenerating).toBe(false);
    pending.resolve({ date: "2026-08-12", digest: null, reason: null, parseError: null });
    await run;
    expect(useAilogStore.getState().digestGenerating).toBe(false);
  });

  it("advances learning pagination by raw rows and drops duplicate visible IDs", async () => {
    vi.mocked(ailogFindings)
      .mockResolvedValueOnce({ total: 3, rows: [
        { text: "keep", kind: "gotcha", sessionId: "one", sessionKind: "codex", date: 1, goalSummary: null, projectLabel: null, costUsd: 0, repeatCount: 1 },
        { text: "skip", kind: "decision", sessionId: "two", sessionKind: "codex", date: 2, goalSummary: null, projectLabel: null, costUsd: 0, repeatCount: 1 },
      ] })
      .mockResolvedValueOnce({ total: 3, rows: [
        { text: "keep", kind: "gotcha", sessionId: "one", sessionKind: "codex", date: 1, goalSummary: null, projectLabel: null, costUsd: 0, repeatCount: 1 },
      ] });
    await useAilogStore.getState().refreshLearning({ kinds: ["gotcha"], includeRankings: false });
    await useAilogStore.getState().refreshLearning({ append: true, kinds: ["gotcha"], includeRankings: false });
    expect(vi.mocked(ailogFindings).mock.calls[1]?.[2]).toMatchObject({ offset: 2 });
    expect(useAilogStore.getState().findings?.rows.map((row) => row.sessionId)).toEqual(["one"]);
    expect(useAilogStore.getState().learningHasMore).toBe(false);
  });

  it("invalidates an older learning request when its query changes", async () => {
    const older = deferred<any>();
    vi.mocked(ailogFindings).mockReturnValueOnce(older.promise).mockResolvedValueOnce({ total: 1, rows: [
      { text: "new", kind: "gotcha", sessionId: "new", sessionKind: "codex", date: 1, goalSummary: null, projectLabel: null, costUsd: 0, repeatCount: 1 },
    ] });
    const first = useAilogStore.getState().refreshLearning({ kinds: ["gotcha"], includeRankings: false });
    useAilogStore.getState().setFindingQuery("new");
    await useAilogStore.getState().refreshLearning({ kinds: ["gotcha"], includeRankings: false });
    older.resolve({ total: 1, rows: [{ text: "old", kind: "gotcha", sessionId: "old", sessionKind: "codex", date: 1, goalSummary: null, projectLabel: null, costUsd: 0, repeatCount: 1 }] });
    await first;
    expect(useAilogStore.getState().findings?.rows.map((row) => row.text)).toEqual(["new"]);
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
});
