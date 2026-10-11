// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import {
  buildDashboardCards, resolveDisplayState, needsHumanCards, matchesDashboardStateFilter,
  partitionDashboardCards, applyDashboardFilters, type DashboardCardModel,
} from "../../src/components/dashboard/dashboardModel";
import { groupCardsByAttentionSection } from "../../src/components/dashboard/dashboardAttentionOrder";
import { buildAttentionFactCards } from "../../src/components/dashboard/attentionModel";
import { DashboardCardRow } from "../../src/components/dashboard/DashboardCardRow";
import type { LiveSessionBrief } from "../../src/lib/livebrief";
import type { Workspace } from "../../src/types";
import notificationCases from "../fixtures/livebrief_autonomy/notification-delivery-cases.json";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const NOW = 1_800_000_000_000;
function brief(overrides: Partial<LiveSessionBrief> = {}): LiveSessionBrief {
  return { ptySessionId: "s", agentSessionId: "conversation", agentKind: "claude", ptyInstanceId: "instance",
    ptyGeneration: 1, sourceRevision: 1, ptyInputRevision: 1, task: null, latestInstruction: null, taskSourceEventIds: [],
    activityKind: null, activityText: "work", activitySourceEventId: null, checkpoint: null, checkpointEvidenceEventIds: [],
    pendingInputKind: null, pendingPrompt: null, pendingOptions: [], promptEventId: null, promptHash: null, eventSeq: 1,
    operationalState: "running", telemetryHealth: "live", lastEventAt: NOW, lastSuccessfulReadAt: NOW, updatedAt: NOW,
    serviceEpoch: "epoch", briefRevision: 1,
    autonomy: { turnState: "complete", openToolCount: 0, armedBackgroundCount: 0, backgroundState: "known",
      pendingNotificationCount: 0, turnStartedAt: NOW - 10_000 }, ...overrides };
}
function workspace(): Workspace {
  return { id: "ws", name: "Workspace", gridTemplateId: "1x1", status: "running", createdAt: NOW,
    panes: [{ id: "pane", sessionId: "s", agentId: "claude", activeTabId: "tab",
      tabs: [{ id: "tab", sessionId: "s", agentId: "claude", type: "terminal", label: "Worker" }] }] };
}
function input() {
  return { metadataBySession: {}, volatileMetadataBySession: {}, lastLogBySession: {}, lastLogAtBySession: {},
    attentionBySession: {}, seenAttentionByTab: new Map<string, string>(), doneMarkByTab: new Map<string, number>(),
    stallsBySession: {}, now: NOW, hasTerminalBuffer: () => true };
}
function card(overrides: Partial<DashboardCardModel> = {}): DashboardCardModel {
  return { ...buildDashboardCards([workspace()], { ...input(), briefsBySession: { s: brief() } })[0], ...overrides };
}
function facts(item: DashboardCardModel) {
  return buildAttentionFactCards([{ sessionId: item.tab.sessionId, label: item.label, brief: item.brief, noUpdateMinutes: 45, now: item.now }]);
}
describe("FIX-1 dashboard reproductions", () => {
  it("F4 an omitted background start cannot be proved absent by a visible end_turn", () => {
    const item = card({ brief: brief({ autonomy: { ...brief().autonomy!, backgroundState: "unknown" } }) });
    expect(resolveDisplayState(item)).toBe("running"); expect(facts(item)).toEqual([]);
  });
  it("H2 F4 background uncertainty expires at thirty minutes from the last event, regardless of fresh reads", () => {
    const uncertain = brief({ autonomy: { ...brief().autonomy!, backgroundState: "unknown" }, updatedAt: NOW + 24 * 60 * 60_000, lastSuccessfulReadAt: NOW + 24 * 60 * 60_000 });
    const early = card({ brief: uncertain, now: NOW + 29 * 60_000 + 59_000 });
    expect(resolveDisplayState(early)).toBe("running");
    expect(groupCardsByAttentionSection([early]).needsReview).toEqual([]);
    const ended = card({ brief: uncertain, now: NOW + 30 * 60_000 });
    expect(resolveDisplayState(ended)).toBe("done");
    expect(groupCardsByAttentionSection([ended]).needsReview).toEqual([ended]);
  });
  it("H2 unknown turns fall back to the original no-boundary rule at thirty minutes", () => {
    const uncertain = brief({ autonomy: { ...brief().autonomy!, turnState: "unknown" } });
    const early = card({ brief: uncertain, now: NOW + 29 * 60_000 + 59_000, noUpdateMinutes: 29 });
    expect(resolveDisplayState(early)).toBe("running");
    expect(facts(early)).toEqual([]);
    const expired = card({ brief: uncertain, now: NOW + 30 * 60_000, noUpdateMinutes: 30 });
    const baseline = { ...expired, brief: { ...uncertain, autonomy: undefined } };
    expect(resolveDisplayState(expired)).toBe(resolveDisplayState(baseline));
    expect(resolveDisplayState(expired)).toBe("noUpdate");
    expect(facts(expired)).toEqual(facts(baseline));
    expect(facts(expired)[0].kind).toBe("noUpdate");
  });
  it.each(["openToolCount", "armedBackgroundCount", "pendingNotificationCount"] as const)("H2 does not expire known %s after twenty-four hours", field => {
    const known = brief({ autonomy: { ...brief().autonomy!, turnState: "unknown", backgroundState: "unknown", [field]: 1 } });
    const item = card({ brief: known, now: NOW + 24 * 60 * 60_000, noUpdateMinutes: 24 * 60 });
    expect(resolveDisplayState(item)).toBe("running");
    expect(groupCardsByAttentionSection([item]).needsReview).toEqual([]);
    expect(facts(item)).toEqual([]);
  });
  it.each(notificationCases)("H4 F6 shared Rust delivery output reaches screen done: $name", scenario => {
    for (const step of scenario.steps) {
      // Rust's producer test verifies these same serialized fields after each
      // native record. Check the display consumer and section for every output.
      const item = card({ brief: brief({ autonomy: step.expected as NonNullable<LiveSessionBrief["autonomy"]> }) });
      expect(resolveDisplayState(item)).toBe(step.display);
      expect(groupCardsByAttentionSection([item]).needsReview).toEqual(step.display === "done" ? [item] : []);
    }
    const final = scenario.steps.at(-1)!;
    // ANSWER-FIX5-1 changes only this anonymous case; the other fixtures
    // retain their original zero-pending / done expectations.
    const ambiguous = scenario.name === "J3 dequeue A before enqueue B then user A and late-ID remove B";
    expect(final.expected.pendingNotificationCount).toBe(ambiguous ? 1 : 0);
    expect(final.display).toBe(ambiguous ? "running" : "done");
  });
  it("F5 manual completion survives late turn_duration and clears only for a new turn", () => {
    const markedAt = NOW + 1000;
    const delayed = brief({ lastEventAt: NOW + 17_000, lastSuccessfulReadAt: NOW + 17_000, updatedAt: NOW + 17_000 });
    const common = { ...input(), now: NOW + 17_000, doneMarkByTab: new Map([["tab", markedAt]]),
      lastLogAtBySession: { s: NOW + 17_000 }, metadataBySession: { s: { agentStatusAt: NOW + 17_000 } } };
    const done = buildDashboardCards([workspace()], { ...common, briefsBySession: { s: delayed } })[0];
    expect(resolveDisplayState(done)).toBe("acknowledged");
    const next = brief({ autonomy: { ...brief().autonomy!, turnState: "active", turnStartedAt: NOW + 18_000 }, lastEventAt: NOW + 18_000 });
    expect(resolveDisplayState(buildDashboardCards([workspace()], { ...common, briefsBySession: { s: next } })[0])).toBe("running");
  });
  it("F6 queued terminal notification stays working through the gap before model delivery", () => {
    const item = card({ brief: brief({ autonomy: { ...brief().autonomy!, pendingNotificationCount: 1 } }) });
    expect(resolveDisplayState(item)).toBe("running");
    expect(groupCardsByAttentionSection([item]).needsReview).toEqual([]); expect(facts(item)).toEqual([]);
  });
  it.each(["ended", "pty_dead", "ptyAlive"] as const)("F12 a %s child with a live parent and done attention is stopped", cause => {
    const health = cause === "ended" ? "ended" : "unlinked";
    const item = card({ telemetryHealth: health, attentionCategory: "done",
      tab: { ...card().tab, delegatedByTabId: "parent" }, delegationParent: { tabId: "parent", label: "Coordinator", alive: true },
      ...(cause === "ptyAlive" ? { volatileMetadata: { ptyAlive: false } } : cause === "pty_dead" ? { stall: { sessionId: "s", reason: "pty_dead", since: NOW } } : {}) });
    expect(resolveDisplayState(item)).toBe("stopped");
    expect(resolveDisplayState({ ...item, attentionCategory: "waiting" })).toBe("needsHuman");
    expect(resolveDisplayState({ ...item, attentionCategory: "error" })).toBe("error");
  });
  it.each(["live", "unlinked"] as const)("F13 %s navigation and urgency filters include only questions and errors", health => {
    const base = card({ telemetryHealth: health });
    const items = [
      { ...base, tab: { ...base.tab, id: "answer" }, operationalState: "needsHuman", attentionCategory: "waiting" },
      { ...base, tab: { ...base.tab, id: "error" }, attentionCategory: "error" },
      { ...base, tab: { ...base.tab, id: "done" }, attentionCategory: "done" },
      { ...base, tab: { ...base.tab, id: "noUpdate" }, brief: undefined, noUpdateMinutes: 10, group: "idle", lastActivityAt: NOW - 600_000 },
    ] as DashboardCardModel[];
    expect(needsHumanCards(items).map(item => item.tab.id)).toEqual(["answer", "error"]);
    expect(partitionDashboardCards(items).needsHuman.map(item => item.tab.id)).toEqual(["answer", "error"]);
    for (const item of items) expect(matchesDashboardStateFilter(item, "needsHuman")).toBe(["answer", "error"].includes(item.tab.id));
    expect(applyDashboardFilters(items, { query: "", workspaceId: null, needsHumanOnly: true, agentKind: null }).map(item => item.tab.id)).toEqual(["answer", "error"]);
    expect(groupCardsByAttentionSection(items).needsReview.map(item => item.tab.id)).toEqual(["error", "done", "noUpdate"]);
  });
  it.each(["grok", "claude", "codex"])("F15 %s without autonomy retains baseline quiet/done behavior", kind => {
    const legacy = brief({ agentKind: kind, autonomy: undefined });
    expect(resolveDisplayState(card({ brief: legacy, noUpdateMinutes: 4 }))).toBe("running");
    const quiet = card({ brief: legacy, noUpdateMinutes: 5 });
    expect(resolveDisplayState(quiet)).toBe("noUpdate"); expect(groupCardsByAttentionSection([quiet]).needsReview).toEqual([quiet]);
    expect(facts(quiet)).toHaveLength(1);
    expect(resolveDisplayState(card({ brief: legacy, operationalState: "idle", attentionCategory: "done", noUpdateMinutes: 0 }))).toBe("done");
    expect(resolveDisplayState(card({ brief: legacy, attentionCategory: "done", noUpdateMinutes: 10 }))).toBe("noUpdate");
  });
  it("F15 renders legacy Grok no-output as review while an observed active turn remains working", async () => {
    const container = document.createElement("div"); const root = createRoot(container);
    try {
      const legacy = card({ brief: brief({ agentKind: "grok", autonomy: null }), noUpdateMinutes: 8 });
      await act(async () => root.render(<DashboardCardRow card={legacy} selected={false} open={false} now={NOW}
        hideWorkspaceBadge={false} onSelect={() => {}} onJump={() => {}} />));
      expect(container.textContent).toContain("要確認");
      const active = card({ brief: brief({ autonomy: { ...brief().autonomy!, turnState: "active" } }), noUpdateMinutes: 45 });
      await act(async () => root.render(<DashboardCardRow card={active} selected={false} open={false} now={NOW}
        hideWorkspaceBadge={false} onSelect={() => {}} onJump={() => {}} />));
      expect(container.textContent).toContain("作業中"); expect(container.textContent).not.toContain("要確認");
    } finally { await act(async () => root.unmount()); container.remove(); }
  });
});
