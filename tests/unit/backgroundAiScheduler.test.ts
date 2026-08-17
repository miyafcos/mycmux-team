import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import { __resetBackgroundAiSchedulerForTests, useBackgroundAiSuggestionStore } from "../../src/lib/backgroundAiScheduler";
import { createBatch, sealBatch } from "../../src/lib/dispatchBatch";
import { logicalSessionId } from "../../src/lib/logicalSessionId";
import { useAiSettingsStore } from "../../src/stores/aiSettingsStore";
import { __resetReportInboxStoreForTests, useReportInboxStore } from "../../src/stores/reportInboxStore";
import { useSettingsStore } from "../../src/stores/settingsStore";

const NOW = Date.parse("2026-08-15T12:00:00.000Z");

function status(revision: number) {
  return {
    server_epoch: "epoch-a",
    session_id: "session-a",
    session_revision: revision,
    status: {
      lifecycle: "running",
      attention: { kind: "done", state_since: NOW + revision, detail: null },
    },
  } as never;
}

function judgeResult(label = "残りを確認") {
  return {
    oneLine: "次の具体案です",
    completionAssessment: "待機中です",
    nextActions: [{ label, prompt: "残りの作業を確認して続けて" }],
  };
}

function registerReportBatch(batchId = "batch-ai") {
  const batch = sealBatch(createBatch([{
    logicalSessionId: logicalSessionId("tab-ai"), instructionRef: "session-a", label: "AI対象",
  }], { batchId }));
  useReportInboxStore.getState().registerSealedDispatchBatch({
    batch,
    commandKind: "plain",
    members: [{
      logicalSessionId: logicalSessionId("tab-ai"),
      ptySessionId: "session-a",
      label: "AI対象",
      delivery: { state: "confirmed", detail: "送達確認済み" },
    }],
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mocks.invoke.mockReset();
  __resetReportInboxStoreForTests();
  __resetBackgroundAiSchedulerForTests();
  useSettingsStore.setState({ replyDraftSuggestionsEnabled: false });
  useAiSettingsStore.setState({ aiEnabled: true, aiProvider: "codex", aiModel: "gpt-5.6-luna" });
});

afterEach(() => {
  __resetBackgroundAiSchedulerForTests();
  __resetReportInboxStoreForTests();
  vi.useRealTimers();
});

describe("backgroundAiScheduler", () => {
  it("does not invoke for a status event while the feature is off", () => {
    useReportInboxStore.getState().ingestStatusEvent(status(1));
    registerReportBatch();
    useReportInboxStore.getState().ingestBatchCompletionEvidence("batch-ai", "session-a", {
      source: "livebrief", kind: "turn-ended", observedAt: NOW, sourceRef: "turn-ai",
    });
    vi.advanceTimersByTime(2_000);
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(useReportInboxStore.getState().dispatchBatchesById["batch-ai"]?.batch.publishedSummaryRevision).toBe(1);
  });

  it("waits for a domain status event, debounces it, and dedupes its key", async () => {
    useSettingsStore.setState({ replyDraftSuggestionsEnabled: true });
    mocks.invoke.mockResolvedValue(judgeResult());
    useReportInboxStore.getState().ingestStatusEvent(status(1));
    await vi.advanceTimersByTimeAsync(1_499);
    expect(mocks.invoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.invoke).toHaveBeenCalledWith("run_next_action_judge", expect.objectContaining({
      sessionId: "session-a",
      cycleKey: "status:session-a",
      promptVersion: "next-action-v1",
    }));
    await Promise.resolve();
    expect(useBackgroundAiSuggestionStore.getState().bySession["session-a"]?.status).toBe("ready");
    useReportInboxStore.getState().ingestStatusEvent(status(1));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.invoke.mock.calls.filter(([name]) => name === "run_next_action_judge")).toHaveLength(1);
  });

  it("discards an older revision result and leaves machine suggestions usable on failure", async () => {
    useSettingsStore.setState({ replyDraftSuggestionsEnabled: true });
    let resolveOld: ((value: unknown) => void) | undefined;
    mocks.invoke.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    useReportInboxStore.getState().ingestStatusEvent(status(1));
    await vi.advanceTimersByTimeAsync(1_500);
    useReportInboxStore.getState().ingestStatusEvent(status(2));
    resolveOld?.(judgeResult("old result"));
    await Promise.resolve();
    expect(useBackgroundAiSuggestionStore.getState().bySession["session-a"]?.nextActions).not.toEqual([
      expect.objectContaining({ label: "old result" }),
    ]);
    mocks.invoke.mockImplementation((name: string) => (
      name === "run_next_action_judge" ? Promise.reject(new Error("offline")) : Promise.resolve(false)
    ));
    await vi.advanceTimersByTimeAsync(1_500);
    await Promise.resolve();
    expect(useBackgroundAiSuggestionStore.getState().bySession["session-a"]?.status).toBe("failed");
  });

  it("blocks a likely provider/model mismatch before it reaches the CLI", async () => {
    useSettingsStore.setState({ replyDraftSuggestionsEnabled: true });
    useAiSettingsStore.setState({ aiEnabled: true, aiProvider: "codex", aiModel: "claude-haiku-4-5" });
    mocks.invoke.mockResolvedValue(judgeResult());
    useReportInboxStore.getState().ingestStatusEvent(status(1));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.invoke.mock.calls.filter(([name]) => name === "run_next_action_judge")).toHaveLength(0);
    const suggestion = useBackgroundAiSuggestionStore.getState().bySession["session-a"];
    expect(suggestion?.status).toBe("failed");
    expect(suggestion?.failureCode).toBe("provider_model_mismatch");
  });

  it("keeps the rejected error code so the failure can name its own reason", async () => {
    useSettingsStore.setState({ replyDraftSuggestionsEnabled: true });
    mocks.invoke.mockImplementation((name: string) => (
      name === "run_next_action_judge"
        ? Promise.reject({ code: "cli_not_found", detail: "codex not on PATH" })
        : Promise.resolve(false)
    ));
    useReportInboxStore.getState().ingestStatusEvent(status(1));
    await vi.advanceTimersByTimeAsync(1_500);
    await Promise.resolve();
    const suggestion = useBackgroundAiSuggestionStore.getState().bySession["session-a"];
    expect(suggestion?.status).toBe("failed");
    expect(suggestion?.failureCode).toBe("cli_not_found");
  });

  it("falls back to internal when the rejection carries no recoverable code", async () => {
    useSettingsStore.setState({ replyDraftSuggestionsEnabled: true });
    mocks.invoke.mockImplementation((name: string) => (
      name === "run_next_action_judge" ? Promise.reject(new Error("offline")) : Promise.resolve(false)
    ));
    useReportInboxStore.getState().ingestStatusEvent(status(1));
    await vi.advanceTimersByTimeAsync(1_500);
    await Promise.resolve();
    expect(useBackgroundAiSuggestionStore.getState().bySession["session-a"]?.failureCode).toBe("internal");
  });

  it("uses the existing scheduler for a report-summary purpose after a mechanical revision", async () => {
    useSettingsStore.setState({ replyDraftSuggestionsEnabled: true });
    mocks.invoke.mockResolvedValue(judgeResult("report"));
    registerReportBatch("batch-summary");
    useReportInboxStore.getState().ingestBatchCompletionEvidence("batch-summary", "session-a", {
      source: "livebrief", kind: "turn-ended", observedAt: NOW, sourceRef: "turn-summary",
    });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(mocks.invoke).toHaveBeenCalledWith("run_next_action_judge", expect.objectContaining({
      sessionId: "batch-summary",
      purpose: "report-summary",
      promptVersion: "report-summary-v1",
      conversationExcerpt: expect.stringContaining("target=1 received=1 reflected=1 missing=0 needsJudgment=0"),
    }));
    await Promise.resolve();
    expect(useBackgroundAiSuggestionStore.getState().byReportBatch["batch-summary"]?.status).toBe("ready");
  });
});
