import { describe, expect, it } from "vitest";

import { toChatMessages } from "../../src/components/dashboard/chatModel";
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
});
