import { describe, expect, it } from "vitest";

import type { PaneConfig } from "../../src/lib/ipc";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";

function paneConfig(index: number): PaneConfig {
  const paneId = `pane-${index}`;
  const tabId = `tab-${index}`;
  return {
    pane_id: paneId,
    agent_id: "claude-code",
    label: null,
    agent_kind: null,
    agent_session_id: null,
    claude_session_id: null,
    active_tab_id: tabId,
    tabs: [{
      tab_id: tabId,
      agent_id: "claude-code",
      type: "terminal",
      agent_kind: null,
      agent_session_id: null,
      claude_session_id: null,
    }],
  } as PaneConfig;
}

function configs(count: number): PaneConfig[] {
  return Array.from({ length: count }, (_, index) => paneConfig(index));
}

function restore(
  count: number,
  savedSplitColumns: number[][] | undefined,
  gridTemplateId: "1x1" | "2x2" | "3x1",
) {
  return useWorkspaceLayoutStore
    .getState()
    .restorePanes("workspace", configs(count), savedSplitColumns, gridTemplateId);
}

describe("restorePanes split-column fallback", () => {
  // A workspace keeps the grid template it was created with, so splitting panes
  // leaves "1x1" on a workspace that now holds five of them. The fallback used
  // to append the leftovers to the last column, which restored every pane as a
  // single vertical stack.
  it("gives each leftover pane its own column when the template is 1x1", () => {
    const restored = restore(5, undefined, "1x1");

    expect(restored.panes).toHaveLength(5);
    expect(restored.splitColumns).toHaveLength(5);
    for (const column of restored.splitColumns) {
      expect(column).toHaveLength(1);
    }
  });

  it("fills the template first and spreads the rest into new columns", () => {
    const restored = restore(6, [], "2x2");

    // 2x2 places four panes as two columns of two; the last two panes each get
    // their own column rather than being stacked onto column two.
    expect(restored.splitColumns.map((column) => column.length)).toEqual([2, 2, 1, 1]);
  });

  it("respects saved split columns instead of rebuilding them", () => {
    const restored = restore(3, [[0, 1], [2]], "1x1");

    const idOf = (index: number) => restored.panes[index].id;
    expect(restored.splitColumns).toEqual([[idOf(0), idOf(1)], [idOf(2)]]);
  });

  it("keeps every pane exactly once in the rebuilt columns", () => {
    for (const template of ["1x1", "2x2", "3x1"] as const) {
      const restored = restore(7, undefined, template);
      const placed = restored.splitColumns.flat();

      expect([...placed].sort()).toEqual(restored.panes.map((pane) => pane.id).sort());
      expect(new Set(placed).size).toBe(placed.length);
    }
  });
});
