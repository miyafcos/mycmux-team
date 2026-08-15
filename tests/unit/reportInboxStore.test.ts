import { afterEach, describe, expect, it } from "vitest";

import type { LiveSessionBrief, SemanticEventEnvelope } from "../../src/lib/livebrief";
import type { SessionStatusChangedPayload } from "../../src/lib/ipc";
import { __resetReportInboxStoreForTests, machineStateForActivity, useReportInboxStore } from "../../src/stores/reportInboxStore";

const SESSION = "pty-1";

function event(eventId: string, kind: SemanticEventEnvelope["kind"]): SemanticEventEnvelope {
  return { eventId, sourceRevision: 1, occurredAt: 1_000, sourceByteStart: 10, sourceByteEnd: 20, kind };
}

function brief(overrides: Partial<LiveSessionBrief> = {}): LiveSessionBrief {
  return {
    ptySessionId: SESSION,
    agentSessionId: "agent-1",
    agentKind: "codex",
    ptyInstanceId: "instance-1",
    ptyGeneration: 1,
    sourceRevision: 1,
    ptyInputRevision: 1,
    task: null,
    latestInstruction: null,
    taskSourceEventIds: [],
    activityKind: null,
    activityText: null,
    activitySourceEventId: null,
    checkpoint: null,
    checkpointEvidenceEventIds: [],
    pendingInputKind: null,
    pendingPrompt: null,
    pendingOptions: [],
    promptEventId: null,
    promptHash: null,
    eventSeq: 1,
    operationalState: "running",
    telemetryHealth: "live",
    lastEventAt: 1_000,
    lastSuccessfulReadAt: 1_000,
    updatedAt: 1_000,
    serviceEpoch: "epoch-1",
    briefRevision: 1,
    ...overrides,
  };
}

function status(overrides: Partial<SessionStatusChangedPayload> = {}): SessionStatusChangedPayload {
  return {
    v: 2,
    kind: "event",
    event: "status.changed",
    server_epoch: "server-1",
    seq: 1,
    session_id: SESSION,
    session_revision: 1,
    status: {
      session_epoch: 1,
      lifecycle: "alive",
      attention: { attention_id: null, kind: "none", detail: null, state_since: 1_000 },
      ui_state: "idle",
    },
    ...overrides,
  };
}

afterEach(() => __resetReportInboxStoreForTests());

describe("reportInboxStore", () => {
  it("uses CompletionEvidence activity vocabulary without creating a synthetic work cycle", () => {
    expect(machineStateForActivity("waiting")).toBe("waiting");
    expect(machineStateForActivity("exited")).toBe("stopped");
    expect(machineStateForActivity("error")).toBe("needsReview");
    expect(machineStateForActivity("completed")).toBeNull();
  });

  it("records an error immediately but never calls a passing test complete", () => {
    useReportInboxStore.getState().ingestSemanticEvents(SESSION, [
      event("test-pass", { type: "testResult", pass: 12, fail: 0 }),
      event("error-1", { type: "error", fingerprint: "f-1", text: "検証に失敗しました" }),
      event("test-fail", { type: "testResult", pass: 11, fail: 1 }),
    ]);

    const cards = useReportInboxStore.getState().cardIds.map((id) => useReportInboxStore.getState().cardsById[id]);
    expect(cards).toHaveLength(2);
    expect(cards.map((card) => card.sourceEventId)).toEqual(["test-fail", "error-1"]);
    expect(cards.every((card) => card.state === "needsReview")).toBe(true);
    expect(cards[0]).not.toHaveProperty("coverage");
    expect(cards[0]).not.toHaveProperty("summaryRevision");
  });

  it("labels a turn-ended brief as waiting, not completed", () => {
    useReportInboxStore.getState().ingestLiveBriefs([brief({ operationalState: "ended" })]);
    const [id] = useReportInboxStore.getState().cardIds;
    expect(useReportInboxStore.getState().cardsById[id]).toMatchObject({
      ptySessionId: SESSION,
      source: "livebrief",
      state: "waiting",
      sourceEventId: "livebrief-ended:epoch-1:pty-1:1",
      syntheticSource: true,
    });
  });

  it("labels process exit as stopped and a status error as needs review", () => {
    useReportInboxStore.getState().ingestStatusEvent(status({
      status: {
        session_epoch: 1,
        lifecycle: "exited",
        attention: { attention_id: null, kind: "none", detail: null, state_since: 2_000 },
        ui_state: "idle",
      },
    }));
    useReportInboxStore.getState().ingestStatusEvent(status({
      seq: 2,
      session_revision: 2,
      status: {
        session_epoch: 1,
        lifecycle: "alive",
        attention: { attention_id: "error-1", kind: "error", detail: "接続を確認してください", state_since: 3_000 },
        ui_state: "error",
      },
    }));

    const cards = useReportInboxStore.getState().cardIds.map((id) => useReportInboxStore.getState().cardsById[id]);
    expect(cards.map((card) => card.state)).toEqual(["needsReview", "stopped"]);
  });

  it("keeps the receive preference in memory with batch as the UI default", () => {
    expect(useReportInboxStore.getState().receiveModeBySession[SESSION] ?? "batch").toBe("batch");
    useReportInboxStore.getState().setReceiveMode(SESSION, "quiet");
    expect(useReportInboxStore.getState().receiveModeBySession[SESSION]).toBe("quiet");
  });
});
