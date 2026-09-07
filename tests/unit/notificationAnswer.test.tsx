// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AskQuestionDeps } from "../../src/components/dashboard/askQuestionRouting";
import type { InterventionResult, LiveSessionBrief } from "../../src/lib/livebrief";

const mocks = vi.hoisted(() => ({
  deps: {} as Partial<AskQuestionDeps>,
  intervention: vi.fn<(...args: unknown[]) => Promise<InterventionResult>>(),
}));
vi.mock("../../src/components/dashboard/askQuestionRouting", async (load) => {
  const actual = await load<typeof import("../../src/components/dashboard/askQuestionRouting")>();
  return {
    ...actual,
    submitAskQuestionChoice: (id: string, index: number) => actual.submitAskQuestionChoice(id, index, mocks.deps),
    submitAskQuestionMultiSelect: (id: string) => actual.submitAskQuestionMultiSelect(id, mocks.deps),
    submitAskQuestionReview: (id: string) => actual.submitAskQuestionReview(id, mocks.deps),
  };
});
vi.mock("../../src/lib/livebrief", async (load) => ({
  ...await load<typeof import("../../src/lib/livebrief")>(),
  sendIntervention: mocks.intervention,
}));
vi.mock("../../src/lib/ipc");
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
import { dashboardStrings } from "../../src/components/dashboard/dashboardStrings";
import { NotificationAnswer } from "../../src/components/layout/NotificationAnswer";
import { notificationPanelStrings as strings } from "../../src/components/layout/notificationPanelStrings";
import { ingestAskQuestionLines, useAskQuestionStore } from "../../src/stores/askQuestionStore";
import { useSessionAttentionStore } from "../../src/stores/sessionAttentionStore";
import { useLiveBriefStore } from "../../src/stores/liveBriefStore";

const fixtures = JSON.parse(readFileSync(resolve(import.meta.dirname, "../fixtures/askQuestionScreens.json"), "utf8")) as
  Record<"single" | "multiSelect" | "tabbed" | "review", string[]>;
let host: HTMLDivElement, root: Root;
const open = vi.fn(), busy = vi.fn(), send = vi.fn();
const sessionId = "inline-question";
function brief(overrides: Partial<LiveSessionBrief> = {}): LiveSessionBrief {
  return {
    ptySessionId: sessionId, agentSessionId: "agent", agentKind: "claude", ptyInstanceId: "instance",
    ptyGeneration: 1, sourceRevision: 7, ptyInputRevision: 4, task: null, latestInstruction: null,
    taskSourceEventIds: [], activityKind: null, activityText: null, activitySourceEventId: null,
    checkpoint: null, checkpointEvidenceEventIds: [], pendingInputKind: "permission",
    pendingPrompt: "Run this command?", pendingOptions: [{ id: "once", label: "Once only" }, { id: "never", label: "Stop here" }],
    promptEventId: "prompt", promptHash: "hash", eventSeq: 1, operationalState: "needsHuman",
    telemetryHealth: "live", lastEventAt: Date.now(), lastSuccessfulReadAt: Date.now(),
    updatedAt: Date.now(), serviceEpoch: "epoch", briefRevision: 1, ...overrides,
  };
}
function scripted(reads: string[][]) {
  let read = 0;
  mocks.deps = {
    readTail: async () => reads[Math.min(read++, reads.length - 1)],
    readInputRevision: async () => 4 + send.mock.calls.length,
    send, sessionExists: () => true,
    attentionFor: () => useSessionAttentionStore.getState().attentionBySession[sessionId],
    claimPrompt: async () => true, isCurrentLaunch: async () => true,
    now: () => Date.now(), sleep: async () => {}, waitTimeoutMs: 1, pollMs: 1,
  };
}
async function render() {
  await act(async () => root.render(<NotificationAnswer sessionId={sessionId} label="Worker" onOpen={open} onBusyChange={busy} />));
}
const answer = () => host.querySelector<HTMLElement>("[data-notification-answer]")!;
const option = (n: number) => host.querySelector<HTMLButtonElement>(`[data-ask-question-option="${n}"], [data-notification-option="${n}"]`)!;
async function key(key: string, target: HTMLElement = answer(), init: KeyboardEventInit = {}) {
  await act(async () => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    if (!event.defaultPrevented && (key === " " || key === "Enter") && target instanceof HTMLButtonElement) target.click();
  });
}
function seedAsk(kind: keyof typeof fixtures = "single") {
  ingestAskQuestionLines(sessionId, fixtures[kind], Date.now(), 4);
  scripted([fixtures[kind], []]);
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  useAskQuestionStore.getState().resetForTests();
  useLiveBriefStore.getState().reset();
  useSessionAttentionStore.setState({ attentionBySession: { [sessionId]: {
    sessionId, sessionEpoch: 1, attentionId: "attention", sessionRevision: 3, kind: "input",
    detail: null, uiState: "waiting", stateSince: 1, occurrenceOrder: 1,
  } } });
  send.mockResolvedValue({ unverified: true });
  mocks.intervention.mockResolvedValue({ type: "confirmed", matchedEventId: "confirmed" });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe("notification AskUserQuestion answers", () => {
  it("retries the same choice after a zero-key stop and displays backend detail", async () => {
    seedAsk();
    scripted([fixtures.single, fixtures.single, []]);
    mocks.deps.readInputRevision = async () => 4;
    send.mockResolvedValueOnce({ sent: false, reason: "input_revision" });
    await render();
    await act(async () => option(1).click());
    expect(send).toHaveBeenCalledTimes(1);
    expect(host.querySelector("fieldset")?.disabled).toBe(false);
    expect(host.textContent).toContain(`${dashboardStrings.askQuestionStopReason("session_revision_mismatch")} (input_revision)`);
    await act(async () => option(1).click());
    expect(send).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain(strings.sent);
  });

  it("allows retry after a preflight stop with no detail", async () => {
    seedAsk();
    let revision = 5;
    scripted([fixtures.single]);
    mocks.deps.readInputRevision = async () => revision++;
    await render(); await key("1");
    expect(send).not.toHaveBeenCalled();
    expect(host.querySelector("fieldset")?.disabled).toBe(false);
    expect(host.querySelector('[aria-live="polite"]')?.textContent)
      .toBe(dashboardStrings.askQuestionStopReason("session_revision_mismatch"));
    scripted([fixtures.single, []]);
    await key("1");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps a stop sealed after a key was written", async () => {
    seedAsk(); scripted([fixtures.single]);
    await render(); await act(async () => option(1).click());
    expect(send).toHaveBeenCalledTimes(1);
    expect(host.querySelector("fieldset")?.disabled).toBe(true);
    await act(async () => option(1).click()); await key("1");
    expect(send).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain(dashboardStrings.askQuestionStopReason("timed_out"));
  });

  it("renders the existing compact card and sends exactly one guarded choice", async () => {
    seedAsk(); await render();
    expect(host.querySelector(".cmux-dashboard-qcard.is-compact")).not.toBeNull();
    expect(host.querySelector(".cmux-dashboard-qcard-head")).toBeNull();
    await act(async () => option(2).click());
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      sessionId, text: "2", expectedAttentionId: "attention", expectedInputRevision: 4, expectedSessionEpoch: 1,
    }));
    expect(mocks.intervention).not.toHaveBeenCalled();
    expect(host.textContent).toContain(strings.sent);
  });

  it("locks immediately before preflight and never sends two rapid clicks", async () => {
    seedAsk();
    let finish!: (value: unknown) => void;
    send.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await render();
    await act(async () => { option(1).click(); option(2).click(); });
    expect(send).toHaveBeenCalledTimes(1);
    expect(host.querySelector("fieldset")?.disabled).toBe(true);
    expect(host.textContent).toContain(strings.sending);
    expect(busy).toHaveBeenCalledWith(true);
    await key("3");
    expect(send).toHaveBeenCalledTimes(1);
    await act(async () => finish({ unverified: true }));
    expect(host.textContent).toContain(strings.sent);
  });

  it("honors shared busy state from a dashboard", async () => {
    seedAsk(); useAskQuestionStore.getState().setInFlight(sessionId, true); await render();
    await key("1");
    expect(send).not.toHaveBeenCalled();
    expect(host.querySelector("fieldset")?.disabled).toBe(true);
  });

  it("does not send when the terminal question changed before preflight", async () => {
    seedAsk();
    scripted([fixtures.single.map((line) => line.replace("Which layout", "Which color"))]);
    await render(); await key("1");
    expect(send).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Which color");
    expect(useAskQuestionStore.getState().bySession[sessionId].stopReason).toBe("stale_question");
  });

  it("does not send an already answered prompt", async () => {
    seedAsk(); mocks.deps.claimPrompt = async () => false; await render(); await key("1"); await key("2");
    expect(send).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain(strings.sent);
  });

  it("routes Type something and Chat about to the seat without any send", async () => {
    seedAsk(); await render();
    expect(host.textContent).toContain(strings.freeInput);
    await key("4");
    expect(open).toHaveBeenCalledTimes(1);
    await act(async () => option(5).click());
    expect(open).toHaveBeenCalledTimes(2);
    expect(send).not.toHaveBeenCalled(); expect(mocks.intervention).not.toHaveBeenCalled();
    expect(host.querySelector("input, textarea")).toBeNull();
  });

  it("opens an explicitly named other-input option without sending its number", async () => {
    const lines = fixtures.single.map((line) => line.replace("3. Auto", `3. ${strings.freeInputLabels[0]}`));
    ingestAskQuestionLines(sessionId, lines, Date.now(), 4); scripted([lines, []]); await render();
    await act(async () => option(3).click());
    expect(open).toHaveBeenCalledTimes(1); expect(send).not.toHaveBeenCalled();
  });

  it("allows a later approval occurrence after a question stopped", async () => {
    seedAsk(); await render();
    await act(async () => {
      useAskQuestionStore.getState().clearScreen(sessionId, "stale_question");
      useSessionAttentionStore.setState({ attentionBySession: { [sessionId]: {
        ...useSessionAttentionStore.getState().attentionBySession[sessionId], attentionId: "approval-next", kind: "approval",
      } } });
      useLiveBriefStore.getState().applyBrief(brief());
    });
    await key("1");
    expect(mocks.intervention).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it("supports number nine without interpreting option labels", async () => {
    const lines = [fixtures.single[0], "Which number?",
      ...Array.from({ length: 9 }, (_, i) => `${i + 1}. Number ${i + 1}`), fixtures.single.at(-1)!];
    ingestAskQuestionLines(sessionId, lines, Date.now(), 4); scripted([lines, []]); await render();
    await key("9");
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: "9" }));
  });

  it.each([{ isComposing: true }, { keyCode: 229 }, { repeat: true }])("ignores composition/repeated keys %j", async (init) => {
    seedAsk(); await render();
    await key("1", answer(), init);
    await key("Enter", option(1), init);
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps native copy shortcuts available inside the answer", async () => {
    seedAsk(); await render();
    const event = new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => answer().dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("uses Space for a multiselect draft and Enter for the existing submit route", async () => {
    seedAsk("multiSelect"); await render();
    await key(" ", option(1));
    expect(option(1).getAttribute("aria-pressed")).toBe("true");
    expect(send).not.toHaveBeenCalled();
    const checked = fixtures.multiSelect.map((line) => line.replace("[ ] Auth", "[✔] Auth").replace(/^❯ /, ""));
    const cursorAt = (match: string) => checked.map((line) => (match === "Submit" ? line === match : line.includes(match)) ? `❯ ${line}` : line);
    const stages = [cursorAt("1. "), cursorAt("2. "), cursorAt("3. "), cursorAt("4. "), cursorAt("Submit"),
      fixtures.review, []];
    let current = fixtures.multiSelect;
    mocks.deps.readTail = async () => current;
    send.mockImplementation(async () => { current = stages.shift()!; return { unverified: true }; });
    await key("Enter", option(1), { isComposing: true });
    expect(send).not.toHaveBeenCalled();
    await key("Enter", option(1));
    expect(send.mock.calls.map(([args]) => args.key ?? args.text)).toEqual(["1", "down", "down", "down", "down", "enter", "1"]);
  });

  it("renders the next question in the same mounted answer, without auto-answering it", async () => {
    seedAsk("tabbed");
    const next = fixtures.tabbed.map((line) => line.replace("Which theme?", "Which density?").replace("☐ Theme  ☐ Density", "☒ Theme  ☐ Density"));
    scripted([fixtures.tabbed, next]); await render(); await key("1");
    expect(send).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("Which density?");
    expect(host.textContent).not.toContain(strings.sent);
  });

  it("submits review with the public review function", async () => {
    seedAsk("review"); await render(); await key("1");
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: "1" }));
    expect(host.textContent).toContain(strings.sent);
  });
});

describe("notification approval answers", () => {
  it.each(["permission", "yesNo", "choice"] as const)("uses only brief options for %s and freezes its expectation", async (kind) => {
    const value = brief({ pendingInputKind: kind });
    useLiveBriefStore.getState().applyBrief(value); await render();
    expect(option(1).textContent).toBe("1Once only");
    expect(option(2).textContent).toBe("2Stop here");
    await key("2");
    expect(mocks.intervention).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      ptySessionId: sessionId, ptyInstanceId: "instance", promptEventId: "prompt", promptHash: "hash",
      sourceRevision: 7, ptyInputRevision: 4, interventionId: expect.any(String),
    }), { type: "choose", optionId: "never" });
    expect(host.textContent).toContain(strings.sent);
    await key("1"); expect(mocks.intervention).toHaveBeenCalledTimes(1);
  });

  it.each([
    undefined, { pendingInputKind: null }, { pendingOptions: [] }, { telemetryHealth: "stale" },
    { telemetryHealth: "ended" }, { operationalState: "running" }, { promptHash: null },
    { lastSuccessfulReadAt: null }, { telemetryHealth: "unavailable" }, { pendingInputKind: "freeText" },
  ] as (Partial<LiveSessionBrief> | undefined)[])("fails closed for unavailable or stale approval %j", async (overrides) => {
    if (overrides) useLiveBriefStore.getState().applyBrief(brief(overrides));
    await render();
    expect(host.querySelector("[data-notification-option]")).toBeNull();
    expect(host.querySelectorAll("button")).toHaveLength(1);
    expect(host.textContent).toContain(strings.answer);
    await key("1"); expect(mocks.intervention).not.toHaveBeenCalled();
  });

  it("uses backend health instead of aging a timestamp excluded from update events", async () => {
    vi.useFakeTimers(); useLiveBriefStore.getState().applyBrief(brief()); await render();
    expect(option(1)).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(30_001));
    expect(option(1)).not.toBeNull();
    await act(async () => useLiveBriefStore.getState().applyBrief(brief({ briefRevision: 2, telemetryHealth: "stale" })));
    expect(host.querySelector("[data-notification-option]")).toBeNull();
    await key("1"); expect(mocks.intervention).not.toHaveBeenCalled();
  });

  it("displays a conflict and never retries the same prompt", async () => {
    useLiveBriefStore.getState().applyBrief(brief());
    mocks.intervention.mockResolvedValue({ type: "conflict", reason: "input_revision", latestBrief: null });
    await render(); await key("1"); await key("2");
    expect(host.textContent).toContain(strings.changed);
    expect(mocks.intervention).toHaveBeenCalledTimes(1);
    await act(async () => host.querySelector<HTMLButtonElement>("[data-notification-open]")!.click());
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("locks rapid approval clicks throughout sending", async () => {
    useLiveBriefStore.getState().applyBrief(brief());
    let finish!: (value: InterventionResult) => void;
    mocks.intervention.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await render(); await act(async () => { option(1).click(); option(2).click(); });
    expect(mocks.intervention).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain(strings.sending);
    expect(host.querySelector("fieldset")?.disabled).toBe(true);
    await act(async () => finish({ type: "writtenAwaitingEvidence" }));
    expect(host.textContent).toContain(strings.sent);
  });

  it.each(["writtenUnconfirmed", "indeterminatePartial", "busy", "rejectedBeforeWrite"] as const)(
    "does not claim success or retry after %s", async (type) => {
      useLiveBriefStore.getState().applyBrief(brief());
      mocks.intervention.mockResolvedValue(type === "rejectedBeforeWrite" ? { type, reason: "unsupported" } : { type });
      await render(); await key("1"); await key("1");
      expect(host.textContent).toContain(strings.unconfirmed);
      expect(host.textContent).not.toContain(strings.sent);
      expect(mocks.intervention).toHaveBeenCalledTimes(1);
    },
  );

  it("unseals only when a new prompt identity arrives", async () => {
    useLiveBriefStore.getState().applyBrief(brief()); await render(); await key("1");
    await act(async () => useLiveBriefStore.getState().applyBrief(brief({ briefRevision: 2, promptEventId: "next", promptHash: "next-hash" })));
    await key("2");
    expect(mocks.intervention).toHaveBeenCalledTimes(2);
    expect(mocks.intervention.mock.calls[1][0]).toMatchObject({ promptEventId: "next", promptHash: "next-hash" });
  });
});
