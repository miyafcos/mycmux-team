import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { scanAskQuestion } from "../../src/lib/askQuestionScan";
import {
  ingestAskQuestionLines,
  questionKey,
  useAskQuestionStore,
} from "../../src/stores/askQuestionStore";

const fixtures = JSON.parse(
  readFileSync(new URL("../fixtures/askQuestionScreens.json", import.meta.url), "utf8"),
) as Record<"single" | "tabbed" | "review" | "multiSelect", string[]>;

const sessionId = "ask-session";

beforeEach(() => {
  useAskQuestionStore.getState().resetForTests();
});

describe("askQuestionStore", () => {
  it("stores a parsed screen, revision, and unread flag", () => {
    const screen = ingestAskQuestionLines(sessionId, fixtures.single, 10, 7);
    expect(screen?.question).toBe("Which layout do you prefer?");
    const state = useAskQuestionStore.getState().bySession[sessionId];
    expect(state.scannedAt).toBe(10);
    expect(state.revision).toBe(1);
    expect(state.read).toBe(false);
    expect(state.screen?.kind).toBe("single");
    expect(state.expectedInputRevision).toBe(7);
  });

  it("keeps the first input revision for the same screen identity", () => {
    ingestAskQuestionLines(sessionId, fixtures.single, 10, 7);
    ingestAskQuestionLines(sessionId, fixtures.single, 11, 9);

    expect(useAskQuestionStore.getState().bySession[sessionId].expectedInputRevision).toBe(7);
  });

  it("binds a new input revision when the screen identity changes", () => {
    ingestAskQuestionLines(sessionId, fixtures.single, 10, 7);
    const replacement = fixtures.single.map((line) => (
      line === "Which layout do you prefer?" ? "Which colour do you prefer?" : line
    ));

    ingestAskQuestionLines(sessionId, replacement, 11, 8);

    expect(useAskQuestionStore.getState().bySession[sessionId].expectedInputRevision).toBe(8);
  });

  it("clears a stale question when the prompt disappears", () => {
    ingestAskQuestionLines(sessionId, fixtures.single, 10);
    ingestAskQuestionLines(sessionId, ["PS C:\\>", "ready"], 11);
    const state = useAskQuestionStore.getState().bySession[sessionId];
    expect(state.screen).toBeNull();
    expect(state.stopReason).toBeNull();
  });

  it("clears on an indeterminate screen instead of keeping the old question", () => {
    ingestAskQuestionLines(sessionId, fixtures.single, 10);
    ingestAskQuestionLines(sessionId, fixtures.single.slice(0, -1), 11);
    expect(useAskQuestionStore.getState().bySession[sessionId].screen).toBeNull();
  });

  it("keeps drafts when a newly discovered tab appears", () => {
    ingestAskQuestionLines(sessionId, fixtures.tabbed, 10);
    const first = scanAskQuestion(fixtures.tabbed)!;
    useAskQuestionStore.getState().setDraft(sessionId, questionKey(first), 2);
    const density = fixtures.tabbed.map((line) => {
      if (line.includes("Theme") && line.includes("Density")) return "\u2190  \u2612 Theme  \u2610 Density  \u2714 Submit  \u2192";
      if (line === "Which theme?") return "Which density?";
      return line;
    });
    ingestAskQuestionLines(sessionId, density, 12);
    const state = useAskQuestionStore.getState().bySession[sessionId];
    expect(state.drafts[questionKey(first)]).toBe(2);
    expect(state.screen?.question).toBe("Which density?");
    expect(state.stopReason).toBeNull();
  });

  it("clears drafts when a different question replaces the current prompt", () => {
    ingestAskQuestionLines(sessionId, fixtures.single, 10);
    const first = scanAskQuestion(fixtures.single)!;
    useAskQuestionStore.getState().setDraft(sessionId, questionKey(first), 2);
    const replacement = fixtures.single.map((line) => (
      line === "Which layout do you prefer?" ? "Which colour do you prefer?" : line
    ));

    ingestAskQuestionLines(sessionId, replacement, 11);

    const state = useAskQuestionStore.getState().bySession[sessionId];
    expect(state.drafts).toEqual({});
    expect(state.confirmedKeys).toEqual([]);
  });

  it("treats an option description change as new content and resets answers", () => {
    ingestAskQuestionLines(sessionId, fixtures.single, 10, 7);
    const first = scanAskQuestion(fixtures.single)!;
    const key = questionKey(first);
    useAskQuestionStore.getState().setDraft(sessionId, key, 2);
    useAskQuestionStore.getState().confirmQuestion(sessionId, key);
    expect(useAskQuestionStore.getState().bySession[sessionId].confirmedStage).toBe("drafting");
    const replacement = fixtures.single.map((line) => (
      line.includes("余白を削って情報を詰め込むレイアウト")
        ? "余白を抑えつつ情報を整理するレイアウト。"
        : line
    ));

    ingestAskQuestionLines(sessionId, replacement, 11, 8);

    const state = useAskQuestionStore.getState().bySession[sessionId];
    expect(state.revision).toBe(2);
    expect(state.screen?.options[0].description).toContain("余白を抑えつつ");
    expect(state.expectedInputRevision).toBe(8);
    expect(state.confirmedStage).toBe("idle");
    expect(state.drafts).toEqual({});
    expect(state.confirmedKeys).toEqual([]);
  });

  it("clears drafts when the old prompt disappears before another occurrence", () => {
    ingestAskQuestionLines(sessionId, fixtures.single, 10);
    const first = scanAskQuestion(fixtures.single)!;
    useAskQuestionStore.getState().setDraft(sessionId, questionKey(first), 2);

    ingestAskQuestionLines(sessionId, ["ready"], 11);

    const state = useAskQuestionStore.getState().bySession[sessionId];
    expect(state.drafts).toEqual({});
    expect(state.confirmedKeys).toEqual([]);
  });

  it("drops ended sessions so an old question cannot linger", () => {
    ingestAskQuestionLines(sessionId, fixtures.single, 10);
    ingestAskQuestionLines("other", fixtures.tabbed, 10);
    useAskQuestionStore.getState().pruneSessions(["other"]);
    expect(useAskQuestionStore.getState().bySession[sessionId]).toBeUndefined();
    expect(useAskQuestionStore.getState().bySession.other.screen?.kind).toBe("tabbed");
  });

  it("records a read failure without leaving the previous prompt visible", () => {
    ingestAskQuestionLines(sessionId, fixtures.single, 10);
    useAskQuestionStore.getState().clearScreen(sessionId, "read_failure");
    const state = useAskQuestionStore.getState().bySession[sessionId];
    expect(state.screen).toBeNull();
    expect(state.stopReason).toBe("read_failure");
  });
});
