import { describe, expect, it } from "vitest";
import { buildAskStripItems } from "../../src/components/dashboard/askStripModel";
import type { AskQuestionSessionState } from "../../src/stores/askQuestionStore";
import type { AskScreen } from "../../src/lib/askQuestionScan";

const screen: AskScreen = {
  kind: "single",
  multiSelect: false,
  tabs: [],
  question: "Which layout do you prefer?",
  options: [{ index: 1, label: "Compact", current: true, role: "option" }],
};

const ask = (value: Partial<AskQuestionSessionState> = {}): AskQuestionSessionState => ({
  screen,
  scannedAt: 1,
  revision: 1,
  read: false,
  inFlight: false,
  confirmedStage: "idle",
  stopReason: null,
  drafts: {},
  draftChecked: {},
  confirmedKeys: [],
  ...value,
});

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

  it("shows a screen-derived chip even when transcript data is empty", () => {
    const items = buildAskStripItems([
      { tabId: "c", sessionId: "c", label: "Claude", brief: undefined, events: [], ask: ask() },
    ]);
    expect(items).toEqual([{
      tabId: "c",
      sessionId: "c",
      label: "Claude",
      prompt: "Which layout do you prefer?",
    }]);
  });

  it("prefers the screen-derived prompt over a livebrief question", () => {
    const items = buildAskStripItems([
      {
        tabId: "a",
        sessionId: "a",
        label: "Alpha",
        brief: { pendingPrompt: "続けますか？", pendingInputKind: "freeText", pendingOptions: [], promptEventId: "event", promptHash: "hash" } as never,
        events: [],
        ask: ask(),
      },
    ]);
    expect(items[0]?.prompt).toBe("Which layout do you prefer?");
  });
});
