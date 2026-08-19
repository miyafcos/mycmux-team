import { describe, expect, it } from "vitest";

import {
  toChatMessages,
  toChatTranscriptRows,
  userTurnIndexFromTops,
  userTurnLabelFrom,
  userTurnsFromRows,
} from "../../src/components/dashboard/chatModel";
import type { SemanticEvent, SemanticEventEnvelope } from "../../src/lib/livebrief";

let sequence = 0;
function envelope(kind: SemanticEvent): SemanticEventEnvelope {
  sequence += 1;
  return { eventId: `e${sequence}`, sourceRevision: sequence, occurredAt: sequence * 1_000, sourceByteStart: 0, sourceByteEnd: 1, kind };
}

describe("toChatMessages", () => {
  it("maps visible event roles and preserves source ordering", () => {
    const messages = toChatMessages([
      envelope({ type: "userMessage", kind: "answer", text: "yes", digest: "d" }),
      envelope({ type: "question", prompt_event_id: "p", provider_call_id: "c", prompt: "Continue?", kind: "choice", options: [] }),
      envelope({ type: "error", fingerprint: "f", text: "failed" }),
    ]);
    expect(messages.map((message) => message.role)).toEqual(["user", "question", "error"]);
    expect(messages.map((message) => message.text)).toEqual(["yes", "Continue?", "failed"]);
  });

  it("merges only consecutive agent messages using the first id and final timestamp", () => {
    const first = envelope({ type: "agentMessage", text: "first" });
    const second = envelope({ type: "agentMessage", text: "second" });
    expect(toChatMessages([first, second])).toEqual([{ id: first.eventId, role: "assistant", text: "first\n\nsecond", at: second.occurredAt }]);
  });

  it("excludes timeline-only events and handles empty input", () => {
    expect(toChatMessages([])).toEqual([]);
    expect(toChatMessages([
      envelope({ type: "toolStart", call_id: "c", tool: "Read", target: null }),
      envelope({ type: "toolEnd", call_id: "c", tool: "Read", target: null, ok: true, summary: null }),
      envelope({ type: "testResult", pass: 1, fail: 0 }),
      envelope({ type: "fileChange", path: "a", change: "modified" }),
      envelope({ type: "questionResolved", prompt_event_id: "p", provider_call_id: "c" }),
    ])).toEqual([]);
  });

  it("folds consecutive tool executions into one group keyed by the first event", () => {
    const first = envelope({ type: "toolStart", call_id: "one", tool: "Read", target: "a.ts" });
    const firstEnd = envelope({ type: "toolEnd", call_id: "one", tool: "Read", target: "a.ts", ok: true, summary: "first" });
    const second = envelope({ type: "toolStart", call_id: "two", tool: "Search", target: "b.ts" });
    const secondEnd = envelope({ type: "toolEnd", call_id: "two", tool: "Search", target: "b.ts", ok: false, summary: "second" });
    expect(toChatTranscriptRows([first, firstEnd, second, secondEnd])).toEqual([
      { kind: "toolGroup", id: first.eventId, tools: [
        { id: first.eventId, tool: "Read", target: "a.ts", ok: true, summary: "first" },
        { id: second.eventId, tool: "Search", target: "b.ts", ok: false, summary: "second" },
      ] },
    ]);
  });

  it("keeps user messages and questions as visible row boundaries", () => {
    const first = envelope({ type: "toolStart", call_id: "one", tool: "Read", target: null });
    const user = envelope({ type: "userMessage", kind: "answer", text: "continue", digest: "d" });
    const second = envelope({ type: "toolStart", call_id: "two", tool: "Search", target: null });
    const question = envelope({ type: "question", prompt_event_id: "p", provider_call_id: "c", prompt: "Continue?", kind: "choice", options: [] });
    expect(toChatTranscriptRows([first, user, second, question]).map((row) => row.kind === "message" ? [row.kind, row.message.role] : [row.kind, row.tools.length])).toEqual([
      ["toolGroup", 1], ["message", "user"], ["toolGroup", 1], ["message", "question"],
    ]);
  });

  it("retains stable event-id disclosure keys when later events arrive", () => {
    const first = envelope({ type: "toolStart", call_id: "one", tool: "Read", target: null });
    const second = envelope({ type: "toolStart", call_id: "two", tool: "Search", target: null });
    const before = toChatTranscriptRows([first]);
    const after = toChatTranscriptRows([first, second]);
    expect(before[0]).toMatchObject({ kind: "toolGroup", id: first.eventId });
    expect(after[0]).toMatchObject({ kind: "toolGroup", id: first.eventId, tools: [{ id: first.eventId }, { id: second.eventId }] });
  });
});

describe("user turn helpers", () => {
  it("normalizes newlines and control characters the same way as terminal labels", () => {
    expect(userTurnLabelFrom("実装して\n確認して\t今すぐ")).toBe("実装して 確認して 今すぐ");
  });

  it("collects only user messages in source order", () => {
    const userA = envelope({ type: "userMessage", kind: "answer", text: "one", digest: "d1" });
    const agent = envelope({ type: "agentMessage", text: "reply" });
    const userB = envelope({ type: "userMessage", kind: "taskStart", text: "two", digest: "d2" });
    const turns = userTurnsFromRows(toChatTranscriptRows([userA, agent, userB]));
    expect(turns.map((turn) => turn.text)).toEqual(["one", "two"]);
  });

  it("points at the last turn when following the bottom, otherwise the last top at or above the container", () => {
    expect(userTurnIndexFromTops([10, 40, 80], 0, true)).toBe(2);
    expect(userTurnIndexFromTops([10, 40, 80], 40, false)).toBe(1);
    expect(userTurnIndexFromTops([10, 40, 80], 5, false)).toBe(0);
    expect(userTurnIndexFromTops([], 0, false)).toBe(-1);
  });
});
