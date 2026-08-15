import { describe, expect, it } from "vitest";
import { applyLayoutMutation, type LayoutMutation } from "../../src/lib/layoutMutation";
import type { Pane, PaneTab, Workspace } from "../../src/types/workspace";

const makeTab = (id: string): PaneTab => ({
  id,
  sessionId: `session-${id}`,
  agentId: `agent-${id}`,
  cwd: `C:\\work\\${id}`,
  lastProcess: `process-${id}`,
  claudeSessionId: `claude-${id}`,
  agentKind: "codex",
  agentSessionId: `agent-session-${id}`,
  suppressedAgentSessions: [{ agentKind: "claude", agentSessionId: `suppressed-${id}` }],
  launchEnv: { TAB_ID: id },
});

function makePane(id: string, tabIds: string[], activeTabId = tabIds[0] ?? "", pinnedTabId?: string): Pane {
  const tabs = tabIds.map(makeTab);
  const active = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  return {
    id,
    agentId: active?.agentId ?? "shell",
    sessionId: active?.sessionId ?? `empty-${id}`,
    activeTabId: active?.id ?? "",
    tabs,
    cwd: active?.cwd,
    lastProcess: active?.lastProcess,
    claudeSessionId: active?.claudeSessionId,
    agentKind: active?.agentKind,
    agentSessionId: active?.agentSessionId,
    suppressedAgentSessions: active?.suppressedAgentSessions,
    launchEnv: active?.launchEnv,
    pinnedTabId,
  };
}

const fixture = (): Workspace[] => [
  {
    id: "a", name: "A", gridTemplateId: "2x2", status: "running", createdAt: 1,
    panes: [makePane("a1", ["t1", "t2"]), makePane("a2", ["t3"]), makePane("a3", ["t4"])],
    splitColumns: [["a1", "a2"], ["a3"]], columnWidths: [40, 60], rowHeightsPerCol: [[45, 55], [100]],
  },
  {
    id: "b", name: "B", gridTemplateId: "1x1", status: "running", createdAt: 1,
    panes: [makePane("b1", ["t5", "t6"])],
    splitColumns: [["b1"]], columnWidths: [100], rowHeightsPerCol: [[100]],
  },
];

const ids = (workspaces: Workspace[]): string[] =>
  workspaces.flatMap((workspace) => workspace.panes.flatMap((pane) => pane.tabs.map((tab) => tab.id)));

const mirrorFields = [
  "agentId",
  "sessionId",
  "cwd",
  "lastProcess",
  "claudeSessionId",
  "agentKind",
  "agentSessionId",
  "suppressedAgentSessions",
  "launchEnv",
] as const;

function assertWellFormed(workspaces: Workspace[], expected: string[], context = ""): void {
  const actual = ids(workspaces);
  expect(new Set(actual).size, context).toBe(actual.length);
  expect(new Set(actual), context).toEqual(new Set(expected));
  for (const workspace of workspaces) {
    expect(workspace.panes.length, context).toBeGreaterThan(0);
    for (const pane of workspace.panes) {
      if (pane.tabs.length === 0) {
        expect(workspace.panes, context).toHaveLength(1);
        expect(pane.activeTabId, context).toBe("");
        expect(pane.pinnedTabId, context).toBeUndefined();
        continue;
      }
      const active = pane.tabs.find((tab) => tab.id === pane.activeTabId);
      expect(active, context).toBeDefined();
      for (const field of mirrorFields) expect(pane[field], `${context} mirror:${field}`).toEqual(active?.[field]);
      if (pane.pinnedTabId !== undefined) {
        expect(pane.tabs.some((tab) => tab.id === pane.pinnedTabId), context).toBe(true);
        expect(pane.tabs[0].id, context).toBe(pane.pinnedTabId);
      }
    }
    const columns = workspace.splitColumns ?? [];
    expect(columns.every((column) => column.length > 0), context).toBe(true);
    const paneIds = columns.flat();
    expect(new Set(paneIds).size, context).toBe(paneIds.length);
    expect(new Set(paneIds), context).toEqual(new Set(workspace.panes.map((pane) => pane.id)));
    expect(workspace.columnWidths, context).toHaveLength(columns.length);
    expect(workspace.columnWidths?.every((size) => Number.isFinite(size) && size > 0), context).toBe(true);
    expect(workspace.rowHeightsPerCol, context).toHaveLength(columns.length);
    columns.forEach((column, columnIndex) => {
      expect(workspace.rowHeightsPerCol?.[columnIndex], context).toHaveLength(column.length);
      expect(workspace.rowHeightsPerCol?.[columnIndex].every((size) => Number.isFinite(size) && size > 0), context).toBe(true);
    });
  }
}

function deepFreeze(value: unknown, seen = new WeakSet<object>()): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  Object.freeze(value);
}

describe("applyLayoutMutation", () => {
  it("moves bundles in visual order and resynchronizes the anchor mirrors", () => {
    const input = fixture();
    const { workspaces, summary } = applyLayoutMutation(input, {
      kind: "move-tabs", operationId: "op", tabIds: ["t4", "t1"], anchorTabId: "t4",
      to: { workspaceId: "b", paneId: "b1" }, sourceLayoutRevision: 7,
    }, 7);
    expect(workspaces[1].panes[0].tabs.map((tab) => tab.id)).toEqual(["t5", "t6", "t1", "t4"]);
    expect(workspaces[1].panes[0]).toMatchObject({ activeTabId: "t4", sessionId: "session-t4", agentId: "agent-t4" });
    expect(summary.moved).toEqual(["t1", "t4"]);
    assertWellFormed(workspaces, ["t1", "t2", "t3", "t4", "t5", "t6"]);
    expect(ids(input)).toEqual(["t1", "t2", "t3", "t4", "t5", "t6"]);
  });

  it("reconciles widths and row heights after panes and columns disappear", () => {
    const { workspaces } = applyLayoutMutation(fixture(), {
      kind: "move-tabs", operationId: "metrics", tabIds: ["t3", "t4"], anchorTabId: "t4",
      to: { workspaceId: "b", paneId: "b1" }, sourceLayoutRevision: 1,
    }, 1);
    expect(workspaces[0]).toMatchObject({
      splitColumns: [["a1"]], columnWidths: [40], rowHeightsPerCol: [[45]],
    });
    expect(workspaces[1].columnWidths).toHaveLength(workspaces[1].splitColumns?.length ?? 0);
    assertWellFormed(workspaces, ["t1", "t2", "t3", "t4", "t5", "t6"]);
  });

  it("keeps the last pane empty and accounts closed tabs separately", () => {
    const { workspaces, summary } = applyLayoutMutation([fixture()[1]], {
      kind: "close-tabs", operationId: "close", tabIds: ["t5", "t6"],
    }, 0);
    expect(workspaces[0].panes).toHaveLength(1);
    expect(workspaces[0].panes[0]).toMatchObject({ id: "b1", tabs: [], activeTabId: "" });
    expect(summary).toMatchObject({ closed: ["t5", "t6"], moved: [], retainedEmptyPanes: ["b1"] });
    assertWellFormed(workspaces, []);
  });

  it("deterministically retains the last pane when an entire multi-pane workspace is closed", () => {
    const { workspaces, summary } = applyLayoutMutation([fixture()[0]], {
      kind: "close-tabs", operationId: "close-all", tabIds: ["t1", "t2", "t3", "t4"],
    }, 0);
    expect(workspaces[0].panes.map((pane) => pane.id)).toEqual(["a3"]);
    expect(summary.removedPanes).toEqual(["a1", "a2"]);
    expect(summary.retainedEmptyPanes).toEqual(["a3"]);
    assertWellFormed(workspaces, []);
  });

  it("chooses the last successor and clears or honors pins", () => {
    const source = fixture();
    source[0].panes[0] = makePane("a1", ["t1", "t2", "t7"], "t2");
    source[0].splitColumns = [["a1", "a2"], ["a3"]];
    source[0].rowHeightsPerCol = [[45, 55], [100]];
    const closed = applyLayoutMutation(source, {
      kind: "close-tabs", operationId: "successor", tabIds: ["t2"],
    }, 0).workspaces;
    expect(closed[0].panes[0]).toMatchObject({ activeTabId: "t7", sessionId: "session-t7", agentId: "agent-t7" });

    const pinned = fixture();
    pinned[0].panes[0] = makePane("a1", ["t1", "t2"], "t1", "t1");
    pinned[1].panes[0] = makePane("b1", ["t5", "t6"], "t5", "t5");
    const moved = applyLayoutMutation(pinned, {
      kind: "move-tabs", operationId: "pin", tabIds: ["t1"], anchorTabId: "t1",
      to: { workspaceId: "b", paneId: "b1" }, sourceLayoutRevision: 2,
    }, 2).workspaces;
    expect(moved[0].panes[0].pinnedTabId).toBeUndefined();
    expect(moved[1].panes[0]).toMatchObject({ pinnedTabId: "t5", activeTabId: "t5", sessionId: "session-t5" });
    assertWellFormed(moved, ["t1", "t2", "t3", "t4", "t5", "t6"]);
  });

  it("rejects stale revisions without changing layout", () => {
    const input = fixture();
    const { workspaces, summary } = applyLayoutMutation(input, {
      kind: "move-tabs", operationId: "stale", tabIds: ["t1", "missing"], anchorTabId: "t1",
      to: { workspaceId: "b", paneId: "b1" }, sourceLayoutRevision: 7,
    }, 8);
    expect(workspaces).toEqual(input);
    expect(summary).toMatchObject({ skipped: ["t1", "missing"], moved: [], staleRevision: true, affectedWorkspaces: [] });
  });

  it("records an ignored anchor and leaves unaffected workspaces unnormalized", () => {
    const input = fixture();
    const malformed: Workspace = {
      id: "c", name: "C", gridTemplateId: "1x1", status: "running", createdAt: 1,
      panes: [makePane("c1", [])], splitColumns: [[], ["c1"]], columnWidths: [7], rowHeightsPerCol: [[], [3]],
    };
    input.push(malformed);
    const { workspaces, summary } = applyLayoutMutation(input, {
      kind: "move-tabs", operationId: "ignored", tabIds: ["t1"], anchorTabId: "outside",
      to: { workspaceId: "a", paneId: "a2" }, sourceLayoutRevision: 3,
    }, 3);
    expect(summary.ignoredAnchorTabId).toBe("outside");
    expect(workspaces[2]).toEqual(malformed);
  });

  it("counts zero prior columns when splitColumns was undefined", () => {
    const workspace = fixture()[1];
    workspace.splitColumns = undefined;
    workspace.columnWidths = undefined;
    workspace.rowHeightsPerCol = undefined;
    const { summary, workspaces } = applyLayoutMutation([workspace], {
      kind: "close-tabs", operationId: "undefined-columns", tabIds: ["t5"],
    }, 0);
    expect(summary.removedColumns).toBe(0);
    assertWellFormed(workspaces, ["t6"]);
  });

  it("resolves new-pane coordinates after source cleanup", () => {
    const workspace: Workspace = {
      id: "a", name: "A", gridTemplateId: "2x1", status: "running", createdAt: 1,
      panes: [makePane("a1", ["t1"]), makePane("a2", ["t2"])],
      splitColumns: [["a1"], ["a2"]], columnWidths: [50, 50], rowHeightsPerCol: [[100], [100]],
    };
    const { workspaces } = applyLayoutMutation([workspace], {
      kind: "move-tabs", operationId: "new", tabIds: ["t1"], anchorTabId: "t1",
      to: { workspaceId: "a", newPane: { column: 1, row: 0 } }, sourceLayoutRevision: 1,
    }, 1);
    expect(workspaces[0].splitColumns).toEqual([["a2"], ["pane-new"]]);
    assertWellFormed(workspaces, ["t1", "t2"]);
  });

  it.each([
    ["left", [["pane-edge"], ["b1"]]],
    ["right", [["b1"], ["pane-edge"]]],
    ["up", [["pane-edge", "b1"]]],
    ["down", [["b1", "pane-edge"]]],
  ] as const)("splits a target pane on its %s edge in one atomic mutation", (zone, expectedColumns) => {
    const input = fixture();
    const { workspaces, summary } = applyLayoutMutation(input, {
      kind: "move-tabs",
      operationId: "edge",
      tabIds: ["t1"],
      anchorTabId: "t1",
      to: { workspaceId: "b", split: { paneId: "b1", zone } },
      sourceLayoutRevision: "drag-a",
    }, "drag-a");
    expect(workspaces[1].splitColumns).toEqual(expectedColumns);
    expect(workspaces[1].panes.find((pane) => pane.id === "pane-edge")?.tabs.map((tab) => tab.id)).toEqual(["t1"]);
    expect(workspaces[0].panes.find((pane) => pane.id === "a1")?.tabs.map((tab) => tab.id)).toEqual(["t2"]);
    expect(summary.moved).toEqual(["t1"]);
    expect(summary.affectedWorkspaces).toEqual(["a", "b"]);
    assertWellFormed(workspaces, ["t1", "t2", "t3", "t4", "t5", "t6"]);
    expect(input[0].panes[0].tabs.map((tab) => tab.id)).toEqual(["t1", "t2"]);
  });

  it("locates a same-workspace split target before source cleanup", () => {
    const { workspaces } = applyLayoutMutation(fixture(), {
      kind: "move-tabs",
      operationId: "same-workspace-edge",
      tabIds: ["t3"],
      anchorTabId: "t3",
      to: { workspaceId: "a", split: { paneId: "a3", zone: "left" } },
      sourceLayoutRevision: "drag-a",
    }, "drag-a");
    expect(workspaces[0].splitColumns).toEqual([["a1"], ["pane-same-workspace-edge"], ["a3"]]);
    expect(workspaces[0].panes.map((pane) => pane.id)).not.toContain("a2");
    assertWellFormed(workspaces, ["t1", "t2", "t3", "t4", "t5", "t6"]);
  });

  it("safely skips empty, missing, and invalid destinations", () => {
    const input = fixture();
    expect(applyLayoutMutation(input, {
      kind: "move-tabs", operationId: "empty", tabIds: [], anchorTabId: "",
      to: { workspaceId: "b", paneId: "b1" }, sourceLayoutRevision: 1,
    }, 1).workspaces).toEqual(input);
    const invalid = applyLayoutMutation(input, {
      kind: "move-tabs", operationId: "invalid", tabIds: ["t1", "missing"], anchorTabId: "t1",
      to: { workspaceId: "b", paneId: "missing-pane" }, sourceLayoutRevision: 1,
    }, 1);
    expect(invalid.workspaces).toEqual(input);
    expect(invalid.summary.skipped).toEqual(["missing", "t1"]);
  });

  it("preserves invariants across 500 deterministic live-destination sequences", () => {
    let seed = 0x1a2b3c4d;
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed;
    };
    const counters = { close: 0, existing: 0, newPane: 0, crossWorkspace: 0, missing: 0, stopped: 0, bundles: [0, 0, 0, 0] };
    for (let sequence = 0; sequence < 500; sequence += 1) {
      let workspaces = fixture();
      let expected = ids(workspaces);
      for (let step = 0; step < 8; step += 1) {
        const currentIds = ids(workspaces);
        if (currentIds.length === 0) {
          counters.stopped += 1;
          break;
        }
        const shuffled = [...currentIds].sort(() => (random() % 3) - 1);
        const bundleSize = Math.min(currentIds.length, 1 + (random() % 4));
        const chosen = shuffled.slice(0, bundleSize);
        counters.bundles[bundleSize - 1] += 1;
        if (random() % 5 === 0) {
          chosen.push(`missing-${sequence}-${step}`);
          counters.missing += 1;
        }
        const close = random() % 4 === 0;
        let mutation: LayoutMutation;
        if (close) {
          counters.close += 1;
          mutation = { kind: "close-tabs", operationId: `${sequence}-${step}`, tabIds: chosen };
          expected = expected.filter((id) => !chosen.includes(id));
        } else {
          const targetWorkspace = workspaces[random() % workspaces.length];
          const sourceWorkspaceIds = new Set(workspaces
            .filter((workspace) => workspace.panes.some((pane) => pane.tabs.some((tab) => chosen.includes(tab.id))))
            .map((workspace) => workspace.id));
          if ([...sourceWorkspaceIds].some((id) => id !== targetWorkspace.id)) counters.crossWorkspace += 1;
          if (random() % 3 === 0) {
            counters.newPane += 1;
            mutation = {
              kind: "move-tabs", operationId: `${sequence}-${step}`, tabIds: chosen, anchorTabId: chosen[0],
              to: { workspaceId: targetWorkspace.id, newPane: { column: random() % 5, row: random() % 5 } },
              sourceLayoutRevision: step,
            };
          } else {
            counters.existing += 1;
            const targetPane = targetWorkspace.panes[random() % targetWorkspace.panes.length];
            mutation = {
              kind: "move-tabs", operationId: `${sequence}-${step}`, tabIds: chosen, anchorTabId: chosen[0],
              to: { workspaceId: targetWorkspace.id, paneId: targetPane.id }, sourceLayoutRevision: step,
            };
          }
        }
        const inputSnapshot = structuredClone(workspaces);
        deepFreeze(workspaces);
        deepFreeze(mutation);
        const result = applyLayoutMutation(workspaces, mutation, step);
        expect(workspaces, `input mutation seq=${sequence} step=${step}`).toEqual(inputSnapshot);
        workspaces = result.workspaces;
        assertWellFormed(workspaces, expected, `seq=${sequence} step=${step} ${mutation.kind}`);
      }
    }
    expect(counters.close).toBeGreaterThan(0);
    expect(counters.existing).toBeGreaterThan(0);
    expect(counters.newPane).toBeGreaterThan(0);
    expect(counters.crossWorkspace).toBeGreaterThan(0);
    expect(counters.missing).toBeGreaterThan(0);
    counters.bundles.forEach((count) => expect(count).toBeGreaterThan(0));
    // 500 sequences run in ~3s alone but exceed the 5s default when the whole
    // suite competes for cores, which reads as a logic failure. Budget for load.
  }, 30_000);
});
