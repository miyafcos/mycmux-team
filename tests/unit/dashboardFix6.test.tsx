// @vitest-environment jsdom
// Synthetic scenes use the supplied skeleton keys and the mothership table.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { buildDashboardCards, resolveDisplayState } from "../../src/components/dashboard/dashboardModel";
import { groupCardsByAttentionSection } from "../../src/components/dashboard/dashboardAttentionOrder";
import { buildAttentionFactCards } from "../../src/components/dashboard/attentionModel";
import { DashboardCardRow } from "../../src/components/dashboard/DashboardCardRow";
import type { LiveSessionBrief } from "../../src/lib/livebrief";
import type { Workspace } from "../../src/types";
import notificationCases from "../fixtures/livebrief_autonomy/notification-provisional-id-cases.json";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const BASE = 1_800_000_000_000;
type Scenario = typeof notificationCases[number];
function brief(step: Scenario["steps"][number]): LiveSessionBrief {
  return {
    ptySessionId:"s", agentSessionId:"conversation", agentKind:"claude", ptyInstanceId:"instance",
    ptyGeneration:1, sourceRevision:1, ptyInputRevision:1, task:null, latestInstruction:null, taskSourceEventIds:[],
    activityKind:null, activityText:"work", activitySourceEventId:null, checkpoint:null, checkpointEvidenceEventIds:[],
    pendingInputKind:null, pendingPrompt:null, pendingOptions:[], promptEventId:null, promptHash:null, eventSeq:1,
    operationalState:"ready", telemetryHealth:"live", lastEventAt:BASE + step.expectedLastEventAtOffsetMs!,
    lastSuccessfulReadAt:BASE, updatedAt:BASE, serviceEpoch:"epoch", briefRevision:1,
    // The Rust producer asserts these same fields and lastEventAt for every
    // native input. The consumer never reconstructs ownership from the name.
    autonomy:step.expected as NonNullable<LiveSessionBrief["autonomy"]>,
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

function checkFinalPolls(scenario: Scenario) {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  try {
    for (const poll of scenario.polls) {
      const value = brief(scenario.steps[poll.atStep]);
      const anchor = value.lastEventAt!;
      const pending = value.autonomy!.pendingNotificationCount;
      expect(value.autonomy).toMatchObject({turnState:"complete", openToolCount:0, armedBackgroundCount:0});
      Object.freeze(value.autonomy);
      Object.freeze(value);
      const now = anchor + poll.elapsedMs;
      const item = card(value, now);
      expect(resolveDisplayState(item)).toBe(poll.display);
      expect(groupCardsByAttentionSection([item]).needsReview).toEqual(poll.display === "done" ? [item] : []);
      expect(buildAttentionFactCards([{sessionId:"s", label:"Worker", brief:value, noUpdateMinutes:Math.floor(poll.elapsedMs / 60_000), now}])).toEqual([]);
      act(() => root.render(<DashboardCardRow card={item} selected={false} open={false} now={now} hideWorkspaceBadge={false} onSelect={() => {}} onJump={() => {}} />));
      expect(node.textContent).toContain(poll.display === "done" ? "返答終了" : "作業中");
      expect(node.querySelector('[aria-label="返答終了 · 要確認"]') !== null).toBe(poll.display === "done");
      expect(value.lastEventAt).toBe(anchor);
      expect(value.autonomy!.pendingNotificationCount).toBe(pending);
    }
  } finally {
    act(() => root.unmount());
    node.remove();
  }
}

describe("FIX-6 provisional remove IDs", () => {
  it.each(notificationCases)("L1 producer outputs agree with immediate model and section state: $name", scenario => {
    for (const step of scenario.steps) {
      const value = brief(step);
      const item = card(value, value.lastEventAt! + 1000);
      expect(resolveDisplayState(item)).toBe(step.display);
      expect(groupCardsByAttentionSection([item]).needsReview).toEqual(step.display === "done" ? [item] : []);
    }
  });
  it.each(notificationCases)("L1 final polls preserve immediate done or the anonymous 30-minute limit in model, section and row: $name", scenario => {
    expect(scenario.polls.map(poll => poll.elapsedMs)).toEqual([1000,1_799_000,1_800_000]);
    checkFinalPolls(scenario);
  });
  it("L1 the four authorized controls distinguish a completed B handoff from no B delivery", () => {
    expect(notificationCases).toHaveLength(4);
    for (const scenario of notificationCases.slice(0,3)) {
      expect(scenario.steps.map(step => step.expected.pendingNotificationCount)).toEqual([1,1,2,1,1,1,0,0]);
      expect(scenario.polls.map(poll => poll.display)).toEqual(["done","done","done"]);
    }
    const anonymous = notificationCases[3];
    expect(anonymous.steps.map(step => step.expected.pendingNotificationCount)).toEqual([1,1,2,1,1,1]);
    expect(anonymous.polls.map(poll => poll.display)).toEqual(["running","running","done"]);
    expect(anonymous.answerCorrection).toContain("ANSWER-FIX6-1");
  });
});
