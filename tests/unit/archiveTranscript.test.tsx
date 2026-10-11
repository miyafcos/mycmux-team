// @vitest-environment jsdom
import { act,StrictMode } from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
const mocks=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock("@tauri-apps/api/core",async(importOriginal)=>({...await importOriginal<typeof import("@tauri-apps/api/core")>(),invoke:mocks.invoke}));
import {ArchiveTranscript} from "../../src/components/dashboard/ArchiveTranscript";
import {TranscriptHistoryReader} from "../../src/stores/transcriptHistoryStore";
import type {ArchiveItem,TranscriptPage,TranscriptDescriptor} from "../../src/lib/livebrief";
let root:Root;let host:HTMLDivElement;let reader:TranscriptHistoryReader|null=null;
const descriptor:TranscriptDescriptor={ptySessionId:"view-pty",tabId:"view-tab",expectedAgentKind:"claude",expectedAgentSessionId:"view-id"};
const item=(n:number):ArchiveItem=>({occurrenceId:`claude:view-id:g:${n*10}:0`,sourceStart:String(n*10),sourceEnd:String(n*10+10),slot:0,kind:n===0?"toolResult":n===1?"question":"assistant",timestamp:null,text:n===0?"result without start":n===1?"historical question":`paragraph ${n}`,bodyRef:null,callId:null,tool:null,target:null,aliases:[]});
const page=(from=0,to=500):TranscriptPage=>({readerId:"view-reader",sourceGeneration:"g",snapshotEnd:"5000",items:Array.from({length:to-from},(_,i)=>item(i+from)),olderCursor:null,newerCursor:"tail",latestCursor:"latest",scanContinuation:null,reachedStart:true,reachedFence:true,diagnostics:[]});
beforeEach(()=>{vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);host=document.createElement("div");document.body.append(host);root=createRoot(host);mocks.invoke.mockReset();mocks.invoke.mockImplementation(async(c:string)=>c==="open_transcript_history"?page():c==="refresh_transcript_history_tail"?{...page(),items:[]}:c==="read_transcript_history_page"?page():null);});
afterEach(async()=>{await act(async()=>root.unmount());reader?.dispose();reader=null;host.remove();vi.unstubAllGlobals();});
async function render(){await act(async()=>{root.render(<ArchiveTranscript descriptor={descriptor}/>);await new Promise(r=>setTimeout(r,10));});}
describe("shared read-only archive view",()=>{
  it("renders a bounded DOM with stable source occurrences and no PTY calls",async()=>{
    await act(async()=>{root.render(<StrictMode><ArchiveTranscript descriptor={descriptor}/></StrictMode>);await new Promise((r)=>setTimeout(r,10));});
    expect(host.querySelectorAll("[data-archive-row]").length).toBeLessThanOrEqual(120);expect(host.querySelectorAll("[data-archive-row]").length).toBeGreaterThan(0);expect(host.textContent).toContain("端末の履歴は Shift+ホイール");
    expect(mocks.invoke.mock.calls.every(([c])=>String(c).includes("transcript_history"))).toBe(true);
  });
  it("shows independent tool results and historical questions as read-only content",async()=>{
    mocks.invoke.mockImplementation(async(c:string)=>c==="open_transcript_history"?page(0,2):null);
    await act(async()=>{root.render(<ArchiveTranscript descriptor={descriptor}/>);await new Promise((r)=>setTimeout(r,5));});
    expect(host.textContent).toContain("result without start");expect(host.textContent).toContain("ツール結果");expect(host.textContent).toContain("historical question");expect(host.textContent).toContain("回答は端末で行います");expect(host.querySelector("textarea,input")).toBeNull();
  });
  it("retains the old source and provides an explicit current conversation action",async()=>{
    reader=new TranscriptHistoryReader(descriptor);
    await act(async()=>{root.render(<ArchiveTranscript descriptor={descriptor} prepared={reader!}/>);await new Promise((r)=>setTimeout(r,5));});
    await act(async()=>{reader!.freeze();root.render(<ArchiveTranscript descriptor={{...descriptor,expectedAgentSessionId:"next"}} prepared={reader!}/>);});
    expect(host.textContent).toContain("以前の会話を表示しています");expect(host.textContent).toContain("現在の会話を開く");expect(reader.snapshot.descriptor.expectedAgentSessionId).toBe("view-id");
  });
  it("mounts and jumps to an offscreen source occurrence after asynchronous page work",async()=>{
    const target="claude:view-id:g:4990:0";
    await act(async()=>{root.render(<ArchiveTranscript descriptor={descriptor} targetEventId={target} targetEventRequest={1}/>);await new Promise((r)=>setTimeout(r,20));});
    await act(async()=>{await new Promise((r)=>setTimeout(r,20));});
    expect(host.querySelector(`[data-archive-row="${target}"]`)).not.toBeNull();expect(host.textContent).not.toContain("指定した発言は記録に見つかりませんでした");
  });
  it("does not open an extra body window while text selection pins its rows",async()=>{
    const p=page(0,2);p.items[0]={...p.items[0],bodyRef:"body"};mocks.invoke.mockImplementation(async(c:string)=>c==="open_transcript_history"?p:c==="read_transcript_history_body"?{text:"x".repeat(32768),cursor:null,sourceText:false}:null);
    await act(async()=>{root.render(<ArchiveTranscript descriptor={descriptor}/>);await new Promise((r)=>setTimeout(r,10));});
    const range=document.createRange();range.selectNodeContents(host.querySelector("[data-archive-row]")!);
    await act(async()=>{window.getSelection()!.addRange(range);document.dispatchEvent(new Event("selectionchange"));});
    const button=Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((b)=>b.textContent==="本文の続きを表示")!;expect(button.disabled).toBe(true);button.click();expect(host.querySelector("[aria-label='会話の本文']")).toBeNull();
    await act(async()=>{window.getSelection()!.removeAllRanges();document.dispatchEvent(new Event("selectionchange"));});
    await act(async()=>{button.click();await Promise.resolve();});
    expect(host.querySelectorAll("[data-archive-row], [data-archive-body-block]").length).toBeLessThanOrEqual(120);
  });

  it("R12 jumps a fully loaded short conversation from the bottom to its first row",async()=>{
    mocks.invoke.mockImplementation(async(c:string)=>c==="open_transcript_history"?page(0,20):null);
    await render();const log=host.querySelector<HTMLElement>("[role=log]")!;
    log.scrollTop=500;await act(async()=>log.dispatchEvent(new Event("scroll",{bubbles:true})));
    const first=[...host.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent==="最初へ")!;
    expect(first.disabled).toBe(false);await act(async()=>first.click());expect(log.scrollTop).toBe(0);
  });
  it.each(["permissionDenied","recordMissing","readerBusy"])("R11 distinguishes %s from an empty archive and exposes retry",async(reason)=>{
    mocks.invoke.mockImplementation(async(c:string)=>{if(c==="open_transcript_history")throw reason;return null;});
    await render();const empty=host.querySelector<HTMLElement>("[data-dashboard-chat-empty]");
    expect(empty?.dataset.dashboardChatEmpty).toBe("unavailable");expect(empty?.textContent).toContain("会話の記録を読み込めていません");expect(empty?.textContent).toContain("履歴を読めません");
    expect([...host.querySelectorAll("button")].some(b=>b.textContent==="もう一度開く")).toBe(true);
  });
  it("R11 keeps an unlinked mapping unavailable without opening a lease",async()=>{
    await act(async()=>root.render(<ArchiveTranscript descriptor={null}/>));
    const empty=host.querySelector<HTMLElement>("[data-dashboard-chat-empty]");
    expect(empty?.dataset.dashboardChatEmpty).toBe("unavailable");expect(empty?.textContent).toContain("会話の記録を読み込めていません");expect(empty?.textContent).toContain("履歴を読めません");expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("R11 preserves the empty-state marker for a successfully read empty archive",async()=>{
    mocks.invoke.mockImplementation(async(c:string)=>c==="open_transcript_history"?page(0,0):null);
    await render();expect(host.querySelector<HTMLElement>("[data-dashboard-chat-empty]")?.dataset.dashboardChatEmpty).toBe("empty");
  });

});
