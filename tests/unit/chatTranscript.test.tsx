// @vitest-environment jsdom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatTranscript } from "../../src/components/dashboard/ChatTranscript";
import { dashboardStrings } from "../../src/components/dashboard/dashboardStrings";
import type { SemanticEvent, SemanticEventEnvelope } from "../../src/lib/livebrief";

let sequence = 0;
function envelope(kind: SemanticEvent): SemanticEventEnvelope {
  sequence += 1;
  return {
    eventId: `user-turn-${sequence}`,
    sourceRevision: sequence,
    occurredAt: sequence * 1_000,
    sourceByteStart: 0,
    sourceByteEnd: 1,
    kind,
  };
}

function userMessage(text: string): SemanticEventEnvelope {
  return envelope({ type: "userMessage", kind: "taskStart", text, digest: text });
}

const NEXT_LABEL = dashboardStrings.userTurnNextAriaLabel;
const PREV_LABEL = dashboardStrings.userTurnPrevAriaLabel;

describe("ChatTranscript user-turn nav", () => {
  it("shows n/total for three user messages and disables next at the latest turn", () => {
    const html = renderToStaticMarkup(
      <ChatTranscript
        events={[
          userMessage("最初の命令"),
          envelope({ type: "agentMessage", text: "了解" }),
          userMessage("二番目の命令"),
          userMessage("最後の命令"),
        ]}
      />,
    );
    expect(html).toContain("data-dashboard-user-turn-nav");
    expect(html).toContain('data-dashboard-user-turn-count="3/3"');
    expect(html).toContain("最後の命令");
    expect(html).toContain(`aria-label="${PREV_LABEL}"`);
    expect(html).toContain(`aria-label="${NEXT_LABEL}"`);
    expect(html).toMatch(new RegExp(`aria-label="${NEXT_LABEL}"[^>]*disabled`));
    expect(html).not.toMatch(new RegExp(`aria-label="${PREV_LABEL}"[^>]*disabled`));
  });

  it("hides the nav when there are no user messages", () => {
    const empty = renderToStaticMarkup(<ChatTranscript events={[]} />);
    const agentOnly = renderToStaticMarkup(
      <ChatTranscript events={[envelope({ type: "agentMessage", text: "hello" })]} />,
    );
    expect(empty).not.toContain("data-dashboard-user-turn-nav");
    expect(agentOnly).not.toContain("data-dashboard-user-turn-nav");
  });

  it("disables previous at the first user turn", () => {
    const html = renderToStaticMarkup(
      <ChatTranscript events={[userMessage("only one")]} />,
    );
    expect(html).toContain('data-dashboard-user-turn-count="1/1"');
    expect(html).toMatch(new RegExp(`aria-label="${PREV_LABEL}"[^>]*disabled`));
    expect(html).toMatch(new RegExp(`aria-label="${NEXT_LABEL}"[^>]*disabled`));
  });

  it("keeps a long Japanese command on one label element for CSS ellipsis", () => {
    const label = "あ".repeat(80);
    const html = renderToStaticMarkup(<ChatTranscript events={[userMessage(label)]} />);
    expect(html.split("cmux-dashboard-user-turn-nav-label").length - 1).toBe(1);
    expect(html).toContain(label);
  });
});

function stubScrollMetrics(node: HTMLElement, metrics: { scrollHeight: number; clientHeight: number; scrollTop: number }): void {
  Object.defineProperties(node, {
    scrollHeight: { configurable: true, get: () => metrics.scrollHeight },
    clientHeight: { configurable: true, get: () => metrics.clientHeight },
    scrollTop: {
      configurable: true,
      get: () => metrics.scrollTop,
      set: (value: number) => { metrics.scrollTop = Number(value); },
    },
  });
}

function pinTurnRects(container: HTMLElement): void {
  const box = { x: 0, y: 0, width: 320, height: 200, top: 0, left: 0, bottom: 200, right: 320, toJSON() { return {}; } };
  vi.spyOn(container, "getBoundingClientRect").mockReturnValue(box as DOMRect);
  for (const element of container.querySelectorAll("[data-dashboard-event]")) {
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
      ...box,
      y: -8,
      top: -8,
      bottom: 32,
      height: 40,
    } as DOMRect);
  }
}

describe("ChatTranscript next-to-latest", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function flushFrame(): Promise<void> {
    await act(async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    });
  }

  async function mountThreeTurns(): Promise<{ log: HTMLElement; metrics: { scrollHeight: number; clientHeight: number; scrollTop: number } }> {
    await act(async () => {
      root.render(
        <ChatTranscript
          events={[
            userMessage("最初の命令"),
            envelope({ type: "agentMessage", text: "了解" }),
            userMessage("二番目の命令"),
            userMessage("最後の命令"),
          ]}
        />,
      );
    });
    const log = host.querySelector('[role="log"]') as HTMLElement;
    const metrics = { scrollHeight: 1000, clientHeight: 200, scrollTop: 800 };
    stubScrollMetrics(log, metrics);
    pinTurnRects(log);
    return { log, metrics };
  }

  async function scrollAwayFromBottom(log: HTMLElement, metrics: { scrollTop: number }): Promise<void> {
    metrics.scrollTop = 700;
    await act(async () => {
      log.dispatchEvent(new Event("scroll"));
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    });
  }

  it("keeps next enabled when the last turn is showing and the view is not following the bottom", async () => {
    const { log, metrics } = await mountThreeTurns();
    await scrollAwayFromBottom(log, metrics);
    const next = host.querySelector(`[aria-label="${NEXT_LABEL}"]`) as HTMLButtonElement;
    expect(host.querySelector('[data-dashboard-user-turn-count="3/3"]')).not.toBeNull();
    expect(next.disabled).toBe(false);
  });

  it("returns to the latest bottom when next is pressed on the last turn", async () => {
    const { log, metrics } = await mountThreeTurns();
    await scrollAwayFromBottom(log, metrics);
    const next = host.querySelector(`[aria-label="${NEXT_LABEL}"]`) as HTMLButtonElement;
    expect(next.disabled).toBe(false);
    await act(async () => { next.click(); });
    await flushFrame();
    expect(metrics.scrollTop).toBe(1000);
    expect(next.disabled).toBe(true);
  });

  it("disables next while following the bottom", async () => {
    await mountThreeTurns();
    const next = host.querySelector(`[aria-label="${NEXT_LABEL}"]`) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
  });
});

describe("ChatTranscript user-turn requests", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const { useDashboardViewStore } = await import("../../src/stores/dashboardViewStore");
    useDashboardViewStore.setState({ userTurnRequests: {}, userTurnRequestSeq: 0 });
  });

  afterEach(async () => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    const { useDashboardViewStore } = await import("../../src/stores/dashboardViewStore");
    useDashboardViewStore.setState({ userTurnRequests: {}, userTurnRequestSeq: 0 });
  });

  function threeTurnEvents() {
    return [
      userMessage("最初の命令"),
      envelope({ type: "agentMessage", text: "了解" }),
      userMessage("二番目の命令"),
      userMessage("最後の命令"),
    ];
  }

  function spyScroll(id: string): ReturnType<typeof vi.fn> {
    const node = document.getElementById(`dashboard-event-${id}`);
    if (!node) throw new Error(`turn ${id} missing`);
    const scrollIntoView = vi.fn();
    node.scrollIntoView = scrollIntoView;
    return scrollIntoView;
  }

  it("consumes a relative step against the current nav index", async () => {
    const { useDashboardViewStore } = await import("../../src/stores/dashboardViewStore");
    const events = threeTurnEvents();
    const firstId = events[0]?.eventId;
    const secondId = events[2]?.eventId;
    if (!firstId || !secondId) throw new Error("event ids missing");

    await act(async () => {
      root.render(<ChatTranscript tabId="tab-claude" events={events} detailLoaded />);
    });
    const firstScroll = spyScroll(firstId);
    const secondScroll = spyScroll(secondId);
    const log = host.querySelector('[role="log"]') as HTMLElement;
    stubScrollMetrics(log, { scrollHeight: 1000, clientHeight: 200, scrollTop: 800 });
    pinTurnRects(log);

    await act(async () => {
      useDashboardViewStore.getState().requestUserTurnStep("tab-claude", -1);
    });

    expect(useDashboardViewStore.getState().userTurnRequests["tab-claude"]).toBeUndefined();
    expect(secondScroll).toHaveBeenCalledTimes(1);
    expect(firstScroll).not.toHaveBeenCalled();
  });

  it("scrolls the newest user message whose label matches", async () => {
    const { useDashboardViewStore } = await import("../../src/stores/dashboardViewStore");
    const events = threeTurnEvents();
    const secondId = events[2]?.eventId;
    if (!secondId) throw new Error("event ids missing");

    await act(async () => {
      root.render(<ChatTranscript tabId="tab-claude" events={events} detailLoaded />);
    });
    const secondScroll = spyScroll(secondId);

    await act(async () => {
      useDashboardViewStore.getState().requestUserTurnByLabel("tab-claude", "二番目の命令");
    });

    expect(secondScroll).toHaveBeenCalledTimes(1);
    expect(useDashboardViewStore.getState().userTurnRequests["tab-claude"]).toBeUndefined();
  });

  it("holds the request until detailLoaded becomes true", async () => {
    const { useDashboardViewStore } = await import("../../src/stores/dashboardViewStore");
    const shallow = [
      userMessage("浅い12件の末尾"),
      envelope({ type: "agentMessage", text: "了解" }),
    ];
    const detail = [
      userMessage("詳細の古い命令"),
      envelope({ type: "agentMessage", text: "old" }),
      ...shallow,
    ];
    const oldId = detail[0]?.eventId;
    if (!oldId) throw new Error("event ids missing");

    await act(async () => {
      root.render(<ChatTranscript tabId="tab-claude" events={detail} detailLoaded={false} />);
    });
    const oldScroll = spyScroll(oldId);
    await act(async () => {
      useDashboardViewStore.getState().requestUserTurnByLabel("tab-claude", "詳細の古い命令");
    });
    expect(oldScroll).not.toHaveBeenCalled();
    expect(useDashboardViewStore.getState().userTurnRequests["tab-claude"]).toMatchObject({
      kind: "label",
      label: "詳細の古い命令",
    });

    await act(async () => {
      root.render(<ChatTranscript tabId="tab-claude" events={detail} detailLoaded />);
    });
    expect(oldScroll).toHaveBeenCalledTimes(1);
    expect(useDashboardViewStore.getState().userTurnRequests["tab-claude"]).toBeUndefined();
  });

  it("consumes a request that arrived before mount once detail is loaded", async () => {
    const { useDashboardViewStore } = await import("../../src/stores/dashboardViewStore");
    const events = threeTurnEvents();
    const secondId = events[2]?.eventId;
    if (!secondId) throw new Error("event ids missing");
    useDashboardViewStore.getState().requestUserTurnStep("tab-claude", -1);
    const scrollIntoView = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      await act(async () => {
        root.render(<ChatTranscript tabId="tab-claude" events={events} detailLoaded />);
      });
      expect(useDashboardViewStore.getState().userTurnRequests["tab-claude"]).toBeUndefined();
      expect(scrollIntoView).toHaveBeenCalled();
      expect(document.getElementById(`dashboard-event-${secondId}`)).not.toBeNull();
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("claims a request once under StrictMode so scroll runs a single time", async () => {
    const { useDashboardViewStore } = await import("../../src/stores/dashboardViewStore");
    const events = threeTurnEvents();
    const secondId = events[2]?.eventId;
    if (!secondId) throw new Error("event ids missing");

    await act(async () => {
      root.render(
        <StrictMode>
          <ChatTranscript tabId="tab-claude" events={events} detailLoaded />
        </StrictMode>,
      );
    });
    const secondScroll = spyScroll(secondId);
    await act(async () => {
      useDashboardViewStore.getState().requestUserTurnStep("tab-claude", -1);
    });
    expect(secondScroll).toHaveBeenCalledTimes(1);
    expect(useDashboardViewStore.getState().userTurnRequests["tab-claude"]).toBeUndefined();
  });

  it("scrolls the latest user message instead of the transcript tail", async () => {
    const { useDashboardViewStore } = await import("../../src/stores/dashboardViewStore");
    const events = [
      userMessage("最後の命令"),
      envelope({ type: "agentMessage", text: "長い応答" }),
    ];
    const userId = events[0]?.eventId;
    if (!userId) throw new Error("event ids missing");

    await act(async () => {
      root.render(<ChatTranscript tabId="tab-claude" events={events} detailLoaded />);
    });
    const userScroll = spyScroll(userId);
    const log = host.querySelector('[role="log"]') as HTMLElement;
    const metrics = { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 };
    stubScrollMetrics(log, metrics);

    await act(async () => {
      useDashboardViewStore.getState().requestUserTurnLatest("tab-claude");
    });

    expect(userScroll).toHaveBeenCalledTimes(1);
    expect(metrics.scrollTop).toBe(0);
  });

  it("no-ops a step past the last user turn without sending the log to the tail", async () => {
    const { useDashboardViewStore } = await import("../../src/stores/dashboardViewStore");
    const events = threeTurnEvents();
    await act(async () => {
      root.render(<ChatTranscript tabId="tab-claude" events={events} detailLoaded />);
    });
    const log = host.querySelector('[role="log"]') as HTMLElement;
    const metrics = { scrollHeight: 1000, clientHeight: 200, scrollTop: 400 };
    stubScrollMetrics(log, metrics);
    const latestId = events[3]?.eventId;
    if (!latestId) throw new Error("event ids missing");
    const latestScroll = spyScroll(latestId);

    await act(async () => {
      useDashboardViewStore.getState().requestUserTurnStep("tab-claude", 1);
    });

    expect(useDashboardViewStore.getState().userTurnRequests["tab-claude"]).toBeUndefined();
    expect(latestScroll).not.toHaveBeenCalled();
    expect(metrics.scrollTop).toBe(400);
  });


  it("jumps inside its own log when another mounted transcript has the same event ids", async () => {
    const events = threeTurnEvents();
    const { useDashboardViewStore } = await import("../../src/stores/dashboardViewStore");
    await act(async () => root.render(<>
      <ChatTranscript events={events} tabId={null} detailLoaded />
      <ChatTranscript events={events} tabId="visible" detailLoaded />
    </>));
    const logs = host.querySelectorAll('[role="log"]');
    const first = logs[0].querySelectorAll("[data-dashboard-event]")[2] as HTMLElement;
    const second = logs[1].querySelectorAll("[data-dashboard-event]")[2] as HTMLElement;
    const hiddenScroll = vi.fn();
    const visibleScroll = vi.fn();
    first.scrollIntoView = hiddenScroll;
    second.scrollIntoView = visibleScroll;
    await act(async () => useDashboardViewStore.getState().requestUserTurnStep("visible", -1));
    expect(visibleScroll).toHaveBeenCalledTimes(1);
    expect(hiddenScroll).not.toHaveBeenCalled();
  });

  it("highlights and jumps to a merged message source once, without pinning later polling to it", async () => {
    const first = envelope({ type: "agentMessage", text: "first paragraph" });
    const second = envelope({ type: "agentMessage", text: "second paragraph" });
    const events = [first, second];
    await act(async () => root.render(<ChatTranscript events={events} />));
    const scroll = spyScroll(first.eventId);
    await act(async () => root.render(<ChatTranscript events={events} targetEventId={second.eventId} targetEventRequest={1} />));
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(host.querySelector(".is-source-highlighted")?.getAttribute("data-dashboard-event")).toBe(first.eventId);
    await act(async () => root.render(<ChatTranscript events={[...events]} targetEventId={second.eventId} targetEventRequest={1} />));
    expect(scroll).toHaveBeenCalledTimes(1);
    await act(async () => root.render(<ChatTranscript events={[...events]} targetEventId={second.eventId} targetEventRequest={2} />));
    expect(scroll).toHaveBeenCalledTimes(2);
  });

  it("updates the turn count after the StrictMode setup-cleanup-setup cycle", async () => {
    const events = [userMessage("first")];
    await act(async () => root.render(<StrictMode><ChatTranscript events={events} /></StrictMode>));
    await act(async () => {
      root.render(<StrictMode><ChatTranscript events={[...events, userMessage("second")]} /></StrictMode>);
    });
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(host.querySelector("[data-dashboard-user-turn-count]")?.getAttribute("data-dashboard-user-turn-count")).toBe("2/2");
  });

  it("ignores a request for a different tab", async () => {
    const { useDashboardViewStore } = await import("../../src/stores/dashboardViewStore");
    useDashboardViewStore.getState().requestUserTurnStep("tab-other", -1);
    await act(async () => {
      root.render(
        <ChatTranscript
          tabId="tab-claude"
          events={[userMessage("最初の命令"), userMessage("最後の命令")]}
          detailLoaded
        />,
      );
    });
    expect(useDashboardViewStore.getState().userTurnRequests["tab-other"]).toMatchObject({
      kind: "step",
      delta: -1,
    });
  });
});
