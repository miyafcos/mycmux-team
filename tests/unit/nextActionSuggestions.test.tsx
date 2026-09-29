// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dashboardStrings } from "../../src/components/dashboard/dashboardStrings";
import { NextActionSuggestions } from "../../src/components/dashboard/NextActionSuggestions";
import { useBackgroundAiSuggestionStore } from "../../src/lib/backgroundAiScheduler";

let container: HTMLDivElement;
let root: Root;

function render(sessionId: string, overrides: Partial<ComponentProps<typeof NextActionSuggestions>> = {}) {
  return <NextActionSuggestions
    sessionId={sessionId}
    displayState="done"
    questionActive={false}
    sending={false}
    onConfirm={vi.fn(async () => {})}
    {...overrides}
  />;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useBackgroundAiSuggestionStore.getState().reset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("NextActionSuggestions", () => {
  it("renders nothing when there is no suggestion", async () => {
    await act(async () => root.render(render("s-empty")));
    expect(container.querySelector("[data-next-action-suggestions]")).toBeNull();
  });

  it("renders the loading line", async () => {
    useBackgroundAiSuggestionStore.getState().set("s-loading", {
      status: "loading", requestKey: "loading-key", oneLine: "", completionAssessment: "", nextActions: [],
    });
    await act(async () => root.render(render("s-loading")));
    expect(container.querySelector("[data-next-action-status]")?.getAttribute("data-next-action-status")).toBe("loading");
    expect(container.textContent).toContain(dashboardStrings.nextActionLoading);
  });

  it("renders three ready chips, highlights the first, and confirms the selected action", async () => {
    const actions = [
      { label: "First action", prompt: "First prompt" },
      { label: "Second action", prompt: "Second prompt" },
      { label: "Third action", prompt: "Third prompt" },
      { label: "Fourth action", prompt: "Fourth prompt" },
    ];
    const onConfirm = vi.fn(async () => {});
    useBackgroundAiSuggestionStore.getState().set("s-ready", {
      status: "ready",
      requestKey: "ready-key",
      oneLine: "Ready summary",
      completionAssessment: "Ready assessment",
      nextActions: actions,
    });
    await act(async () => root.render(render("s-ready", { onConfirm })));
    const chips = container.querySelectorAll<HTMLButtonElement>(".cmux-dashboard-next-action");
    expect(chips).toHaveLength(3);
    expect(chips[0]?.dataset.nextActionRecommended).toBe("true");
    expect(chips[0]?.querySelector(".cmux-dashboard-next-action-star")).not.toBeNull();
    await act(async () => chips[1]?.click());
    expect(container.querySelector("[data-next-action-confirm]")?.textContent).toContain(actions[1]?.prompt);
    const confirm = [...container.querySelectorAll<HTMLButtonElement>("[data-next-action-confirm] button")]
      .find((button) => button.textContent === dashboardStrings.nextActionSendConfirm);
    await act(async () => confirm?.click());
    expect(onConfirm).toHaveBeenCalledWith(actions[1]);
  });

  it("shows the failed reason and a retry button", async () => {
    useBackgroundAiSuggestionStore.getState().set("s-failed", {
      status: "failed", requestKey: "failed-key", oneLine: "", completionAssessment: "", nextActions: [], failureCode: "cli_not_found",
    });
    await act(async () => root.render(render("s-failed")));
    expect(container.textContent).toContain(dashboardStrings.nextActionFailed(dashboardStrings.aiSuggestionFailureReason("cli_not_found")));
    expect(container.querySelector<HTMLButtonElement>(`button[aria-label="${dashboardStrings.nextActionRetry}"]`)).not.toBeNull();
  });

  it("renders nothing while a question is active", async () => {
    useBackgroundAiSuggestionStore.getState().set("s-question", {
      status: "ready",
      requestKey: "question-key",
      oneLine: "Ready summary",
      completionAssessment: "Ready assessment",
      nextActions: [{ label: "Action", prompt: "Prompt" }],
    });
    await act(async () => root.render(render("s-question", { questionActive: true, displayState: "needsHuman" })));
    expect(container.querySelector("[data-next-action-suggestions]")).toBeNull();
  });
});
