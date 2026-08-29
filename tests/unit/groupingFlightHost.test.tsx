// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { tabGroupingStrings } from "../../src/components/dashboard/dashboardStrings";
import {
  GroupingFlightHost,
  GROUPING_LANDING_FADE_MS,
  requestGroupingLandingFlight,
  type GroupingLandingFlightRequest,
} from "../../src/components/layout/GroupingFlightHost";
import {
  GROUPING_BRIDGE_FLIGHT_MS,
  GROUPING_LANDING_WAIT_LIMIT_MS,
} from "../../src/components/layout/groupingLandingFlight";

let root: Root | null = null;
let container: HTMLElement | null = null;
let rafQueue: FrameRequestCallback[] = [];

function flushFrames(timestamps: readonly number[]) {
  for (const timestamp of timestamps) {
    const callbacks = rafQueue.splice(0);
    for (const callback of callbacks) callback(timestamp);
  }
}

function mountHost() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<GroupingFlightHost />));
}

function stubRect(element: HTMLElement, rect: { left: number; top: number; width: number; height: number }) {
  element.getBoundingClientRect = () => ({
    ...rect,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    x: rect.left,
    y: rect.top,
    toJSON: () => rect,
  } as DOMRect);
}

function request(overrides?: Partial<GroupingLandingFlightRequest>): GroupingLandingFlightRequest {
  return {
    items: [
      {
        tabId: "tab-a",
        label: "母艦",
        color: "#4488ff",
        width: 60,
        height: 24,
        exitCenter: { x: 100, y: 100 },
        exitTangent: { x: 1, y: 0 },
        destination: { kind: "pane", workspaceId: "ws-1", paneId: "p-1" },
      },
    ],
    movedCount: 4,
    focusWorkspaceId: "ws-1",
    ...overrides,
  };
}

function flightChips(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(".cmux-grouping-flight-host .cmux-tab-grouping-flight-chip")];
}

const SETTLE_FRAMES = [0, 16, 32] as const;
const AFTER_BRIDGE = 32 + GROUPING_BRIDGE_FLIGHT_MS;
const AFTER_FADE = AFTER_BRIDGE + GROUPING_LANDING_FADE_MS;

beforeEach(() => {
  rafQueue = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    rafQueue.push(callback);
    return rafQueue.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.spyOn(performance, "now").mockReturnValue(0);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GroupingFlightHost", () => {
  it("rejects requests while unmounted", () => {
    expect(requestGroupingLandingFlight(request())).toBe(false);
  });

  it("lands a proxy on the destination tab pill and cleans up", () => {
    mountHost();
    const pill = document.createElement("div");
    pill.setAttribute("data-tab-id", "tab-a");
    stubRect(pill, { left: 400, top: 200, width: 80, height: 24 });
    document.body.appendChild(pill);

    expect(requestGroupingLandingFlight(request())).toBe(true);
    const chip = flightChips()[0];
    expect(chip).toBeTruthy();
    expect(chip.style.transform).toBe("translate3d(70px, 88px, 0)");
    expect(chip.textContent).toBe("母艦");

    flushFrames(SETTLE_FRAMES);
    flushFrames([48]);
    expect(flightChips()[0].style.transform).not.toBe("translate3d(70px, 88px, 0)");

    flushFrames([AFTER_BRIDGE]);
    const landed = flightChips()[0];
    // Landing centre = pill centre (440, 212) minus half the chip size.
    expect(landed.style.transform).toBe("translate3d(410px, 200px, 0)");

    flushFrames([AFTER_FADE, AFTER_FADE + 16]);
    expect(flightChips()).toHaveLength(0);
  });

  it("bundles non-visible workspace tabs onto the navigation entry", () => {
    mountHost();
    const nav = document.createElement("div");
    nav.setAttribute("data-dnd-workspace-target-id", "ws-2");
    stubRect(nav, { left: 10, top: 300, width: 180, height: 30 });
    document.body.appendChild(nav);

    expect(requestGroupingLandingFlight(request({
      items: [{
        ...request().items[0],
        destination: { kind: "workspace", workspaceId: "ws-2" },
      }],
    }))).toBe(true);
    flushFrames(SETTLE_FRAMES);
    flushFrames([AFTER_BRIDGE]);
    // Landing centre = nav centre (100, 315) minus half the chip size.
    expect(flightChips()[0].style.transform).toBe("translate3d(70px, 303px, 0)");
  });

  it("fades out in place when no landing target ever appears", () => {
    mountHost();
    expect(requestGroupingLandingFlight(request())).toBe(true);
    flushFrames([0, 40, 80, GROUPING_LANDING_WAIT_LIMIT_MS]);
    const expiredAt = GROUPING_LANDING_WAIT_LIMIT_MS;
    flushFrames([expiredAt + 16, expiredAt + GROUPING_BRIDGE_FLIGHT_MS]);
    const chip = flightChips()[0];
    expect(chip.style.transform).toBe("translate3d(70px, 88px, 0)");
    flushFrames([expiredAt + GROUPING_BRIDGE_FLIGHT_MS + GROUPING_LANDING_FADE_MS, expiredAt + GROUPING_BRIDGE_FLIGHT_MS + GROUPING_LANDING_FADE_MS + 16]);
    expect(flightChips()).toHaveLength(0);
  });

  it("discards the motion on workspace visibility change without touching data", () => {
    mountHost();
    expect(requestGroupingLandingFlight(request())).toBe(true);
    flushFrames([0]);
    window.dispatchEvent(new Event("mycmux:workspace-visibility-change"));
    expect(flightChips()).toHaveLength(0);
  });

  it("focuses the settled workspace pane once when the user gave no input", () => {
    mountHost();
    const pane = document.createElement("div");
    pane.setAttribute("data-dnd-workspace-id", "ws-1");
    pane.setAttribute("data-dnd-pane-id", "p-1");
    pane.tabIndex = -1;
    stubRect(pane, { left: 300, top: 100, width: 400, height: 300 });
    document.body.appendChild(pane);

    expect(requestGroupingLandingFlight(request())).toBe(true);
    flushFrames(SETTLE_FRAMES);
    flushFrames([AFTER_BRIDGE, AFTER_FADE, AFTER_FADE + 16]);
    expect(document.activeElement).toBe(pane);
  });

  it("never writes focus after the user interacted mid-flight", () => {
    mountHost();
    const pane = document.createElement("div");
    pane.setAttribute("data-dnd-workspace-id", "ws-1");
    pane.setAttribute("data-dnd-pane-id", "p-1");
    pane.tabIndex = -1;
    stubRect(pane, { left: 300, top: 100, width: 400, height: 300 });
    document.body.appendChild(pane);

    expect(requestGroupingLandingFlight(request())).toBe(true);
    flushFrames(SETTLE_FRAMES);
    window.dispatchEvent(new Event("pointerdown"));
    flushFrames([AFTER_BRIDGE, AFTER_FADE, AFTER_FADE + 16]);
    expect(document.activeElement).not.toBe(pane);
  });

  it("announces the applied move count via the live region", () => {
    mountHost();
    expect(requestGroupingLandingFlight(request())).toBe(true);
    const live = document.querySelector<HTMLElement>("[aria-live='polite']");
    expect(live?.textContent).toBe(tabGroupingStrings.undoApplied(4));
  });
});
