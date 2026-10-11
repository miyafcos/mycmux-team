import { describe, expect, it } from "vitest";
import {
  buildDashboardCards, resolveDisplayState, needsHumanCards, matchesDashboardStateFilter,
  partitionDashboardCards, type DashboardCardModel,
} from "../../src/components/dashboard/dashboardModel";
import { groupCardsByAttentionSection } from "../../src/components/dashboard/dashboardAttentionOrder";
import { buildAttentionFactCards } from "../../src/components/dashboard/attentionModel";
import { dashboardActivity } from "../../src/components/dashboard/dashboardActivity";
import { dashboardStrings } from "../../src/components/dashboard/dashboardStrings";
import { displayStateColor } from "../../src/components/dashboard/DashboardCardRow";
import { buildMinimapModel, minimapWorkspaceStrip } from "../../src/components/dashboard/minimapModel";
import { resolveComposerRoute } from "../../src/components/dashboard/interventionRouting";
import type { LiveSessionBrief } from "../../src/lib/livebrief";
import type { Workspace } from "../../src/types";

const NOW = 1_800_000_000_000;
type Autonomy = NonNullable<LiveSessionBrief["autonomy"]>;
const active: Autonomy = { turnState: "active", openToolCount: 0, armedBackgroundCount: 0 };
const complete: Autonomy = { ...active, turnState: "complete" };
function brief(autonomy: Autonomy): LiveSessionBrief {
  return {
    ptySessionId: "child-session", agentSessionId: "conversation", agentKind: "claude",
    ptyInstanceId: "instance", ptyGeneration: 1, sourceRevision: 1, ptyInputRevision: 1,
    task: "work", latestInstruction: "continue", taskSourceEventIds: [],
    activityKind: "Bash", activityText: "Running tests", activitySourceEventId: "call",
    checkpoint: null, checkpointEvidenceEventIds: [], pendingInputKind: null, pendingPrompt: null,
    pendingOptions: [], promptEventId: null, promptHash: null, eventSeq: 1,
    operationalState: "running", telemetryHealth: "live", lastEventAt: NOW,
    lastSuccessfulReadAt: NOW, updatedAt: NOW, serviceEpoch: "epoch", briefRevision: 1, autonomy,
  };
}
function workspace(): Workspace {
  return { id: "ws", name: "Workspace", gridTemplateId: "1x1", status: "running", createdAt: NOW,
    panes: [{ id: "pane", agentId: "claude", sessionId: "parent-session", activeTabId: "parent",
      tabs: [
        { id: "parent", sessionId: "parent-session", agentId: "claude", type: "terminal", label: "Coordinator" },
        { id: "child", sessionId: "child-session", agentId: "codex", type: "terminal", delegatedByTabId: "parent", delegatedByAgentSessionId: "parent-conversation", delegatedAt: NOW, label: "Worker" },
      ] }] };
}
function input() {
  return { metadataBySession: {}, volatileMetadataBySession: {}, lastLogBySession: {},
    lastLogAtBySession: {}, attentionBySession: {}, seenAttentionByTab: new Map<string, string>(),
    doneMarkByTab: new Map<string, number>(), stallsBySession: {}, now: NOW, hasTerminalBuffer: () => true };
}
function card(autonomy: Autonomy, overrides: Partial<DashboardCardModel> = {}): DashboardCardModel {
  const ws = workspace(); ws.panes[0].tabs.find(tab => tab.id === "child")!.delegatedByTabId = undefined;
  const built = buildDashboardCards([ws], {
    ...input(), briefsBySession: { "child-session": brief(autonomy) },
  }).find(item => item.tab.id === "child")!;
  return { ...built, ...overrides };
}
function facts(item: DashboardCardModel, minutes = 45) {
  return buildAttentionFactCards([{ sessionId: item.tab.sessionId, label: item.label, brief: item.brief, noUpdateMinutes: minutes }]);
}

describe("self-driving dashboard acceptance", () => {
  it("T1 keeps an open Claude tool working after 12 quiet minutes and suppresses noUpdate facts", () => {
    const item = card({ ...active, openToolCount: 1 }, { noUpdateMinutes: 12 });
    expect(resolveDisplayState(item)).toBe("running");
    expect(facts(item, 12)).toEqual([]);
    expect(facts(item, 45)).toEqual([]);
    expect(dashboardActivity(item)).toBe("Running tests");
  });
  it("T2 keeps a seven-minute model response wait working after the last tool result", () => {
    const item = card(active, { noUpdateMinutes: 7 });
    expect(resolveDisplayState(item)).toBe("running");
    expect(dashboardActivity(item)).toBe(dashboardStrings.modelResponseWait);
    expect(dashboardStrings.modelResponseWait).toBe("AI の応答待ち");
  });
  it.each([0, 5, 60])("T3 reviews a completed turn immediately and after %i minutes, including already-viewed output", minutes => {
    const item = card(complete, { noUpdateMinutes: minutes, attentionCategory: null });
    expect(resolveDisplayState(item)).toBe("done");
    expect(groupCardsByAttentionSection([item]).needsReview).toEqual([item]);
  });
  it.each(["T4 Monitor", "T6 background command", "T8 ScheduleWakeup", "T9 async agent"])("%s stays working with armed background work", () => {
    const item = card({ ...complete, armedBackgroundCount: 1 }, { noUpdateMinutes: 45 });
    expect(resolveDisplayState(item)).toBe("running");
    expect(dashboardActivity(item)).toBe(dashboardStrings.backgroundWork(1));
    expect(dashboardStrings.backgroundWork(1)).toBe("仕掛けた作業 1件");
    expect(facts(item)).toEqual([]);
  });
  it("T5 resumes a notification turn then reviews its completion", () => {
    expect(resolveDisplayState(card(active))).toBe("running");
    expect(resolveDisplayState(card(complete))).toBe("done");
  });
  it.each(["T6 killed command", "T7 expired Monitor", "T8 expired wakeup", "T12 restarted process"])("%s is reviewable with no remaining background", () => {
    expect(resolveDisplayState(card(complete))).toBe("done");
  });
  it("T10 preserves question and permission priority over self-driving work", () => {
    const item = card({ ...active, armedBackgroundCount: 1 }, { operationalState: "needsHuman" });
    expect(resolveDisplayState(item)).toBe("needsHuman");
    expect(resolveComposerRoute({ ...item.brief!, operationalState: "needsHuman" }, true)).toEqual({ kind: "intervention" });
  });
  it("T11 preserves error and rate-limit priority over self-driving work", () => {
    expect(resolveDisplayState(card({ ...active, armedBackgroundCount: 1 }, { attentionCategory: "error" }))).toBe("error");
  });
  it("T13 keeps a thirty-minute open Codex sleep working", () => {
    const item = card({ ...active, openToolCount: 1 }, { noUpdateMinutes: 30, agentKind: "codex" });
    expect(resolveDisplayState(item)).toBe("running");
    expect(facts(item, 30)).toEqual([]);
    expect(resolveComposerRoute(item.brief, true)).toEqual({ kind: "paneSendText" });
  });
  it.each(["T14 Codex task_complete", "T15 Codex turn_aborted"])("%s is immediately reviewable", () => {
    expect(resolveDisplayState(card(complete, { agentKind: "codex" }))).toBe("done");
  });
  it("T16 defers a completed delegated seat while its coordinator is alive", () => {
    const items = buildDashboardCards([workspace()], { ...input(),
      briefsBySession: { "child-session": brief(complete) },
      volatileMetadataBySession: { "parent-session": { ptyAlive: true, liveAgentKind: "claude", liveAgentSessionId: "parent-conversation" } },
    });
    const item = items.find(item => item.tab.id === "child")!;
    expect(resolveDisplayState(item)).toBe("delegated");
    expect(groupCardsByAttentionSection([item]).other).toEqual([item]);
    expect(needsHumanCards([item])).toEqual([]);
    expect(dashboardActivity(item)).toBe(dashboardStrings.delegatedTo("Coordinator"));
  });
  it.each([{ ptyAlive: false, liveAgentKind: "claude" }, { ptyAlive: true, liveAgentKind: null }])("T17 reviews a worker after its parent process dies: %j", parent => {
    const items = buildDashboardCards([workspace()], { ...input(),
      briefsBySession: { "child-session": brief(complete) }, volatileMetadataBySession: { "parent-session": parent },
    });
    expect(resolveDisplayState(items.find(item => item.tab.id === "child")!)).toBe("done");
  });
  it("T17 reviews a worker after its parent pane closes", () => {
    const ws = workspace(); ws.panes[0].tabs = ws.panes[0].tabs.filter(tab => tab.id === "child");
    const item = buildDashboardCards([ws], { ...input(), briefsBySession: { "child-session": brief(complete) },
      delegationParents: { parent: { tabId: "parent", label: "Coordinator", alive: false, state: "ended", checkedAt: NOW } },
    })[0];
    expect(resolveDisplayState(item)).toBe("done");
  });
  it("T18 keeps questions and errors urgent on delegated seats", () => {
    const parent = { tabId: "parent", label: "Coordinator", alive: true };
    expect(resolveDisplayState(card(complete, { delegationParent: parent, operationalState: "needsHuman" }))).toBe("needsHuman");
    expect(resolveDisplayState(card(complete, { delegationParent: parent, attentionCategory: "error" }))).toBe("error");
  });
  it("T21 retains manual done, queued input and process-exit priority", () => {
    expect(resolveDisplayState(card(active, { manualDoneAt: NOW }))).toBe("acknowledged");
    expect(resolveDisplayState(card(active, { stall: { sessionId: "child-session", reason: "queued_input", since: NOW } }))).toBe("noUpdate");
    expect(resolveDisplayState(card(active, { stall: { sessionId: "child-session", reason: "pty_dead", since: NOW } }))).toBe("stopped");
    expect(resolveDisplayState(card(active, { telemetryHealth: "ended" }))).toBe("stopped");
  });
  it("T21 keeps manual completion through read-only polls and clears it on the next turn", () => {
    const markedAt = NOW + 1_000;
    const polled = { ...brief(complete), lastSuccessfulReadAt: NOW + 60_000, updatedAt: NOW + 60_000 };
    const inputMarked = { ...input(), now: NOW + 60_000, doneMarkByTab: new Map([["child", markedAt]]) };
    const acknowledged = buildDashboardCards([workspace()], { ...inputMarked, briefsBySession: { "child-session": polled } }).find(item => item.tab.id === "child")!;
    expect(resolveDisplayState(acknowledged)).toBe("acknowledged");
    const nextTurn = { ...brief(active), lastEventAt: NOW + 61_000, lastSuccessfulReadAt: NOW + 61_000, updatedAt: NOW + 61_000 };
    const resumed = buildDashboardCards([workspace()], { ...inputMarked, briefsBySession: { "child-session": nextTurn } }).find(item => item.tab.id === "child")!;
    expect(resumed.manualDoneAt).toBeUndefined();
    expect(resolveDisplayState(resumed)).toBe("running");
  });
  it("T22 aligns four section counts, minimap colors, next-attention navigation and filters", () => {
    const states = [
      card(active, { tab: { ...card(active).tab, id: "working" } }),
      card(complete, { tab: { ...card(complete).tab, id: "review" } }),
      card(active, { operationalState: "needsHuman", tab: { ...card(active).tab, id: "answer" } }),
      card(complete, { delegationParent: { tabId: "parent", label: "Coordinator", alive: true, agentSessionId: "parent-conversation" }, tab: { ...card(complete).tab, id: "other", delegatedByTabId: "parent", delegatedByAgentSessionId: "parent-conversation" } }),
    ];
    const sections = groupCardsByAttentionSection(states);
    expect(Object.values(sections).map(items => items.length)).toEqual([1, 1, 1, 1]);
    expect(needsHumanCards(states).map(item => item.tab.id)).toEqual(["answer"]);
    for (const item of states) {
      expect(matchesDashboardStateFilter(item, "needsHuman")).toBe(item.tab.id === "answer");
    }
    const partition = partitionDashboardCards(states);
    expect(new Set([...partition.needsHuman, ...partition.active, ...partition.deferred]).size).toBe(4);
    expect(displayStateColor(resolveDisplayState(states[0]))).toBe("var(--status-working)");
    expect(displayStateColor(resolveDisplayState(states[1]))).toBe("var(--status-done)");
    const ws = workspace(); ws.panes[0].tabs = states.map(item => item.tab);
    const map = new Map(states.map(item => [item.tab.id, resolveDisplayState(item)]));
    expect(minimapWorkspaceStrip(buildMinimapModel(ws), map).ticks.map(item => item.activity)).toEqual(["working", "idle", "waiting", "idle"]);
  });
  it("keeps unknown transcript state out of review and preserves unlinked no-output facts", () => {
    const item = card({ ...active, turnState: "unknown" }, { noUpdateMinutes: 90 });
    expect(resolveDisplayState(item)).toBe("running");
    expect(dashboardActivity(item)).toBe(dashboardStrings.turnStateUnknown);
    expect(facts(item, 90)).toEqual([]);
    const fallback = card(active, { telemetryHealth: "unlinked", brief: { ...brief(active), telemetryHealth: "unlinked" }, lastActivityAt: NOW - 45 * 60_000, group: "idle" });
    expect(resolveDisplayState(fallback)).toBe("noUpdate");
    expect(facts(fallback)).toHaveLength(1);
  });
  it("keeps never-instructed live transcripts idle and open tools ahead of completion", () => {
    expect(resolveDisplayState(card({ ...complete, turnState: "idle" }))).toBe("idle");
    expect(resolveDisplayState(card({ ...complete, openToolCount: 1 }))).toBe("running");
  });
});
