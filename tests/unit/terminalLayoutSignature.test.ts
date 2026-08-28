import { describe, expect, it } from "vitest";

import {
  terminalLayoutSignatureOf,
  type TerminalLayoutSignatureInput,
} from "../../src/lib/terminalLayoutSignature";

function input(overrides: Partial<TerminalLayoutSignatureInput> = {}): TerminalLayoutSignatureInput {
  return {
    workspaceId: "ws-1",
    viewportSize: { width: 1200, height: 800 },
    layoutColumns: [["p1"], ["p2"]],
    panes: [
      { id: "p1", activeTabId: "t1", tabs: [1] },
      { id: "p2", activeTabId: "t2", tabs: [1, 2] },
    ],
    zoomedPaneId: null,
    ...overrides,
  };
}

describe("terminalLayoutSignatureOf", () => {
  // Zoom resizes panes without moving the grid container, the columns or the
  // pane list. When it was missing from the signature no layout-change event
  // fired, the terminal's dropped refit was never rescheduled, and the pane
  // stayed mis-sized until an unrelated sidebar drag moved the viewport.
  it("changes when a pane is zoomed and again when it is restored", () => {
    const flat = terminalLayoutSignatureOf(input());
    const zoomed = terminalLayoutSignatureOf(input({ zoomedPaneId: "p1" }));
    const restored = terminalLayoutSignatureOf(input({ zoomedPaneId: null }));

    expect(zoomed).not.toBe(flat);
    expect(restored).toBe(flat);
  });

  it("distinguishes which pane is zoomed", () => {
    expect(terminalLayoutSignatureOf(input({ zoomedPaneId: "p1" })))
      .not.toBe(terminalLayoutSignatureOf(input({ zoomedPaneId: "p2" })));
  });

  it("still reacts to the viewport, the columns and the pane list", () => {
    const base = terminalLayoutSignatureOf(input());
    expect(terminalLayoutSignatureOf(input({ viewportSize: { width: 900, height: 800 } }))).not.toBe(base);
    expect(terminalLayoutSignatureOf(input({ layoutColumns: [["p1", "p2"]] }))).not.toBe(base);
    expect(terminalLayoutSignatureOf(input({
      panes: [
        { id: "p1", activeTabId: "t9", tabs: [1] },
        { id: "p2", activeTabId: "t2", tabs: [1, 2] },
      ],
    }))).not.toBe(base);
  });

  it("ignores sub-pixel viewport jitter", () => {
    expect(terminalLayoutSignatureOf(input({ viewportSize: { width: 1200.4, height: 799.6 } })))
      .toBe(terminalLayoutSignatureOf(input()));
  });
});
