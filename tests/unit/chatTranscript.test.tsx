// @vitest-environment jsdom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatTranscript } from "../../src/components/dashboard/ChatTranscript";
import * as chatModel from "../../src/components/dashboard/chatModel";
import * as linkedTextModule from "../../src/components/dashboard/DashboardLinkedText";
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

  it("moves compact turn navigation into the header and preserves its labels and focus behavior", async () => {
    const target = document.createElement("header");
    document.body.append(target);
    const events = [userMessage("first"), userMessage("last")];
    try {
      await act(async () => root.render(<ChatTranscript compact events={events} navigationTarget={target} />));
      expect(host.querySelector("[data-dashboard-user-turn-nav]")).toBeNull();
      expect([...target.querySelectorAll("button")].map(button => button.getAttribute("aria-label")))
        .toEqual([PREV_LABEL, NEXT_LABEL]);
      const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      target.querySelector("button")!.dispatchEvent(down);
      expect(down.defaultPrevented).toBe(true);
      await act(async () => root.render(<ChatTranscript compact events={events} />));
      expect(target.children).toHaveLength(0);
      expect(host.querySelectorAll("[data-dashboard-user-turn-nav]")).toHaveLength(1);
      await act(async () => root.render(<ChatTranscript events={events} navigationTarget={target} />));
      expect(target.children).toHaveLength(0);
      expect(host.querySelector(".cmux-dashboard-user-turn-nav-count")).not.toBeNull();
    } finally {
      target.remove();
    }
  });

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

describe("ChatTranscript scroll work", () => {
  const turnCount = 48;
  let host: HTMLDivElement;
  let root: Root;

  function transcriptEvents(): SemanticEventEnvelope[] {
    return Array.from({ length: turnCount }, (_, index) => {
      const call_id = `call-${index}`;
      const target = `tool target ${index}`;
      return [
        userMessage(`Request ${index + 1}`),
        envelope({ type: "agentMessage", text: `Response ${index + 1}` }),
        envelope({ type: "toolStart", call_id, tool: "Read", target }),
        envelope({ type: "toolEnd", call_id, tool: "Read", target, ok: true, summary: null }),
      ];
    }).flat();
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });


  it.each([true, false])("forgets the oldest tool disclosure at the cap while retaining its conversation (separate first update: %s)", async separateFirst => {
    const events = Array.from({ length: 257 }, (_, index) => {
      const call_id = "disclosure-" + index;
      return [
        userMessage("request-" + index),
        envelope({ type: "toolStart", call_id, tool: "Read", target: call_id }),
        envelope({ type: "toolEnd", call_id, tool: "Read", target: call_id, ok: true, summary: null }),
      ];
    }).flat();
    const invoke = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
    await act(async () => root.render(<ChatTranscript events={events} />));
    const groups = [...host.querySelectorAll<HTMLDetailsElement>(".cmux-dashboard-toolfold")];
    expect(groups).toHaveLength(257);
    const open = (group: HTMLDetailsElement) => {
      group.open = true;
      group.dispatchEvent(new Event("toggle"));
    };
    if (separateFirst) await act(async () => open(groups[0]));
    await act(async () => { for (const group of groups.slice(separateFirst ? 1 : 0)) open(group); });
    expect(groups[0].open).toBe(false);
    expect(groups.slice(1).every(group => group.open)).toBe(true);
    expect(host.textContent).toContain("request-0");
    expect(groups[0].textContent).toContain("disclosure-0");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0].slice(0, 2)).toEqual(["report_renderer_heartbeat", {
      diagnostic: expect.objectContaining({ event: "coalesced", numbers: { count_tool_disclosure_evicted: 1 } }),
    }]);
  });

  it("keeps both new tool groups open when their native toggle events arrive separately", async () => {
    const events = Array.from({ length: 258 }, (_, index) => {
      const call_id = "native-disclosure-" + index;
      return [
        userMessage("request-" + index),
        envelope({ type: "toolStart", call_id, tool: "Read", target: call_id }),
        envelope({ type: "toolEnd", call_id, tool: "Read", target: call_id, ok: true, summary: null }),
      ];
    }).flat();
    const invoke = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
    await act(async () => root.render(<ChatTranscript events={events} />));
    const groups = [...host.querySelectorAll<HTMLDetailsElement>(".cmux-dashboard-toolfold")];
    expect(groups).toHaveLength(258);
    const click = (group: HTMLDetailsElement) => group.querySelector("summary")!.click();
    const toggled = (group: HTMLDetailsElement) =>
      new Promise<void>(resolve => group.addEventListener("toggle", () => resolve(), { once: true }));
    await act(async () => {
      for (const group of groups.slice(0, 256)) {
        group.open = true;
        group.dispatchEvent(new Event("toggle"));
      }
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    const firstToggle = toggled(groups[256]);
    const secondToggle = toggled(groups[257]);
    await act(async () => {
      click(groups[256]);
      click(groups[257]);
      await firstToggle;
    });
    await act(async () => { await secondToggle; });
    expect(groups.slice(0, 2).map(group => group.open)).toEqual([false, false]);
    expect(groups.slice(2).every(group => group.open)).toBe(true);
    expect(host.textContent).toContain("request-0");
    expect(host.textContent).toContain("native-disclosure-0");
    const evictions = invoke.mock.calls.map(([, args]) => args.diagnostic.numbers.count_tool_disclosure_evicted);
    expect(evictions.reduce((total, count) => total + count, 0)).toBe(2);
  });

  it("bounds lookups and row renders during settled wheel scrolling", () => {
    const linkedText = vi.spyOn(linkedTextModule, "DashboardLinkedText").mockImplementation(({ text }) => <>{text}</>);
    const events = transcriptEvents();
    act(() => root.render(<ChatTranscript compact events={events} displayState="idle" />));
    act(() => vi.advanceTimersToNextFrame());
    expect(linkedText.mock.calls.filter(([props]) => props.text.startsWith("tool target "))).toHaveLength(turnCount);
    linkedText.mockClear();

    const log = host.querySelector<HTMLElement>(".cmux-dashboard-chat")!;
    const metrics = { scrollHeight: 5000, clientHeight: 400, scrollTop: 4600 };
    stubScrollMetrics(log, metrics);
    const containerRect = vi.spyOn(log, "getBoundingClientRect").mockReturnValue({ top: 0 } as DOMRect);
    const turns = Array.from(log.querySelectorAll<HTMLElement>(".cmux-dashboard-msg.is-user"));
    expect(turns).toHaveLength(turnCount);
    const turnRects = turns.map((turn, index) => vi.spyOn(turn, "getBoundingClientRect").mockImplementation(() => (
      { top: index * 90 - metrics.scrollTop } as DOMRect
    )));
    const selectors = vi.spyOn(log, "querySelectorAll");
    const frames = vi.spyOn(window, "requestAnimationFrame");
    const next = host.querySelector<HTMLButtonElement>(`button[aria-label="${NEXT_LABEL}"]`)!;

    for (const [scrollTop, expectedTurn, followingBottom] of [
      [2250, 26, false],
      [1508, 17, false],
      [1509, 17, false],
      [3600, 41, false],
      [4575, 48, false],
      [4576, 48, true],
    ] as const) {
      act(() => {
        for (let offset = 3; offset >= 0; offset -= 1) {
          metrics.scrollTop = scrollTop - offset;
          log.dispatchEvent(new Event("scroll"));
        }
        vi.advanceTimersToNextFrame();
      });
      expect(host.querySelector("[data-dashboard-user-turn-nav]")?.getAttribute("aria-label"))
        .toBe(dashboardStrings.userTurnNavAriaLabel(expectedTurn, turnCount));
      expect(next.disabled).toBe(followingBottom);
      expect(metrics.scrollTop).toBe(scrollTop);
    }

    const eventLookups = selectors.mock.calls.flatMap(([selector], index) => (
      selector === "[data-dashboard-event]" ? [selectors.mock.results[index].value.length as number] : []
    ));
    const counts = {
      eventQueries: eventLookups.length,
      eventMatches: eventLookups.reduce((total, matches) => total + matches, 0),
      turnRects: turnRects.reduce((total, rect) => total + rect.mock.calls.length, 0),
      containerRects: containerRect.mock.calls.length,
      frameRequests: frames.mock.calls.length,
      toolRowRenders: linkedText.mock.calls.filter(([props]) => props.text.startsWith("tool target ")).length,
      userBubbleRenders: linkedText.mock.calls.filter(([props]) => props.text.startsWith("Request ")).length,
    };
    if (process.env.DASHBOARD_SCROLL_METRICS === "1") console.info("Settled scroll counts", counts);
    expect.soft(counts.eventQueries).toBe(0);
    expect.soft(counts.turnRects).toBeLessThanOrEqual(5 * Math.ceil(Math.log2(turnCount)));
    expect.soft(counts.containerRects).toBeLessThanOrEqual(5);
    expect.soft(counts.frameRequests).toBe(6);
    expect.soft(counts.toolRowRenders).toBe(0);
    expect.soft(counts.userBubbleRenders).toBe(0);
  });

  it("reuses transcript rows across refetched copies and rebuilds when an event changes without a new ID", () => {
    const projectRows = vi.spyOn(chatModel, "toChatTranscriptRows");
    const linkedText = vi.spyOn(linkedTextModule, "DashboardLinkedText").mockImplementation(({ text }) => <>{text}</>);
    const events = transcriptEvents();
    act(() => root.render(<ChatTranscript compact events={events} displayState="idle" />));
    expect(projectRows).toHaveBeenCalledTimes(1);
    expect(linkedText.mock.calls.filter(([props]) => props.text.startsWith("tool target "))).toHaveLength(turnCount);

    for (let poll = 0; poll < 3; poll += 1) {
      const copy: SemanticEventEnvelope[] = JSON.parse(JSON.stringify(events));
      act(() => root.render(<ChatTranscript compact events={copy} displayState="idle" />));
      act(() => vi.advanceTimersToNextFrame());
    }

    const counts = {
      rowBuilds: projectRows.mock.calls.length,
      toolRowRenders: linkedText.mock.calls.filter(([props]) => props.text.startsWith("tool target ")).length,
      userBubbleRenders: linkedText.mock.calls.filter(([props]) => props.text.startsWith("Request ")).length,
    };
    if (process.env.DASHBOARD_SCROLL_METRICS === "1") console.info("Initial render and refetch counts", counts);
    expect.soft(counts.rowBuilds).toBe(1);
    expect.soft(counts.toolRowRenders).toBe(turnCount);
    expect.soft(counts.userBubbleRenders).toBe(turnCount);

    const changed: SemanticEventEnvelope = {
      ...events[0],
      kind: { type: "userMessage", kind: "taskStart", text: "Corrected request", digest: "Request 1" },
    };
    act(() => root.render(<ChatTranscript compact events={[changed, ...events.slice(1)]} displayState="idle" />));
    expect(projectRows).toHaveBeenCalledTimes(counts.rowBuilds + 1);
    expect(host.querySelector(".cmux-dashboard-msg.is-user")?.textContent).toBe("Corrected request");
  });
});
