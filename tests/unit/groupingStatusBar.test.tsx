// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GroupingRuntimeState, GroupingUndoRecord } from "../../src/stores/groupingRuntimeStore";
import type { Sha256 } from "../../src/lib/persistentLayoutProjection";

const mocks = vi.hoisted(() => ({
  runtime: {} as GroupingRuntimeState,
  relaunch: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(() => new Promise<string>(() => {})),
}));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: mocks.relaunch }));
vi.mock("../../src/stores/groupingRuntimeStore", () => ({
  useGroupingRuntimeStore: () => mocks.runtime,
}));
vi.mock("../../src/stores/workspaceListStore", () => ({
  useWorkspaceListStore: () => ({ workspaces: [], layoutRevision: 0 }),
}));

import { GroupingStatusBar } from "../../src/components/dashboard/GroupingStatusBar";
import { tabGroupingStrings } from "../../src/components/dashboard/dashboardStrings";
import { acquireGroupingPanelOpen } from "../../src/components/layout/groupingPanelPresence";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const signature = "c".repeat(64) as Sha256;
const durabilityBase = {
  requestId: "persist-1",
  layoutRevision: 1,
  signature,
  snapshotDigest: signature,
  leaderGeneration: 1,
};
const undo: GroupingUndoRecord = {
  recordId: "status-undo-1",
  schemaVersion: 1,
  snapshot: { schemaVersion: 1, workspaces: [], selection: { activeWorkspaceId: null, activeSessionId: null, lastActivePaneByWorkspace: {} } },
  report: { movedTabCount: 3, affectedWorkspaceIds: [], emptyWorkspaceIds: [], appliedAt: 1 },
  appliedLayoutSignature: signature,
  expectedStructuralSignature: signature,
  committedLayoutRevision: 1,
  createdAt: 1,
  status: "available",
  expireReason: null,
};

let container: HTMLDivElement;
let root: Root;
let releasePanel: (() => void) | null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.relaunch.mockReset();
  mocks.writeText.mockReset();
  mocks.runtime = {
    boundaryToken: {},
    schemaVersion: 1,
    persistentSchema: { loadedSchemaVersion: 1, migrationComplete: true, schemaEpoch: 1 },
    transitionDepth: 0,
    transitionEpoch: 0,
    transitionSource: null,
    transitionFrames: [],
    operation: null,
    poisoned: false,
    diagnostic: null,
    undo: structuredClone(undo),
    focusIntent: null,
    durability: { status: "saved", ...durabilityBase },
  };
  releasePanel = null;
});

afterEach(() => {
  act(() => releasePanel?.());
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("GroupingStatusBar post-apply visibility", () => {
  it.each(["idle", "pending", "saved"] as const)("renders nothing after apply with %s durability", (status) => {
    mocks.runtime.durability = status === "idle" ? { status } : { status, ...durabilityBase };
    const record = mocks.runtime.undo;
    act(() => root.render(<GroupingStatusBar />));

    expect(container.childElementCount).toBe(0);
    expect(container.textContent).toBe("");
    expect(mocks.runtime.undo).toBe(record);
  });

  it("renders nothing after undo expires or its record is cleared", () => {
    mocks.runtime.undo = { ...undo, status: "expired", expireReason: tabGroupingStrings.undoExpired };
    act(() => root.render(<GroupingStatusBar />));
    expect(container.childElementCount).toBe(0);

    mocks.runtime.undo = null;
    act(() => root.render(<GroupingStatusBar />));
    expect(container.childElementCount).toBe(0);
  });

  it("stays hidden while the panel opens and closes without changing the undo record", () => {
    const record = mocks.runtime.undo;
    act(() => root.render(<GroupingStatusBar />));
    act(() => { releasePanel = acquireGroupingPanelOpen(); });
    act(() => root.render(<GroupingStatusBar />));
    expect(container.childElementCount).toBe(0);

    act(() => releasePanel?.());
    releasePanel = null;
    act(() => root.render(<GroupingStatusBar />));
    expect(container.childElementCount).toBe(0);
    expect(mocks.runtime.undo).toBe(record);
  });

  it.each(["failed", "deferred"] as const)("keeps %s persistence warnings visible with available undo and an open panel", (status) => {
    mocks.runtime.durability = status === "failed"
      ? { status, ...durabilityBase, errorCode: "persistence_failed", retryScheduled: true, failureGeneration: 1 }
      : { status, ...durabilityBase, reason: "not_leader" };
    const record = mocks.runtime.undo;
    act(() => {
      releasePanel = acquireGroupingPanelOpen();
      root.render(<GroupingStatusBar />);
    });

    const bar = container.querySelector(".cmux-grouping-status-bar");
    expect(bar?.getAttribute("data-kind")).toBe("durability_warning");
    expect(bar?.getAttribute("role")).toBe("status");
    expect(bar?.textContent).toBe(tabGroupingStrings.statusDurabilityWarning);
    expect(bar?.querySelector("button")).toBeNull();
    expect(mocks.runtime.undo).toBe(record);

    act(() => releasePanel?.());
    releasePanel = null;
    act(() => root.render(<GroupingStatusBar />));
    expect(container.querySelector(".cmux-grouping-status-bar")?.textContent)
      .toBe(tabGroupingStrings.statusDurabilityWarning);

    mocks.runtime.durability = { status: "saved", ...durabilityBase };
    act(() => root.render(<GroupingStatusBar />));
    expect(container.childElementCount).toBe(0);
    expect(mocks.runtime.undo).toBe(record);
  });

  it("keeps the permanent poison alert, persistence warning, and diagnostic actions operational", () => {
    mocks.runtime.poisoned = true;
    mocks.runtime.diagnostic = {
      code: "rollback_failed",
      occurredAt: 1,
      layoutRevision: 1,
      operation: "undo",
      errors: ["private details"],
    };
    mocks.runtime.durability = {
      status: "failed",
      ...durabilityBase,
      errorCode: "persistence_failed",
      retryScheduled: false,
      failureGeneration: 1,
    };
    vi.stubGlobal("navigator", { clipboard: { writeText: mocks.writeText } });
    act(() => {
      releasePanel = acquireGroupingPanelOpen();
      root.render(<GroupingStatusBar />);
    });

    const bar = container.querySelector(".cmux-grouping-status-bar");
    expect(bar?.getAttribute("data-kind")).toBe("poisoned");
    expect(bar?.getAttribute("role")).toBe("alert");
    expect(bar?.textContent).toContain(tabGroupingStrings.statusPoisoned);
    expect(bar?.textContent).toContain(tabGroupingStrings.statusDurabilityWarning);
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.map((button) => button.textContent)).toEqual([
      tabGroupingStrings.statusCopyDiagnostics,
      tabGroupingStrings.statusInspectLayout,
      tabGroupingStrings.statusRestartApp,
    ]);
    expect(buttons.every((button) => !button.disabled && button.tabIndex === 0)).toBe(true);

    act(() => buttons[0].click());
    expect(mocks.writeText).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mocks.writeText.mock.calls[0][0])).toMatchObject({ errors: ["rollback_failed:1"] });

    const minimap = document.createElement("div");
    minimap.className = "cmux-minimap-panel";
    const focusTarget = document.createElement("button");
    minimap.appendChild(focusTarget);
    container.appendChild(minimap);
    minimap.scrollIntoView = vi.fn();
    act(() => buttons[1].click());
    expect(minimap.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(document.activeElement).toBe(focusTarget);

    act(() => buttons[2].click());
    expect(mocks.relaunch).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".cmux-grouping-status-bar")?.getAttribute("role")).toBe("alert");
  });
});
