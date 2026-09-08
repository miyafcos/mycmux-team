// @ts-expect-error @xterm/headless@6.0.0 publishes this ESM file without colocated declarations.
import { Terminal as PublishedTerminal } from "@xterm/headless/lib-headless/xterm-headless.mjs";
import { describe, expect, it } from "vitest";
import {
  createRepaintHoldController,
  REPAINT_HOLD_MAX_MS,
  REPAINT_HOLD_MIN_COL_DELTA,
  REPAINT_HOLD_MIN_ROW_DELTA,
  REPAINT_HOLD_STREAM_MS,
  REPAINT_HOLD_TOTAL_MAX_MS,
  resolveRepaintHoldDeadline,
  shouldHoldRepaint,
} from "../../src/components/terminal/terminalViewportStability";

type HeadlessTerminalConstructor = typeof import("@xterm/headless").Terminal;
type HeadlessTerminal = InstanceType<HeadlessTerminalConstructor>;

const Terminal = PublishedTerminal as HeadlessTerminalConstructor;

/** Build number past the ConPTY reflow gate, matching what production passes. */
const CONPTY_BUILD_NUMBER = 26100;

/** Just enough of an element for the controller, which only touches opacity. */
function fakeElement(initialOpacity = ""): HTMLElement {
  return { style: { opacity: initialOpacity } } as unknown as HTMLElement;
}

function createTerminal(cols: number, rows: number): HeadlessTerminal {
  return new Terminal({
    cols,
    rows,
    scrollback: 5000,
    allowProposedApi: true,
    windowsPty: { backend: "conpty", buildNumber: CONPTY_BUILD_NUMBER },
  });
}

function write(term: HeadlessTerminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

/**
 * Index of the lowest row that still holds text, and how many blank rows sit
 * between it and the bottom of the viewport. An agent TUI keeps its prompt on
 * the last row, so a healthy pane reads back a gap of zero.
 */
function measureTail(term: HeadlessTerminal): { lastTextLine: number; gapBelow: number } {
  const buffer = term.buffer.active;
  let lastTextLine = -1;
  for (let i = buffer.length - 1; i >= 0; i--) {
    const line = buffer.getLine(i);
    if (line && line.translateToString(true).trim() !== "") {
      lastTextLine = i;
      break;
    }
  }
  return {
    lastTextLine,
    gapBelow: buffer.viewportY + term.rows - 1 - lastTextLine,
  };
}

/**
 * A conversation long enough to have pushed rows into scrollback, ending with a
 * prompt on the bottom row -- the state every agent pane is in while it is being
 * read.
 */
async function paintConversationEndingAtBottom(term: HeadlessTerminal): Promise<void> {
  const lines: string[] = [];
  for (let i = 0; i < 120; i++) {
    lines.push(`turn ${i} some output text`);
  }
  await write(term, `${lines.join("\r\n")}\r\n> prompt`);
}

/**
 * The controller is the part that can leave a pane invisible with output still
 * flowing into it, so it is covered directly rather than through the component.
 */
describe("createRepaintHoldController", () => {
  it("hides on the first hold and restores on the last release", () => {
    const element = fakeElement();
    const controller = createRepaintHoldController();

    const release = controller.acquire(element);
    expect(element.style.opacity).toBe("0");

    release();
    expect(element.style.opacity).toBe("");
    expect(controller.depth).toBe(0);
  });

  it("keeps the pane hidden until overlapping holds have all been released", () => {
    const element = fakeElement();
    const controller = createRepaintHoldController();

    const releaseResize = controller.acquire(element);
    const releaseReplay = controller.acquire(element);
    expect(controller.depth).toBe(2);

    releaseResize();
    expect(element.style.opacity).toBe("0");

    releaseReplay();
    expect(element.style.opacity).toBe("");
  });

  it("survives a release being called twice without dropping a live hold", () => {
    const element = fakeElement();
    const controller = createRepaintHoldController();

    const releaseResize = controller.acquire(element);
    const releaseReplay = controller.acquire(element);

    releaseResize();
    releaseResize();
    releaseResize();
    expect(controller.depth).toBe(1);
    expect(element.style.opacity).toBe("0");

    releaseReplay();
    expect(element.style.opacity).toBe("");
    expect(controller.depth).toBe(0);
  });

  it("puts back whatever opacity the element already carried", () => {
    const element = fakeElement("0.5");
    const controller = createRepaintHoldController();

    controller.acquire(element)();

    expect(element.style.opacity).toBe("0.5");
  });

  it("leaves the element alone once the mount that held it is gone", () => {
    const element = fakeElement();
    let stale = false;
    const controller = createRepaintHoldController({ isStale: () => stale });

    const release = controller.acquire(element);
    stale = true;
    release();

    // The next mount owns this element now and may be holding it itself; the
    // attach path is what clears the leftover.
    expect(element.style.opacity).toBe("0");
    expect(controller.depth).toBe(0);
  });

  it("is inert when there is no element yet, and stays balanced", () => {
    const controller = createRepaintHoldController();

    const release = controller.acquire(null);
    expect(controller.depth).toBe(0);

    expect(() => release()).not.toThrow();
    expect(controller.depth).toBe(0);
  });

  it("releases from a finally even when the held work throws", () => {
    const element = fakeElement();
    const controller = createRepaintHoldController();

    expect(() => {
      const release = controller.acquire(element);
      try {
        throw new Error("term.reset() failed");
      } finally {
        release();
      }
    }).toThrow("term.reset() failed");

    // The count has to come back to zero, or every later hold and release in
    // this mount becomes a no-op and the pane stays hidden for good.
    expect(controller.depth).toBe(0);
    expect(element.style.opacity).toBe("");
  });
});

describe("shouldHoldRepaint", () => {
  const isolated = { msSinceLastSizeChange: null };

  it("ignores a plain shell, which has no bottom bar to lift", () => {
    expect(shouldHoldRepaint({
      ...isolated,
      isAgentTuiPane: false,
      previous: { cols: 100, rows: 30 },
      next: { cols: 70, rows: 40 },
    })).toBe(false);
  });

  it("ignores the one-cell steps a divider drag produces", () => {
    expect(shouldHoldRepaint({
      ...isolated,
      isAgentTuiPane: true,
      previous: { cols: 100, rows: 30 },
      next: { cols: 99, rows: 30 },
    })).toBe(false);
    expect(shouldHoldRepaint({
      ...isolated,
      isAgentTuiPane: true,
      previous: { cols: 100, rows: 30 },
      next: { cols: 100, rows: 31 },
    })).toBe(false);
  });

  it("covers a workspace-sized jump in either dimension", () => {
    expect(shouldHoldRepaint({
      ...isolated,
      isAgentTuiPane: true,
      previous: { cols: 100, rows: 30 },
      next: { cols: 100 - REPAINT_HOLD_MIN_COL_DELTA, rows: 30 },
    })).toBe(true);
    expect(shouldHoldRepaint({
      ...isolated,
      isAgentTuiPane: true,
      previous: { cols: 100, rows: 30 },
      next: { cols: 100, rows: 30 + REPAINT_HOLD_MIN_ROW_DELTA },
    })).toBe(true);
  });

  it("stays out of a drag, where a stutter delivers the whole accumulated delta at once", () => {
    // The resize path is debounced, so a drag that pauses lands one large change
    // rather than many small ones. Size alone cannot tell that from a workspace
    // switch; the time since the previous change can.
    expect(shouldHoldRepaint({
      isAgentTuiPane: true,
      previous: { cols: 100, rows: 30 },
      next: { cols: 60, rows: 30 },
      msSinceLastSizeChange: REPAINT_HOLD_STREAM_MS - 1,
    })).toBe(false);
    expect(shouldHoldRepaint({
      isAgentTuiPane: true,
      previous: { cols: 100, rows: 30 },
      next: { cols: 60, rows: 30 },
      msSinceLastSizeChange: REPAINT_HOLD_STREAM_MS,
    })).toBe(true);
  });

  it("stays out of the way of a cold start with no measured size yet", () => {
    expect(shouldHoldRepaint({
      ...isolated,
      isAgentTuiPane: true,
      previous: { cols: -1, rows: -1 },
      next: { cols: 100, rows: 30 },
    })).toBe(false);
  });
});

describe("resolveRepaintHoldDeadline", () => {
  it("waits the full window for the first resize of a run", () => {
    expect(resolveRepaintHoldDeadline({
      now: 1_000,
      holdStartedAt: 0,
      hasOutstandingHold: false,
    })).toBe(1_000 + REPAINT_HOLD_MAX_MS);
  });

  it("gives a follow-up resize its own window while there is room under the ceiling", () => {
    expect(resolveRepaintHoldDeadline({
      now: 1_100,
      holdStartedAt: 1_000,
      hasOutstandingHold: true,
    })).toBe(1_100 + REPAINT_HOLD_MAX_MS);
  });

  it("never pushes the reveal past the ceiling of the run, however many resizes arrive", () => {
    const holdStartedAt = 1_000;
    let latest = 0;
    for (const now of [1_050, 1_200, 1_300, 1_350]) {
      latest = Math.max(latest, resolveRepaintHoldDeadline({
        now,
        holdStartedAt,
        hasOutstandingHold: true,
      }));
    }
    expect(latest).toBeLessThanOrEqual(holdStartedAt + REPAINT_HOLD_TOTAL_MAX_MS);
  });

  it("returns a deadline already past once the ceiling is spent, so the pane is shown at once", () => {
    const holdStartedAt = 1_000;
    const now = holdStartedAt + REPAINT_HOLD_TOTAL_MAX_MS + 50;
    expect(resolveRepaintHoldDeadline({
      now,
      holdStartedAt,
      hasOutstandingHold: true,
    })).toBeLessThan(now);
  });
});

/**
 * These reproduce the buffer state that produces the jump, not the jump itself.
 * Under the ConPTY backend xterm does not pull scrollback down to fill a taller
 * terminal -- conhost is expected to reprint -- so the prompt lifts off the
 * bottom row until that reprint arrives. Scrolling to the bottom cannot close
 * the gap, because the viewport is already at the bottom; only the reprint can.
 * That is the whole reason the pane is held during the transition.
 */
describe("ConPTY resize leaves a gap that scrolling cannot close", () => {
  // Measured against recorded conhost output for a real Claude Code session:
  // growing a 100x30 pane to 100x40 left the prompt 12 rows above the bottom
  // until the 7 KB repaint arrived, and 100x45 left it 16 rows above until an
  // 8 KB repaint arrived. Both closed back to a single row afterwards.
  it("lifts the prompt off the bottom row when the pane grows taller", async () => {
    const term = createTerminal(100, 30);
    await paintConversationEndingAtBottom(term);
    expect(measureTail(term).gapBelow).toBe(0);

    term.resize(100, 40);

    const afterResize = measureTail(term);
    expect(afterResize.gapBelow).toBeGreaterThan(1);

    // The pane is already following the live end, so this is a no-op: the gap
    // is blank rows below the text, not a scrolled-away viewport.
    term.scrollToBottom();
    expect(measureTail(term).gapBelow).toBe(afterResize.gapBelow);

    term.dispose();
  });

  it("re-lays out the text above the prompt when the pane narrows", async () => {
    // Narrowing does not lift the prompt -- the viewport follows the extra
    // wrapped rows down -- but every line above it moves, and the shell then
    // reprints its own idea of the reflow over the top. Both halves are visible
    // churn, which is why the hold covers a width change too.
    const term = createTerminal(100, 30);
    const wrapped = "x".repeat(160);
    await write(term, `${wrapped}\r\n`.repeat(40) + "> prompt");
    const before = measureTail(term);

    term.resize(70, 30);

    expect(measureTail(term).lastTextLine).not.toBe(before.lastTextLine);
    term.dispose();
  });

  it("grows the gap with the number of rows added, and holds for each size that opens one", async () => {
    // Walks the row threshold rather than sampling two points either side of it,
    // so moving REPAINT_HOLD_MIN_ROW_DELTA has to be justified against what the
    // buffer actually does at that size.
    for (const addedRows of [1, 2, 3, 5, 10, 15]) {
      const term = createTerminal(100, 30);
      await paintConversationEndingAtBottom(term);
      term.resize(100, 30 + addedRows);

      const gap = measureTail(term).gapBelow;
      const opensAGap = gap > 1;
      expect(opensAGap).toBe(addedRows >= REPAINT_HOLD_MIN_ROW_DELTA);
      expect(shouldHoldRepaint({
        isAgentTuiPane: true,
        previous: { cols: 100, rows: 30 },
        next: { cols: 100, rows: 30 + addedRows },
        msSinceLastSizeChange: null,
      })).toBe(opensAGap);

      term.dispose();
    }
  });
});
