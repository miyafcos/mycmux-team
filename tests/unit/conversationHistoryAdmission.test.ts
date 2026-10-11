// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { ConversationHistoryArbiter, automaticHistorySafe, explicitHistorySafe, isExplicitHistoryKey, isHistoryBoundaryKey, type HistorySafety } from "../../src/components/terminal/conversationHistoryAdmission";
import type { LiveSessionBrief } from "../../src/lib/livebrief";
const now = 10000;
function safe(patch: Partial<HistorySafety> = {}): HistorySafety {
  return { active: true, visible: true, disposed: false, composing: false, selecting: false, dragging: false, overlay: false, liveAgentKind: "claude", ptyAlive: true, ready: true,
    descriptor: { ptySessionId: "pty", tabId: "tab", expectedAgentKind: "claude", expectedAgentSessionId: "exact" },
    attention: {sessionId:"pty",sessionEpoch:7,attentionId:null,kind:"none",detail:null,sessionRevision:1,uiState:"working",stateSince:now,occurrenceOrder:1},
    signals:{activity:"streaming",health:"fresh",lastOutputAt:now,lastMonitorAt:now,lastEvidenceAt:now,processStartedAt:1},
    brief:{ptySessionId:"pty",ptyGeneration:7,agentKind:"claude",agentSessionId:"exact",telemetryHealth:"live",pendingInputKind:null,pendingPrompt:null,lastSuccessfulReadAt:now,operationalState:"running"} as LiveSessionBrief, now, ...patch };
}
const normal={type:"normal" as const,baseY:5000,viewportY:0};const alt={type:"alternate" as const,baseY:0,viewportY:0};
const wheel=(patch:WheelEventInit={})=>{const event=new WheelEvent("wheel",{bubbles:true,cancelable:true,...patch,deltaY:Number.isFinite(patch.deltaY??-120)?patch.deltaY??-120:-120,deltaX:Number.isFinite(patch.deltaX??0)?patch.deltaX??0:0});for(const key of ["deltaY","deltaX"] as const)if(patch[key]!==undefined&&!Number.isFinite(patch[key]))Object.defineProperty(event,key,{value:patch[key]});return event;};
describe("seven guarded history entry conditions",()=>{
  it.each([normal,alt])("agent-wheel admits a ready exact live source in either buffer",(buffer)=>{const accept=vi.fn(()=>true);expect(new ConversationHistoryArbiter().wheel(wheel(),"agent-wheel",buffer,safe(),accept)).toBe(true);expect(accept).toHaveBeenCalledOnce();});
  it.each(["legacy","manual"] as const)("%s never intercepts wheel",(mode)=>{expect(new ConversationHistoryArbiter().wheel(wheel(),mode,normal,safe(),()=>true)).toBe(false);});
  it.each([{ctrlKey:true},{shiftKey:true},{altKey:true},{metaKey:true},{deltaY:0},{deltaY:120},{deltaY:NaN},{deltaX:Infinity},{deltaX:500}])("preserves modified/invalid/down/horizontal gestures %j",(event)=>{expect(new ConversationHistoryArbiter().wheel(wheel(event),"agent-wheel",alt,safe(),()=>true)).toBe(false);});
  it.each([{active:false},{visible:false},{disposed:true},{composing:true},{selecting:true},{dragging:true},{overlay:true},{ready:false},{descriptor:null},{liveAgentKind:null},{liveAgentKind:"shell"},{ptyAlive:false},{brief:undefined},{attention:undefined},{signals:undefined}])("skips unavailable/interaction facts %j",(facts)=>{const accept=vi.fn(()=>true);expect(new ConversationHistoryArbiter().wheel(wheel(),"agent-wheel",alt,safe(facts),accept)).toBe(false);expect(accept).not.toHaveBeenCalled();});
  it.each(["input","approval","error","rate_limited"] as const)("passes attention %s to the terminal",(kind)=>{const s=safe();s.attention={...s.attention!,kind};expect(automaticHistorySafe(s)).toBe(false);});
  it.each(["waiting","unknown"] as const)("passes ui state %s",(uiState)=>{const s=safe();s.attention={...s.attention!,uiState};expect(automaticHistorySafe(s)).toBe(false);});
  it("rejects stale signals, epochs, source changes, unreadable briefs and pending prompts",()=>{
    const changes:((s:HistorySafety)=>void)[]=[s=>{s.signals!.health="stale";},s=>{s.signals!.lastMonitorAt=100;},s=>{s.attention!.sessionEpoch=8;},s=>{s.attention!.sessionEpoch=null;},s=>{s.brief!.agentSessionId="another";},s=>{s.brief!.pendingInputKind="choice";},s=>{s.brief!.pendingPrompt="question";},s=>{s.brief!.telemetryHealth="ended";},s=>{s.brief!.lastSuccessfulReadAt=100;},s=>{s.brief!.operationalState="needsHuman";}];
    for(const change of changes){const s=safe();change(s);expect(automaticHistorySafe(s)).toBe(false);}
  });
  it("only consumes after admission accepts and ignores already prevented/overlay events",()=>{
    const event=wheel();event.preventDefault();expect(new ConversationHistoryArbiter().wheel(event,"agent-wheel",alt,safe(),()=>true)).toBe(false);
    const node=document.createElement("div");node.dataset.terminalTranscriptPanel="true";document.body.append(node);let consumed=true;const e=wheel();node.addEventListener("wheel",()=>{consumed=new ConversationHistoryArbiter().wheel(e,"agent-wheel",alt,safe(),()=>true);});node.dispatchEvent(e);expect(consumed).toBe(false);node.remove();
    expect(new ConversationHistoryArbiter().wheel(wheel(),"agent-wheel",alt,safe(),()=>false)).toBe(false);
  });
  it("boundary requires normal top, an additional gesture after momentum, and a close cooldown",()=>{
    const arbiter=new ConversationHistoryArbiter();const accept=vi.fn(()=>true);
    expect(arbiter.wheel(wheel(),"boundary",{...normal,viewportY:3},safe(),accept)).toBe(false);
    expect(arbiter.wheel(wheel(),"boundary",normal,safe({now:10050}),accept)).toBe(false);
    expect(arbiter.wheel(wheel(),"boundary",normal,safe({now:10300}),accept)).toBe(true);
    arbiter.noteClose(10300);expect(arbiter.wheel(wheel(),"boundary",normal,safe({now:10600}),accept)).toBe(false);
    expect(arbiter.wheel(wheel(),"boundary",alt,safe({now:11000}),accept)).toBe(false);
    expect(arbiter.wheel(wheel(),"boundary",{...normal,baseY:0},safe({now:11300}),accept)).toBe(false);
  });
  it("explicit entry can read ended/waiting sources, while boundary remains guarded",()=>{
    const s=safe({ptyAlive:false});s.attention!.kind="approval";expect(explicitHistorySafe(s)).toBe(true);expect(automaticHistorySafe(s)).toBe(false);
    expect(new ConversationHistoryArbiter().boundary("boundary",normal,s,()=>true)).toBe(false);
  });
  it("reserves only dedicated platform chords and local Shift PageUp",()=>{
    expect(isExplicitHistoryKey(new KeyboardEvent("keydown",{key:"PageUp",ctrlKey:true,altKey:true}),false)).toBe(true);
    expect(isExplicitHistoryKey(new KeyboardEvent("keydown",{key:"PageUp",metaKey:true,altKey:true}),true)).toBe(true);
    expect(isExplicitHistoryKey(new KeyboardEvent("keydown",{key:"PageUp"}),false)).toBe(false);
    expect(isHistoryBoundaryKey(new KeyboardEvent("keydown",{key:"PageUp",shiftKey:true}))).toBe(true);
  });
  it("R9 accepts a fresh successful observation for an unchanged brief and expires it when reads stop",()=>{
    const s=safe();s.brief!.serviceEpoch="service";s.brief!.ptyInstanceId="instance";s.brief!.lastSuccessfulReadAt=100;
    const observed={ptySessionId:"pty",agentKind:"claude",agentSessionId:"exact",ptyGeneration:7,ptyInstanceId:"instance",serviceEpoch:"service",lastSuccessfulReadAt:now};
    Object.assign(s,{observation:observed});expect(automaticHistorySafe(s)).toBe(true);
    s.now=now+5001;s.signals!.lastMonitorAt=s.now;expect(automaticHistorySafe(s)).toBe(false);
    s.now=now;for(const patch of [{serviceEpoch:"foreign"},{ptyGeneration:8},{agentSessionId:"foreign"},{ptyInstanceId:"foreign"}]){Object.assign(s,{observation:{...observed,...patch}});expect(automaticHistorySafe(s)).toBe(false);}
  });

});
