// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  measureDropResultRect,
  resolveColumnPaneIds,
  resolveDropResultRect,
  unionRects,
} from "../../src/lib/paneDropResultRect";

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

function mountPane(workspaceId: string, paneId: string, box: Box): void {
  const element = document.createElement("div");
  element.setAttribute("data-dnd-workspace-id", workspaceId);
  element.setAttribute("data-dnd-pane-id", paneId);
  element.getBoundingClientRect = () => ({
    ...box,
    right: box.left + box.width,
    bottom: box.top + box.height,
    x: box.left,
    y: box.top,
    toJSON: () => ({}),
  }) as DOMRect;
  document.body.appendChild(element);
}

/** Two stacked panes in the left column, one pane in the right column. */
function mountTwoColumnLayout(): { splitColumns: string[][]; paneIds: string[] } {
  mountPane("ws-1", "pane-a", { left: 0, top: 0, width: 600, height: 300 });
  mountPane("ws-1", "pane-b", { left: 0, top: 300, width: 600, height: 300 });
  mountPane("ws-1", "pane-c", { left: 600, top: 0, width: 400, height: 600 });
  return { splitColumns: [["pane-a", "pane-b"], ["pane-c"]], paneIds: ["pane-a", "pane-b", "pane-c"] };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("drop result geometry", () => {
  const paneRect = { left: 100, top: 50, width: 400, height: 200 };
  const columnRect = { left: 100, top: 0, width: 400, height: 600 };

  it("gives a left/right split half of the column, top to bottom", () => {
    expect(resolveDropResultRect(paneRect, columnRect, "left"))
      .toEqual({ left: 100, top: 0, width: 200, height: 600 });
    expect(resolveDropResultRect(paneRect, columnRect, "right"))
      .toEqual({ left: 300, top: 0, width: 200, height: 600 });
  });

  it("gives an up/down split half of the pane only", () => {
    expect(resolveDropResultRect(paneRect, columnRect, "up"))
      .toEqual({ left: 100, top: 50, width: 400, height: 100 });
    expect(resolveDropResultRect(paneRect, columnRect, "down"))
      .toEqual({ left: 100, top: 150, width: 400, height: 100 });
  });

  it("gives center the whole pane", () => {
    expect(resolveDropResultRect(paneRect, columnRect, "center")).toEqual(paneRect);
  });

  it("unions rectangles into their bounding box", () => {
    expect(unionRects([
      { left: 0, top: 0, width: 600, height: 300 },
      { left: 0, top: 300, width: 600, height: 300 },
    ])).toEqual({ left: 0, top: 0, width: 600, height: 600 });
    expect(unionRects([])).toBeNull();
  });

  it("falls back to one column when the workspace never split", () => {
    expect(resolveColumnPaneIds(undefined, ["pane-a", "pane-b"], "pane-b"))
      .toEqual(["pane-a", "pane-b"]);
    expect(resolveColumnPaneIds([["pane-a"], ["pane-b"]], ["pane-a", "pane-b"], "pane-b"))
      .toEqual(["pane-b"]);
  });
});

describe("drop result measured against the live layout", () => {
  it("covers the stacked column, not just the pane under the pointer", () => {
    const { splitColumns, paneIds } = mountTwoColumnLayout();

    expect(measureDropResultRect("ws-1", "pane-a", "left", splitColumns, paneIds))
      .toEqual({ left: 0, top: 0, width: 300, height: 600 });
    expect(measureDropResultRect("ws-1", "pane-c", "right", splitColumns, paneIds))
      .toEqual({ left: 800, top: 0, width: 200, height: 600 });
  });

  it("halves only the target pane for an up/down split", () => {
    const { splitColumns, paneIds } = mountTwoColumnLayout();

    expect(measureDropResultRect("ws-1", "pane-a", "down", splitColumns, paneIds))
      .toEqual({ left: 0, top: 150, width: 600, height: 150 });
    expect(measureDropResultRect("ws-1", "pane-a", "center", splitColumns, paneIds))
      .toEqual({ left: 0, top: 0, width: 600, height: 300 });
  });

  it("ignores panes belonging to another workspace", () => {
    mountPane("ws-1", "pane-a", { left: 0, top: 0, width: 600, height: 600 });
    mountPane("ws-2", "pane-a", { left: 0, top: 0, width: 50, height: 50 });

    expect(measureDropResultRect("ws-1", "pane-a", "left", [["pane-a"]], ["pane-a"]))
      .toEqual({ left: 0, top: 0, width: 300, height: 600 });
    expect(measureDropResultRect("ws-3", "pane-a", "left", [["pane-a"]], ["pane-a"]))
      .toBeNull();
  });

  it("returns nothing while the pane has no box to point at", () => {
    mountPane("ws-1", "pane-a", { left: 0, top: 0, width: 0, height: 0 });

    expect(measureDropResultRect("ws-1", "pane-a", "left", [["pane-a"]], ["pane-a"]))
      .toBeNull();
  });
});
