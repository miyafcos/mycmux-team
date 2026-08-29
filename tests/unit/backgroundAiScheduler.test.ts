import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import {
  __resetBackgroundAiSchedulerForTests,
  observeActiveSession,
  retryActiveSession,
  useBackgroundAiSuggestionStore,
} from "../../src/lib/backgroundAiScheduler";
import { createBatch, sealBatch } from "../../src/lib/dispatchBatch";
import { logicalSessionId } from "../../src/lib/logicalSessionId";
import { useAiSettingsStore } from "../../src/stores/aiSettingsStore";
import { __resetReportInboxStoreForTests, useReportInboxStore } from "../../src/stores/reportInboxStore";
import { useSettingsStore } from "../../src/stores/settingsStore";

const NOW = Date.parse("2026-08-20T12:00:00.000Z");

function target(sessionId = "session-a", eventSeq = 1, overrides: Record<string, unknown> = {}) {
  return {
    sessionId,
    displayState: "done" as const,
    questionActive: false,
    eventSeq,
    tabLabel: "Target tab",
    cwd: "C:\\work\\target",
    ...overrides,
  };
}

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

function judgeResult(label = "Check remaining") {
  return {
    oneLine: "Suggested next action",
    completionAssessment: "Waiting for direction",
    nextActions: [{ label, prompt: "Check the remaining work and continue" }],
  };
}

function registerReportBatch(batchId = "batch-ai") {
  const batch = sealBatch(createBatch([{
    logicalSessionId: logicalSessionId("tab-ai"), instructionRef: "session-a", label: "AI target",
  }], { batchId }));
  useReportInboxStore.getState().registerSealedDispatchBatch({
    batch,
    commandKind: "plain",
    members: [{
      logicalSessionId: logicalSessionId("tab-ai"),
      ptySessionId: "session-a",
      label: "AI target",
      delivery: { state: "confirmed", detail: "confirmed" },
    }],
  });
}

function judgeCalls() {
  return mocks.invoke.mock.calls.filter(([name]) => name === "run_next_action_judge");
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
  it("does not invoke when the feature flags are off", async () => {
    observeActiveSession(target());
    await vi.advanceTimersByTimeAsync(1_500);
    expect(judgeCalls()).toHaveLength(0);
  });

  it("schedules the active eligible session without a frontend excerpt", async () => {
    useSettingsStore.setState({ replyDraftSuggestionsEnabled: true });
    mocks.invoke.mockResolvedValue(judgeResult());
    observeActiveSession(target());
    await vi.advanceTimersByTimeAsync(1_500);
    const calls = judgeCalls();
    expect(calls).toHaveLength(1);
    const args = calls[0]?.[1] as Record<string, unknown>;
    expect(args).toMatchObject({
      sessionId: "session-a",
      cycleKey: "active:session-a",
      promptVersion: "next-action-v2",
      purpose: "next-action",
      tabLabel: "Target tab",
      cwd: "C:\\work\\target",
    });
    expect(args).not.toHaveProperty("conversationExcerpt");
  });

  it("reuses a ready result for the same event and reschedules on a new event", async () => {
    useSettingsStore.setState({ replyDraftSuggestionsEnabled: true });
    mocks.invoke.mockResolvedValue(judgeResult());
    observeActiveSession(target());
    await vi.advanceTimersByTimeAsync(1_500);
    await Promise.resolve();
    expect(useBackgroundAiSuggestionStore.getState().bySession["session-a"]?.status).toBe("ready");
    observeActiveSession(target());
    await vi.advanceTimersByTimeAsync(1_500);
    expect(judgeCalls()).toHaveLength(1);
    observeActiveSession(target("session-a", 2));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(judgeCalls()).toHaveLength(2);
  });

  it("lets a started judge finish after switching so the next visit is instant", async () => {
    // Until 2026-08-30 switching sessions aborted the running judge: 22 of 27
    // real runs were cancelled that way and only 5 ever produced anything.
    // The result is keyed by session, so finishing it is what makes coming
    // back instant.
    useSettingsStore.setState({ replyDraftSuggestionsEnabled: true });
    let resolveOld: ((value: unknown) => void) | undefined;
    mocks.invoke.mockImplementation((name: string) => {
      if (name === "run_next_action_judge") return new Promise((resolve) => { resolveOld = resolve; });
      return Promise.resolve(true);
    });
    observeActiveSession(target("session-a"));
    await vi.advanceTimersByTimeAsync(1_500);
    observeActiveSession(target("session-b"));
    expect(mocks.invoke).not.toHaveBeenCalledWith("abort_next_action_judge", expect.anything());
    expect(useBackgroundAiSuggestionStore.getState().bySession["session-a"]?.status).toBe("loading");
    resolveOld?.(judgeResult("Old result"));
    await Promise.resolve();
    expect(useBackgroundAiSuggestionStore.getState().bySession["session-a"]?.status).toBe("ready");
  });

  it("runs at most two judges at once and drops the oldest waiting one", async () => {
    useSettingsStore.setState({ replyDraftSuggestionsEnabled: true });
    const resolvers: Array<(value: unknown) => void> = [];
    mocks.invoke.mockImplementation((name: string) => {
      if (name === "run_next_action_judge") return new Promise((resolve) => { resolvers.push(resolve); });
      return Promise.resolve(true);
    });
    // Seven visited sessions: two run, four wait, and the oldest waiting one
    // is dropped once the queue is full.
    for (let index = 0; index < 7; index += 1) {
      observeActiveSession(target(`session-${index}`, index + 1));
      await vi.advanceTimersByTimeAsync(1_500);
    }
    expect(judgeCalls()).toHaveLength(2);
    const store = () => useBackgroundAiSuggestionStore.getState().bySession;
    expect(store()["session-0"]?.status).toBe("loading");
    expect(store()["session-2"]).toBeUndefined();
    expect(store()["session-6"]?.status).toBe("loading");

    resolvers[0]?.(judgeResult("first"));
    await vi.advanceTimersByTimeAsync(0);
    // A finished judge hands its slot to the next session in the queue.
    expect(judgeCalls()).toHaveLength(3);
    expect(store()["session-0"]?.status).toBe("ready");
  });

  it("does not schedule running or question-active targets and clears loading state", async () => {
    useSettingsStore.setState({ replyDraftSuggestionsEnabled: true });
    observeActiveSession(target());
    expect(useBackgroundAiSuggestionStore.getState().bySession["session-a"]?.status).toBe("loading");
    observeActiveSession(target("session-a", 1, { displayState: "running" }));
    expect(useBackgroundAiSuggestionStore.getState().bySession["session-a"]).toBeUndefined();
    observeActiveSession(target("session-b", 1, { questionActive: true }));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(judgeCalls()).toHaveLength(0);
  });

  it("does not schedule from the removed status-card trigger", async () => {
    useSettingsStore.setState({ replyDraftSuggestionsEnabled: true });
    useReportInboxStore.getState().ingestStatusEvent(status(1));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(judgeCalls()).toHaveLength(0);
  });

  it("keeps report-summary scheduling and its caller-supplied excerpt", async () => {
    useSettingsStore.setState({ replyDraftSuggestionsEnabled: true });
    mocks.invoke.mockResolvedValue(judgeResult("Report summary"));
    registerReportBatch("batch-summary");
    useReportInboxStore.getState().ingestBatchCompletionEvidence("batch-summary", "session-a", {
      source: "livebrief", kind: "turn-ended", observedAt: NOW, sourceRef: "turn-summary",
    });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(mocks.invoke).toHaveBeenCalledWith("run_next_action_judge", expect.objectContaining({
      sessionId: "batch-summary",
      purpose: "report-summary",
      promptVersion: "report-summary-v1",
      conversationExcerpt: expect.any(String),
    }));
  });

  it("clears the session instead of showing a no-context failure", async () => {
    useSettingsStore.setState({ replyDraftSuggestionsEnabled: true });
    mocks.invoke.mockRejectedValue({ code: "no_context" });
    observeActiveSession(target());
    await vi.advanceTimersByTimeAsync(1_500);
    await Promise.resolve();
    expect(useBackgroundAiSuggestionStore.getState().bySession["session-a"]).toBeUndefined();
  });

  it("retries a ready active session with a fresh judge request", async () => {
    useSettingsStore.setState({ replyDraftSuggestionsEnabled: true });
    mocks.invoke.mockResolvedValue(judgeResult());
    observeActiveSession(target());
    await vi.advanceTimersByTimeAsync(1_500);
    await Promise.resolve();
    retryActiveSession();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(judgeCalls()).toHaveLength(2);
  });
});
