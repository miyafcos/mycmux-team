// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ipc from "../../src/lib/ipc";
import { useDelegationParents } from "../../src/components/dashboard/useDelegationParents";
import {
  delegationParentsFromFragments, DELEGATION_PARENT_TTL_MS, DELEGATION_QUERY_TIMEOUT_MS, type DelegationParent,
} from "../../src/components/dashboard/delegationModel";
import { buildDashboardCards, resolveDisplayState } from "../../src/components/dashboard/dashboardModel";
import { groupCardsByAttentionSection } from "../../src/components/dashboard/dashboardAttentionOrder";
import { stateLabels } from "../../src/components/dashboard/stateLabels";
import type { LiveSessionBrief } from "../../src/lib/livebrief";
import type { Workspace } from "../../src/types";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";

const NOW = 1_800_000_000_000;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
function workspaces(localParent = false, childAge = 0): Workspace[] {
  return [{ id: "child-ws", name: "Workspace", gridTemplateId: "1x1", status: "running", createdAt: NOW,
    panes: [{ id: "pane", sessionId: "child-session", agentId: "codex", activeTabId: "child", tabs: [
      { id: "child", sessionId: "child-session", agentId: "codex", type: "terminal", delegatedByTabId: "parent", delegatedByAgentSessionId: "parent-conversation", delegatedAt: NOW - childAge },
      ...(localParent ? [{ id: "parent", sessionId: "new-session", agentId: "claude", type: "terminal" as const, label: "Coordinator" }] : []),
    ] }] }];
}
function fragment(session = "new-session", label = "Coordinator", pending = false): ipc.WindowFragment {
  return { window_label: "peer", pending, workspaces: [{ id: "parent-ws", name: "Parent", panes: [
    { pane_id: "parent-pane", agent_id: "claude", label: null, tabs: [{ tab_id: "parent", session_id: session, agent_id: "claude", type: "terminal", label }] },
  ] }] };
}
function child(parents: Record<string, DelegationParent>, local = false, childAge = 0) {
  const brief: LiveSessionBrief = {
    ptySessionId: "child-session", agentSessionId: "conversation", agentKind: "codex", ptyInstanceId: "instance", ptyGeneration: 1,
    sourceRevision: 1, ptyInputRevision: 1, task: null, latestInstruction: null, taskSourceEventIds: [], activityKind: null,
    activityText: null, activitySourceEventId: null, checkpoint: null, checkpointEvidenceEventIds: [],
    pendingInputKind: null, pendingPrompt: null, pendingOptions: [], promptEventId: null, promptHash: null, eventSeq: 1,
    operationalState: "running", telemetryHealth: "live", lastEventAt: NOW, lastSuccessfulReadAt: NOW, updatedAt: NOW, serviceEpoch: "epoch", briefRevision: 1,
    autonomy: { turnState: "complete", openToolCount: 0, armedBackgroundCount: 0 },
  };
  return buildDashboardCards(workspaces(local, childAge), { metadataBySession: {}, volatileMetadataBySession: {}, lastLogBySession: {},
    lastLogAtBySession: {}, attentionBySession: {}, seenAttentionByTab: new Map(), doneMarkByTab: new Map(),
    stallsBySession: {}, now: Date.now(), briefsBySession: { "child-session": brief }, delegationParents: parents,
    hasTerminalBuffer: () => true }).find(card => card.tab.id === "child")!;
}
let root: Root, container: HTMLDivElement, parents: Record<string, DelegationParent>;
const renderedStates: string[] = [];
function Probe({ local = false, childAge = 0 }: { local?: boolean; childAge?: number }) {
  parents = useDelegationParents(workspaces(local, childAge));
  const card = child(parents, local, childAge);
  renderedStates.push(resolveDisplayState(card));
  return <div>{stateLabels(resolveDisplayState(card)).primary}</div>;
}
async function mount(local = false, childAge = 0) { await act(async () => { root.render(<Probe local={local} childAge={childAge} />); }); }
async function tick(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW); parents = {}; renderedStates.length = 0;
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {} });
  container = document.createElement("div"); root = createRoot(container);
  vi.spyOn(ipc, "getWindowFragments").mockResolvedValue([fragment()]);
  vi.spyOn(ipc, "getPtyMetadataSnapshot").mockResolvedValue({ "new-session": { live_agent_kind: "claude", process_name: "claude", agent_session_id: "parent-conversation", agent_session_trusted: true, agent_started_at: NOW - 1000 } } as ipc.PtyMetadataSnapshot);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.restoreAllMocks();
});
describe("FIX-1 parent observations", () => {
  it("F8 first observation is unknown and local adoption keeps the previous confirmed peer alive", async () => {
    expect(resolveDisplayState(child({}, true))).toBe("delegationUnknown");
    await mount(); expect(resolveDisplayState(child(parents, true))).toBe("delegated");
    await mount(true); expect(container.textContent).toBe("委譲元の確認待ち");
    vi.mocked(ipc.getPtyMetadataSnapshot).mockResolvedValue({ "new-session": { live_agent_kind: null, process_name: null } } as ipc.PtyMetadataSnapshot);
    await tick(15_000);
    expect(resolveDisplayState(child(parents, true))).toBe("delegationUnknown");
    await tick(DELEGATION_PARENT_TTL_MS);
    expect(resolveDisplayState(child(parents, true))).toBe("done");
  });
  it("F9 G3 240 failed polls bound the unknown episode and keep retrying after fallback", async () => {
    await mount(); expect(resolveDisplayState(child(parents))).toBe("delegated");
    vi.mocked(ipc.getWindowFragments).mockRejectedValue(new Error("read failed"));
    await tick(15_000);
    const unknown = child(parents);
    expect(resolveDisplayState(unknown)).toBe("delegationUnknown");
    expect(stateLabels(resolveDisplayState(unknown)).primary).toBe("委譲元の状態を確認中");
    expect(groupCardsByAttentionSection([unknown]).needsReview).toEqual([]);
    await tick(240 * 15_000 - 15_000);
    expect(ipc.getWindowFragments).toHaveBeenCalledTimes(241);
    expect(resolveDisplayState(child(parents))).toBe("done");
    vi.mocked(ipc.getWindowFragments).mockResolvedValue([]);
    vi.mocked(ipc.getPtyMetadataSnapshot).mockResolvedValue({});
    await tick(15_000); expect(resolveDisplayState(child(parents))).toBe("done");
  });
  it("F9 an absent owning pane cannot refresh cached liveness from an orphan process alone", async () => {
    await mount(); expect(resolveDisplayState(child(parents))).toBe("delegated");
    vi.mocked(ipc.getWindowFragments).mockResolvedValue([]);
    await tick(15_000); expect(resolveDisplayState(child(parents))).toBe("delegationUnknown");
    await tick(DELEGATION_PARENT_TTL_MS);
    expect(resolveDisplayState(child(parents))).toBe("done");
    vi.mocked(ipc.getPtyMetadataSnapshot).mockResolvedValue({});
    await tick(15_000); expect(resolveDisplayState(child(parents))).toBe("done");
  });
  it("F9 a hung RPC times out and releases the next poll instead of freezing permanently", async () => {
    vi.mocked(ipc.getWindowFragments).mockImplementationOnce(() => new Promise(() => {}));
    await mount(); expect(resolveDisplayState(child(parents))).toBe("delegationUnknown");
    await tick(DELEGATION_QUERY_TIMEOUT_MS);
    await tick(15_000 - DELEGATION_QUERY_TIMEOUT_MS);
    expect(ipc.getWindowFragments).toHaveBeenCalledTimes(2);
    expect(resolveDisplayState(child(parents))).toBe("delegated");
  });
  it("G3 first successful empty fragments with an unrelated live process stays unknown until the parent appears", async () => {
    vi.mocked(ipc.getWindowFragments).mockResolvedValueOnce([]);
    await mount();
    expect(parents.parent.state).toBe("unknown");
    expect(resolveDisplayState(child(parents))).toBe("delegationUnknown");
    await tick(15_000);
    expect(resolveDisplayState(child(parents))).toBe("delegated");
  });
  it("G7 a delayed old alive response cannot override a newer local exit or its subsequent read failures", async () => {
    let resolve!: (snapshot:ipc.PtyMetadataSnapshot)=>void;
    vi.mocked(ipc.getPtyMetadataSnapshot).mockReturnValueOnce(new Promise(done=>{resolve=done;}));
    await mount(true);
    await tick(100);
    usePaneMetadataStore.getState().setLiveAgent("new-session",null,false);
    await tick(100);
    await act(async()=>resolve({"new-session":{live_agent_kind:"claude",process_name:"claude",agent_session_id:"parent-conversation",agent_started_at:NOW-1000,observed_at:NOW}} as ipc.PtyMetadataSnapshot));
    expect(parents.parent.state).toBe("ended");
    expect(resolveDisplayState(child(parents,true))).toBe("done");
    vi.mocked(ipc.getWindowFragments).mockRejectedValue(new Error("failed"));
    await tick(15_000);
    expect(resolveDisplayState(child(parents,true))).toBe("done");
  });
  it("G8 identical fresh local observations remain confirmed even while peer reads fail", async () => {
    usePaneMetadataStore.getState().setLiveAgent("new-session","claude",true,{agentSessionId:"parent-conversation",startedAt:NOW-1000});
    const changed=usePaneMetadataStore.getState().volatileMetadata["new-session"].liveAgentChangedAt;
    await mount(true);
    vi.mocked(ipc.getWindowFragments).mockRejectedValue(new Error("failed"));
    await tick(130_000);
    await act(async()=>{
      usePaneMetadataStore.getState().setLiveAgent("new-session","claude",true,{agentSessionId:"parent-conversation",startedAt:NOW-1000});
      root.render(<Probe local />);
    });
    const observation=usePaneMetadataStore.getState().volatileMetadata["new-session"];
    expect(observation.liveAgentObservedAt).toBe(NOW+130_000);
    expect(observation.liveAgentChangedAt).toBe(changed);
    const card=buildDashboardCards(workspaces(true),{metadataBySession:{},volatileMetadataBySession:{"new-session":observation},
      lastLogBySession:{},lastLogAtBySession:{},attentionBySession:{},seenAttentionByTab:new Map(),doneMarkByTab:new Map(),
      stallsBySession:{},now:Date.now(),briefsBySession:{"child-session":child(parents,true).brief!},delegationParents:parents,hasTerminalBuffer:()=>true}).find(item=>item.tab.id==="child")!;
    expect(resolveDisplayState(card)).toBe("delegated");
  });
  it.each(["conversation", "process start"] as const)("G3 G8 repeated fresh observations without %s proof retain the two-minute uncertainty deadline", async (missing) => {
    const evidence = missing === "conversation" ? { startedAt: NOW - 1000 } : { agentSessionId: "parent-conversation" };
    usePaneMetadataStore.getState().setLiveAgent("new-session", "claude", true, evidence);
    await mount(true);
    vi.mocked(ipc.getWindowFragments).mockRejectedValue(new Error("failed"));
    const cards = () => {
      const spaces = workspaces(true);
      if (missing === "process start") spaces[0].panes[0].tabs[0].delegatedByAgentSessionId = undefined;
      return buildDashboardCards(spaces, {
        metadataBySession: {}, volatileMetadataBySession: usePaneMetadataStore.getState().volatileMetadata,
        lastLogBySession: {}, lastLogAtBySession: {}, attentionBySession: {}, seenAttentionByTab: new Map(), doneMarkByTab: new Map(),
        stallsBySession: {}, now: Date.now(), briefsBySession: { "child-session": child(parents, true).brief! },
        delegationParents: parents, hasTerminalBuffer: () => true,
      }).find(card => card.tab.id === "child")!;
    };
    expect(resolveDisplayState(cards())).toBe("delegationUnknown");
    for (let i = 0; i < 13; i++) {
      await tick(10_000);
      usePaneMetadataStore.getState().setLiveAgent("new-session", "claude", true, evidence);
      expect(resolveDisplayState(cards())).toBe(i < 11 ? "delegationUnknown" : "done");
    }
    const observation = usePaneMetadataStore.getState().volatileMetadata["new-session"];
    expect(observation.liveAgentObservedAt).toBe(NOW + 120_000);
    expect(missing === "conversation" ? observation.liveAgentIdentityUnknownSince : observation.liveAgentStartUnknownSince).toBe(NOW);
    expect(usePaneMetadataStore.getState().metadata["new-session"]).toBeUndefined();
    expect(ipc.getWindowFragments).toHaveBeenCalledTimes(9);
  });
  it("G3 T20 legacy delegation without a creation timestamp has a bounded unknown period despite fresh parent confirmations", async () => {
    const evidence = { agentSessionId: "parent-conversation", startedAt: NOW - 1000 };
    usePaneMetadataStore.getState().setLiveAgent("new-session", "claude", true, evidence);
    await mount(true);
    const card = () => {
      const spaces = workspaces(true);
      spaces[0].panes[0].tabs[0].delegatedAt = undefined;
      spaces[0].panes[0].tabs[0].delegatedByAgentSessionId = undefined;
      return buildDashboardCards(spaces, {
        metadataBySession: {}, volatileMetadataBySession: usePaneMetadataStore.getState().volatileMetadata,
        lastLogBySession: {}, lastLogAtBySession: {}, attentionBySession: {}, seenAttentionByTab: new Map(), doneMarkByTab: new Map(),
        stallsBySession: {}, now: Date.now(), briefsBySession: { "child-session": child(parents, true).brief! },
        delegationParents: parents, hasTerminalBuffer: () => true,
      }).find(item => item.tab.id === "child")!;
    };
    expect(resolveDisplayState(card())).toBe("delegationUnknown");
    for (let i = 0; i < 13; i++) {
      await tick(10_000);
      usePaneMetadataStore.getState().setLiveAgent("new-session", "claude", true, evidence);
      expect(resolveDisplayState(card())).toBe(i < 11 ? "delegationUnknown" : "done");
    }
    expect(parents.parent.firstObservedAt).toBe(NOW);
    expect(usePaneMetadataStore.getState().volatileMetadata["new-session"].liveAgentObservedAt).toBe(NOW + 120_000);
  });
  it.each(["hung", "failed"] as const)("H1 G3 F8 a ten-minute-old child starts its unknown epoch at the first render with %s reads", async mode => {
    vi.mocked(ipc.getWindowFragments).mockImplementation(() => mode === "hung" ? new Promise(() => {}) : Promise.reject(new Error("failed")));
    await mount(false, 600_000);
    expect(renderedStates[0]).toBe("delegationUnknown");
    expect(parents.parent.unknownSince).toBe(NOW);
    expect(container.textContent).toBe("委譲元の状態を確認中");
    await tick(119_999);
    await mount(false, 600_000);
    const unknown = child(parents, false, 600_000);
    expect(resolveDisplayState(unknown)).toBe("delegationUnknown");
    expect(groupCardsByAttentionSection([unknown]).other).toEqual([unknown]);
    expect(groupCardsByAttentionSection([unknown]).needsReview).toEqual([]);
    await tick(1);
    await mount(false, 600_000);
    const done = child(parents, false, 600_000);
    expect(resolveDisplayState(done)).toBe("done");
    expect(groupCardsByAttentionSection([done]).needsReview).toEqual([done]);
    expect(parents.parent.unknownSince).toBe(NOW);
  });
  it("H1 F8 first same-conversation observation before the deadline delegates an old child without a false done frame", async () => {
    let resolve!: (snapshot: ipc.PtyMetadataSnapshot) => void;
    vi.mocked(ipc.getPtyMetadataSnapshot).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    await mount(false, 600_000);
    expect(resolveDisplayState(child(parents, false, 600_000))).toBe("delegationUnknown");
    await tick(2_000);
    await act(async () => resolve({ "new-session": { live_agent_kind: "claude", process_name: "claude", agent_session_id: "parent-conversation", agent_started_at: NOW - 1000, observed_at: Date.now() } } as ipc.PtyMetadataSnapshot));
    expect(resolveDisplayState(child(parents, false, 600_000))).toBe("delegated");
    expect(renderedStates).not.toContain("done");
  });
  it("H3 G7 F9 local exit is accepted after a one-hour clock rollback", async () => {
    usePaneMetadataStore.getState().setLiveAgent("new-session", "claude", true, { agentSessionId: "parent-conversation", startedAt: NOW - 1000 });
    await mount(true);
    vi.setSystemTime(NOW - 3_600_000);
    usePaneMetadataStore.getState().setLiveAgent("new-session", null, false);
    const observation = usePaneMetadataStore.getState().volatileMetadata["new-session"];
    expect(observation).toMatchObject({ ptyAlive: false, liveAgentKind: null, liveAgentObservedAt: Date.now(), liveAgentChangedAt: Date.now() });
    vi.mocked(ipc.getWindowFragments).mockRejectedValue(new Error("failed"));
    await tick(15_000);
    const item = buildDashboardCards(workspaces(true), { metadataBySession: {}, volatileMetadataBySession: { "new-session": observation },
      lastLogBySession: {}, lastLogAtBySession: {}, attentionBySession: {}, seenAttentionByTab: new Map(), doneMarkByTab: new Map(),
      stallsBySession: {}, now: Date.now(), briefsBySession: { "child-session": child(parents, true).brief! }, delegationParents: parents, hasTerminalBuffer: () => true }).find(card => card.tab.id === "child")!;
    expect(resolveDisplayState(item)).toBe("done");
  });
  it("H3 G7 F9 a fresh ended snapshot after rollback survives subsequent peer failure", async () => {
    await mount();
    vi.setSystemTime(NOW - 3_600_000);
    vi.mocked(ipc.getPtyMetadataSnapshot).mockResolvedValue({});
    await tick(15_000);
    expect(parents.parent.state).toBe("ended");
    expect(resolveDisplayState(child(parents))).toBe("done");
    vi.mocked(ipc.getWindowFragments).mockRejectedValue(new Error("failed"));
    await tick(15_000);
    expect(resolveDisplayState(child(parents))).toBe("done");
  });
  it.each([false, true])("H3 G3 F9 without a new observation the rollback epoch expires once in two minutes (local=%s)", async local => {
    if (local) usePaneMetadataStore.getState().setLiveAgent("new-session", "claude", true, { agentSessionId: "parent-conversation", startedAt: NOW - 1000 });
    await mount(local);
    vi.mocked(ipc.getWindowFragments).mockImplementation(() => new Promise(() => {}));
    const resetAt = NOW - 3_600_000;
    vi.setSystemTime(resetAt);
    await mount(local);
    expect(parents.parent.unknownSince).toBe(resetAt);
    const item = () => buildDashboardCards(workspaces(local), { metadataBySession: {}, volatileMetadataBySession: usePaneMetadataStore.getState().volatileMetadata,
      lastLogBySession: {}, lastLogAtBySession: {}, attentionBySession: {}, seenAttentionByTab: new Map(), doneMarkByTab: new Map(),
      stallsBySession: {}, now: Date.now(), briefsBySession: { "child-session": child(parents, local).brief! }, delegationParents: parents, hasTerminalBuffer: () => true }).find(card => card.tab.id === "child")!;
    expect(resolveDisplayState(item())).toBe("delegationUnknown");
    await tick(119_999); await mount(local);
    expect(resolveDisplayState(item())).toBe("delegationUnknown");
    await tick(1); await mount(local);
    expect(resolveDisplayState(item())).toBe("done");
    expect(parents.parent.unknownSince).toBe(resetAt);
  });
  it("F10 published parent wins over stale pending workspace and duplicate tab ids", () => {
    const pending = fragment("old-session", "Old", true), published = fragment();
    const processes = { "new-session": { live_agent_kind: "claude" } } as ipc.PtyMetadataSnapshot;
    for (const fragments of [[published, pending], [pending, published]]) {
      expect(delegationParentsFromFragments(fragments, processes, NOW).parent).toMatchObject({ alive: true, label: "Coordinator", sessionId: "new-session" });
    }
    pending.workspaces[0].id = "duplicate-other-workspace";
    expect(delegationParentsFromFragments([published, pending], processes, NOW).parent.alive).toBe(true);
    expect(delegationParentsFromFragments([pending], { "old-session": { live_agent_kind: "claude" } } as ipc.PtyMetadataSnapshot, NOW).parent.alive).toBe(true);
  });
});
