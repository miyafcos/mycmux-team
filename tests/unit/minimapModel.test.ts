import { describe, expect, it } from "vitest";
import { buildMinimapModel } from "../../src/components/dashboard/minimapModel";
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
