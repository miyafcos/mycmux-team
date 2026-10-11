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
import notificationCases from "../fixtures/livebrief_autonomy/notification-delivery-cases.json";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const BASE = 1_800_000_000_000;
const ANONYMOUS_J3 = "J3 dequeue A before enqueue B then user A and late-ID remove B";
const k1Cases = notificationCases.filter(scenario => scenario.name.startsWith("K1 "));
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
function checkUndeliveredPolls(scenario: Scenario) {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  try {
    for (const poll of scenario.undeliveredPolls!) {
      const value = brief(scenario.steps[poll.atStep]);
      const anchor = value.lastEventAt!;
      expect(value.autonomy).toMatchObject({turnState:"complete", openToolCount:0, armedBackgroundCount:0, pendingNotificationCount:1});
      Object.freeze(value.autonomy);
      Object.freeze(value);
      const now = anchor + poll.elapsedMs;
      const item = card(value, now);
      expect(resolveDisplayState(item)).toBe(poll.display);
      expect(groupCardsByAttentionSection([item]).needsReview).toEqual(poll.display === "done" ? [item] : []);
      expect(buildAttentionFactCards([{sessionId:"s", label:"Worker", brief:value, noUpdateMinutes:Math.floor(poll.elapsedMs / 60_000), now}])).toEqual([]);
      act(() => root.render(<DashboardCardRow card={item} selected={false} open={false} now={now} hideWorkspaceBadge={false} onSelect={() => {}} onJump={() => {}} />));
      expect(node.textContent).toContain(poll.display === "done" ? "要確認" : "作業中");
      expect(node.querySelector('[aria-label="要確認 · 完了"]') !== null).toBe(poll.display === "done");
      expect(value.lastEventAt).toBe(anchor);
      expect(value.autonomy!.pendingNotificationCount).toBe(1);
    }
  } finally {
    act(() => root.unmount());
    node.remove();
  }
}

describe("FIX-5 anonymous notification duplicates", () => {
  it.each(k1Cases)("K1 preserves possible B across A's two routes, then settles later B: $name", scenario => {
    expect(k1Cases).toHaveLength(4);
    expect(scenario.steps.map(step => step.expected.pendingNotificationCount)).toEqual([1,1,2,1,1,1,0,0]);
    for (const step of scenario.steps) {
      const value = brief(step);
      const item = card(value, value.lastEventAt! + 1000);
      expect(resolveDisplayState(item)).toBe(step.display);
      expect(groupCardsByAttentionSection([item]).needsReview).toEqual(step.display === "done" ? [item] : []);
    }
    const ended = brief(scenario.steps.at(-1)!);
    expect(ended.autonomy).toMatchObject({turnState:"complete", pendingNotificationCount:0});
    expect(resolveDisplayState(card(ended, ended.lastEventAt! + 1000))).toBe("done");
  });
  it.each(k1Cases)("K1 undelivered B stays working at 1s / 29:59, expires at 30:00 in model, section and row: $name", scenario => {
    expect(scenario.undeliveredPolls!.map(poll => poll.elapsedMs)).toEqual([1000,1_799_000,1_800_000]);
    expect(scenario.undeliveredPolls!.map(poll => poll.display)).toEqual(["running","running","done"]);
    checkUndeliveredPolls(scenario);
  });
  it("K1 the authorized anonymous J3 correction keeps its name, pending trace and bounded completion", () => {
    const scenario = notificationCases.find(scenario => scenario.name === ANONYMOUS_J3)!;
    expect(scenario.expectationCorrection).toContain("indistinguishable");
    expect(scenario.steps.map(step => step.expected.pendingNotificationCount)).toEqual([1,1,2,1,1,2,2,1,1]);
    expect(scenario.steps.at(-1)!.display).toBe("running");
    checkUndeliveredPolls(scenario);
  });
});
