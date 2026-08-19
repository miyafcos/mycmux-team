// @vitest-environment jsdom

import { act } from "react";
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
