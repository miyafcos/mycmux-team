import { describe, expect, it } from "vitest";

import {
  applyDashboardFilters,
  buildDashboardCards,
  countByDisplayState,
  countVisibility,
  countWorkspaceStructure,
  groupDashboardCard,
  matchesDashboardStateFilter,
  needsHumanCards,
  orderDashboardCards,
  partitionDashboardCards,
  resolveDisplayState,
  type DashboardCardModel,
} from "../../src/components/dashboard/dashboardModel";
import type { LiveSessionBrief } from "../../src/lib/livebrief";
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

function brief(overrides: Partial<LiveSessionBrief> = {}): LiveSessionBrief {
  return {
    ptySessionId: "s-1",
    agentSessionId: "a-1",
    agentKind: "claude",
    ptyInstanceId: "pty-1",
    ptyGeneration: 1,
    sourceRevision: 1,
    ptyInputRevision: 1,
    task: "目的",
    latestInstruction: "テストを通して",
    taskSourceEventIds: [],
    activityKind: null,
    activityText: "実行中",
    activitySourceEventId: null,
    checkpoint: "確認済み",
    checkpointEvidenceEventIds: [],
    pendingInputKind: null,
    pendingPrompt: null,
    pendingOptions: [],
    promptEventId: null,
    promptHash: null,
    eventSeq: 1,
    operationalState: "running",
    telemetryHealth: "live",
    lastEventAt: now,
    lastSuccessfulReadAt: now,
    updatedAt: now,
    serviceEpoch: "epoch",
    briefRevision: 1,
    ...overrides,
  };
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
    noUpdateMinutes: null,
    ...overrides,
  };
}

/** tab.id が同じだと並び替えの Map が潰れるので、テスト用に別 id を振る。 */
function distinct(overrides: Partial<DashboardCardModel>, id: string): DashboardCardModel {
  const base = card(overrides);
  return { ...base, tab: { ...base.tab, id } };
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

  it("carries the livebrief fields onto the card", () => {
    const [built] = cards({
      briefsBySession: { "s-1": brief({ operationalState: "needsHuman" }) },
      lastLogAtBySession: { "s-1": now - 60_000 },
    });
    expect(built.telemetryHealth).toBe("live");
    expect(built.operationalState).toBe("needsHuman");
    expect(built.task).toBe("目的");
    expect(built.activityText).toBe("実行中");
    expect(built.checkpoint).toBe("確認済み");
    expect(built.latestInstruction).toBe("テストを通して");
    expect(built.neverStarted).toBe(false);
    expect(built.noUpdateMinutes).toBe(0);
  });

  it("marks a tab that has no brief, no buffer and no activity as never started", () => {
    const [built] = cards({ hasTerminalBuffer: () => false });
    expect(built.neverStarted).toBe(true);
    expect(built.latestInstruction).toBeNull();
    // 端末バッファが無いだけの稼働中タブは未起動ではない。
    expect(cards({ hasTerminalBuffer: () => false, lastLogAtBySession: { "s-1": now - 1 } })[0].neverStarted).toBe(false);
    // brief があるなら未起動ではない。
    expect(cards({ hasTerminalBuffer: () => false, briefsBySession: { "s-1": brief() } })[0].neverStarted).toBe(false);
  });

  it("never calls a never-started tab stale or running", () => {
    const [built] = cards({ hasTerminalBuffer: () => false });
    expect(resolveDisplayState(built)).toBe("idle");
    // stall / group が付いていても未起動なら断定しない。
    expect(resolveDisplayState({
      ...built,
      stall: { sessionId: "s-1", reason: "no_output", since: 0 },
      group: "stalled",
    })).toBe("idle");
    expect(resolveDisplayState({ ...built, group: "working" })).toBe("idle");
  });

  it("searches the brief instruction as well", () => {
    const [built] = cards({ briefsBySession: { "s-1": brief({ latestInstruction: "章立ての整理" }) } });
    const filters = { query: "章立て", workspaceId: null, needsHumanOnly: false, agentKind: null };
    expect(applyDashboardFilters([built], filters)).toEqual([built]);
  });

  describe("resolveDisplayState", () => {
    it("lets a live livebrief win over the attention feed", () => {
      expect(resolveDisplayState(card({
        telemetryHealth: "live",
        operationalState: "needsHuman",
        attentionCategory: "done",
        group: "done",
        noUpdateMinutes: 0,
      }))).toBe("needsHuman");
      expect(resolveDisplayState(card({
        telemetryHealth: "live",
        operationalState: "running",
        attentionCategory: null,
        noUpdateMinutes: 1,
      }))).toBe("running");
      expect(resolveDisplayState(card({
        telemetryHealth: "live",
        operationalState: "ready",
        attentionCategory: null,
        noUpdateMinutes: 0,
      }))).toBe("idle");
    });

    it("still reports an error while the livebrief is live", () => {
      expect(resolveDisplayState(card({
        telemetryHealth: "live",
        operationalState: "running",
        attentionCategory: "error",
        noUpdateMinutes: 0,
      }))).toBe("error");
    });

    it("calls a live session stale once it passes the five minute threshold", () => {
      expect(resolveDisplayState(card({
        telemetryHealth: "live",
        operationalState: "running",
        noUpdateMinutes: 4,
      }))).toBe("running");
      expect(resolveDisplayState(card({
        telemetryHealth: "live",
        operationalState: "running",
        noUpdateMinutes: 5,
      }))).toBe("noUpdate");
      // 人間待ちは古くても要対応のまま (先に人間の手が要る)。
      expect(resolveDisplayState(card({
        telemetryHealth: "live",
        operationalState: "needsHuman",
        noUpdateMinutes: 90,
      }))).toBe("needsHuman");
    });

    it("falls back to the attention/stall/metadata judgement when telemetry is not live", () => {
      // livebrief が needsHuman でも live でなければ採らない。
      expect(resolveDisplayState(card({
        telemetryHealth: "unlinked",
        operationalState: "needsHuman",
        attentionCategory: null,
        group: "working",
        lastActivityAt: now - 1,
      }))).toBe("running");
      expect(resolveDisplayState(card({
        telemetryHealth: "unavailable",
        attentionCategory: "waiting",
        group: "waiting",
      }))).toBe("needsHuman");
      expect(resolveDisplayState(card({
        attentionCategory: "error",
        group: "waiting",
      }))).toBe("error");
      expect(resolveDisplayState(card({
        stall: { sessionId: "s", reason: "no_output", since: 0 },
        group: "stalled",
      }))).toBe("noUpdate");
      expect(resolveDisplayState(card({ attentionCategory: "done", group: "done" }))).toBe("done");
      expect(resolveDisplayState(card({ group: "idle", lastActivityAt: now - 600_000 }))).toBe("noUpdate");
      // 一度も動いていないタブを「更新なし」と言い切らない。
      expect(resolveDisplayState(card({ group: "idle", lastActivityAt: 0 }))).toBe("idle");
    });
  });

  it("orders every session into the single needsHuman > error > running > noUpdate > idle > done list", () => {
    const done = distinct({ attentionCategory: "done", group: "done" }, "t-done");
    const idle = distinct({ group: "idle", lastActivityAt: 0 }, "t-idle");
    const noUpdate = distinct({ group: "idle", lastActivityAt: now - 600_000, noUpdateMinutes: 10 }, "t-noupdate");
    const running = distinct({ group: "working", lastActivityAt: now - 1 }, "t-running");
    const error = distinct({ attentionCategory: "error", group: "waiting" }, "t-error");
    const needsHuman = distinct({ attentionCategory: "waiting", group: "waiting" }, "t-needs");
    const ordered = orderDashboardCards([done, idle, noUpdate, running, error, needsHuman], "attention");
    expect(ordered.map((item) => item.tab.id)).toEqual([
      "t-needs", "t-error", "t-running", "t-noupdate", "t-idle", "t-done",
    ]);
  });

  it("puts the oldest waiting session first inside the needsHuman section", () => {
    const items = [5, 4, 3, 2, 1].map((occurrenceOrder) => distinct({
      attentionCategory: "waiting",
      group: "waiting",
      attention: { occurrenceOrder } as DashboardCardModel["attention"],
    }, `t-${occurrenceOrder}`));
    expect(needsHumanCards([])).toEqual([]);
    expect(needsHumanCards(items).map((item) => item.attention?.occurrenceOrder)).toEqual([1, 2, 3, 4, 5]);
    // done / running は要対応セクションに混ぜない。
    expect(needsHumanCards([distinct({ attentionCategory: "done", group: "done" }, "t-done")])).toEqual([]);
  });

  it("keeps each workspace together when sorting by workspace", () => {
    const first = { ...distinct({ attentionCategory: "done", group: "done" }, "t-a"), workspaceIndex: 0 };
    const second = { ...distinct({ attentionCategory: "waiting", group: "waiting" }, "t-b"), workspaceIndex: 1 };
    expect(orderDashboardCards([second, first], "workspace").map((item) => item.tab.id)).toEqual(["t-a", "t-b"]);
    expect(orderDashboardCards([second, first], "attention").map((item) => item.tab.id)).toEqual(["t-b", "t-a"]);
  });

  it("counts every session under exactly one display state", () => {
    const counts = countByDisplayState([
      distinct({ attentionCategory: "waiting", group: "waiting" }, "t-1"),
      distinct({ attentionCategory: "error", group: "waiting" }, "t-2"),
      distinct({ group: "working", lastActivityAt: now - 1 }, "t-3"),
      distinct({ attentionCategory: "done", group: "done" }, "t-4"),
    ]);
    expect(counts).toEqual({ needsHuman: 1, error: 1, running: 1, noUpdate: 0, idle: 0, done: 1 });
  });

  it("counts the header structure as panes, tabs and workspaces", () => {
    const base = workspace();
    const second: Workspace = {
      ...base,
      id: "ws-2",
      name: "Workspace B",
      panes: [
        { id: "pane-2", sessionId: "s-2", activeTabId: "tab-2", tabs: [
          { id: "tab-2", sessionId: "s-2", agentId: "claude", label: "Beta", type: "terminal" },
          { id: "tab-3", sessionId: "s-3", agentId: "codex", label: "Gamma", type: "terminal" },
        ] },
        { id: "pane-3", sessionId: "s-4", activeTabId: "tab-4", tabs: [
          { id: "tab-4", sessionId: "s-4", agentId: "codex", label: "Delta", type: "terminal" },
        ] },
      ],
    } as Workspace;
    expect(countWorkspaceStructure([base, second])).toEqual({ panes: 3, tabs: 4, workspaces: 2 });
    expect(countWorkspaceStructure([])).toEqual({ panes: 0, tabs: 0, workspaces: 0 });
  });

  it("splits visible from background by the terminal buffer, not by the state", () => {
    expect(countVisibility([
      distinct({ unobserved: false }, "t-1"),
      distinct({ unobserved: true }, "t-2"),
      distinct({ unobserved: true }, "t-3"),
    ])).toEqual({ visible: 1, background: 2 });
    expect(countVisibility([])).toEqual({ visible: 0, background: 0 });
  });

  it("applies every filter as an intersection", () => {
    const selected = card({
      workspaceId: "ws-1",
      workspace: { ...workspace(), name: "Match" },
      attentionCategory: "waiting",
      group: "waiting",
      agentKind: "codex",
      label: "Needle",
      metadata: { cwd: "C:/needle" },
    });
    const excluded = card({ workspaceId: "ws-2", attentionCategory: "waiting", group: "waiting", agentKind: "codex" });
    expect(applyDashboardFilters([selected, excluded], {
      query: "needle",
      workspaceId: "ws-1",
      needsHumanOnly: true,
      agentKind: "codex",
    })).toEqual([selected]);
  });

  it("drops everything but needsHuman and error under the needsHumanOnly filter", () => {
    const waiting = distinct({ attentionCategory: "waiting", group: "waiting" }, "t-1");
    const errored = distinct({ attentionCategory: "error", group: "waiting" }, "t-2");
    const running = distinct({ group: "working", lastActivityAt: now - 1 }, "t-3");
    const filters = { query: "", workspaceId: null, needsHumanOnly: true, agentKind: null };
    expect(applyDashboardFilters([waiting, errored, running], filters).map((item) => item.tab.id))
      .toEqual(["t-1", "t-2"]);
  });

  it("treats the 要対応 count filter as needsHuman plus error", () => {
    const waiting = distinct({ attentionCategory: "waiting", group: "waiting" }, "t-waiting");
    const errored = distinct({ attentionCategory: "error", group: "waiting" }, "t-error");
    const running = distinct({ group: "working", lastActivityAt: now - 1 }, "t-running");
    expect(applyDashboardFilters([waiting, errored, running], {
      query: "",
      workspaceId: null,
      needsHumanOnly: false,
      agentKind: null,
      stateFilter: "needsHuman",
    }).map((item) => item.tab.id)).toEqual(["t-waiting", "t-error"]);
    expect(matchesDashboardStateFilter(running, "needsHuman")).toBe(false);
  });

  it("partitions completed, idle, and never-started cards behind the disclosure", () => {
    const waiting = distinct({ attentionCategory: "waiting", group: "waiting" }, "t-waiting");
    const running = distinct({ group: "working", lastActivityAt: now - 1 }, "t-running");
    const done = distinct({ attentionCategory: "done", group: "done" }, "t-done");
    const idle = distinct({ group: "idle", lastActivityAt: 0 }, "t-idle");
    const neverStarted = distinct({ neverStarted: true, group: "working", lastActivityAt: now - 1 }, "t-never");
    const result = partitionDashboardCards([waiting, running, done, idle, neverStarted]);
    expect(result.needsHuman.map((item) => item.tab.id)).toEqual(["t-waiting"]);
    expect(result.active.map((item) => item.tab.id)).toEqual(["t-running"]);
    expect(result.deferred.map((item) => item.tab.id)).toEqual(["t-done", "t-idle", "t-never"]);
  });

  it("searches the livebrief summary as well as the terminal fields", () => {
    const withTask = card({ task: "章立ての整理", activityText: null });
    const filters = { query: "章立て", workspaceId: null, needsHumanOnly: false, agentKind: null };
    expect(applyDashboardFilters([withTask], filters)).toEqual([withTask]);
  });
});
