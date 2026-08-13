import { describe, expect, it } from "vitest";
import type { Pane, Workspace } from "../../src/types";
import {
  activeWorkspaceTabLabels,
  workspaceTabCount,
  workspaceTabPreview,
} from "../../src/lib/workspaceRow";

function pane(id: string, labels: Array<string | undefined>, activeTabId = `${id}-0`): Pane {
  return {
    id,
    agentId: "terminal",
    sessionId: `${id}-session-0`,
    activeTabId,
    tabs: labels.map((label, index) => ({
      id: `${id}-${index}`,
      sessionId: `${id}-session-${index}`,
      agentId: "terminal",
      label,
    })),
  };
}

function workspace(panes: Pane[]): Pick<Workspace, "panes"> {
  return { panes };
}

describe("workspace row helpers", () => {
  it("counts every tab in the workspace, not its panes", () => {
    expect(workspaceTabCount(workspace([
      pane("a", ["one", "two"]),
      pane("b", ["three"]),
      pane("c", ["four", "five", "six"]),
      pane("d", ["seven"]),
    ]))).toBe(7);
  });

  it("uses each pane's active tab and falls back to its first tab", () => {
    expect(activeWorkspaceTabLabels(workspace([
      pane("a", ["first", "selected"], "a-1"),
      pane("b", ["fallback", "other"], "missing"),
    ]))).toEqual(["selected", "fallback"]);
  });

  it("limits the preview to four labels and reports the remaining count", () => {
    expect(workspaceTabPreview(workspace([
      pane("a", ["one"]),
      pane("b", ["two"]),
      pane("c", ["three"]),
      pane("d", ["four"]),
      pane("e", ["five"]),
      pane("f", ["six"]),
    ]))).toEqual({ labels: ["one", "two", "three", "four"], remainingCount: 2 });
  });

  it("uses the unnamed placeholder for empty tab labels", () => {
    expect(activeWorkspaceTabLabels(workspace([
      pane("a", ["" ]),
      pane("b", [undefined], "missing"),
    ]))).toEqual(["(名前なし)", "(名前なし)"]);
  });
});
