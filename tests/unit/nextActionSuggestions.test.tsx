import { dashboardText } from "../helpers/dashboardA11y";
// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dashboardStrings } from "../../src/components/dashboard/dashboardStrings";
import { NextActionSuggestions } from "../../src/components/dashboard/NextActionSuggestions";
import { useAiSettingsStore } from "../../src/stores/aiSettingsStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { nextActionRequestKey, useBackgroundAiSuggestionStore } from "../../src/lib/backgroundAiScheduler";

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
  useAiSettingsStore.setState({ aiEnabled: true });
  useSettingsStore.setState({ replyDraftSuggestionsEnabled: true });
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
      status: "loading", requestKey: nextActionRequestKey({ sessionId: "s-loading", eventSeq: 0, displayState: "done" }), oneLine: "", completionAssessment: "", nextActions: [],
    });
    await act(async () => root.render(render("s-loading")));
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(container.querySelector("[data-next-action-status]")?.getAttribute("data-next-action-status")).toBe("loading");
    expect(dashboardText(container)).toContain(dashboardStrings.nextActionLoading);
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
      requestKey: nextActionRequestKey({ sessionId: "s-ready", eventSeq: 0, displayState: "done" }),
      oneLine: "Ready summary",
      completionAssessment: "Ready assessment",
      nextActions: actions,
    });
    await act(async () => root.render(render("s-ready", { onConfirm })));
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    // One line: only the first (recommended) suggestion and the "more" button are shown.
    expect(container.querySelectorAll(".cmux-dashboard-next-action")).toHaveLength(1);
    await act(async () => container.querySelector<HTMLButtonElement>(".cmux-dashboard-next-actions-more-button")!.click());
    const chips = container.querySelectorAll<HTMLButtonElement>(".cmux-dashboard-next-action");
    expect(chips).toHaveLength(3);
    expect(chips[0]?.dataset.nextActionRecommended).toBe("true");
    expect(chips[0]?.querySelector(".cmux-dashboard-next-action-star")).not.toBeNull();
    await act(async () => chips[1]?.click());
    // Choosing from the panel closes it and puts focus back on the "more" button.
    expect(container.querySelector(".cmux-dashboard-next-actions-more-panel")).toBeNull();
    expect(document.activeElement).toBe(container.querySelector(".cmux-dashboard-next-actions-more-button"));
    expect(container.querySelector("[data-next-action-confirm]")?.textContent).toContain(actions[1]?.prompt);
    const confirm = [...container.querySelectorAll<HTMLButtonElement>("[data-next-action-confirm] button")]
      .find((button) => button.textContent === dashboardStrings.nextActionSendConfirm);
    await act(async () => confirm?.click());
    expect(onConfirm).toHaveBeenCalledWith(actions[1]);
  });

  it("shows the failed reason and a retry button", async () => {
    useBackgroundAiSuggestionStore.getState().set("s-failed", {
      status: "failed", requestKey: nextActionRequestKey({ sessionId: "s-failed", eventSeq: 0, displayState: "done" }), oneLine: "", completionAssessment: "", nextActions: [], failureCode: "cli_not_found",
    });
    await act(async () => root.render(render("s-failed")));
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(dashboardText(container)).toContain(dashboardStrings.nextActionFailed(dashboardStrings.aiSuggestionFailureReason("cli_not_found")));
    expect(container.querySelector<HTMLButtonElement>(`button[aria-label="${dashboardStrings.nextActionRetry}"]`)).not.toBeNull();
  });

  it("renders nothing while a question is active", async () => {
    useBackgroundAiSuggestionStore.getState().set("s-question", {
      status: "ready",
      requestKey: nextActionRequestKey({ sessionId: "s-question", eventSeq: 0, displayState: "done" }),
      oneLine: "Ready summary",
      completionAssessment: "Ready assessment",
      nextActions: [{ label: "Action", prompt: "Prompt" }],
    });
    await act(async () => root.render(render("s-question", { questionActive: true, displayState: "needsHuman" })));
    expect(container.querySelector("[data-next-action-suggestions]")).toBeNull();
  });
});

describe("NextActionSuggestions one-line row (N9 plan 1)", () => {
  const actions = [
    { label: "First action", prompt: "First prompt" },
    { label: "Second action", prompt: "Second prompt" },
    { label: "Third action", prompt: "Third prompt" },
  ];

  async function renderReady(sessionId: string, nextActions = actions, overrides: Partial<ComponentProps<typeof NextActionSuggestions>> = {}) {
    useBackgroundAiSuggestionStore.getState().set(sessionId, {
      status: "ready",
      requestKey: nextActionRequestKey({ sessionId, eventSeq: 0, displayState: "done" }),
      oneLine: "Ready summary",
      completionAssessment: "Ready assessment",
      nextActions,
    });
    await act(async () => root.render(render(sessionId, overrides)));
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  }
  const moreButton = () => container.querySelector<HTMLButtonElement>(".cmux-dashboard-next-actions-more-button")!;
  const panel = () => container.querySelector<HTMLElement>(".cmux-dashboard-next-actions-more-panel");

  it("shows the first suggestion and a count of the rest, with the rest hidden until opened", async () => {
    await renderReady("s-one-line");
    expect(container.querySelector("[data-next-action-status]")?.className).toContain("is-balanced");
    expect(container.querySelectorAll(".cmux-dashboard-next-action")).toHaveLength(1);
    expect(container.querySelector(".cmux-dashboard-next-action-star")).not.toBeNull();
    expect(moreButton().textContent).toBe(dashboardStrings.nextActionMoreCount(2));
    expect(moreButton().textContent).toBe("ほか 2 件");
    expect(moreButton().getAttribute("aria-expanded")).toBe("false");
    expect(panel()).toBeNull();
    expect(container.querySelector(".cmux-dashboard-next-actions-summary")).toBeNull();
    expect(container.querySelector(".cmux-dashboard-next-actions-retry")).toBeNull();
  });

  it("opens the panel with the summary, the other suggestions and the retry button", async () => {
    await renderReady("s-open");
    await act(async () => moreButton().click());
    expect(moreButton().getAttribute("aria-expanded")).toBe("true");
    expect(moreButton().getAttribute("aria-controls")).toBe(panel()?.id);
    expect(panel()?.getAttribute("aria-label")).toBe(dashboardStrings.nextActionMorePanelLabel);
    expect(panel()?.querySelector(".cmux-dashboard-next-actions-summary")?.textContent).toBe("Ready summary");
    expect([...panel()!.querySelectorAll(".cmux-dashboard-next-action")].map(chip => chip.textContent)).toEqual(["Second action", "Third action"]);
    expect(panel()?.querySelector(`button[aria-label="${dashboardStrings.nextActionRetry}"]`)).not.toBeNull();
    await act(async () => moreButton().click());
    expect(panel()).toBeNull();
    expect(moreButton().getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on Escape and returns focus to the more button", async () => {
    await renderReady("s-esc");
    await act(async () => moreButton().click());
    moreButton().focus();
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => { document.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(moreButton());
  });

  it("leaves Escape alone while the panel is closed", async () => {
    await renderReady("s-esc-closed");
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => { document.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(false);
  });

  it("closes on a press outside, but not on a press inside, the panel", async () => {
    await renderReady("s-outside");
    await act(async () => moreButton().click());
    await act(async () => { panel()!.querySelector(".cmux-dashboard-next-actions-summary")!.dispatchEvent(new Event("pointerdown", { bubbles: true })); });
    expect(panel()).not.toBeNull();
    await act(async () => { moreButton().dispatchEvent(new Event("pointerdown", { bubbles: true })); });
    expect(panel()).not.toBeNull();
    await act(async () => { document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })); });
    expect(panel()).toBeNull();
  });

  it("closes when keyboard focus leaves the panel", async () => {
    await renderReady("s-focus-out");
    const outside = document.createElement("input");
    document.body.appendChild(outside);
    await act(async () => moreButton().click());
    const inside = panel()!.querySelector<HTMLButtonElement>(".cmux-dashboard-next-action")!;
    await act(async () => inside.focus());
    expect(panel()).not.toBeNull();
    await act(async () => outside.focus());
    expect(panel()).toBeNull();
    outside.remove();
  });

  it("keeps the keyboard order: first suggestion, more button, then the panel items", async () => {
    await renderReady("s-order");
    await act(async () => moreButton().click());
    const order = [...container.querySelectorAll<HTMLButtonElement>("section button")].map(button => button.className.includes("more-button") ? "more" : button.textContent);
    expect(order[0]).toContain("First action");
    expect(order[1]).toBe("more");
    expect(order[2]).toBe("Second action");
  });

  it("offers the summary and retry even with a single suggestion", async () => {
    await renderReady("s-single", [actions[0]!]);
    expect(moreButton().textContent).toBe(dashboardStrings.nextActionMoreDetail);
    await act(async () => moreButton().click());
    expect(panel()?.querySelectorAll(".cmux-dashboard-next-action")).toHaveLength(0);
    expect(panel()?.querySelector(".cmux-dashboard-next-actions-summary")).not.toBeNull();
    expect(panel()?.querySelector(".cmux-dashboard-next-actions-retry")).not.toBeNull();
  });

  it("shows the confirmation under the one-line row and disables suggestions while sending", async () => {
    await renderReady("s-confirm");
    await act(async () => container.querySelector<HTMLButtonElement>(".cmux-dashboard-next-action")!.click());
    const section = container.querySelector("[data-next-action-status='ready']")!;
    expect(section.querySelector("[data-next-action-confirm] pre")?.textContent).toBe("First prompt");
    await act(async () => root.render(render("s-confirm", { sending: true })));
    expect(container.querySelector<HTMLButtonElement>(".cmux-dashboard-next-action")!.disabled).toBe(true);
  });

  it("closes the panel when a question replaces the suggestion", async () => {
    await renderReady("s-question-close");
    await act(async () => moreButton().click());
    expect(panel()).not.toBeNull();
    await act(async () => root.render(render("s-question-close", { questionActive: true, displayState: "needsHuman" })));
    expect(container.querySelector("[data-next-action-suggestions]")).toBeNull();
    await act(async () => root.render(render("s-question-close")));
    expect(panel()).toBeNull();
  });

  it("uses a short wording and a compact row before suggestions are read", async () => {
    await act(async () => root.render(render("s-not-read")));
    const section = container.querySelector("[data-next-action-status='not-requested']")!;
    expect(section.className).toContain("is-balanced");
    expect(section.querySelector("span")?.textContent).toBe(dashboardStrings.nextActionNotRequested);
    expect(dashboardStrings.nextActionNotRequested.length).toBeLessThan("提案はまだ読み込んでいません".length);
    expect(section.querySelector("button")?.textContent).toBe("提案を読む");
    await act(async () => root.render(render("s-not-read", { displayState: "running" })));
    expect(container.querySelector("[data-next-action-status='not-requested'] span")?.textContent).toBe(dashboardStrings.nextActionWaitSettle);
  });

  it("keeps the failed row compact and retryable", async () => {
    useBackgroundAiSuggestionStore.getState().set("s-compact-failed", {
      status: "failed", requestKey: nextActionRequestKey({ sessionId: "s-compact-failed", eventSeq: 0, displayState: "done" }), oneLine: "", completionAssessment: "", nextActions: [], failureCode: "timeout",
    });
    await act(async () => root.render(render("s-compact-failed")));
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(container.querySelector("[data-next-action-status='failed']")?.className).toContain("is-balanced");
    expect(container.querySelector(`button[aria-label="${dashboardStrings.nextActionRetry}"]`)).not.toBeNull();
  });
});

describe("NextActionSuggestions more panel inside a dashboard root (N9 plan 1 round 2)", () => {
  const actions = [
    { label: "First action", prompt: "First prompt" },
    { label: "Second action", prompt: "Second prompt" },
    { label: "Third action", prompt: "Third prompt" },
  ];
  let host: HTMLDivElement;
  let rowRect = { left: 40, top: 500, width: 600, height: 28 };
  let rootTop = 0;

  beforeEach(() => {
    // Like the dashboard root: a focusable region that is the portal target.
    host = document.createElement("div");
    host.className = "cmux-dashboard-view";
    host.tabIndex = -1;
    container.remove();
    container = document.createElement("div");
    host.appendChild(container);
    document.body.appendChild(host);
    root = createRoot(container);
    rowRect = { left: 40, top: 500, width: 600, height: 28 };
    rootTop = 0;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const r = this.classList.contains("cmux-dashboard-next-actions") ? rowRect : { left: 0, top: this === host ? rootTop : 0, width: 0, height: 0 };
      return { ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON: () => ({}) } as DOMRect;
    });
  });
  afterEach(() => { vi.restoreAllMocks(); host.remove(); });

  async function renderReady(sessionId: string, overrides: Partial<ComponentProps<typeof NextActionSuggestions>> = {}) {
    useBackgroundAiSuggestionStore.getState().set(sessionId, {
      status: "ready",
      requestKey: nextActionRequestKey({ sessionId, eventSeq: 0, displayState: "done" }),
      oneLine: "Ready summary",
      completionAssessment: "Ready assessment",
      nextActions: actions,
    });
    await act(async () => root.render(render(sessionId, overrides)));
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  }
  const moreButton = () => container.querySelector<HTMLButtonElement>(".cmux-dashboard-next-actions-more-button")!;
  const panel = () => host.querySelector<HTMLElement>(".cmux-dashboard-next-actions-more-panel");
  const escape = (init: KeyboardEventInit = {}) => new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, ...init });

  it("draws the panel into the dashboard root, anchored to the row and capped by the column width", async () => {
    await renderReady("s-r2-place");
    await act(async () => moreButton().click());
    expect(panel()?.parentElement).toBe(host);
    expect(container.querySelector(".cmux-dashboard-next-actions-more-panel")).toBeNull();
    const style = panel()!.style;
    expect(style.position).toBe("fixed");
    expect(style.left).toBe("40px");
    expect(style.width).toBe("420px");
    expect(style.minWidth).toBe("300px");
    expect(style.bottom).toBe(`${window.innerHeight - 500 + 4}px`);
    expect(Number.parseFloat(style.maxHeight)).toBeLessThanOrEqual(window.innerHeight * 0.6);
  });

  it("measures again when the window is resized or an ancestor scrolls, and never exceeds the column", async () => {
    await renderReady("s-r2-measure");
    await act(async () => moreButton().click());
    rowRect = { left: 10, top: 300, width: 250, height: 28 };
    await act(async () => { window.dispatchEvent(new Event("resize")); });
    expect(panel()!.style.left).toBe("10px");
    expect(panel()!.style.width).toBe("250px");
    expect(panel()!.style.minWidth).toBe("250px");
    rowRect = { left: 10, top: 20, width: 250, height: 28 };
    await act(async () => { host.dispatchEvent(new Event("scroll")); });
    expect(panel()!.style.bottom).toBe(`${window.innerHeight - 20 + 4}px`);
    expect(Number.parseFloat(panel()!.style.maxHeight)).toBe(8);
  });

  it("closes on Escape with focus on the dashboard root, and the dashboard root's own Escape handler never runs", async () => {
    const dashboardClose = vi.fn();
    const dashboardLike = (event: KeyboardEvent) => { if (event.key === "Escape") dashboardClose(); };
    document.addEventListener("keydown", dashboardLike, true);
    try {
      await renderReady("s-r2-esc-root");
      await act(async () => moreButton().click());
      host.focus();
      const event = escape();
      await act(async () => { host.dispatchEvent(event); });
      expect(panel()).toBeNull();
      expect(dashboardClose).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(moreButton());
      // Once the panel is closed, Escape reaches the dashboard again.
      await act(async () => { host.dispatchEvent(escape()); });
      expect(dashboardClose).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener("keydown", dashboardLike, true);
    }
  });

  it("does not take the Escape that cancels an IME composition", async () => {
    await renderReady("s-r2-ime");
    await act(async () => moreButton().click());
    const composing = escape({ isComposing: true });
    await act(async () => { document.body.dispatchEvent(composing); });
    expect(composing.defaultPrevented).toBe(false);
    expect(panel()).not.toBeNull();
    const legacy = escape({ keyCode: 229 });
    await act(async () => { document.body.dispatchEvent(legacy); });
    expect(legacy.defaultPrevented).toBe(false);
    expect(panel()).not.toBeNull();
  });

  it("stays open when text inside the panel is pressed (focus moves to the panel itself) but closes when focus goes to the root", async () => {
    await renderReady("s-r2-press-inside");
    moreButton().focus();
    await act(async () => moreButton().click());
    expect(panel()!.getAttribute("tabindex")).toBe("-1");
    await act(async () => {
      panel()!.querySelector(".cmux-dashboard-next-actions-summary")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      panel()!.focus();
    });
    expect(panel()).not.toBeNull();
    await act(async () => { host.focus(); });
    expect(panel()).toBeNull();
  });

  it("walks Tab into the panel, back to more on Shift+Tab, and forward to the reply", async () => {
    await renderReady("s-r2-tab");
    const reply = document.createElement("textarea");
    host.appendChild(reply);
    await act(async () => moreButton().click());
    const items = [...panel()!.querySelectorAll<HTMLButtonElement>("button")];
    expect(items.map(item => item.textContent || item.getAttribute("aria-label"))).toEqual(["Second action", "Third action", dashboardStrings.nextActionRetry]);
    moreButton().focus();
    await act(async () => { moreButton().dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); });
    expect(document.activeElement).toBe(items[0]);
    await act(async () => { items[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })); });
    expect(document.activeElement).toBe(moreButton());
    expect(panel()).not.toBeNull();
    items[2]!.focus();
    await act(async () => { items[2]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); });
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(reply);
  });

  it("only points aria-controls at the panel while the panel exists", async () => {
    await renderReady("s-r2-aria");
    expect(moreButton().hasAttribute("aria-controls")).toBe(false);
    await act(async () => moreButton().click());
    expect(moreButton().getAttribute("aria-controls")).toBe(panel()?.id);
    await act(async () => moreButton().click());
    expect(moreButton().hasAttribute("aria-controls")).toBe(false);
  });

  it("closes the panel when only questionActive changes", async () => {
    await renderReady("s-r2-question-only");
    await act(async () => moreButton().click());
    expect(panel()).not.toBeNull();
    await act(async () => root.render(render("s-r2-question-only", { questionActive: true })));
    expect(panel()).toBeNull();
    // Escape is not swallowed by a hidden panel while the question card is up.
    const hidden = escape();
    await act(async () => { document.body.dispatchEvent(hidden); });
    expect(hidden.defaultPrevented).toBe(false);
    await act(async () => root.render(render("s-r2-question-only")));
    expect(panel()).toBeNull();
    const after = escape();
    await act(async () => { document.body.dispatchEvent(after); });
    expect(after.defaultPrevented).toBe(false);
  });

  it("closes the panel when the suggestion status changes under the same request key", async () => {
    await renderReady("s-r2-status");
    await act(async () => moreButton().click());
    const requestKey = nextActionRequestKey({ sessionId: "s-r2-status", eventSeq: 0, displayState: "done" });
    await act(async () => useBackgroundAiSuggestionStore.getState().set("s-r2-status", { status: "loading", requestKey, oneLine: "", completionAssessment: "", nextActions: [] }));
    const during = escape();
    await act(async () => { document.body.dispatchEvent(during); });
    expect(during.defaultPrevented).toBe(false);
    await act(async () => useBackgroundAiSuggestionStore.getState().set("s-r2-status", { status: "ready", requestKey, oneLine: "Ready summary", completionAssessment: "Ready assessment", nextActions: actions }));
    expect(panel()).toBeNull();
    expect(moreButton().getAttribute("aria-expanded")).toBe("false");
  });

  it("lets Escape through after the retry button inside the panel was pressed", async () => {
    await renderReady("s-r2-retry-esc");
    await act(async () => moreButton().click());
    await act(async () => panel()!.querySelector<HTMLButtonElement>(`button[aria-label="${dashboardStrings.nextActionRetry}"]`)!.click());
    const requestKey = nextActionRequestKey({ sessionId: "s-r2-retry-esc", eventSeq: 0, displayState: "done" });
    await act(async () => useBackgroundAiSuggestionStore.getState().set("s-r2-retry-esc", { status: "loading", requestKey, oneLine: "", completionAssessment: "", nextActions: [] }));
    expect(panel()).toBeNull();
    const event = escape();
    await act(async () => { document.body.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(false);
  });

  it("closes the panel when AI or reply suggestions are switched off while it is open, and then stops taking Escape", async () => {
    const dashboardClose = vi.fn();
    const dashboardLike = (event: KeyboardEvent) => { if (event.key === "Escape") dashboardClose(); };
    document.addEventListener("keydown", dashboardLike, true);
    try {
      for (const off of [
        () => useAiSettingsStore.setState({ aiEnabled: false }),
        () => useSettingsStore.setState({ replyDraftSuggestionsEnabled: false }),
      ]) {
        useAiSettingsStore.setState({ aiEnabled: true });
        useSettingsStore.setState({ replyDraftSuggestionsEnabled: true });
        dashboardClose.mockClear();
        await renderReady("s-r3-settings");
        await act(async () => moreButton().click());
        expect(panel()).not.toBeNull();
        // The scheduler resets the suggestion store when a setting goes off, which would also close the
        // panel through the suggestion status. Put the same suggestion back so that only the setting changes.
        await act(async () => {
          off();
          useBackgroundAiSuggestionStore.getState().set("s-r3-settings", {
            status: "ready",
            requestKey: nextActionRequestKey({ sessionId: "s-r3-settings", eventSeq: 0, displayState: "done" }),
            oneLine: "Ready summary",
            completionAssessment: "Ready assessment",
            nextActions: actions,
          });
        });
        expect(panel()).toBeNull();
        const event = escape();
        await act(async () => { host.dispatchEvent(event); });
        expect(event.defaultPrevented).toBe(false);
        expect(dashboardClose).toHaveBeenCalledTimes(1);
        await act(async () => root.render(null));
      }
    } finally {
      document.removeEventListener("keydown", dashboardLike, true);
    }
  });

  it.each(["last item", "panel"])("closes on forward Tab from %s and focuses the next control after more (DB-R2-003)", async (from) => {
    await renderReady("s-l1-forward-tab");
    await act(async () => moreButton().click());
    const disabled = document.createElement("button");
    disabled.disabled = true;
    const next = document.createElement("textarea");
    const later = document.createElement("button");
    // Deliberately after the portal: panel buttons must be excluded from the DOM-order lookup.
    host.append(disabled, next, later);
    const target = from === "panel" ? panel()! : panel()!.querySelector<HTMLElement>(".cmux-dashboard-next-actions-retry")!;
    target.focus();
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    await act(async () => { target.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(panel()).toBeNull();
    expect(moreButton().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(next);
  });

  it.each(["search", "confirmation"])("leaves Escape to an unrelated %s control while the panel remains open (DB-R2-004)", async (kind) => {
    await renderReady("s-l1-unrelated-esc");
    host.focus(); // WKWebView can leave focus on the root when a button is clicked.
    await act(async () => moreButton().click());
    const surface = document.createElement("div");
    const control = document.createElement(kind === "search" ? "input" : "button");
    if (kind === "confirmation") surface.setAttribute("role", "dialog");
    surface.appendChild(control);
    (kind === "search" ? host : document.body).appendChild(surface);
    control.focus(); // No blur from the trigger/panel: this reproduces the reported state.
    expect(panel()).not.toBeNull();
    const downstream = vi.fn();
    document.addEventListener("keydown", downstream, true);
    try {
      const event = escape();
      await act(async () => { control.dispatchEvent(event); });
      expect(event.defaultPrevented).toBe(false);
      expect(downstream).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(control);
      expect(panel()).not.toBeNull();
    } finally {
      document.removeEventListener("keydown", downstream, true);
      surface.remove();
    }
  });

  it.each(["close", "unmount"])("observes the composer as well as the row and disconnects everything on %s (DB-R2-005)", async (end) => {
    const observers: FakeResizeObserver[] = [];
    class FakeResizeObserver {
      observe = vi.fn();
      disconnect = vi.fn();
      constructor(readonly callback: ResizeObserverCallback) { observers.push(this); }
      fire() { this.callback([], this as unknown as ResizeObserver); }
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    container.className = "cmux-dashboard-composer";
    const addWindow = vi.spyOn(window, "addEventListener");
    const removeWindow = vi.spyOn(window, "removeEventListener");
    const addDocument = vi.spyOn(document, "addEventListener");
    const removeDocument = vi.spyOn(document, "removeEventListener");
    await renderReady("s-l1-observe");
    await act(async () => moreButton().click());
    expect(observers).toHaveLength(1);
    const observer = observers[0]!;
    expect(observer.observe).toHaveBeenCalledWith(container.querySelector(".cmux-dashboard-next-actions"));
    expect(observer.observe).toHaveBeenCalledWith(container);
    // The row moves without changing size; only the composer's observer signals the change.
    rowRect = { ...rowRect, top: 380 };
    await act(async () => { observer.fire(); });
    expect(panel()!.style.bottom).toBe(`${window.innerHeight - 380 + 4}px`);
    const resize = addWindow.mock.calls.find(call => call[0] === "resize")!;
    const scroll = addWindow.mock.calls.find(call => call[0] === "scroll")!;
    const key = addWindow.mock.calls.find(call => call[0] === "keydown")!;
    const pointer = addDocument.mock.calls.find(call => call[0] === "pointerdown")!;
    await act(async () => { if (end === "close") moreButton().click(); else root.render(null); });
    expect(panel()).toBeNull();
    expect(observer.disconnect).toHaveBeenCalledTimes(1);
    expect(removeWindow).toHaveBeenCalledWith("resize", resize[1]);
    expect(removeWindow).toHaveBeenCalledWith("scroll", scroll[1], true);
    expect(removeWindow).toHaveBeenCalledWith("keydown", key[1], true);
    expect(removeDocument).toHaveBeenCalledWith("pointerdown", pointer[1], true);
  });

  it.each([200, 110, 90])("caps the panel above the dashboard root at row top %s, even with less than 120px available (DB-R2-008)", async (top) => {
    rootTop = 96;
    rowRect = { ...rowRect, top };
    await renderReady("s-l1-root-height");
    await act(async () => moreButton().click());
    expect(Number.parseFloat(panel()!.style.maxHeight)).toBe(Math.max(0, top - rootTop - 4 - 8));
    expect(panel()!.style.width).toBe("420px"); // DB-R2-007 remains a separate decision.
    rootTop = 100;
    await act(async () => { window.dispatchEvent(new Event("resize")); });
    expect(Number.parseFloat(panel()!.style.maxHeight)).toBe(Math.max(0, top - rootTop - 4 - 8));
  });

  it.each(["loading", "ready"] as const)("keeps retry focus on the %s row after the panel disappears (DB-R-008)", async (status) => {
    const sessionId = "s-l1-retry-focus";
    await renderReady(sessionId);
    await act(async () => moreButton().click());
    const retry = panel()!.querySelector<HTMLButtonElement>(".cmux-dashboard-next-actions-retry")!;
    retry.focus();
    expect(document.activeElement).toBe(retry);
    await act(async () => {
      retry.click();
      if (status === "loading") useBackgroundAiSuggestionStore.getState().set(sessionId, {
        status: "loading", requestKey: nextActionRequestKey({ sessionId, eventSeq: 0, displayState: "done" }),
        oneLine: "", completionAssessment: "", nextActions: [],
      });
    });
    expect(panel()).toBeNull();
    const target = status === "loading" ? container.querySelector(".cmux-dashboard-next-actions-retry") : moreButton();
    expect(target).not.toBeNull();
    expect(document.activeElement).toBe(target);
    const event = escape();
    await act(async () => { document.activeElement!.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(false);
  });


  const otherKeyState = (sessionId: string, requestKey: string) => ({
    status: "loading" as const, requestKey, oneLine: "", completionAssessment: "", nextActions: [],
  });

  it("does not steal focus from a field the user moved to when the retry row is drawn later (L1R-0907-001)", async () => {
    const sessionId = "s-l1r-retry-no-steal";
    const rowKey = nextActionRequestKey({ sessionId, eventSeq: 0, displayState: "done" });
    await renderReady(sessionId);
    await act(async () => moreButton().click());
    const retry = panel()!.querySelector<HTMLButtonElement>(".cmux-dashboard-next-actions-retry")!;
    retry.focus();
    await act(async () => {
      retry.click();
      // A request key this row does not show: the row has no rowRef while it waits.
      useBackgroundAiSuggestionStore.getState().set(sessionId, otherKeyState(sessionId, "other-key"));
    });
    expect(panel()).toBeNull();
    const reply = document.createElement("textarea");
    host.appendChild(reply);
    reply.focus();
    expect(document.activeElement).toBe(reply);
    await act(async () => useBackgroundAiSuggestionStore.getState().set(sessionId, otherKeyState(sessionId, rowKey)));
    expect(container.querySelector(".cmux-dashboard-next-actions-retry")).not.toBeNull();
    expect(document.activeElement).toBe(reply);
  });

  async function retryFromPanelToLoading(sessionId: string) {
    await renderReady(sessionId);
    await act(async () => moreButton().click());
    const retry = panel()!.querySelector<HTMLButtonElement>(".cmux-dashboard-next-actions-retry")!;
    retry.focus();
    await act(async () => { retry.click(); useBackgroundAiSuggestionStore.getState().set(sessionId, otherKeyState(sessionId, nextActionRequestKey({ sessionId, eventSeq: 0, displayState: "done" }))); });
    expect(document.activeElement).toBe(container.querySelector(".cmux-dashboard-next-actions-retry"));
  }

  it("follows retry focus to the more button when the loading row becomes ready (TM 0907)", async () => {
    const sessionId = "s-tm-retry-follow-ready";
    await retryFromPanelToLoading(sessionId);
    await act(async () => useBackgroundAiSuggestionStore.getState().set(sessionId, {
      status: "ready", requestKey: nextActionRequestKey({ sessionId, eventSeq: 0, displayState: "done" }),
      oneLine: "Ready summary", completionAssessment: "Ready assessment", nextActions: actions,
    }));
    expect(document.activeElement).toBe(moreButton());
  });

  it("follows retry focus to the failed row's retry button when loading fails (TM 0907)", async () => {
    const sessionId = "s-tm-retry-follow-failed";
    await retryFromPanelToLoading(sessionId);
    await act(async () => useBackgroundAiSuggestionStore.getState().set(sessionId, {
      status: "failed", requestKey: nextActionRequestKey({ sessionId, eventSeq: 0, displayState: "done" }),
      oneLine: "", completionAssessment: "", nextActions: [], failureCode: "cli_not_found",
    }));
    const retry = container.querySelector(".cmux-dashboard-next-actions-retry");
    expect(retry).not.toBeNull();
    expect(document.activeElement).toBe(retry);
  });

  it("does not take focus back from a reply field when the loading row becomes ready (TM 0907)", async () => {
    const sessionId = "s-tm-retry-follow-no-steal";
    await retryFromPanelToLoading(sessionId);
    const reply = document.createElement("textarea");
    host.appendChild(reply);
    reply.focus();
    await act(async () => useBackgroundAiSuggestionStore.getState().set(sessionId, {
      status: "ready", requestKey: nextActionRequestKey({ sessionId, eventSeq: 0, displayState: "done" }),
      oneLine: "Ready summary", completionAssessment: "Ready assessment", nextActions: actions,
    }));
    expect(document.activeElement).toBe(reply);
  });

  it("still moves focus to the retry button when focus stayed on body and the row is drawn later (L1R-0907-001)", async () => {
    const sessionId = "s-l1r-retry-late-row";
    const rowKey = nextActionRequestKey({ sessionId, eventSeq: 0, displayState: "done" });
    await renderReady(sessionId);
    await act(async () => moreButton().click());
    const retry = panel()!.querySelector<HTMLButtonElement>(".cmux-dashboard-next-actions-retry")!;
    retry.focus();
    await act(async () => {
      retry.click();
      useBackgroundAiSuggestionStore.getState().set(sessionId, otherKeyState(sessionId, "other-key"));
    });
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(document.body);
    await act(async () => useBackgroundAiSuggestionStore.getState().set(sessionId, otherKeyState(sessionId, rowKey)));
    expect(document.activeElement).toBe(container.querySelector(".cmux-dashboard-next-actions-retry"));
  });
});
