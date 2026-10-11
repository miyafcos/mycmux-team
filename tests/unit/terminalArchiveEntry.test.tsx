// @vitest-environment jsdom
import {act,useRef} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import type {Terminal} from "@xterm/xterm";
const mocks=vi.hoisted(()=>({invoke:vi.fn(),mappings:vi.fn(),connect:vi.fn(),release:vi.fn(),open:vi.fn(()=>true)}));
vi.mock("@tauri-apps/api/core",async(original)=>({...await original<typeof import("@tauri-apps/api/core")>(),invoke:mocks.invoke}));
vi.mock("../../src/lib/ipc",async(original)=>({...await original<typeof import("../../src/lib/ipc")>(),readAgentSessionMappings:mocks.mappings}));
vi.mock("../../src/stores/liveBriefStore",async(original)=>({...await original<typeof import("../../src/stores/liveBriefStore")>(),connectLiveBriefStore:mocks.connect}));
import {useTerminalArchiveEntry} from "../../src/components/terminal/useTerminalArchiveEntry";
import {useSettingsStore} from "../../src/stores/settingsStore";
import {usePaneMetadataStore} from "../../src/stores/paneMetadataStore";
import {useSessionAttentionStore} from "../../src/stores/sessionAttentionStore";
import {useLiveBriefStore} from "../../src/stores/liveBriefStore";
import {useUiStore} from "../../src/stores/uiStore";
import {useDashboardViewStore} from "../../src/stores/dashboardViewStore";
const entries=new Map<string,ReturnType<typeof useTerminalArchiveEntry>>();
let entry:ReturnType<typeof useTerminalArchiveEntry>;let root:Root;let host:HTMLDivElement;
const marker={line:77,isDisposed:false,dispose:vi.fn()};
const term={buffer:{active:{type:"normal",baseY:5000,viewportY:77,cursorY:23}},hasSelection:()=>false,registerMarker:vi.fn(()=>marker),scrollToLine:vi.fn()} as unknown as Terminal;
function Harness({open=false,id="pty-entry",visible=true}:{open?:boolean;id?:string;visible?:boolean}){const node=useRef<HTMLDivElement>(null);const terminal=useRef<Terminal|null>(term);entry=useTerminalArchiveEntry(id,`tab-${id}`,node,terminal,open,mocks.open,visible);entries.set(id,entry);return <div ref={node}/>;}
beforeEach(()=>{
 vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);vi.stubGlobal("ResizeObserver",class{observe(){}disconnect(){}});vi.spyOn(HTMLElement.prototype,"clientWidth","get").mockReturnValue(800);vi.spyOn(HTMLElement.prototype,"clientHeight","get").mockReturnValue(600);
 vi.clearAllMocks();entries.clear();marker.isDisposed=false;mocks.connect.mockImplementation(()=>mocks.release);mocks.mappings.mockResolvedValue({"pty-entry":{agent_kind:"claude",session_id:"exact-entry"}});
 mocks.invoke.mockImplementation(async(c:string)=>c==="open_transcript_history"?{readerId:"entry-reader",sourceGeneration:"entry-g",snapshotEnd:"0",items:[],olderCursor:null,newerCursor:"tail",latestCursor:"latest",scanContinuation:null,reachedStart:true,reachedFence:true,diagnostics:[]}:null);
 useSettingsStore.setState({conversationHistoryMode:"agent-wheel",showTerminalHistoryButton:false});usePaneMetadataStore.setState({volatileMetadata:{"pty-entry":{liveAgentKind:"claude",ptyAlive:true}}});useDashboardViewStore.setState({open:false});useUiStore.setState({activePaneId:"pty-entry"});
 const now=Date.now();useSessionAttentionStore.setState({attentionBySession:{"pty-entry":{sessionId:"pty-entry",sessionEpoch:7,attentionId:null,kind:"none",detail:null,sessionRevision:1,uiState:"working",stateSince:now,occurrenceOrder:1}},statusSignalsBySession:{"pty-entry":{activity:"streaming",health:"fresh",lastOutputAt:now,lastMonitorAt:now,lastEvidenceAt:now,processStartedAt:1}}});
 useLiveBriefStore.setState({briefsBySession:{"pty-entry":{ptySessionId:"pty-entry",ptyGeneration:7,agentKind:"claude",agentSessionId:"exact-entry",telemetryHealth:"live",pendingInputKind:null,pendingPrompt:null,lastSuccessfulReadAt:now,operationalState:"running"} as never}});
 host=document.createElement("div");document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();vi.unstubAllGlobals();});
async function mount(open=false){await act(async()=>{root.render(<Harness open={open}/>);await new Promise((r)=>setTimeout(r,10));});await act(async()=>{await new Promise((r)=>setTimeout(r,10));});}
describe("terminal pre-open and brief demand",()=>{
 it("prepares an exact reader and fresh brief demand with Dashboard/button closed",async()=>{
  await mount();expect(mocks.connect).toHaveBeenCalledOnce();expect(entry.reader?.snapshot.status).toBe("ready");
  let accepted=false;await act(async()=>{accepted=entry.wheel(new WheelEvent("wheel",{deltaY:-120,deltaX:0}),term,{composing:false,dragging:false},false);});expect(accepted).toBe(true);expect(mocks.open).toHaveBeenCalledOnce();
  expect(entry.close()).toBe(true);expect(term.scrollToLine).toHaveBeenCalledWith(77);
  await act(async()=>{useSettingsStore.getState().setConversationHistoryMode("manual");});expect(mocks.release).toHaveBeenCalledOnce();
 });
 it("a shell with a retained agent mapping and a pending question preserve the terminal route",async()=>{
  await mount();await act(async()=>{usePaneMetadataStore.getState().setLiveAgent("pty-entry",null,true);});
  expect(entry.reader).toBeUndefined();expect(mocks.release).toHaveBeenCalledOnce();
  expect(entry.wheel(new WheelEvent("wheel",{deltaY:-120}),term,{composing:false,dragging:false},false)).toBe(false);
  await act(async()=>{usePaneMetadataStore.getState().setLiveAgent("pty-entry","claude",true);useLiveBriefStore.setState({briefsBySession:{"pty-entry":{...useLiveBriefStore.getState().briefsBySession["pty-entry"],pendingInputKind:"choice"}}});});
  expect(entry.wheel(new WheelEvent("wheel",{deltaY:-120}),term,{composing:false,dragging:false},false)).toBe(false);expect(mocks.open).not.toHaveBeenCalled();
 });
 it("does not consume an unready reader and disposes all demand in legacy mode",async()=>{
  mocks.invoke.mockImplementation((c:string)=>c==="open_transcript_history"?new Promise(()=>{}):Promise.resolve(null));await mount();expect(entry.wheel(new WheelEvent("wheel",{deltaY:-120}),term,{composing:false,dragging:false},false)).toBe(false);
  await act(async()=>{useSettingsStore.getState().setConversationHistoryMode("legacy");});expect(mocks.release).toHaveBeenCalledOnce();expect(entry.reader).toBeUndefined();expect(mocks.open).not.toHaveBeenCalled();
 });
 it("detects a lost terminal marker without resetting or recreating the terminal",async()=>{
  await mount();await act(async()=>{entry.wheel(new WheelEvent("wheel",{deltaY:-120}),term,{composing:false,dragging:false},false);});marker.isDisposed=true;expect(entry.close()).toBe(false);expect(term.scrollToLine).not.toHaveBeenCalled();expect(mocks.invoke.mock.calls.every(([c])=>String(c).includes("transcript_history"))).toBe(true);
 });
 it("R5 releases hidden preparations on visibility-only workspace changes and Dashboard overlap",async()=>{
  await mount();expect(entry.reader?.snapshot.status).toBe("ready");
  host.style.visibility="hidden";await act(async()=>window.dispatchEvent(new CustomEvent("mycmux:workspace-visibility-change")));
  expect(entry.reader).toBeUndefined();expect(mocks.release).toHaveBeenCalled();
  host.style.visibility="visible";await act(async()=>window.dispatchEvent(new CustomEvent("mycmux:workspace-visibility-change")));await mount();expect(entry.reader?.snapshot.status).toBe("ready");
  await act(async()=>useDashboardViewStore.setState({open:true}));expect(entry.reader).toBeUndefined();
 });

 it("R5 twelve retained tabs and an invisible other window leave capacity to the painted pane",async()=>{
  const ids=Array.from({length:13},(_,i)=>`retained-${i}`);
  usePaneMetadataStore.setState({volatileMetadata:Object.fromEntries(ids.map(id=>[id,{liveAgentKind:"claude",ptyAlive:true}]))});
  mocks.mappings.mockImplementation(async(requested:string[])=>Object.fromEntries(requested.map(id=>[id,{agent_kind:"claude",session_id:`exact-${id}`}])));
  const show=async(active:number)=>{await act(async()=>{root.render(<>{ids.map((id,i)=><Harness key={id} id={id} visible={i===active}/>)}</>);await new Promise(r=>setTimeout(r,10));});await act(async()=>{await new Promise(r=>setTimeout(r,10));});};
  await show(0);expect(mocks.invoke.mock.calls.filter(c=>c[0]==="open_transcript_history")).toHaveLength(1);expect(entries.get(ids[0])?.reader?.snapshot.status).toBe("ready");
  await show(12);expect(entries.get(ids[0])?.reader).toBeUndefined();expect(entries.get(ids[12])?.reader?.snapshot.status).toBe("ready");expect(mocks.invoke.mock.calls.filter(c=>c[0]==="close_transcript_history")).toHaveLength(1);
  const hidden=vi.spyOn(document,"hidden","get").mockReturnValue(true);await act(async()=>document.dispatchEvent(new Event("visibilitychange")));expect(entries.get(ids[12])?.reader).toBeUndefined();
  const before=mocks.invoke.mock.calls.filter(c=>c[0]==="open_transcript_history").length;await show(12);expect(mocks.invoke.mock.calls.filter(c=>c[0]==="open_transcript_history")).toHaveLength(before);
  hidden.mockReturnValue(false);await act(async()=>document.dispatchEvent(new Event("visibilitychange")));await show(12);expect(entries.get(ids[12])?.reader?.snapshot.status).toBe("ready");
 });

});
