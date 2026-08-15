import { describe, expect, it } from "vitest";
import { buildAskStripItems } from "../../src/components/dashboard/askStripModel";

describe("buildAskStripItems", () => {
  it("keeps unresolved brief questions and omits sessions without one", () => {
    const items = buildAskStripItems([
      { tabId: "a", sessionId: "a", label: "Alpha", brief: { pendingPrompt: "続けますか？", pendingInputKind: "freeText", pendingOptions: [], promptEventId: "event", promptHash: "hash" } as never, events: [] },
      { tabId: "b", sessionId: "b", label: "Beta", brief: undefined, events: [] },
    ]);
    expect(items).toEqual([{ tabId: "a", sessionId: "a", label: "Alpha", prompt: "続けますか？" }]);
  });

  it("returns an empty strip when every question is resolved", () => {
    expect(buildAskStripItems([{ tabId: "a", sessionId: "a", label: "Alpha", brief: undefined, events: [] }])).toEqual([]);
  });
});
