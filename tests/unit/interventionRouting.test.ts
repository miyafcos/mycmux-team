import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  InterventionResult,
  LiveSessionBrief,
  PendingOption,
  SemanticEvent,
  SemanticEventEnvelope,
} from "../../src/lib/livebrief";

// send_intervention は Rust 側の invoke。ここでは「返ってきた結果で brief を
// 書き換えないこと」を見たいだけなので、返り値だけ差し替える。
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

const {
  canSendIntervention,
  questionModel,
  resolveComposerRoute,
  runIntervention,
  useInterventionFeedbackStore,
} = await import("../../src/components/dashboard/interventionRouting");
const { useLiveBriefStore } = await import("../../src/stores/liveBriefStore");

function brief(overrides: Partial<LiveSessionBrief> = {}): LiveSessionBrief {
  return {
    ptySessionId: "pty-1",
    agentSessionId: "agent-1",
    agentKind: "claude",
    ptyInstanceId: "inst-1",
    ptyGeneration: 1,
    sourceRevision: 7,
    ptyInputRevision: 3,
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
    promptEventId: "prompt-1",
    promptHash: "hash-1",
    eventSeq: 12,
    operationalState: "running",
    telemetryHealth: "live",
    lastEventAt: 1_000,
    lastSuccessfulReadAt: 1_000,
    updatedAt: 1_000,
    serviceEpoch: "epoch-1",
    briefRevision: 4,
    ...overrides,
  };
}

let sequence = 0;
function envelope(kind: SemanticEvent): SemanticEventEnvelope {
  sequence += 1;
  return {
    eventId: `e${sequence}`,
    sourceRevision: sequence,
    occurredAt: 1_000 + sequence,
    sourceByteStart: 0,
    sourceByteEnd: 1,
    kind,
  };
}

const options: PendingOption[] = [
  { id: "yes", label: "はい" },
  { id: "no", label: "いいえ" },
];

describe("resolveComposerRoute", () => {
  it("routes a live needsHuman brief through the intervention path", () => {
    expect(resolveComposerRoute(brief({ operationalState: "needsHuman" }), true)).toEqual({ kind: "intervention" });
  });

  it("keeps the composer usable while the agent is running (input is queued by the TUI)", () => {
    expect(resolveComposerRoute(brief({ operationalState: "running" }), true))
      .toEqual({ kind: "paneSendText" });
  });

  it("falls back to raw pane input when the agent is ready or in any other live state", () => {
    expect(resolveComposerRoute(brief({ operationalState: "ready" }), true)).toEqual({ kind: "paneSendText" });
    expect(resolveComposerRoute(brief({ operationalState: "somethingElse" }), true)).toEqual({ kind: "paneSendText" });
  });

  it("falls back to raw pane input for ended, unlinked, and unreadable telemetry", () => {
    for (const telemetryHealth of ["ended", "unlinked", "unavailable"]) {
      expect(resolveComposerRoute(brief({ telemetryHealth, operationalState: "needsHuman" }), true), telemetryHealth)
        .toEqual({ kind: "paneSendText" });
    }
  });

  it("uses the raw pane path when there is no brief at all but a pty exists", () => {
    expect(resolveComposerRoute(undefined, true)).toEqual({ kind: "paneSendText" });
  });

  it("disables everything when the tab was never started", () => {
    expect(resolveComposerRoute(undefined, false)).toEqual({ kind: "disabled", reason: "notStarted" });
    // A Web pane has no PTY to write to, however live its page looks.
    expect(resolveComposerRoute(undefined, true, true)).toEqual({ kind: "disabled", reason: "webPane" });
    expect(resolveComposerRoute(brief({ telemetryHealth: "ended" }), false))
      .toEqual({ kind: "disabled", reason: "notStarted" });
  });
});

describe("questionModel", () => {
  it("prefers the brief's pending question over the event stream", () => {
    const events = [envelope({
      type: "question",
      prompt_event_id: "prompt-old",
      provider_call_id: "call-old",
      prompt: "古い質問",
      kind: "yesNo",
      options: [],
    })];
    const model = questionModel(
      brief({ pendingPrompt: "続けますか?", pendingInputKind: "choice", pendingOptions: options }),
      events,
    );
    expect(model).toEqual({ prompt: "続けますか?", kind: "choice", options, canSend: true });
  });

  it("falls back to the unresolved question in the event stream", () => {
    const events = [envelope({
      type: "question",
      prompt_event_id: "prompt-1",
      provider_call_id: "call-1",
      prompt: "上書きしますか?",
      kind: "yesNo",
      options,
    })];
    expect(questionModel(brief({ pendingPrompt: null }), events)).toEqual({
      prompt: "上書きしますか?",
      kind: "yesNo",
      options,
      canSend: true,
    });
  });

  it("ignores a question that was already resolved", () => {
    const events = [
      envelope({ type: "question", prompt_event_id: "p1", provider_call_id: "c1", prompt: "?", kind: "yesNo", options }),
      envelope({ type: "questionResolved", prompt_event_id: "p1", provider_call_id: "c1" }),
    ];
    expect(questionModel(brief({ pendingPrompt: null }), events)).toBeNull();
    expect(questionModel(undefined, undefined)).toBeNull();
  });

  it("marks canSend false when the prompt identity is missing (fail-closed)", () => {
    const withPrompt = { pendingPrompt: "続けますか?", pendingOptions: options };
    expect(questionModel(brief({ ...withPrompt, promptEventId: null }), [])?.canSend).toBe(false);
    expect(questionModel(brief({ ...withPrompt, promptHash: null }), [])?.canSend).toBe(false);
    expect(canSendIntervention(brief({ promptEventId: null }))).toBe(false);
    expect(canSendIntervention(undefined)).toBe(false);
    expect(canSendIntervention(brief())).toBe(true);
  });
});

describe("runIntervention", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useInterventionFeedbackStore.getState().reset();
    useLiveBriefStore.getState().reset();
  });

  it("never writes when the prompt identity is missing", async () => {
    const result = await runIntervention(brief({ promptEventId: null }), { type: "choose", optionId: "yes" });
    expect(result).toEqual({ type: "rejectedBeforeWrite", reason: "target_missing" });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  // conflict は「対象が変わったので送っていない」だけ。カードを消す・brief を
  // 書き換えるといった状態変更をルーティング層でやらない (再送も撃たない)。
  it("keeps the brief untouched on conflict and does not retry", async () => {
    const target = brief({ operationalState: "needsHuman", pendingPrompt: "続けますか?" });
    useLiveBriefStore.getState().applyBrief(target);
    const conflict: InterventionResult = { type: "conflict", reason: "pty_input_revision", latestBrief: null };
    invokeMock.mockResolvedValue(conflict);

    const result = await runIntervention(target, { type: "choose", optionId: "yes" });

    expect(result).toEqual(conflict);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(useLiveBriefStore.getState().briefsBySession["pty-1"]).toBe(target);
    expect(resolveComposerRoute(useLiveBriefStore.getState().briefsBySession["pty-1"], true))
      .toEqual({ kind: "intervention" });
    expect(questionModel(useLiveBriefStore.getState().briefsBySession["pty-1"], [])?.prompt).toBe("続けますか?");
  });

  it("records the result per target and clears the in-flight flag", async () => {
    const target = brief({ operationalState: "needsHuman" });
    invokeMock.mockResolvedValue({ type: "confirmed", matchedEventId: "e9" });

    const result = await runIntervention(target, { type: "replyText", text: "続けて" });

    expect(result).toEqual({ type: "confirmed", matchedEventId: "e9" });
    const state = useInterventionFeedbackStore.getState();
    const key = "pty-1:inst-1:1:agent-1";
    expect(state.resultByTarget[key]).toEqual({ type: "confirmed", matchedEventId: "e9" });
    expect(state.inFlightByTarget[key]).toBe(false);
  });

  it("reports a transport failure as rejected-before-write instead of resending", async () => {
    invokeMock.mockRejectedValue(new Error("ipc down"));
    const result = await runIntervention(brief(), { type: "choose", optionId: "yes" });
    expect(result).toEqual({ type: "rejectedBeforeWrite", reason: "transport" });
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});
