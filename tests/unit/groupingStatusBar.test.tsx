// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  undo: vi.fn(),
  runtime: {
    undo: {
      recordId: "status-undo-1",
      createdAt: 1,
      status: "available",
    } as { recordId: string; createdAt: number; status: "available" | "expired" } | null,
    durability: { status: "idle" } as { status: string; requestId?: string },
  },
  view: {
    kind: "undo_available",
    message: "再配置を適用しました",
    warning: null,
    actions: [{ id: "undo", label: "元に戻す", enabled: true }],
  } as {
    kind: "undo_available" | "undo_expired" | "poisoned" | "durability_warning";
    message: string;
    warning: string | null;
    actions: Array<{ id: "undo" | "dismiss" | "review_changes"; label: string; enabled: boolean }>;
  },
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(() => new Promise<string>(() => {})),
}));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));
vi.mock("../../src/components/layout/groupingBoundary", () => ({
  groupingBoundary: { undo: mocks.undo },
}));
vi.mock("../../src/stores/groupingRuntimeStore", () => ({
  useGroupingRuntimeStore: () => mocks.runtime,
}));
vi.mock("../../src/stores/workspaceListStore", () => ({
  useWorkspaceListStore: () => ({ workspaces: [], layoutRevision: 0 }),
}));
vi.mock("../../src/components/dashboard/groupingStatusBarModel", () => ({
  selectGroupingStatusBarView: () => mocks.view,
}));

import { GroupingStatusBar } from "../../src/components/dashboard/GroupingStatusBar";
import { acquireGroupingPanelOpen } from "../../src/components/layout/groupingPanelPresence";
import { TAB_GROUPING_OPEN_EVENT } from "../../src/components/layout/tabGrouping";

let container: HTMLDivElement;
let root: Root;
let releasePanel: (() => void) | null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.undo.mockReset();
  mocks.runtime.undo = { recordId: "status-undo-1", createdAt: 1, status: "available" };
  mocks.runtime.durability = { status: "idle" };
  mocks.view = {
    kind: "undo_available",
    message: "再配置を適用しました",
    warning: null,
    actions: [{ id: "undo", label: "元に戻す", enabled: true }],
  };
  releasePanel = null;
});

afterEach(() => {
  act(() => releasePanel?.());
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("GroupingStatusBar undo diagnostics", () => {
  it("warns through the existing diagnostic channel when undo returns a typed failure", () => {
    const failure = {
      ok: false as const,
      kind: "post_undo_failed" as const,
      layoutReverted: true as const,
      reason: "persistence exploded",
    };
    mocks.undo.mockReturnValue(failure);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    act(() => root.render(<GroupingStatusBar />));
    const before = container.textContent;
    const button = container.querySelector("button");
    expect(button?.textContent).toBe("元に戻す");
    act(() => button?.click());

    expect(warn).toHaveBeenCalledWith("[mycmux] tab grouping undo failed", failure);
    expect(container.textContent).toBe(before);
  });

  it("suppresses undo views only while the grouping panel is open", () => {
    act(() => root.render(<GroupingStatusBar />));
    expect(container.querySelector(".cmux-grouping-status-bar")?.getAttribute("data-kind")).toBe("undo_available");

    act(() => {
      releasePanel = acquireGroupingPanelOpen();
    });
    expect(container.querySelector(".cmux-grouping-status-bar")).toBeNull();

    act(() => releasePanel?.());
    releasePanel = null;
    expect(container.querySelector(".cmux-grouping-status-bar")?.getAttribute("data-kind")).toBe("undo_available");
  });

  it.each(["poisoned", "durability_warning"] as const)("keeps %s visible while the panel is open", (kind) => {
    mocks.view = { kind, message: kind, warning: null, actions: [] };
    act(() => {
      releasePanel = acquireGroupingPanelOpen();
      root.render(<GroupingStatusBar />);
    });
    expect(container.querySelector(".cmux-grouping-status-bar")?.getAttribute("data-kind")).toBe(kind);
  });

  it("suppresses undo_expired and tolerates disposing the presence token twice", () => {
    mocks.view = { kind: "undo_expired", message: "expired", warning: null, actions: [] };
    act(() => {
      releasePanel = acquireGroupingPanelOpen();
      root.render(<GroupingStatusBar />);
    });
    expect(container.querySelector(".cmux-grouping-status-bar")).toBeNull();

    act(() => {
      releasePanel?.();
      releasePanel?.();
    });
    releasePanel = null;
    expect(container.querySelector(".cmux-grouping-status-bar")?.getAttribute("data-kind")).toBe("undo_expired");
  });

  it("dismisses only the current view key, then resurfaces the preserved undo and executes it", () => {
    const undoRecord = mocks.runtime.undo;
    mocks.view = {
      kind: "undo_available",
      message: "再配置を適用しました",
      warning: null,
      actions: [
        { id: "undo", label: "元に戻す", enabled: true },
        { id: "dismiss", label: "閉じる", enabled: true },
      ],
    };
    mocks.undo.mockReturnValue({ ok: true });

    act(() => root.render(<GroupingStatusBar />));
    const dismiss = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "閉じる");
    expect(dismiss).toBeDefined();
    act(() => dismiss?.click());

    expect(container.querySelector(".cmux-grouping-status-bar")).toBeNull();
    expect(mocks.runtime.undo).toBe(undoRecord);
    expect(mocks.undo).not.toHaveBeenCalled();

    mocks.runtime.durability = { status: "pending", requestId: "persist-2" };
    act(() => root.render(<GroupingStatusBar />));

    expect(container.querySelector(".cmux-grouping-status-bar")?.getAttribute("data-kind"))
      .toBe("undo_available");
    expect(mocks.runtime.undo).toBe(undoRecord);
    const undo = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "元に戻す");
    expect(undo).toBeDefined();
    act(() => undo?.click());
    expect(mocks.undo).toHaveBeenCalledTimes(1);
  });

  it("dispatches review intent when the user opens the applied-layout review", () => {
    mocks.view = {
      kind: "undo_available",
      message: "再配置を適用しました",
      warning: null,
      actions: [{ id: "review_changes", label: "変更内容を見る", enabled: true }],
    };
    const events: Event[] = [];
    const listener = (event: Event) => events.push(event);
    window.addEventListener(TAB_GROUPING_OPEN_EVENT, listener);
    try {
      act(() => root.render(<GroupingStatusBar />));
      const review = [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "変更内容を見る");
      expect(review).toBeDefined();
      act(() => review?.click());
      expect(events).toHaveLength(1);
      expect(events[0]).toBeInstanceOf(CustomEvent);
      expect((events[0] as CustomEvent).detail).toEqual({ intent: "review" });
    } finally {
      window.removeEventListener(TAB_GROUPING_OPEN_EVENT, listener);
    }
  });
});
