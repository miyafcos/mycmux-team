import { describe, expect, it, vi } from "vitest";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { resolveDelegationState, mergeDelegationParent, type DelegationParent } from "../../src/components/dashboard/delegationModel";
import type { PaneTab } from "../../src/types";

const NOW = 1_800_000_000_000;
const child = { delegatedByTabId:"parent",delegatedByAgentSessionId:"A",delegatedAt:NOW } satisfies Partial<PaneTab>;
const alive:DelegationParent={tabId:"parent",label:"Parent",alive:true,state:"alive",checkedAt:NOW,agentSessionId:"A",processStartedAt:NOW-1000};
describe("FIX-2 display decision table",()=>{
  it.each([
    ["no record",{} as typeof child,undefined,NOW,"ended"],
    ["same conversation",child,alive,NOW,"alive"],
    ["same conversation after restart",child,{...alive,processStartedAt:NOW+1000},NOW+1000,"alive"],
    ["different conversation",child,{...alive,agentSessionId:"B"},NOW,"ended"],
    ["shell",child,{...alive,alive:false,state:"ended"},NOW,"ended"],
    ["closed PTY",child,{...alive,alive:false,state:"ended",checkedAt:NOW-500000},NOW,"ended"],
    ["no location yet",child,undefined,NOW+119999,"unknown"],
    ["no initial observation epoch",child,undefined,NOW+120000,"unknown"],
    ["unknown episode begins later",child,{...alive,state:"unknown",unknownSince:NOW+300000},NOW+419999,"unknown"],
    ["unknown episode times out",child,{...alive,state:"unknown",unknownSince:NOW+300000},NOW+420000,"ended"],
    ["conversation not observed",child,{...alive,agentSessionId:undefined,identityUnknownSince:NOW},NOW+119999,"unknown"],
    ["conversation unknown timeout",child,{...alive,agentSessionId:undefined,identityUnknownSince:NOW},NOW+120000,"ended"],
    ["birth before creation",{...child,delegatedByAgentSessionId:undefined},alive,NOW,"alive"],
    ["shell then new agent",{...child,delegatedByAgentSessionId:undefined},{...alive,processStartedAt:NOW+1},NOW,"ended"],
    ["birth unobserved",{...child,delegatedByAgentSessionId:undefined},{...alive,processStartedAt:undefined,startUnknownSince:NOW},NOW+119999,"unknown"],
    ["birth unknown timeout",{...child,delegatedByAgentSessionId:undefined},{...alive,processStartedAt:undefined,startUnknownSince:NOW},NOW+120000,"ended"],
    ["legacy creation time missing",{delegatedByTabId:"parent"}, {...alive,firstObservedAt:NOW,checkedAt:NOW+119999},NOW+119999,"unknown"],
    ["legacy creation unknown timeout",{delegatedByTabId:"parent"}, {...alive,firstObservedAt:NOW,checkedAt:NOW+120000},NOW+120000,"ended"],
    ["last confirmation expired",child,alive,NOW+120000,"ended"],
  ] as const)("G3 G4 state table: %s",(name,record,parent,now,expected)=>{
    expect(resolveDelegationState(record,parent as DelegationParent|undefined,now)).toBe(expected);
  });
  it.each([
    ["birth in previous second", NOW - 1000, NOW, "alive"],
    ["shell child +100ms then agent +900ms in same second (rounded)", NOW, NOW + 100, "ended"],
    ["agent in next second", NOW + 1000, NOW + 100, "ended"],
  ] as const)("H6 G4 F8 coarse producer precision: %s", (_, birth, created, expected) => {
    expect(resolveDelegationState({ ...child, delegatedByAgentSessionId: undefined, delegatedAt: created },
      { ...alive, processStartedAt: birth, checkedAt: NOW + 20_000 }, NOW + 20_000)).toBe(expected);
  });
  it.each([[59_999, false], [60_000, true]] as const)("H3 resets the setter and merge series only from the named sixty-second threshold (%i)", (rollback, accepted) => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(NOW);
      usePaneMetadataStore.setState({ volatileMetadata: {} });
      usePaneMetadataStore.getState().setLiveAgent("parent-pty", "claude", true, { agentSessionId: "A", startedAt: NOW - 1000 });
      vi.setSystemTime(NOW - rollback);
      usePaneMetadataStore.getState().setLiveAgent("parent-pty", null, false);
      expect(usePaneMetadataStore.getState().volatileMetadata["parent-pty"].ptyAlive).toBe(!accepted);
      const freshEnd = { ...alive, state: "ended" as const, alive: false, checkedAt: Date.now() };
      expect(mergeDelegationParent(alive, freshEnd, Date.now()).state).toBe(accepted ? "ended" : "alive");
    } finally { vi.useRealTimers(); }
  });
  it("G7 older observations cannot overwrite a confirmed newer end",()=>{
    const ended={...alive,state:"ended" as const,alive:false,checkedAt:NOW+100};
    expect(mergeDelegationParent(ended,alive,NOW+200)).toEqual(ended);
    expect(mergeDelegationParent(ended,{...alive,state:"unknown",checkedAt:NOW+200},NOW+200)).toEqual(ended);
  });
});
