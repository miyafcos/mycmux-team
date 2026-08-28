import { beforeEach, describe, expect, it, vi } from "vitest";

import { WORKSPACE_COLORS } from "../../src/lib/workspaceColors";
import { persistentLayoutSignature } from "../../src/lib/persistentLayoutProjection";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import type { Pane, PaneTab, Workspace } from "../../src/types";

const BLUE = WORKSPACE_COLORS[0].value;
const PINK = WORKSPACE_COLORS[6].value;

function tab(id: string, sessionId = `session-${id}`): PaneTab {
  return {
    id,
    sessionId,
    agentId: "shell-starter",
    type: "terminal",
    label: `label-${id}`,
  };
}

function pane(id: string, tabs: PaneTab[]): Pane {
  const active = tabs[0];
  return {
    id,
    agentId: active?.agentId ?? "",
    sessionId: active?.sessionId ?? "",
    activeTabId: active?.id ?? "",
    tabs,
    label: `pane-${id}`,
  };
}

function workspace(id: string, name: string, paneId: string, tabId: string): Workspace {
  return {
    id,
    name,
    gridTemplateId: "1x1",
    status: "running",
    createdAt: 10,
    color: BLUE,
    pet: "clawd",
    panes: [pane(paneId, [tab(tabId)])],
    splitColumns: [[paneId]],
    columnWidths: [1],
    rowHeightsPerCol: [[1]],
  };
}

function seed(): Workspace[] {
  return [
    workspace("ws-a", "Alpha", "pane-a", "t1"),
    workspace("ws-b", "Beta", "pane-b", "t2"),
  ];
}

function reset(workspaces = seed(), activeWorkspaceId = "ws-a"): void {
  useWorkspaceListStore.setState({
    workspaces: structuredClone(workspaces),
    activeWorkspaceId,
    lastActivePaneByWorkspace: {},
    layoutRevision: 0,
  });
}

function snapshot(): { revision: number; signature: string } {
  const state = useWorkspaceListStore.getState();
  return {
    revision: state.layoutRevision,
    signature: persistentLayoutSignature(state.workspaces),
  };
}

function expectActionDelta(run: () => void, delta: 0 | 1): void {
  const before = snapshot();
  run();
  const after = snapshot();
  const change = after.revision - before.revision;
  expect(change).toBe(delta);
  expect(change).toBeLessThan(2);
  expect(after.signature === before.signature).toBe(delta === 0);
}

type MutatingActionCase = {
  name: string;
  delta: 0 | 1;
  setup?: () => void;
  run: () => void;
};

const MUTATING_ACTION_CASES = [
    {
      name: "createWorkspace changes projection",
      delta: 1 as const,
      setup: undefined as (() => void) | undefined,
      run: () => {
        useWorkspaceListStore.getState().createWorkspace(
          "Gamma",
          "1x1",
          [pane("pane-c", [tab("t3")])],
          [["pane-c"]],
          { id: "ws-c", createdAt: 11, pet: "clawd", activate: false },
        );
      },
    },
    {
      name: "removeWorkspace changes projection",
      delta: 1 as const,
      run: () => useWorkspaceListStore.getState().removeWorkspace("ws-b"),
    },
    {
      name: "removeWorkspace missing id is a no-op",
      delta: 0 as const,
      run: () => useWorkspaceListStore.getState().removeWorkspace("missing"),
    },
    {
      name: "renameWorkspace to a new name changes projection",
      delta: 1 as const,
      run: () => useWorkspaceListStore.getState().renameWorkspace("ws-a", "Renamed"),
    },
    {
      name: "renameWorkspace to the same name is a no-op",
      delta: 0 as const,
      run: () => useWorkspaceListStore.getState().renameWorkspace("ws-a", "Alpha"),
    },
    {
      name: "setWorkspaceColor to a new color changes projection",
      delta: 1 as const,
      run: () => useWorkspaceListStore.getState().setWorkspaceColor("ws-a", PINK),
    },
    {
      name: "setWorkspaceColor to the same color is a no-op",
      delta: 0 as const,
      run: () => useWorkspaceListStore.getState().setWorkspaceColor("ws-a", BLUE),
    },
    {
      name: "setWorkspacePet to a new pet changes projection",
      delta: 1 as const,
      run: () => useWorkspaceListStore.getState().setWorkspacePet("ws-a", "other-pet"),
    },
    {
      name: "setWorkspacePet to the same pet is a no-op",
      delta: 0 as const,
      run: () => useWorkspaceListStore.getState().setWorkspacePet("ws-a", "clawd"),
    },
    {
      name: "setWorkspaceStatus to a new status changes projection",
      delta: 1 as const,
      run: () => useWorkspaceListStore.getState().setWorkspaceStatus("ws-a", "stopped"),
    },
    {
      name: "setWorkspaceStatus to the same status is a no-op",
      delta: 0 as const,
      run: () => useWorkspaceListStore.getState().setWorkspaceStatus("ws-a", "running"),
    },
    {
      name: "reorderWorkspaces with a real move changes projection",
      delta: 1 as const,
      run: () => useWorkspaceListStore.getState().reorderWorkspaces(0, 1),
    },
    {
      name: "reorderWorkspaces with fromIndex===toIndex is a no-op",
      delta: 0 as const,
      run: () => useWorkspaceListStore.getState().reorderWorkspaces(0, 0),
    },
    {
      name: "setWorkspaceLayoutMetrics with new widths changes projection",
      delta: 1 as const,
      run: () => useWorkspaceListStore.getState().setWorkspaceLayoutMetrics("ws-a", [2], [[2]]),
    },
    {
      name: "setWorkspaceLayoutMetrics with the same metrics is a no-op",
      delta: 0 as const,
      run: () => useWorkspaceListStore.getState().setWorkspaceLayoutMetrics("ws-a", [1], [[1]]),
    },
    {
      name: "_updateWorkspacePanes with a new tab changes projection",
      delta: 1 as const,
      run: () => {
        const current = useWorkspaceListStore.getState().getWorkspace("ws-a")!;
        const nextPane = {
          ...current.panes[0],
          tabs: [...current.panes[0].tabs, tab("t-new")],
        };
        useWorkspaceListStore.getState()._updateWorkspacePanes("ws-a", [nextPane], [["pane-a"]]);
      },
    },
    {
      name: "_updateWorkspacePanes with the same panes is a no-op",
      delta: 0 as const,
      run: () => {
        const current = useWorkspaceListStore.getState().getWorkspace("ws-a")!;
        useWorkspaceListStore.getState()._updateWorkspacePanes(
          "ws-a",
          current.panes,
          current.splitColumns,
        );
      },
    },
    {
      name: "_replaceWorkspaces with a renamed workspace changes projection",
      delta: 1 as const,
      run: () => {
        const next = structuredClone(useWorkspaceListStore.getState().workspaces);
        next[0] = { ...next[0], name: "Replaced" };
        useWorkspaceListStore.getState()._replaceWorkspaces(next);
      },
    },
    {
      name: "_replaceWorkspaces with identical content is a no-op",
      delta: 0 as const,
      run: () => {
        useWorkspaceListStore.getState()._replaceWorkspaces(
          structuredClone(useWorkspaceListStore.getState().workspaces),
        );
      },
    },
    {
      name: "_restoreGroupingLayout with a renamed workspace changes projection",
      delta: 1 as const,
      run: () => {
        const state = useWorkspaceListStore.getState();
        const next = structuredClone(state.workspaces);
        next[0] = { ...next[0], name: "Restored" };
        state._restoreGroupingLayout(next, {
          activeWorkspaceId: state.activeWorkspaceId,
          activeSessionId: null,
          lastActivePaneByWorkspace: { ...state.lastActivePaneByWorkspace },
        }, "restore");
      },
    },
    {
      name: "_restoreGroupingLayout with identical content is a no-op",
      delta: 0 as const,
      run: () => {
        const state = useWorkspaceListStore.getState();
        state._restoreGroupingLayout(structuredClone(state.workspaces), {
          activeWorkspaceId: state.activeWorkspaceId,
          activeSessionId: null,
          lastActivePaneByWorkspace: { ...state.lastActivePaneByWorkspace },
        }, "restore");
      },
    },
    {
      name: "setPaneAgentSessionFromMetadata with new metadata changes projection",
      delta: 1 as const,
      run: () => {
        useWorkspaceListStore.getState().setPaneAgentSessionFromMetadata("session-t1", {
          agentKind: "codex",
          agentSessionId: "agent-1",
        });
      },
    },
    {
      name: "setPaneAgentSessionFromMetadata with the same metadata is a no-op",
      delta: 0 as const,
      setup: () => {
        useWorkspaceListStore.getState().setPaneAgentSessionFromMetadata("session-t1", {
          agentKind: "codex",
          agentSessionId: "agent-1",
        });
        useWorkspaceListStore.setState({ layoutRevision: 0 });
      },
      run: () => {
        useWorkspaceListStore.getState().setPaneAgentSessionFromMetadata("session-t1", {
          agentKind: "codex",
          agentSessionId: "agent-1",
        });
      },
    },
  ] satisfies MutatingActionCase[];

beforeEach(() => {
  reset();
});

describe("layoutRevision matrix", () => {
  it.each(MUTATING_ACTION_CASES)("$name → revision +$delta", ({ run, delta, setup }) => {
    setup?.();
    expectActionDelta(run, delta);
  });

  it("does not bump layoutRevision when only the active workspace changes", () => {
    expectActionDelta(() => {
      useWorkspaceListStore.getState().setActiveWorkspace("ws-b");
    }, 0);
  });

  it.each([NaN, Infinity, -Infinity])(
    "keeps unrelated workspace writes alive when the current layout contains %s",
    (value) => {
      const poisoned = seed();
      poisoned[0].columnWidths = [value];
      useWorkspaceListStore.setState({ workspaces: poisoned, layoutRevision: 0 });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        expect(() => useWorkspaceListStore.getState().renameWorkspace("ws-b", "Renamed")).not.toThrow();
        const state = useWorkspaceListStore.getState();
        expect(state.workspaces[1].name).toBe("Renamed");
        expect(state.layoutRevision).toBe(1);
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/non-finite persistent number/i));
      } finally {
        warn.mockRestore();
      }
    },
  );
});
