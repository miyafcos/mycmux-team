/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const routingMocks = vi.hoisted(() => ({
  submitAskQuestionChoice: vi.fn(async () => ({ ok: true, stopReason: null, keysSent: [] })),
  submitAskQuestionMultiSelect: vi.fn(async () => ({ ok: true, stopReason: null, keysSent: [] })),
  submitAskQuestionReview: vi.fn(async () => ({ ok: true, stopReason: null, keysSent: [] })),
  toggleAskQuestionDraft: vi.fn(),
  isAskQuestionBusy: vi.fn(() => false),
}));

vi.mock("../../src/components/dashboard/askQuestionRouting", async () => {
  const actual = await vi.importActual<typeof import("../../src/components/dashboard/askQuestionRouting")>(
    "../../src/components/dashboard/askQuestionRouting",
  );
  return {
    ...actual,
    submitAskQuestionChoice: routingMocks.submitAskQuestionChoice,
    submitAskQuestionMultiSelect: routingMocks.submitAskQuestionMultiSelect,
    submitAskQuestionReview: routingMocks.submitAskQuestionReview,
    toggleAskQuestionDraft: routingMocks.toggleAskQuestionDraft,
    isAskQuestionBusy: routingMocks.isAskQuestionBusy,
  };
});

import { QuestionCard } from "../../src/components/dashboard/QuestionCard";
import { dashboardStrings } from "../../src/components/dashboard/dashboardStrings";
import { ingestAskQuestionLines, useAskQuestionStore } from "../../src/stores/askQuestionStore";
import type { SessionAttention } from "../../src/stores/sessionAttentionStore";

const fixtures = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../fixtures/askQuestionScreens.json"), "utf8"),
) as Record<"single" | "tabbed" | "review" | "multiSelect", string[]>;

const attention: SessionAttention = {
  sessionId: "s-ask",
  attentionId: "att-1",
  kind: "input",
  detail: null,
  sessionRevision: 3,
  uiState: "waiting",
  stateSince: 1,
  occurrenceOrder: 1,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useAskQuestionStore.getState().resetForTests();
  routingMocks.submitAskQuestionChoice.mockClear();
  routingMocks.submitAskQuestionMultiSelect.mockClear();
  routingMocks.submitAskQuestionReview.mockClear();
  routingMocks.toggleAskQuestionDraft.mockClear();
  routingMocks.isAskQuestionBusy.mockReturnValue(false);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function renderCard(sessionId = "s-ask") {
  await act(async () => {
    root.render(<QuestionCard
      brief={undefined}
      events={[]}
      targetLabel="Worker"
      onFocusComposer={() => {}}
      sessionId={sessionId}
      attention={attention}
    />);
  });
}

describe("AskUserQuestion QuestionCard", () => {
  it("renders header, description, tab progress, checked state, stop reason, sending, and ARIA names", async () => {
    ingestAskQuestionLines("s-ask", fixtures.multiSelect, 1);
    useAskQuestionStore.getState().setInFlight("s-ask", true);
    useAskQuestionStore.getState().setStopReason("s-ask", "needs_confirmation");
    await renderCard();

    expect(container.querySelector("[data-ask-question-header]")?.textContent).toBe("Modules");
    expect(container.querySelector("[data-ask-question-tab-progress]")?.textContent).toBe(
      dashboardStrings.askQuestionTabProgress(0, 1),
    );
    expect(container.textContent).toContain("ログイン・セッション・権限管理");
    expect(container.querySelector("[data-ask-question-option='1']")?.textContent).toContain("[ ]");
    expect(container.querySelector("[aria-label='AskUserQuestion option 1']")).not.toBeNull();
    expect(container.querySelector("[aria-label='AskUserQuestion tabs']")).not.toBeNull();
    expect(container.querySelector("[aria-label='AskUserQuestion status']")?.textContent).toBe(
      dashboardStrings.askQuestionSending,
    );
    expect(container.querySelector("[aria-label='AskUserQuestion stop reason']")?.textContent).toBe(
      dashboardStrings.askQuestionStopReason("needs_confirmation"),
    );
    expect(container.querySelector<HTMLButtonElement>("[data-ask-question-option='1']")?.disabled).toBe(true);
  });

  it("shows checked draft state for multiSelect options", async () => {
    ingestAskQuestionLines("s-ask", fixtures.multiSelect, 1);
    const key = "tabbed:Modules:Which modules to enable?";
    useAskQuestionStore.getState().setDraftChecked("s-ask", key, [1, 3]);
    await renderCard();
    expect(container.querySelector("[data-ask-question-option='1']")?.textContent).toContain("[✔]");
    expect(container.querySelector("[data-ask-question-option='2']")?.textContent).toContain("[ ]");
    expect(container.querySelector("[data-ask-question-option='3']")?.textContent).toContain("[✔]");
  });

  it("uses the shared in-flight guard so a second click does not start another send", async () => {
    ingestAskQuestionLines("s-ask", fixtures.single, 1);
    routingMocks.isAskQuestionBusy.mockReturnValue(true);
    await renderCard();
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-ask-question-option='1']")?.click();
      container.querySelector<HTMLButtonElement>("[data-ask-question-option='1']")?.click();
    });
    expect(routingMocks.submitAskQuestionChoice).not.toHaveBeenCalled();
  });

  it("sends a numbered choice through the AskUserQuestion route, not intervention", async () => {
    ingestAskQuestionLines("s-ask", fixtures.single, 1);
    await renderCard();
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-ask-question-option='2']")?.click();
    });
    expect(routingMocks.submitAskQuestionChoice).toHaveBeenCalledWith("s-ask", 2);
  });

  it("exposes only review Submit answers and routes it through the review path", async () => {
    ingestAskQuestionLines("s-ask", fixtures.review, 1);
    await renderCard();

    expect(container.querySelector("[data-ask-question-option='2']")).toBeNull();
    expect(container.textContent).not.toContain("Cancel");
    const submit = container.querySelector<HTMLButtonElement>("[data-ask-question-option='1']");
    expect(submit?.textContent).toContain("Submit answers");
    expect(submit?.getAttribute("aria-label")).toBe("AskUserQuestion submit");

    await act(async () => submit?.click());
    expect(routingMocks.submitAskQuestionReview).toHaveBeenCalledWith("s-ask");
    expect(routingMocks.submitAskQuestionChoice).not.toHaveBeenCalled();
  });

  it("does not expose Type something or Chat about rows as numeric answer buttons", async () => {
    ingestAskQuestionLines("s-ask", fixtures.single, 1);
    await renderCard();
    expect(container.querySelector("[data-ask-question-option='4']")).toBeNull();
    expect(container.querySelector("[data-ask-question-option='5']")).toBeNull();
    expect(container.textContent).not.toContain("Chat about this");
    expect(container.textContent).not.toContain(dashboardStrings.otherFreeText);
  });

  it("keeps a fail-closed stop reason visible after the screen is cleared", async () => {
    ingestAskQuestionLines("s-ask", fixtures.single, 1);
    useAskQuestionStore.getState().clearScreen("s-ask", "read_failure");
    await renderCard();

    expect(container.querySelector("[aria-label='AskUserQuestion stop reason']")?.textContent).toBe(
      dashboardStrings.askQuestionStopReason("read_failure"),
    );
  });

  it.each(["stale_question", "timed_out"] as const)(
    "P2-05 keeps %s visible instead of removing the card",
    async (reason) => {
      ingestAskQuestionLines("s-ask", fixtures.single, 1);
      useAskQuestionStore.getState().clearScreen("s-ask", reason);
      await renderCard();

      expect(container.querySelector("[data-ask-question-session='s-ask']")).not.toBeNull();
      expect(container.querySelector("[aria-label='AskUserQuestion stop reason']")?.textContent).toBe(
        dashboardStrings.askQuestionStopReason(reason),
      );
    },
  );
});
