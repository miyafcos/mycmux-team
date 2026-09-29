import { describe, expect, it } from "vitest";
import { buildMinimapModel, minimapWorkspaceStrip } from "../../src/components/dashboard/minimapModel";
import type { Pane, PaneTab, Workspace } from "../../src/types";

function tab(id: string): PaneTab {
  return { id, sessionId: `session-${id}`, agentId: "shell-starter", type: "terminal", label: id };
}

function pane(id: string, tabs: PaneTab[], activeTabId = tabs[0]?.id ?? ""): Pane {
  return { id, agentId: "shell-starter", sessionId: tabs[0]?.sessionId ?? "", tabs, activeTabId };
}

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  const first = pane("pane-a", [tab("tab-a"), tab("tab-b")], "tab-b");
  const second = pane("pane-b", [tab("tab-c")]);
  return {
    id: "workspace-a",
    name: "Workspace A",
    gridTemplateId: "1x1",
    status: "running",
    createdAt: 1,
    panes: [first, second],
    splitColumns: [["pane-a"], ["pane-b"]],
    ...overrides,
  };
}

describe("buildMinimapModel", () => {
  it("normalizes missing split columns and malformed saved metrics", () => {
    const model = buildMinimapModel(workspace({
      splitColumns: undefined,
      columnWidths: [9],
      rowHeightsPerCol: [[5, 5]],
    }));

    expect(model.columns).toHaveLength(1);
    expect(model.columns[0].cells.map((cell) => cell.paneId)).toEqual(["pane-a", "pane-b"]);
    expect(model.columns[0].widthShare).toBe(1);
    expect(model.columns[0].cells.map((cell) => cell.heightShare)).toEqual([0.5, 0.5]);
  });

  it("falls back to equal shares for saved metric length mismatches", () => {
    const model = buildMinimapModel(workspace({
      splitColumns: [["pane-a", "pane-b"]],
      columnWidths: [3, 7],
      rowHeightsPerCol: [[3]],
    }));

    expect(model.columns).toHaveLength(1);
    expect(model.columns[0].widthShare).toBe(1);
    expect(model.columns[0].cells.map((cell) => cell.heightShare)).toEqual([0.5, 0.5]);
  });

  it("returns an empty model for a workspace without panes", () => {
    expect(buildMinimapModel(workspace({ panes: [], splitColumns: undefined }))).toEqual({
      workspaceId: "workspace-a",
      columns: [],
    });
  });

  it("keeps chip metadata forward-compatible and deterministic", () => {
    const declared = { ...tab("declared"), lifecycle: "declared" as const, declaredPrompt: "start", origin: { kind: "agent" as const, parentTabId: "root" } };
    const active = tab("active");
    const modelInput = workspace({ panes: [{ ...pane("pane-a", [declared, active], "active"), pinnedTabId: "declared" }] });
    const ctx = { activePaneId: "pane-a", displayStateByTabId: { active: "running" } };

    const first = buildMinimapModel(modelInput, ctx);
    expect(buildMinimapModel(modelInput, ctx)).toEqual(first);
    expect(first.columns[0].cells[0]).toMatchObject({ isActivePane: true, heightShare: 1 });
    expect(first.columns[0].cells[0].chips).toMatchObject([
      { tabId: "declared", declared: true, declaredPrompt: "start", originParentTabId: "root", isPinned: true },
      { tabId: "active", declared: false, displayState: "running", isActiveTab: true },
    ]);
  });

  it("reads the elapsed source the chat column uses", () => {
    const model = buildMinimapModel(workspace(), {
      metadataBySession: {
        "session-tab-a": { backendLastOutputAt: 1_700_000_000_000 },
        "session-tab-c": {},
      },
    });

    expect(model.columns[0].cells[0].chips.map((chip) => chip.lastOutputAt)).toEqual([1_700_000_000_000, undefined]);
    expect(model.columns[1].cells[0].chips[0].lastOutputAt).toBeUndefined();
  });

  it("projects CTX% onto chips and omits the slot when missing", () => {
    const model = buildMinimapModel(workspace(), {
      contextPctBySession: { "session-tab-a": 34, "session-tab-c": 80 },
    });
    expect(model.columns[0].cells[0].chips.map((chip) => chip.contextPct)).toEqual([34, undefined]);
    expect(model.columns[1].cells[0].chips[0].contextPct).toBe(80);
  });

  it("flattens the workspace strip in visual order and folds only existing display states", () => {
    const model = buildMinimapModel(workspace(), {
      displayStateByTabId: { "tab-a": "running", "tab-b": "needsHuman", "tab-c": "done" },
    });

    expect(minimapWorkspaceStrip(model)).toEqual({
      ticks: [
        { tabId: "tab-a", mark: null, activity: "working" },
        { tabId: "tab-b", mark: null, activity: "waiting" },
        { tabId: "tab-c", mark: null, activity: "idle" },
      ],
      tabCount: 3,
      waitingCount: 1,
    });
    // An explicit map wins over the state baked into the model, and the counts
    // come from the same single pass as the ticks.
    const overridden = minimapWorkspaceStrip(model, new Map([["tab-a", "needsHuman"], ["tab-b", "idle"]]));
    expect(overridden.ticks.map((entry) => entry.activity)).toEqual(["waiting", "idle", "idle"]);
    expect(overridden.waitingCount).toBe(1);
    expect(overridden.tabCount).toBe(3);
    expect(minimapWorkspaceStrip(buildMinimapModel(workspace({ panes: [], splitColumns: undefined }))))
      .toEqual({ ticks: [], tabCount: 0, waitingCount: 0 });
  });

  it("keeps width and height shares normalized", () => {
    const model = buildMinimapModel(workspace({
      splitColumns: [["pane-a", "pane-b"]],
      columnWidths: [5],
      rowHeightsPerCol: [[1, 3]],
    }));

    expect(model.columns.reduce((total, column) => total + column.widthShare, 0)).toBe(1);
    expect(model.columns[0].cells.reduce((total, cell) => total + cell.heightShare, 0)).toBe(1);
    expect(model.columns[0].cells.map((cell) => cell.heightShare)).toEqual([0.25, 0.75]);
  });
});
