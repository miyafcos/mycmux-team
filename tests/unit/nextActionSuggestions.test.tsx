// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NextActionSuggestions, machineNextActions } from "../../src/components/dashboard/NextActionSuggestions";
import { useBackgroundAiSuggestionStore } from "../../src/lib/backgroundAiScheduler";

let container: HTMLDivElement;
let root: Root;

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

describe("machineNextActions", () => {
  it("maps only the established display-state vocabulary", () => {
    expect(machineNextActions("done", false).map((action) => action.label)).toEqual(["続きをお願い", "詳しく報告"]);
    expect(machineNextActions("noUpdate", false).map((action) => action.label)).toEqual(["再開して", "状況を教えて"]);
    expect(machineNextActions("idle", false).map((action) => action.label)).toEqual(["続けて", "ゴールと残りは？"]);
    expect(machineNextActions("running", false)).toEqual([]);
    expect(machineNextActions("needsHuman", true)).toEqual([]);
  });

  it("suppresses both layers while QuestionCard owns an answer", async () => {
    useBackgroundAiSuggestionStore.getState().set("s-question", {
      status: "ready",
      requestKey: "key",
      oneLine: "AI candidate",
      completionAssessment: "waiting",
      nextActions: [{ label: "AI action", prompt: "do it" }],
    });
    await act(async () => {
      root.render(<NextActionSuggestions
        sessionId="s-question"
        displayState="needsHuman"
        questionActive
        sending={false}
        onConfirm={vi.fn(async () => {})}
      />);
    });
    expect(container.querySelector("[data-next-action-suggestions]")).toBeNull();
  });

  it("shows the complete prompt before it invokes the existing composer callback", async () => {
    const onConfirm = vi.fn(async () => {});
    await act(async () => {
      root.render(<NextActionSuggestions
        sessionId="s-idle"
        displayState="idle"
        questionActive={false}
        sending={false}
        onConfirm={onConfirm}
      />);
    });
    const action = [...container.querySelectorAll<HTMLButtonElement>(".cmux-dashboard-next-action")]
      .find((button) => button.textContent === "続けて");
    await act(async () => action?.click());
    expect(container.querySelector("[data-next-action-confirm]")?.textContent).toContain("続けて");
    expect(onConfirm).not.toHaveBeenCalled();
    const confirm = [...container.querySelectorAll<HTMLButtonElement>("[data-next-action-confirm] button")]
      .find((button) => button.textContent === "この内容を送る");
    await act(async () => confirm?.click());
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ source: "machine", prompt: "続けて" }));
  });
});
