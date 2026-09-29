import { describe, expect, it } from "vitest";

import { mergeWebPaneTurns, type WebPaneTurn } from "../../src/lib/webPaneTranscript";
import { toChatMessages } from "../../src/components/dashboard/chatModel";

const turns = (...pairs: Array<[WebPaneTurn["role"], string]>): WebPaneTurn[] =>
  pairs.map(([role, text]) => ({ role, text }));

describe("mergeWebPaneTurns", () => {
  it("maps a page's turns onto the transcript the dashboard already renders", () => {
    const events = mergeWebPaneTurns([], turns(["user", "要約して"], ["assistant", "はい"]), "tab-1", 1_000);
    expect(events.map((event) => event.eventId)).toEqual(["webpane:tab-1:0", "webpane:tab-1:1"]);
    expect(toChatMessages(events)).toEqual([
      { id: "webpane:tab-1:0", role: "user", text: "要約して", at: 1_000 },
      { id: "webpane:tab-1:1", role: "assistant", text: "はい", at: 1_000 },
    ]);
  });

  it("keeps the first-seen time of turns that did not change", () => {
    const first = mergeWebPaneTurns([], turns(["user", "A"], ["assistant", "B"]), "t", 1_000);
    const second = mergeWebPaneTurns(first, turns(["user", "A"], ["assistant", "B"], ["user", "C"]), "t", 5_000);
    expect(second.slice(0, 2)).toEqual(first);
    // Identity too, so an unchanged bubble does not re-render on every poll.
    expect(second[0]).toBe(first[0]);
    expect(second[2].occurredAt).toBe(5_000);
  });

  it("re-stamps the turn that is still being written", () => {
    const first = mergeWebPaneTurns([], turns(["user", "A"], ["assistant", "考え"]), "t", 1_000);
    const second = mergeWebPaneTurns(first, turns(["user", "A"], ["assistant", "考えています"]), "t", 4_000);
    expect(second[0]).toBe(first[0]);
    expect(second[1].occurredAt).toBe(4_000);
    expect(second[1].kind).toEqual({ type: "agentMessage", text: "考えています" });
  });

  it("does not carry a stale time onto a different turn when the reader drops the oldest", () => {
    const first = mergeWebPaneTurns([], turns(["user", "A"], ["assistant", "B"]), "t", 1_000);
    const shifted = mergeWebPaneTurns(first, turns(["assistant", "B"], ["user", "C"]), "t", 9_000);
    expect(shifted.every((event) => event.occurredAt === 9_000)).toBe(true);
  });

  it("returns nothing for a page with no conversation", () => {
    expect(mergeWebPaneTurns([], [], "t", 1_000)).toEqual([]);
  });
});
