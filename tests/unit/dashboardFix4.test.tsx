// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { buildDashboardCards, isSelfDriving, resolveDisplayState, UNKNOWN_AUTONOMY_TTL_MS } from "../../src/components/dashboard/dashboardModel";
import { groupCardsByAttentionSection } from "../../src/components/dashboard/dashboardAttentionOrder";
import { buildAttentionFactCards } from "../../src/components/dashboard/attentionModel";
import { DashboardCardRow } from "../../src/components/dashboard/DashboardCardRow";
import type { LiveSessionBrief } from "../../src/lib/livebrief";
import type { Workspace } from "../../src/types";
import clockCases from "../fixtures/livebrief_autonomy/autonomy-clock-cases.json";
import notificationCases from "../fixtures/livebrief_autonomy/notification-delivery-cases.json";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const BASE = 1_800_000_000_000;
function brief(overrides: Partial<LiveSessionBrief> = {}): LiveSessionBrief {
  return {
    ptySessionId:"s", agentSessionId:"conversation", agentKind:"claude", ptyInstanceId:"instance",
    ptyGeneration:1, sourceRevision:1, ptyInputRevision:1, task:null, latestInstruction:null, taskSourceEventIds:[],
    activityKind:null, activityText:"work", activitySourceEventId:null, checkpoint:null, checkpointEvidenceEventIds:[],
    pendingInputKind:null, pendingPrompt:null, pendingOptions:[], promptEventId:null, promptHash:null, eventSeq:1,
    operationalState:"ready", telemetryHealth:"live", lastEventAt:BASE, lastSuccessfulReadAt:BASE, updatedAt:BASE,
    serviceEpoch:"epoch", briefRevision:1,
    autonomy:{turnState:"complete", openToolCount:0, armedBackgroundCount:0, backgroundState:"known", pendingNotificationCount:0},
    ...overrides,
  };
}
const workspace: Workspace = {
  id:"ws", name:"Workspace", gridTemplateId:"1x1", status:"running", createdAt:BASE,
  panes:[{id:"pane", sessionId:"s", agentId:"claude", activeTabId:"tab",
    tabs:[{id:"tab", sessionId:"s", agentId:"claude", type:"terminal", label:"Worker"}]}],
};
function card(value: LiveSessionBrief, now: number) {
  return buildDashboardCards([workspace], {
    metadataBySession:{}, volatileMetadataBySession:{}, lastLogBySession:{}, lastLogAtBySession:{},
    attentionBySession:{}, seenAttentionByTab:new Map(), doneMarkByTab:new Map(), stallsBySession:{},
    briefsBySession:{s:value}, now, hasTerminalBuffer:()=>true,
  })[0];
}
describe("FIX-4 clock and queue display reproductions", () => {
  it.each(clockCases)("J2 H2 F4 Rust's corrected clock reaches the screen deadline: $name", scenario => {
    for (const step of scenario.steps) {
      const value = brief({
        lastEventAt:step.expectedLastEventAtOffsetMs === null ? null : BASE + step.expectedLastEventAtOffsetMs,
        autonomy:{...brief().autonomy!, turnState:step.expectedTurnState as "complete" | "active" | "unknown", backgroundState:"unknown"},
      });
      // The Rust fixture test produces these exact fields from every record
      // and cached poll. Display classification has no clock state or mutation.
      const now = BASE + step.nowOffsetMs;
      const item = card(value, now);
      expect(resolveDisplayState(item)).toBe(step.display);
      expect(groupCardsByAttentionSection([item]).needsReview).toEqual(["done","noUpdate"].includes(step.display) ? [item] : []);
      if (value.lastEventAt === null) expect(isSelfDriving(value, now)).toBe(false);
    }
  });
  it.each(notificationCases.filter(scenario => scenario.name.startsWith("J3 ")))("J3 H4 G6 F6 shared overlap finishes with no pending notice: $name", scenario => {
    for (const step of scenario.steps) {
      const item = card(brief({autonomy:step.expected as NonNullable<LiveSessionBrief["autonomy"]>}), BASE);
      expect(resolveDisplayState(item)).toBe(step.display);
      expect(groupCardsByAttentionSection([item]).needsReview).toEqual(step.display === "done" ? [item] : []);
    }
    // ANSWER-FIX5-1 authorizes the anonymous case only; identified J3
    // and the reverse handoff still finish with zero and done.
    const ambiguous = scenario.name === "J3 dequeue A before enqueue B then user A and late-ID remove B";
    expect(scenario.steps.at(-1)!.expected.pendingNotificationCount).toBe(ambiguous ? 1 : 0);
    expect(scenario.steps.at(-1)!.display).toBe(ambiguous ? "running" : "done");
  });
  it("J3 a mismatched pending count on a completed turn expires exactly at thirty minutes", () => {
    const value = brief({autonomy:{...brief().autonomy!, pendingNotificationCount:1}});
    const early = card(value, BASE + 29 * 60_000 + 59_000);
    const ended = card(value, BASE + UNKNOWN_AUTONOMY_TTL_MS);
    expect(resolveDisplayState(early)).toBe("running");
    expect(resolveDisplayState(ended)).toBe("done");
    expect(groupCardsByAttentionSection([early]).needsReview).toEqual([]);
    expect(groupCardsByAttentionSection([ended]).needsReview).toEqual([ended]);
    expect(buildAttentionFactCards([{sessionId:"s", label:"Worker", brief:value, noUpdateMinutes:30, now:ended.now}])).toEqual([]);
    const node = document.createElement("div");
    document.body.append(node);
    const root = createRoot(node);
    act(() => root.render(<DashboardCardRow card={early} selected={false} open={false} now={early.now!} hideWorkspaceBadge={false} onSelect={() => {}} onJump={() => {}} />));
    expect(node.textContent).toContain("作業中");
    act(() => root.render(<DashboardCardRow card={ended} selected={false} open={false} now={ended.now!} hideWorkspaceBadge={false} onSelect={() => {}} onJump={() => {}} />));
    expect(node.textContent).toContain("要確認");
    expect(node.querySelector('[aria-label="要確認 · 完了"]')).not.toBeNull();
    act(() => root.unmount());
    node.remove();
  });
  it.each(["active", "unknown", "idle"] as const)("J3 a %s turn's pending notice is not expired while it is not complete", turnState => {
    const value = brief({autonomy:{...brief().autonomy!, turnState, pendingNotificationCount:1}});
    expect(resolveDisplayState(card(value, BASE + 24 * 60 * 60_000))).toBe("running");
  });
  it.each(["openToolCount", "armedBackgroundCount"] as const)("J3 known %s survives pending safety-net expiry after twenty-four hours", field => {
    const value = brief({autonomy:{...brief().autonomy!, pendingNotificationCount:1, [field]:1}});
    expect(resolveDisplayState(card(value, BASE + 24 * 60 * 60_000))).toBe("running");
  });
  it("J3 a new event resets the completed pending-notice window", () => {
    const old = brief({autonomy:{...brief().autonomy!, pendingNotificationCount:1}});
    expect(resolveDisplayState(card(old, BASE + UNKNOWN_AUTONOMY_TTL_MS))).toBe("done");
    const next = {...old, lastEventAt:BASE + UNKNOWN_AUTONOMY_TTL_MS};
    expect(resolveDisplayState(card(next, next.lastEventAt + 29 * 60_000 + 59_000))).toBe("running");
    expect(resolveDisplayState(card(next, next.lastEventAt + UNKNOWN_AUTONOMY_TTL_MS))).toBe("done");
  });
  it("J2 J3 share one deadline and leave a frozen brief unchanged", () => {
    const value = brief({autonomy:Object.freeze({...brief().autonomy!, backgroundState:"unknown", pendingNotificationCount:1})});
    Object.freeze(value);
    expect(isSelfDriving(value, BASE + UNKNOWN_AUTONOMY_TTL_MS - 1)).toBe(true);
    expect(isSelfDriving(value, BASE + UNKNOWN_AUTONOMY_TTL_MS)).toBe(false);
    expect(value.lastEventAt).toBe(BASE);
  });
});
