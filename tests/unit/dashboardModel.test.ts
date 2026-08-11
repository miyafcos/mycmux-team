import { describe, expect, it } from "vitest";

import {
  applyDashboardFilters,
  buildDashboardCards,
  groupDashboardCard,
  sortCardsWithinGroup,
  urgentRibbon,
  type DashboardCardModel,
} from "../../src/components/dashboard/dashboardModel";
import type { Workspace } from "../../src/types";

const now = 1_000_000;

function workspace(): Workspace {
  return {
    id: "ws-1",
    name: "Workspace A",
    gridTemplateId: "single",
    status: "active",
    createdAt: now,
    panes: [{
      id: "pane-1",
      sessionId: "s-1",
      activeTabId: "tab-1",
      tabs: [{ id: "tab-1", sessionId: "s-1", agentId: "claude", label: "Alpha", type: "terminal" }],
    }],
  } as Workspace;
}

function cards(input: Partial<Parameters<typeof buildDashboardCards>[1]> = {}) {
  return buildDashboardCards([workspace()], {
    metadataBySession: {},
    lastLogBySession: {},
    lastLogAtBySession: {},
    attentionBySession: {},
    seenAttentionByTab: new Map(),
    stallsBySession: {},
    now,
    hasTerminalBuffer: () => true,
    ...input,
  });
}

function card(overrides: Partial<DashboardCardModel>): DashboardCardModel {
  return {
    ...cards()[0],
    group: "idle",
    status: "idle",
    lastActivityAt: 0,
    ...overrides,
  };
}

describe("dashboard model", () => {
  it("uses the required exclusive group order", () => {
    expect(groupDashboardCard("waiting", undefined, 0, now)).toBe("waiting");
    expect(groupDashboardCard("error", undefined, 0, now)).toBe("waiting");
    expect(groupDashboardCard("done", { sessionId: "s", reason: "no_output", since: 0 }, 0, now)).toBe("stalled");
    expect(groupDashboardCard("done", undefined, 0, now)).toBe("done");
    expect(groupDashboardCard(null, undefined, now - 1, now)).toBe("working");
    expect(groupDashboardCard(null, undefined, now - 300_001, now)).toBe("idle");
  });

  it("builds card status and unobserved state", () => {
    const [built] = cards({
      metadataBySession: { "s-1": { cwd: "C:/repo", agentKind: "codex" } },
      lastLogBySession: { "s-1": "ready" },
      lastLogAtBySession: { "s-1": now - 1 },
      hasTerminalBuffer: () => false,
    });
    expect(built.group).toBe("working");
    expect(built.status).toBe("unobserved");
    expect(built.agentKind).toBe("codex");
    expect(built.label).toBe("Alpha");
  });

  it("sorts each group according to its specified key", () => {
    const waiting = sortCardsWithinGroup([
      card({ group: "waiting", attention: { occurrenceOrder: 2 } as DashboardCardModel["attention"] }),
      card({ group: "waiting", attention: { occurrenceOrder: 1 } as DashboardCardModel["attention"] }),
    ], "waiting");
    expect(waiting.map((item) => item.attention?.occurrenceOrder)).toEqual([1, 2]);

    const stalled = sortCardsWithinGroup([
      card({ group: "stalled", stall: { sessionId: "s", reason: "no_output", since: 1 } }),
      card({ group: "stalled", stall: { sessionId: "s", reason: "queued_input", since: 3 } }),
      card({ group: "stalled", stall: { sessionId: "s", reason: "pty_dead", since: 5 } }),
    ], "stalled");
    expect(stalled.map((item) => item.stall?.reason)).toEqual(["pty_dead", "queued_input", "no_output"]);

    const working = sortCardsWithinGroup([
      card({ group: "working", lastActivityAt: 1 }),
      card({ group: "working", lastActivityAt: 2 }),
    ], "working");
    expect(working.map((item) => item.lastActivityAt)).toEqual([2, 1]);
  });

  it("applies every filter as an intersection", () => {
    const selected = card({
      workspaceId: "ws-1",
      workspace: { ...workspace(), name: "Match" },
      group: "waiting",
      background: true,
      unobserved: true,
      agentKind: "codex",
      label: "Needle",
      metadata: { cwd: "C:/needle" },
    });
    const excluded = card({ workspaceId: "ws-2", group: "waiting", background: true, unobserved: true, agentKind: "codex" });
    expect(applyDashboardFilters([selected, excluded], {
      query: "needle",
      workspaceId: "ws-1",
      attentionOnly: true,
      stalledOnly: false,
      backgroundOnly: true,
      unobservedOnly: true,
      agentKind: "codex",
    })).toEqual([selected]);
  });

  it("limits urgent ribbon to the oldest three waiting cards", () => {
    const items = [5, 4, 3, 2, 1].map((occurrenceOrder) => card({
      group: "waiting",
      attention: { occurrenceOrder } as DashboardCardModel["attention"],
    }));
    expect(urgentRibbon([])).toEqual([]);
    expect(urgentRibbon(items.slice(0, 1))).toHaveLength(1);
    expect(urgentRibbon(items.slice(0, 3))).toHaveLength(3);
    expect(urgentRibbon(items).map((item) => item.attention?.occurrenceOrder)).toEqual([1, 2, 3]);
  });
});
