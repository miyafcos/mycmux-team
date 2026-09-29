import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PAINT_REASONS,
  bump,
  recordApprovalScan,
  recordCursorBlink,
  recordPtyBatch,
  recordReactCommit,
  recordRender,
  recordRenderer,
  recordResync,
  recordTerminalWriteCallback,
  recordTerminalWriteStart,
  recordWebglContextLoss,
  recordWriteParsed,
  recordXtermFocus,
  recordXtermMounted,
  recordXtermUnmounted,
  reset,
  setPaintStatsSessionScope,
  snapshot,
} from "../../src/lib/paintStats";

describe("paintStats", () => {
  beforeEach(() => {
    reset();
  });

  afterEach(() => {
    setPaintStatsSessionScope(null);
    recordXtermUnmounted("session-a");
    recordXtermUnmounted("session-b");
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("starts with every reason and cumulative layer counter at zero", () => {
    const current = snapshot();
    expect(current.counts).toEqual(
      Object.fromEntries(PAINT_REASONS.map((reason) => [reason, 0])),
    );
    expect(current.layers.inputParse).toMatchObject({
      ptyReceivedBytes: 0,
      writeCalls: 0,
      pendingBytes: 0,
      maxPendingBytes: 0,
      onWriteParsedCalls: 0,
    });
    expect(current.layers.render).toMatchObject({
      onRenderCalls: 0,
      renderedRows: 0,
      fullScreenRenders: 0,
      webglContextLosses: 0,
    });
    expect(current.layers.surrounding).toMatchObject({
      resyncBytes: 0,
      reactCommits: 0,
    });
    expect(JSON.stringify(current)).not.toMatch(/NaN|Infinity/);
  });

  it("increments legacy paint reasons independently", () => {
    bump("pty-batch");
    bump("pty-batch");
    bump("scan");

    expect(snapshot().counts).toMatchObject({
      "pty-batch": 2,
      scan: 1,
      resize: 0,
    });
  });

  it("records input, parser backlog, and callback percentiles", () => {
    recordPtyBatch(12);
    recordPtyBatch(28);
    const now = vi.spyOn(performance, "now");
    now.mockReturnValueOnce(0).mockReturnValueOnce(1).mockReturnValueOnce(5).mockReturnValueOnce(11);

    const first = recordTerminalWriteStart("session-a", 10);
    const second = recordTerminalWriteStart("session-a", 20);
    recordTerminalWriteCallback(first);
    recordTerminalWriteCallback(second);
    recordWriteParsed();

    expect(snapshot().layers.inputParse).toEqual({
      ptyReceivedBytes: 40,
      batchBytes: { count: 2, total: 40, min: 12, max: 28, avg: 20 },
      writeCalls: 2,
      writeCallbackMs: {
        count: 2,
        total: 15,
        min: 5,
        max: 10,
        avg: 7.5,
        p50: 5,
        p95: 10,
        retainedSamples: 2,
      },
      pendingBytes: 0,
      maxPendingBytes: 30,
      onWriteParsedCalls: 1,
    });
  });

  it("ignores callbacks from a previous reset window", () => {
    vi.spyOn(performance, "now").mockReturnValue(1);
    const oldWrite = recordTerminalWriteStart("session-a", 10);
    reset();
    const currentWrite = recordTerminalWriteStart("session-b", 20);

    recordTerminalWriteCallback(oldWrite);
    expect(snapshot().layers.inputParse.pendingBytes).toBe(20);

    recordTerminalWriteCallback(currentWrite);
    expect(snapshot().layers.inputParse.pendingBytes).toBe(0);
  });

  it("records render events, actual renderer state, and context loss", () => {
    recordXtermMounted("session-a");
    recordXtermMounted("session-b");
    recordRenderer("session-a", "webgl");
    recordRenderer("session-b", "dom");
    recordRender(0, 23, 24);
    recordRender(4, 8, 24);
    recordWebglContextLoss();

    expect(snapshot().layers.render).toEqual({
      onRenderCalls: 2,
      renderedRows: 29,
      fullScreenRenders: 1,
      renderer: "mixed",
      rendererCounts: { dom: 1, webgl: 1 },
      webglContextLosses: 1,
    });
  });

  it("isolates replay counters to the scoped session", () => {
    setPaintStatsSessionScope("session-a");
    reset();
    recordPtyBatch(10, "session-b");
    recordPtyBatch(20, "session-a");
    recordRender(0, 4, 5, "session-b");
    recordRender(0, 2, 5, "session-a");
    recordReactCommit();

    const current = snapshot();
    expect(current.layers.inputParse.ptyReceivedBytes).toBe(20);
    expect(current.layers.render).toMatchObject({ onRenderCalls: 1, renderedRows: 3 });
    expect(current.layers.surrounding.reactCommits).toBe(0);
  });

  it("records surrounding work and current terminal gauges", () => {
    recordApprovalScan(2);
    recordApprovalScan(4);
    recordResync(128, 8);
    recordReactCommit();
    recordXtermMounted("session-a");
    recordCursorBlink("session-a", true);
    recordXtermFocus("session-a", true);

    expect(snapshot().layers.surrounding).toMatchObject({
      approvalScanMs: { count: 2, total: 6, min: 2, max: 4, avg: 3 },
      resyncBytes: 128,
      resyncMs: { count: 1, total: 8, min: 8, max: 8, avg: 8 },
      reactCommits: 1,
      mountedXterms: 1,
      cursorBlinkingXterms: 1,
      focusedXterms: 1,
    });
  });

  it("returns defensive copies of nested counters", () => {
    recordPtyBatch(5);
    recordRenderer("session-a", "dom");
    const first = snapshot();
    first.counts.scroll = 99;
    first.layers.inputParse.batchBytes.total = 999;
    first.layers.render.rendererCounts.dom = 999;

    const second = snapshot();
    expect(second.counts.scroll).toBe(0);
    expect(second.layers.inputParse.batchBytes.total).toBe(5);
    expect(second.layers.render.rendererCounts.dom).toBe(1);
  });

  it("reset clears cumulative counters while preserving live gauges", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T00:00:00.000Z"));
    reset();
    bump("settings");
    recordPtyBatch(10);
    recordXtermMounted("session-a");
    recordRenderer("session-a", "webgl");

    vi.setSystemTime(new Date("2026-07-29T00:01:00.000Z"));
    reset();

    const current = snapshot();
    expect(current.startedAt).toBe("2026-07-29T00:01:00.000Z");
    expect(current.counts).toEqual(Object.fromEntries(PAINT_REASONS.map((reason) => [reason, 0])));
    expect(current.layers.inputParse.ptyReceivedBytes).toBe(0);
    expect(current.layers.render.renderer).toBe("webgl");
    expect(current.layers.surrounding.mountedXterms).toBe(1);
  });
});
