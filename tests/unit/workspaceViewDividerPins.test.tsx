// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface AllotmentProbe {
  vertical: boolean;
  resize: ReturnType<typeof vi.fn>;
  /** Captured once, on mount — allotment never swaps this one. */
  onReset?: () => void;
  onDragStart?: (sizes: number[]) => void;
  onDragEnd?: (sizes: number[]) => void;
}

const mocks = vi.hoisted(() => ({ instances: [] as unknown[] }));

/**
 * Stands in for allotment with its callback wiring, which is what this suite is
 * about: `onDidChange` / `onDidDragStart` / `onDidDragEnd` are re-assigned on
 * every render, but the `sashreset` listener is registered once inside a
 * mount-only effect and there is no `onDidReset` to swap it. So the double
 * click always calls the `onReset` the component was given on mount.
 */
vi.mock("allotment", async () => {
  const React = await import("react");
  const Pane = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  const Allotment = Object.assign(
    React.forwardRef(function MockAllotment(
      props: {
        children?: React.ReactNode;
        vertical?: boolean;
        onReset?: () => void;
        onDragStart?: (sizes: number[]) => void;
        onDragEnd?: (sizes: number[]) => void;
      },
      ref: React.ForwardedRef<unknown>,
    ) {
      const slot = React.useRef(-1);
      const handle = React.useRef({ resize: vi.fn(), reset: vi.fn() });
      if (slot.current < 0) {
        slot.current = mocks.instances.length;
        mocks.instances.push({
          resize: handle.current.resize,
          vertical: Boolean(props.vertical),
          onReset: props.onReset,
          onDragStart: props.onDragStart,
          onDragEnd: props.onDragEnd,
        });
      } else {
        const instance = mocks.instances[slot.current] as AllotmentProbe;
        instance.vertical = Boolean(props.vertical);
        instance.onDragStart = props.onDragStart;
        instance.onDragEnd = props.onDragEnd;
      }
      React.useImperativeHandle(ref, () => handle.current, []);
      return <div>{props.children}</div>;
    }),
    { Pane },
  );
  return { Allotment };
});

vi.mock("allotment/dist/style.css", () => ({}));
vi.mock("../../src/components/workspace/TerminalPane", () => ({ default: () => null }));
vi.mock("../../src/components/workspace/WebPaneController", () => ({ default: () => null }));
vi.mock("../../src/components/terminal/XTermWrapper", () => ({ evictTerminalCache: vi.fn() }));
vi.mock("../../src/lib/ipc", () => ({ killSession: vi.fn(() => Promise.resolve()) }));

import { TerminalGrid } from "../../src/components/workspace/WorkspaceView";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import type { Pane, Workspace } from "../../src/types";

const WIDTH = 1200;
const HEIGHT = 900;

function pane(id: string): Pane {
  return {
    id,
    agentId: "shell-starter",
    sessionId: `session-${id}`,
    tabs: [{ id: `tab-${id}`, sessionId: `session-${id}`, agentId: "shell-starter", type: "terminal" }],
    activeTabId: `tab-${id}`,
  };
}

function seedWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  const workspace: Workspace = {
    id: "ws",
    name: "ws",
    gridTemplateId: "3x1",
    status: "running",
    createdAt: 1,
    panes: [pane("a"), pane("b"), pane("c")],
    splitColumns: [["a"], ["b"], ["c"]],
    columnWidths: [1 / 3, 1 / 3, 1 / 3],
    rowHeightsPerCol: [[1], [1], [1]],
    columnDividerPins: [false, false],
    rowDividerPinsPerCol: [[], [], []],
    ...overrides,
  };
  useWorkspaceListStore.setState({
    workspaces: [workspace],
    activeWorkspaceId: workspace.id,
    lastActivePaneByWorkspace: {},
  });
  return workspace;
}

function stored(): Workspace {
  const found = useWorkspaceListStore.getState().getWorkspace("ws");
  if (!found) throw new Error("workspace disappeared");
  return found;
}

function probes(): AllotmentProbe[] {
  return mocks.instances as AllotmentProbe[];
}

function outerAllotment(): AllotmentProbe {
  const found = probes().find((instance) => !instance.vertical);
  if (!found) throw new Error("outer allotment was never rendered");
  return found;
}

function innerAllotments(): AllotmentProbe[] {
  return probes().filter((instance) => instance.vertical);
}

function lastResizeOf(probe: AllotmentProbe): number[] {
  const calls = probe.resize.mock.calls;
  if (calls.length === 0) throw new Error("resize was never called");
  return calls[calls.length - 1][0] as number[];
}

let container: HTMLDivElement;
let root: Root;
let originalResizeObserver: typeof ResizeObserver | undefined;
let originalRect: () => DOMRect;

beforeEach(() => {
  mocks.instances.length = 0;
  originalResizeObserver = globalThis.ResizeObserver;
  originalRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function fakeRect(): DOMRect {
    return { width: WIDTH, height: HEIGHT, top: 0, left: 0, right: WIDTH, bottom: HEIGHT,
      x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  Element.prototype.getBoundingClientRect = originalRect;
  globalThis.ResizeObserver = originalResizeObserver as typeof ResizeObserver;
});

function render(workspace: Workspace): void {
  act(() => {
    root.render(
      <TerminalGrid
        workspaceId={workspace.id}
        gridTemplateId={workspace.gridTemplateId}
        panes={workspace.panes}
        splitColumns={workspace.splitColumns}
      />,
    );
  });
}

describe("TerminalGrid divider wiring", () => {
  it("remembers the divider the pointer moved and evens out the rest", () => {
    render(seedWorkspace());
    const outer = outerAllotment();

    act(() => {
      outer.onDragStart?.([400, 400, 400]);
      outer.onDragEnd?.([600, 200, 400]);
    });

    const after = stored();
    expect(after.columnDividerPins).toEqual([true, false]);
    expect(after.columnWidths?.[0]).toBeCloseTo(0.5, 12);
    expect(after.columnWidths?.[1]).toBeCloseTo(0.25, 12);
    expect(after.columnWidths?.[2]).toBeCloseTo(0.25, 12);
    // The free divider only moves on screen once it is pushed back through the
    // imperative handle, and the pixels have to still add up to the viewport.
    expect(outer.resize).toHaveBeenCalledWith([600, 300, 300]);
  });

  it("leaves the layout alone when the drag changed nothing", () => {
    render(seedWorkspace());
    const outer = outerAllotment();

    act(() => {
      outer.onDragStart?.([400, 400, 400]);
      outer.onDragEnd?.([400, 400, 400]);
    });

    expect(stored().columnDividerPins).toEqual([false, false]);
    expect(outer.resize).not.toHaveBeenCalled();
  });

  it("leaves a pane that was dragged shut where the pointer left it", () => {
    render(seedWorkspace());
    const outer = outerAllotment();

    act(() => {
      outer.onDragStart?.([400, 400, 400]);
      outer.onDragEnd?.([0, 800, 400]);
    });

    // Settling would re-open the pane that was just dragged shut, so the axis
    // is left alone. The sizes cannot pass the store's check, which is the
    // same place they stopped before any of this existed.
    expect(outer.resize).not.toHaveBeenCalled();
    expect(stored().columnWidths).toBeUndefined();
  });

  it("forgets every divider on the axis when one of them is double clicked", () => {
    render(seedWorkspace({
      columnWidths: [0.7, 0.15, 0.15],
      columnDividerPins: [true, false],
    }));
    const outer = outerAllotment();

    act(() => {
      outer.onReset?.();
    });

    const after = stored();
    expect(after.columnDividerPins).toEqual([false, false]);
    expect(after.columnWidths?.[0]).toBeCloseTo(1 / 3, 12);
    expect(outer.resize).toHaveBeenCalledWith([400, 400, 400]);
  });

  it("keeps the other columns describable when one column's rows are dragged", () => {
    const workspace = seedWorkspace({
      gridTemplateId: "2x2",
      panes: [pane("a"), pane("b"), pane("c")],
      splitColumns: [["a", "b"], ["c"]],
      columnWidths: [0.5, 0.5],
      rowHeightsPerCol: undefined,
      columnDividerPins: [false],
      rowDividerPinsPerCol: undefined,
    });
    render(workspace);
    const inner = innerAllotments()[0];
    expect(inner).toBeDefined();

    act(() => {
      inner.onDragStart?.([450, 450]);
      inner.onDragEnd?.([630, 270]);
    });

    const after = stored();
    expect(after.rowDividerPinsPerCol).toEqual([[true], []]);
    expect(after.rowHeightsPerCol?.[0]?.[0]).toBeCloseTo(0.7, 12);
    expect(after.rowHeightsPerCol?.[1]).toEqual([1]);
  });

  // allotment captures the reset callback on mount and never swaps it, so
  // these two cover the double click that arrives after the layout has moved
  // on from what that callback was handed.
  it("answers a double click with the columns that are on screen now", () => {
    render(seedWorkspace({
      panes: [pane("a"), pane("b")],
      splitColumns: [["a"], ["b"]],
      columnWidths: [0.7, 0.3],
      rowHeightsPerCol: [[1], [1]],
      columnDividerPins: [true],
      rowDividerPinsPerCol: [[], []],
    }));
    const outer = outerAllotment();
    const resetFromMount = outer.onReset;

    render(seedWorkspace({
      panes: [pane("a"), pane("b"), pane("c"), pane("d")],
      splitColumns: [["a", "d"], ["b"], ["c"]],
      columnWidths: [0.7, 0.15, 0.15],
      rowHeightsPerCol: [[0.5, 0.5], [1], [1]],
      columnDividerPins: [true, false],
      rowDividerPinsPerCol: [[false], [], []],
    }));

    act(() => {
      resetFromMount?.();
    });

    const after = stored();
    expect(lastResizeOf(outer)).toEqual([400, 400, 400]);
    expect(after.columnWidths).toHaveLength(3);
    after.columnWidths?.forEach((width) => expect(width).toBeCloseTo(1 / 3, 12));
    expect(after.columnDividerPins).toEqual([false, false]);
    // The rows belong to the other axis and must survive the column reset.
    expect(after.rowHeightsPerCol).toEqual([[0.5, 0.5], [1], [1]]);
    expect(after.rowDividerPinsPerCol).toEqual([[false], [], []]);
  });

  it("answers a row double click on the column it belongs to, not the one at that index", () => {
    // Two columns of different heights, so a handler that kept the index it
    // was mounted with would reset the wrong one — and give it the wrong
    // number of rows while it was at it.
    render(seedWorkspace({
      panes: [pane("a"), pane("b"), pane("d"), pane("e"), pane("f")],
      splitColumns: [["a", "d"], ["b", "e", "f"]],
      columnWidths: [0.5, 0.5],
      rowHeightsPerCol: [[0.8, 0.2], [0.5, 0.25, 0.25]],
      columnDividerPins: [false],
      rowDividerPinsPerCol: [[true], [true, false]],
    }));
    const rightColumn = innerAllotments()[1];
    const resetFromMount = rightColumn?.onReset;
    expect(resetFromMount).toBeDefined();

    // A column appears to its left, so it is now the third of three.
    render(seedWorkspace({
      panes: [pane("a"), pane("b"), pane("c"), pane("d"), pane("e"), pane("f")],
      splitColumns: [["c"], ["a", "d"], ["b", "e", "f"]],
      columnWidths: [1 / 3, 1 / 3, 1 / 3],
      rowHeightsPerCol: [[1], [0.8, 0.2], [0.5, 0.25, 0.25]],
      columnDividerPins: [false, false],
      rowDividerPinsPerCol: [[], [true], [true, false]],
    }));

    act(() => {
      resetFromMount?.();
    });

    const after = stored();
    expect(lastResizeOf(rightColumn)).toEqual([300, 300, 300]);
    expect(after.rowHeightsPerCol?.[2]).toHaveLength(3);
    after.rowHeightsPerCol?.[2]?.forEach((height) => expect(height).toBeCloseTo(1 / 3, 12));
    expect(after.rowDividerPinsPerCol).toEqual([[], [true], [false, false]]);
    // The column that now sits where this one used to be is untouched.
    expect(after.rowHeightsPerCol?.[1]).toEqual([0.8, 0.2]);
  });

  it("answers a row double click after its column has moved and grown", () => {
    render(seedWorkspace({
      panes: [pane("a"), pane("b"), pane("d")],
      splitColumns: [["a", "d"], ["b"]],
      columnWidths: [0.5, 0.5],
      rowHeightsPerCol: [[0.8, 0.2], [1]],
      columnDividerPins: [false],
      rowDividerPinsPerCol: [[true], []],
    }));
    const resetFromMount = innerAllotments()[0]?.onReset;
    expect(resetFromMount).toBeDefined();

    // The column keeps its identity while it moves to the middle and gains a
    // third pane; its mounted reset handler has to find it again.
    render(seedWorkspace({
      panes: [pane("a"), pane("b"), pane("c"), pane("d"), pane("e")],
      splitColumns: [["b"], ["a", "d", "e"], ["c"]],
      columnWidths: [1 / 3, 1 / 3, 1 / 3],
      rowHeightsPerCol: [[1], [0.8, 0.1, 0.1], [1]],
      columnDividerPins: [false, false],
      rowDividerPinsPerCol: [[], [true, false], []],
    }));

    act(() => {
      resetFromMount?.();
    });

    const after = stored();
    const movedInner = innerAllotments().find((instance) => instance.resize.mock.calls.length > 0);
    expect(movedInner && lastResizeOf(movedInner)).toEqual([300, 300, 300]);
    expect(after.rowHeightsPerCol?.[1]).toHaveLength(3);
    after.rowHeightsPerCol?.[1]?.forEach((height) => expect(height).toBeCloseTo(1 / 3, 12));
    expect(after.rowDividerPinsPerCol).toEqual([[], [false, false], []]);
    // The untouched columns keep theirs, and the column axis is not disturbed.
    expect(after.rowHeightsPerCol?.[0]).toEqual([1]);
    expect(after.columnWidths).toHaveLength(3);
  });
});
