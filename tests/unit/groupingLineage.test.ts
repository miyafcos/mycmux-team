import { describe, expect, it } from "vitest";

import {
  groupingLineageNodes,
  groupingLiveInfo,
  groupingLiveInfoByTabId,
  groupingTabLocations,
} from "../../src/components/layout/groupingLineage";
import { buildGroups } from "../../src/lib/groupMembership";
import type { Pane, PaneTab, Workspace } from "../../src/types";

function tab(
  id: string,
  parentTabId?: string,
  options: Partial<PaneTab> = {},
): PaneTab {
  return {
    id,
    sessionId: `session-${id}`,
    agentId: "codex",
    ...(parentTabId ? { origin: { kind: "agent", parentTabId } as const } : {}),
    ...options,
  };
}

function pane(id: string, tabs: PaneTab[]): Pane {
  return {
    id,
    agentId: "codex",
    sessionId: tabs[0]?.sessionId ?? "",
    tabs,
    activeTabId: tabs[0]?.id ?? "",
  };
}

function workspace(id: string, panes: Pane[], splitColumns?: string[][]): Workspace {
  return {
    id,
    name: id,
    gridTemplateId: "2x1",
    panes,
    splitColumns,
    status: "running",
    createdAt: 1,
  };
}

function lineageOriginGroups(
  nodes: ReturnType<typeof groupingLineageNodes>,
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const node of nodes.values()) {
    const key = `origin:${node.rootTabId}`;
    groups.set(key, [...(groups.get(key) ?? []), node.tabId]);
  }
  return groups;
}

function buildOriginGroups(workspaces: Workspace[]): Map<string, string[]> {
  return new Map(
    [...buildGroups(workspaces).entries()].filter(([key]) => key.startsWith("origin:")),
  );
}

describe("groupingLineageNodes", () => {
  it("resolves two and three generations in split-column traversal order", () => {
    const workspaces = [workspace("ws", [
      pane("pane-second", [tab("sibling", "root")]),
      pane("pane-first", [tab("root"), tab("child", "root"), tab("grandchild", "child")]),
    ], [["pane-first"], ["pane-second"]])];

    const nodes = groupingLineageNodes(workspaces);
    expect(nodes.get("root")).toMatchObject({ rootTabId: "root", depth: 0, childTabIds: ["child", "sibling"] });
    expect(nodes.get("child")).toMatchObject({ rootTabId: "root", depth: 1, childTabIds: ["grandchild"] });
    expect(nodes.get("grandchild")).toMatchObject({ rootTabId: "root", depth: 2 });
    expect(nodes.get("sibling")).toMatchObject({ rootTabId: "root", depth: 1 });
  });

  it("normalizes an absent parent into a finite orphan root", () => {
    const nodes = groupingLineageNodes([workspace("ws", [pane("pane", [tab("orphan", "missing")])])]);
    expect(nodes.get("orphan")).toEqual({
      tabId: "orphan",
      parentTabId: null,
      rootTabId: "missing",
      depth: 0,
      childTabIds: [],
      orphan: true,
      cycleBroken: false,
    });
  });

  it("breaks cycles at the alphabetically first root and terminates", () => {
    const nodes = groupingLineageNodes([workspace("ws", [pane("pane", [
      tab("B", "A"),
      tab("A", "B"),
      tab("descendant", "B"),
    ])])]);

    expect(nodes.get("A")).toMatchObject({ rootTabId: "A", depth: 0, cycleBroken: true });
    expect(nodes.get("B")).toMatchObject({ rootTabId: "A", depth: 1, cycleBroken: true });
    expect(nodes.get("descendant")).toMatchObject({ rootTabId: "A", depth: 2, cycleBroken: false });
  });

  it("retains a root across workspaces", () => {
    const nodes = groupingLineageNodes([
      workspace("parent-ws", [pane("parent-pane", [tab("parent")])]),
      workspace("child-ws", [pane("child-pane", [tab("child", "parent")])]),
    ]);
    expect(nodes.get("child")).toMatchObject({ rootTabId: "parent", depth: 1, parentTabId: "parent" });
  });

  it("matches buildGroups for two orphans sharing one absent parent", () => {
    const workspaces = [workspace("ws", [pane("pane", [
      tab("orphan-one", "missing-shared"),
      tab("orphan-two", "missing-shared"),
    ])])];

    expect(lineageOriginGroups(groupingLineageNodes(workspaces))).toEqual(buildOriginGroups(workspaces));
  });

  it("matches buildGroups for orphans with different absent parents", () => {
    const workspaces = [workspace("ws", [pane("pane", [
      tab("orphan-one", "missing-one"),
      tab("orphan-two", "missing-two"),
    ])])];

    expect(lineageOriginGroups(groupingLineageNodes(workspaces))).toEqual(buildOriginGroups(workspaces));
  });

  it("matches buildGroups when orphans, cycles, and cross-workspace children coexist", () => {
    const workspaces = [
      workspace("one", [pane("p1", [
        tab("root"),
        tab("child", "root"),
        tab("orphan-one", "missing-shared"),
        tab("orphan-two", "missing-shared"),
      ])]),
      workspace("two", [pane("p2", [
        tab("cross", "child"),
        tab("cycle-b", "cycle-a"),
        tab("cycle-a", "cycle-b"),
        tab("cycle-child", "cycle-b"),
      ])]),
    ];

    expect(lineageOriginGroups(groupingLineageNodes(workspaces))).toEqual(buildOriginGroups(workspaces));
  });
});

describe("groupingTabLocations", () => {
  it("indexes tab labels and their workspace and pane locations", () => {
    const locations = groupingTabLocations([
      workspace("parent-ws", [pane("parent-pane", [tab("parent", undefined, { label: "Parent" })])]),
      workspace("child-ws", [pane("child-pane", [tab("child", "parent", { label: "Child" })])]),
    ]);

    expect([...locations.entries()]).toEqual([
      ["parent", { workspaceId: "parent-ws", paneId: "parent-pane", label: "Parent" }],
      ["child", { workspaceId: "child-ws", paneId: "child-pane", label: "Child" }],
    ]);
  });
});

describe("groupingLiveInfoByTabId", () => {
  it("matches groupingLiveInfo and makes declared tabs timeless idle", () => {
    const workspaces = [workspace("ws", [pane("pane", [
      tab("metadata-kind", undefined, { agentKind: "claude" }),
      tab("tab-kind", undefined, { agentKind: "codex" }),
      tab("declared", undefined, { lifecycle: "declared", agentKind: "grok" }),
    ])])];
    const info = groupingLiveInfoByTabId(workspaces, {
      metadataBySession: {
        "session-metadata-kind": {
          processIsShell: false,
          agentStatus: "working",
          backendLastOutputAt: 123,
          agentKind: "grok",
        },
        "session-tab-kind": { agentStatus: "done", backendLastOutputAt: 456 },
        "session-declared": { agentStatus: "working", backendLastOutputAt: 789, agentKind: "claude" },
      },
      volatileBySession: {
        "session-metadata-kind": { outputActive: true, backendLastOutputAt: 124 },
      },
      attentionCategoryByTabId: {
        "metadata-kind": null,
        "tab-kind": "error",
        declared: "error",
      },
    });

    const direct = groupingLiveInfo({
      declared: false,
      metadata: {
        processIsShell: false,
        agentStatus: "working",
        backendLastOutputAt: 123,
        agentKind: "grok",
      },
      volatile: { outputActive: true, backendLastOutputAt: 124 },
      attentionCategory: null,
      tabAgentKind: "claude",
    });
    expect(info.get("metadata-kind")).toEqual(direct);
    expect(direct).toEqual({ status: "working", lastOutputAt: 124, agentKind: "grok" });
    expect(info.get("tab-kind")).toEqual({ status: "error", lastOutputAt: 456, agentKind: "codex" });
    expect(info.get("declared")).toEqual({ status: "idle", lastOutputAt: null, agentKind: "claude" });
  });

  it("rejects metadata-only working while preserving status precedence", () => {
    expect(groupingLiveInfo({
      declared: false,
      metadata: { agentStatus: "working" },
      attentionCategory: null,
      tabAgentKind: null,
    })).toEqual({ status: "idle", lastOutputAt: null, agentKind: null });
    expect(groupingLiveInfo({
      declared: false,
      metadata: { processIsShell: false, agentStatus: "done" },
      volatile: { outputActive: true },
      attentionCategory: "waiting",
      tabAgentKind: null,
    }).status).toBe("waiting");
    expect(groupingLiveInfo({
      declared: false,
      metadata: { agentStatus: "waiting" },
      attentionCategory: "error",
      tabAgentKind: null,
    }).status).toBe("error");
  });
});
