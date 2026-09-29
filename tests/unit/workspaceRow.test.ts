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

  it("prefers the name the pane resolves over the placeholder", () => {
    // The sidebar showed "(名前なし)" for tabs whose own tab bar was showing
    // "node", because only the stored label reaches the workspace record.
    expect(activeWorkspaceTabLabels(
      workspace([pane("a", [undefined]), pane("b", [undefined])]),
      (tab) => (tab.id === "a-0" ? "node" : "mycmux"),
    )).toEqual(["node", "mycmux"]);
  });

  it("tells the resolver whether the tab it is naming is the pane's active one", () => {
    // The cwd fallback is only correct for the tab in front, so the pane's
    // first-tab rescue must not be reported as active.
    const seen: Array<[string, boolean]> = [];
    activeWorkspaceTabLabels(
      workspace([pane("a", [undefined, undefined], "a-1"), pane("b", [undefined], "missing")]),
      (tab, isTabActive) => {
        seen.push([tab.id, isTabActive]);
        return undefined;
      },
    );
    expect(seen).toEqual([["a-1", true], ["b-0", false]]);
  });

  it("falls back to the stored label when the resolver has no name", () => {
    expect(activeWorkspaceTabLabels(
      workspace([pane("a", ["stored"]), pane("b", [undefined])]),
      () => "   ",
    )).toEqual(["stored", "(名前なし)"]);
  });
});
