// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { performance as measurementClock } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GroupingFlightHost } from "../../src/components/layout/GroupingFlightHost";
import { useUiStore } from "../../src/stores/uiStore";
import { setup, cleanup, mount, content, textarea, pointer, advance } from "./paneHoverFocusHarness";

let flightRoot: Root | undefined;
beforeEach(() => setup());
afterEach(async () => {
  if (flightRoot) await act(async () => { flightRoot!.unmount(); });
  flightRoot = undefined; await cleanup();
});

describe("HF-R2-02 observer filtering and P03 attribute batch cost", () => {
  it.each(["xterm textarea", "GroupingFlightHost layer"])("P03 %s: 1000 separate style batches retain dwell without document blocker scans", async (scenario) => {
    let measuredTarget: HTMLElement | undefined;
    const samples: number[] = [], recordCounts: number[] = [];
    const NativeMutation = window.MutationObserver;
    vi.stubGlobal("MutationObserver", class extends NativeMutation {
      constructor(callback: MutationCallback) {
        super((records, observer) => {
          const measured = records.some((r) => r.type === "attributes" && r.attributeName === "style" && r.target === measuredTarget);
          const start = measurementClock.now();
          try { callback(records, observer); }
          finally {
            if (measured) { samples.push(measurementClock.now() - start); recordCounts.push(records.length); }
          }
        });
      }
    });
    const hidden = document.createElement("div"); hidden.setAttribute("role", "alertdialog"); hidden.hidden = true;
    document.body.append(hidden);
    let layer: HTMLElement | undefined;
    if (scenario === "GroupingFlightHost layer") {
      const container = document.createElement("div"); document.body.append(container); flightRoot = createRoot(container);
      await act(async () => { flightRoot!.render(<GroupingFlightHost />); });
      layer = container.querySelector<HTMLElement>(".cmux-grouping-flight-host")!;
      expect(layer.hasAttribute("data-cmux-overlay-root")).toBe(true);
      expect(layer.hasAttribute("data-pane-hover-focus-ignore")).toBe(true);
    }
    await mount();
    await act(async () => { pointer(content(), "pointermove"); }); await advance(50);
    const target = layer ?? textarea();
    expect(target.isConnected).toBe(true); expect(hidden.hidden).toBe(true);
    measuredTarget = target;
    const searches = vi.spyOn(document, "querySelectorAll"), styles = vi.spyOn(window, "getComputedStyle");
    await act(async () => {
      for (let i = 0; i < 1000; i++) {
        if (layer) target.style.transform = `translate3d(${i}px, 0, 0)`;
        else target.style.left = `${i}px`;
        // Each update is delivered by the native observer before the next update.
        await Promise.resolve();
      }
    });
    const scans = searches.mock.calls.filter(([selector]) => selector.includes("[data-pane-hover-focus-blocker]")
      && selector.includes("[data-cmux-overlay-root]")).length;
    const styleReads = styles.mock.calls.length;
    const totalMs = samples.reduce((sum, ms) => sum + ms, 0);
    process.stdout.write(`P03 ${JSON.stringify({ scenario, batches: samples.length, totalMs,
      meanMsPerBatch: totalMs / samples.length, maxBatchMs: Math.max(...samples),
      minRecordsPerBatch: Math.min(...recordCounts), maxRecordsPerBatch: Math.max(...recordCounts),
      documentBlockerSearches: scans, computedStyleReads: styleReads })}\n`);
    expect(samples).toHaveLength(1000); expect(new Set(recordCounts)).toEqual(new Set([1]));
    await advance(49); expect(useUiStore.getState().activePaneId).toBe("a");
    await advance(1); expect(useUiStore.getState().activePaneId).toBe("b"); expect(document.activeElement).toBe(textarea());
    expect(scans).toBe(0); expect(styleReads).toBe(0);
  });
});
