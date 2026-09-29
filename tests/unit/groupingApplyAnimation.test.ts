// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
  GROUPING_DIAGRAM_COMMIT_PROGRESS,
  GROUPING_DIAGRAM_FLIGHT_MS,
  groupingApplyTrackPoint,
  sampleGroupingApplyPath,
  startGroupingApplyAnimation,
  type GroupingApplyAnimationItem,
} from "../../src/components/layout/groupingApplyAnimation";

function animationItem(tabId = "tab-1", pathSegments: readonly string[] = ["M 0 0 L 100 0"]): GroupingApplyAnimationItem {
  const proxyElement = document.createElement("div");
  const sourceElement = document.createElement("button");
  const destinationElement = document.createElement("button");
  return {
    tabId,
    width: 10,
    height: 6,
    sourceCenter: { x: 5, y: 3 },
    destinationCenter: { x: 105, y: 3 },
    pathSegments,
    proxyElement,
    sourceElement,
    destinationElement,
  };
}

function frameHarness() {
  const frames: Array<{ id: number; callback: FrameRequestCallback }> = [];
  let nextId = 0;
  return {
    frames,
    requestFrame: (callback: FrameRequestCallback) => {
      nextId += 1;
      frames.push({ id: nextId, callback });
      return nextId;
    },
    cancelFrame: (id: number) => {
      const index = frames.findIndex((frame) => frame.id === id);
      if (index >= 0) frames.splice(index, 1);
    },
    runAt: (timestamp: number) => {
      const pending = frames.splice(0, frames.length);
      for (const frame of pending) frame.callback(timestamp);
    },
  };
}

describe("grouping apply diagram animation", () => {
  it("samples the same cubic and lead-in path strings used by the preview", () => {
    const segments = ["M 0 0 C 20 0 80 40 100 40", "M 100 40 L 120 40"];
    const samples = sampleGroupingApplyPath(segments, 16);
    expect(samples).toHaveLength(17);
    expect(samples[0]).toEqual({ x: 0, y: 0 });
    expect(samples[16]).toEqual({ x: 120, y: 40 });
    expect(groupingApplyTrackPoint(samples, 0)).toEqual(samples[0]);
    expect(groupingApplyTrackPoint(samples, 1)).toEqual(samples[16]);
  });

  it("uses one time-based rAF loop and issues commit once at the seam", () => {
    const harness = frameHarness();
    const item = animationItem();
    const commit = vi.fn(() => ({ ok: true }));
    const finished = vi.fn();
    const controller = startGroupingApplyAnimation({
      items: [item],
      requestFrame: harness.requestFrame,
      cancelFrame: harness.cancelFrame,
      onCommit: commit,
      commitSucceeded: (outcome) => outcome.ok,
      shouldReverse: (outcome) => !outcome.ok,
      onFinished: finished,
    });
    expect(controller).not.toBeNull();
    expect(harness.frames).toHaveLength(1);
    harness.runAt(0);
    expect(commit).not.toHaveBeenCalled();
    expect(harness.frames).toHaveLength(1);
    harness.runAt(GROUPING_DIAGRAM_FLIGHT_MS * GROUPING_DIAGRAM_COMMIT_PROGRESS - 1);
    expect(commit).not.toHaveBeenCalled();
    harness.runAt(GROUPING_DIAGRAM_FLIGHT_MS * GROUPING_DIAGRAM_COMMIT_PROGRESS);
    expect(commit).toHaveBeenCalledTimes(1);
    harness.runAt(GROUPING_DIAGRAM_FLIGHT_MS);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(finished).toHaveBeenCalledTimes(1);
    expect(controller?.phase()).toBe("finished");
    expect(item.sourceElement.style.opacity).toBe("");
    expect(item.destinationElement.style.opacity).toBe("");
  });

  it("reverses a failed commit over the identical frozen track", () => {
    const harness = frameHarness();
    const item = animationItem();
    const positions: string[] = [];
    const controller = startGroupingApplyAnimation({
      items: [item],
      requestFrame: harness.requestFrame,
      cancelFrame: harness.cancelFrame,
      onCommit: () => ({ ok: false }),
      commitSucceeded: (outcome) => outcome.ok,
      shouldReverse: (outcome) => !outcome.ok,
      onFinished: vi.fn(),
    });
    if (!controller) throw new Error("animation controller was not created");
    const capture = (timestamp: number) => {
      harness.runAt(timestamp);
      positions.push(item.proxyElement.style.transform);
    };
    capture(0);
    capture(40);
    capture(80);
    expect(controller.phase()).toBe("reverse");
    capture(120);
    capture(160);
    expect(positions[3]).toBe(positions[1]);
    expect(positions[4]).toBe(positions[0]);
    expect(controller.phase()).toBe("finished");
  });

  it("keeps 29 chips on one scheduler without frame-time layout reads", () => {
    const harness = frameHarness();
    const items = Array.from({ length: 29 }, (_, index) => animationItem(`tab-${index}`));
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    const commit = vi.fn(() => ({ ok: true }));
    const controller = startGroupingApplyAnimation({
      items,
      requestFrame: harness.requestFrame,
      cancelFrame: harness.cancelFrame,
      onCommit: commit,
      commitSucceeded: (outcome) => outcome.ok,
      shouldReverse: (outcome) => !outcome.ok,
      onFinished: vi.fn(),
    });
    expect(controller).not.toBeNull();
    expect(harness.frames).toHaveLength(1);
    harness.runAt(0);
    expect(harness.frames).toHaveLength(1);
    harness.runAt(80);
    expect(harness.frames).toHaveLength(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(rectSpy).not.toHaveBeenCalled();
    expect(items.every((item) => item.proxyElement.style.transform.startsWith("translate3d("))).toBe(true);
    rectSpy.mockRestore();
  });

  it("settles immediately without adding a second commit", () => {
    const harness = frameHarness();
    const commit = vi.fn(() => ({ ok: true }));
    const finished = vi.fn();
    const controller = startGroupingApplyAnimation({
      items: [animationItem()],
      requestFrame: harness.requestFrame,
      cancelFrame: harness.cancelFrame,
      onCommit: commit,
      commitSucceeded: (outcome) => outcome.ok,
      shouldReverse: (outcome) => !outcome.ok,
      onFinished: finished,
    });
    controller?.settleImmediately();
    controller?.settleImmediately();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(finished).toHaveBeenCalledTimes(1);
    expect(harness.frames).toHaveLength(0);
  });
});
