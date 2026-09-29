import { beforeEach, describe, expect, it } from "vitest";
import { mergeWindowFragmentWorkspaces } from "../../src/lib/windowFragments";
import {
  filterAlreadyRestoredConfigs,
  transposeSplitRowsToCols,
} from "../../src/lib/workspaceRestore";
import { sessionIdsInWorkspace } from "../../src/lib/workspaceTearOut";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import type { WindowFragment, WorkspaceConfig } from "../../src/lib/ipc";
import type { Pane, PaneTab, Workspace } from "../../src/types";

function config(id: string): WorkspaceConfig {
  return {
    id,
    name: id,
    grid_template_id: "single",
    panes: [],
    created_at: 0,
  };
}

function fragment(label: string, ids: string[]): WindowFragment {
  return {
    window_label: label,
    workspaces: ids.map(config),
    active_workspace_id: ids[0] ?? null,
  };
}

function tab(id: string, sessionId: string): PaneTab {
  return { id, sessionId, agentId: "claude-code", type: "terminal" };
}

function workspace(id: string, panes: Pane[]): Workspace {
  return {
    id,
    name: id,
    gridTemplateId: "single",
    panes,
    splitColumns: [panes.map((pane) => pane.id)],
    status: "running",
    createdAt: 0,
  };
}

describe("mergeWindowFragmentWorkspaces", () => {
  it("appends every non-main window's workspaces to main's own list", () => {
    const merged = mergeWindowFragmentWorkspaces(
      [config("ws-main")],
      [fragment("mycmux-w1", ["ws-a"]), fragment("mycmux-w2", ["ws-b"])],
    );

    expect(merged.map((workspace) => workspace.id)).toEqual(["ws-main", "ws-a", "ws-b"]);
  });

  it("ignores the window's own fragment", () => {
    // Main publishes no fragment today, but a stale one must never duplicate
    // the live copy it already holds.
    const merged = mergeWindowFragmentWorkspaces(
      [config("ws-main")],
      [fragment("main", ["ws-main"]), fragment("mycmux-w1", ["ws-a"])],
    );

    expect(merged.map((workspace) => workspace.id)).toEqual(["ws-main", "ws-a"]);
  });

  it("keeps the live copy when a workspace is mid-move", () => {
    const live = { ...config("ws-a"), name: "live" };
    const stale = { ...config("ws-a"), name: "stale" };

    const merged = mergeWindowFragmentWorkspaces(
      [live],
      [{ window_label: "mycmux-w1", workspaces: [stale] }],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0].name).toBe("live");
  });

  it("dedupes a workspace claimed by two windows", () => {
    const merged = mergeWindowFragmentWorkspaces(
      [],
      [fragment("mycmux-w1", ["ws-a"]), fragment("mycmux-w2", ["ws-a", "ws-b"])],
    );

    expect(merged.map((workspace) => workspace.id)).toEqual(["ws-a", "ws-b"]);
  });

  it("survives an empty or malformed fragment list", () => {
    expect(mergeWindowFragmentWorkspaces([config("ws-main")], [])).toHaveLength(1);
    expect(
      mergeWindowFragmentWorkspaces(
        [],
        [{ window_label: "mycmux-w1" } as WindowFragment],
      ),
    ).toEqual([]);
  });
});

describe("filterAlreadyRestoredConfigs", () => {
  beforeEach(() => {
    useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null });
  });

  it("drops workspaces this window already holds", () => {
    // A second restore of the same workspace would mount a second terminal for
    // the same session id, and a PTY streams to exactly one webview.
    useWorkspaceListStore.setState({
      workspaces: [workspace("ws-a", [])],
      activeWorkspaceId: "ws-a",
    });

    const filtered = filterAlreadyRestoredConfigs([config("ws-a"), config("ws-b")]);
    expect(filtered.map((cfg) => cfg.id)).toEqual(["ws-b"]);
  });

  it("drops duplicates inside a single adoption batch", () => {
    const filtered = filterAlreadyRestoredConfigs([config("ws-a"), config("ws-a")]);
    expect(filtered.map((cfg) => cfg.id)).toEqual(["ws-a"]);
  });
});

describe("transposeSplitRowsToCols", () => {
  it("keeps the legacy split_rows migration intact after the move", () => {
    expect(transposeSplitRowsToCols([])).toEqual([]);
    expect(transposeSplitRowsToCols([[0, 1], [2, 3]])).toEqual([[0, 2], [1, 3]]);
    expect(transposeSplitRowsToCols([[0, 1], [2]])).toEqual([[0, 2], [1]]);
  });
});

describe("sessionIdsInWorkspace", () => {
  it("collects pane and tab sessions once each", () => {
    // Every one of these gets evictTerminalCache + focusController.clearSession
    // on tear-out — and none of them gets killSession.
    const first = tab("tab-1", "session-1");
    const second = tab("tab-2", "session-2");
    const pane: Pane = {
      id: "pane-1",
      agentId: "claude-code",
      sessionId: first.sessionId,
      tabs: [first, second],
      activeTabId: first.id,
    };

    expect(sessionIdsInWorkspace(workspace("ws-a", [pane])).sort()).toEqual([
      "session-1",
      "session-2",
    ]);
  });
});

describe("mergeWindowFragmentWorkspaces — pending adoption queue", () => {
  it("keeps a torn-out workspace that the new window has not adopted yet", () => {
    const merged = mergeWindowFragmentWorkspaces(
      [config("ws-main")],
      [{ window_label: "mycmux-w1", pending: true, workspaces: [config("ws-moved")] }],
    );
    expect(merged.map((workspace) => workspace.id)).toEqual(["ws-main", "ws-moved"]);
  });

  it("keeps a merge-back queued to this window before it adopts", () => {
    const merged = mergeWindowFragmentWorkspaces(
      [config("ws-main")],
      [{ window_label: "main", pending: true, workspaces: [config("ws-returning")] }],
    );
    expect(merged.map((workspace) => workspace.id)).toEqual(["ws-main", "ws-returning"]);
  });

  it("still ignores this window's own published fragment", () => {
    const merged = mergeWindowFragmentWorkspaces(
      [config("ws-main")],
      [{ window_label: "main", workspaces: [config("ws-stale")] }],
    );
    expect(merged.map((workspace) => workspace.id)).toEqual(["ws-main"]);
  });

  it("does not duplicate a workspace present in both a publish and the queue", () => {
    const merged = mergeWindowFragmentWorkspaces(
      [],
      [
        { window_label: "mycmux-w1", workspaces: [config("ws-moved")] },
        { window_label: "mycmux-w1", pending: true, workspaces: [config("ws-moved")] },
      ],
    );
    expect(merged.map((workspace) => workspace.id)).toEqual(["ws-moved"]);
  });
});
