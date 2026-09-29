import { beforeEach, describe, expect, it, vi } from "vitest";

const eventMocks = vi.hoisted(() => ({
  emit: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/api/event", () => eventMocks);

import {
  askQuestionAttentionId,
  clearAskQuestionEvidence,
  publishAskQuestionEvidence,
  releaseAskQuestionEvidence,
  resetAskQuestionEvidenceForTests,
} from "../../src/lib/askQuestionEvidence";
import type { AskScreen } from "../../src/lib/askQuestionScan";

const sessionId = "ask-session";
const single: AskScreen = {
  kind: "single",
  multiSelect: false,
  tabs: [],
  question: "Pick one",
  options: [
    { index: 1, label: "First", current: true, role: "option" },
    { index: 2, label: "Second", current: false, role: "option" },
  ],
};

beforeEach(() => {
  eventMocks.emit.mockClear();
  resetAskQuestionEvidenceForTests();
});

describe("AskUserQuestion screen evidence", () => {
  it("publishes the prompt as canonical input attention", async () => {
    await publishAskQuestionEvidence(sessionId, single, 10);

    expect(eventMocks.emit).toHaveBeenCalledWith("mycmux:session-state-evidence", expect.objectContaining({
      session_id: sessionId,
      attention: "input",
      attention_id: askQuestionAttentionId(sessionId, single),
      detail: "Pick one",
      observed_at: 10,
    }));
  });

  it("keeps cursor changes and a tabbed flow stable but changes id for a replacement", async () => {
    await publishAskQuestionEvidence(sessionId, single, 10);
    const initialId = askQuestionAttentionId(sessionId, single);
    const cursorMoved: AskScreen = {
      ...single,
      options: single.options.map((option) => ({
        ...option,
        current: option.index === 2,
      })),
    };
    const replacement: AskScreen = {
      ...single,
      question: "Pick another",
    };

    expect(askQuestionAttentionId(sessionId, cursorMoved)).toBe(initialId);
    expect(askQuestionAttentionId(sessionId, replacement)).not.toBe(initialId);

    resetAskQuestionEvidenceForTests();
    const firstTab: AskScreen = {
      ...single,
      kind: "tabbed",
      tabs: [
        { label: "Colour", answered: false, active: true },
        { label: "Size", answered: false, active: false },
      ],
    };
    await publishAskQuestionEvidence(sessionId, firstTab, 11);
    const tabbedId = askQuestionAttentionId(sessionId, firstTab);
    const secondTab: AskScreen = {
      ...firstTab,
      question: "Pick a size",
      tabs: [
        { label: "Colour", answered: true, active: false },
        { label: "Size", answered: false, active: true },
      ],
    };
    expect(askQuestionAttentionId(sessionId, secondTab)).toBe(tabbedId);
  });

  it("re-publishes when the canonical attention was overwritten", async () => {
    await publishAskQuestionEvidence(sessionId, single, 10);
    const attentionId = askQuestionAttentionId(sessionId, single);

    await publishAskQuestionEvidence(sessionId, single, 11, {
      attentionId: "other",
      kind: "approval",
    });

    expect(eventMocks.emit).toHaveBeenCalledTimes(2);
    expect(eventMocks.emit).toHaveBeenLastCalledWith("mycmux:session-state-evidence", expect.objectContaining({
      attention: "input",
      attention_id: attentionId,
      observed_at: 11,
    }));
  });

  it("releases ownership when another screen evidence replaces the prompt", async () => {
    await publishAskQuestionEvidence(sessionId, single, 10);
    releaseAskQuestionEvidence(sessionId);

    expect(await clearAskQuestionEvidence(sessionId, 11)).toBe(false);
  });

  it("clears only a prompt previously published by this module", async () => {
    expect(await clearAskQuestionEvidence(sessionId, 10)).toBe(false);
    await publishAskQuestionEvidence(sessionId, single, 11);
    await clearAskQuestionEvidence(sessionId, 12);

    expect(eventMocks.emit).toHaveBeenLastCalledWith("mycmux:session-state-evidence", expect.objectContaining({
      session_id: sessionId,
      attention: "none",
      attention_id: null,
      observed_at: 12,
    }));
  });
});
