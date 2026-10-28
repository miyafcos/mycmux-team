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
  it("keeps dashboard conversation content without redundant visible labels",async()=>{
    const compactPage=page(0,2);
    compactPage.items[0]={...compactPage.items[0],kind:"user",text:"確認をお願いします",timestamp:Date.now()};
    compactPage.items[1]={...compactPage.items[1],kind:"assistant",text:"内容を確認しました",timestamp:Date.now()};
    mocks.invoke.mockImplementation(async(command:string)=>command==="open_transcript_history"||command==="read_transcript_history_page"?compactPage:null);
    await act(async()=>{root.render(<ArchiveTranscript descriptor={descriptor} compact/>);await new Promise(resolve=>setTimeout(resolve,10));});
    expect(host.querySelectorAll(".cmux-dashboard-msg-who")).toHaveLength(0);
    expect(host.textContent).not.toMatch(/エージェント|会話の最初|読み込み済み|Shift\+ホイール/);
    expect(host.querySelector('[role="group"][aria-label="私"]')?.textContent).toBe("確認をお願いします");
    expect(host.querySelector('[role="group"][aria-label="エージェント"]')?.textContent).toContain("内容を確認しました");
    for(const label of ["最初へ","最新へ","前の指示へ","次の指示へ"]){
      const button=host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
      expect(button?.textContent).toBe("");expect(button?.title).toBe(label);
    }
    expect(host.querySelector(".cmux-archive-nav")).toBeNull();
  });

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
  it("keeps diagnostic records out of the conversation while preserving access to their source",async()=>{
    const p=page(0,4);
    p.items[0]={...p.items[0],kind:"user",text:"表示を直してください"};
    p.items[1]={...p.items[1],kind:"diagnostic",text:"未対応の記録（元の記録を表示できます）",bodyRef:"raw-body"};
    p.items[2]={...p.items[2],kind:"assistant",text:"会話本文を読みやすく直します。"};
    p.items[3]={...p.items[3],kind:"source",text:"大きい記録・読み取れない記録（元の記録を表示）",bodyRef:"raw-body-2"};
    mocks.invoke.mockImplementation(async(c:string)=>c==="open_transcript_history"?p:c==="read_transcript_history_body"?{text:"original record",cursor:null,sourceText:true}:null);
    await render();
    expect(host.textContent).toContain("表示を直してください");expect(host.textContent).toContain("会話本文を読みやすく直します。");
    expect(host.textContent).not.toContain("未対応の記録");expect(host.textContent).not.toContain("時刻不明");
    expect(host.querySelectorAll("[data-archive-row]")).toHaveLength(2);
    const details=[...host.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="記録の詳細 2件")!;
    expect(details.getAttribute("aria-pressed")).toBe("false");await act(async()=>details.click());
    expect(host.querySelectorAll("[data-archive-row]")).toHaveLength(4);
    const source=[...host.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="元の記録を表示")!;
    await act(async()=>{source.click();await Promise.resolve();});
    expect(host.querySelector(".cmux-archive-body")?.textContent).toContain("original record");
  });
  it("does not pretend a diagnostic-only page is an empty conversation",async()=>{
    const p=page(0,1);p.items[0]={...p.items[0],kind:"diagnostic",text:"未対応の記録（元の記録を表示できます）",bodyRef:"raw-body"};
    mocks.invoke.mockImplementation(async(c:string)=>c==="open_transcript_history"?p:null);
    await render();expect(host.textContent).toContain("この範囲には表示できる会話本文がありません");
    expect(host.textContent).toContain("記録の詳細 1件");expect(host.textContent).not.toContain("時刻不明");
  });
  it("collapses tool input and output without hiding the recorded question",async()=>{
    const p=page(0,3);p.items[0]={...p.items[0],kind:"toolCall",tool:"Read",target:"src/example.ts",text:'{"file_path":"src/example.ts"}'};
    p.items[1]={...p.items[1],kind:"toolResult",text:"読み取った内容"};
    p.items[2]={...p.items[2],kind:"question",text:"この方針で進めますか？"};
    mocks.invoke.mockImplementation(async(c:string)=>c==="open_transcript_history"?p:null);
    await render();const tools=[...host.querySelectorAll<HTMLDetailsElement>("details.cmux-archive-tool")];
    expect(tools).toHaveLength(2);expect(tools.every(tool=>!tool.open)).toBe(true);
    expect(tools[0].querySelector("summary")?.textContent).toContain("Read");
    expect(tools[0].querySelector("summary")?.textContent).toContain("src/example.ts");
    expect(tools[1].querySelector("summary")?.textContent).toContain("ツール結果");
    expect(host.textContent).toContain("この方針で進めますか？");
    expect(host.textContent).not.toContain("時刻不明");
  });
  it("reveals a diagnostic source explicitly targeted by its stable occurrence",async()=>{
    const p=page(0,2);p.items[1]={...p.items[1],kind:"diagnostic",text:"unclassified record",bodyRef:"raw-body"};
    mocks.invoke.mockImplementation(async(c:string)=>c==="open_transcript_history"||c==="read_transcript_history_page"?p:c==="refresh_transcript_history_tail"?{...p,items:[]}:null);
    await act(async()=>{root.render(<ArchiveTranscript descriptor={descriptor} targetEventId={p.items[1].occurrenceId}/>);await new Promise(resolve=>setTimeout(resolve,25));});
    expect(host.querySelector(`[data-archive-row="${p.items[1].occurrenceId}"]`)).not.toBeNull();
    expect(host.textContent).toContain("unclassified record");
  });
  it("opens a targeted tool result while leaving unrelated tools collapsed",async()=>{
    const p=page(0,2);p.items[1]={...p.items[1],kind:"toolResult",text:"target result"};
    mocks.invoke.mockImplementation(async(c:string)=>c==="open_transcript_history"||c==="read_transcript_history_page"?p:c==="refresh_transcript_history_tail"?{...p,items:[]}:null);
    await act(async()=>{root.render(<ArchiveTranscript descriptor={descriptor} targetEventId={p.items[1].occurrenceId}/>);await new Promise(resolve=>setTimeout(resolve,25));});
    const tools=[...host.querySelectorAll<HTMLDetailsElement>("details.cmux-archive-tool")];
    expect(tools).toHaveLength(2);expect(tools[0].open).toBe(false);expect(tools[1].open).toBe(true);
  });
  it("reopens a tool after it was closed and the same target is requested again",async()=>{
    const p=page(0,1);mocks.invoke.mockImplementation(async(c:string)=>c==="open_transcript_history"||c==="read_transcript_history_page"?p:c==="refresh_transcript_history_tail"?{...p,items:[]}:null);
    await act(async()=>{root.render(<ArchiveTranscript descriptor={descriptor} targetEventId={p.items[0].occurrenceId} targetEventRequest={1}/>);await new Promise(resolve=>setTimeout(resolve,25));});
    const tool=host.querySelector<HTMLDetailsElement>("details.cmux-archive-tool")!;
    expect(tool.open).toBe(true);await act(async()=>{tool.open=false;tool.dispatchEvent(new Event("toggle"));});
    expect(tool.open).toBe(false);
    await act(async()=>{root.render(<ArchiveTranscript descriptor={descriptor} targetEventId={p.items[0].occurrenceId} targetEventRequest={2}/>);await new Promise(resolve=>setTimeout(resolve,25));});
    expect(tool.open).toBe(true);
  });
  it("does not reopen a manually closed tool merely because text selection ends",async()=>{
    const p=page(0,2);mocks.invoke.mockImplementation(async(c:string)=>c==="open_transcript_history"||c==="read_transcript_history_page"?p:c==="refresh_transcript_history_tail"?{...p,items:[]}:null);
    await act(async()=>{root.render(<ArchiveTranscript descriptor={descriptor} targetEventId={p.items[0].occurrenceId} targetEventRequest={1}/>);await new Promise(resolve=>setTimeout(resolve,25));});
    const tool=host.querySelector<HTMLDetailsElement>("details.cmux-archive-tool")!;
    await act(async()=>{tool.open=false;tool.dispatchEvent(new Event("toggle"));});
    const range=document.createRange();range.selectNodeContents(host.querySelector("[data-archive-row]:last-of-type")??host.querySelector("[role=log]")!);
    await act(async()=>{window.getSelection()!.addRange(range);document.dispatchEvent(new Event("selectionchange"));});
    await act(async()=>{window.getSelection()!.removeAllRanges();document.dispatchEvent(new Event("selectionchange"));await Promise.resolve();});
    expect(tool.open).toBe(false);
  });
  it("preserves an expanded tool during selection when a different target arrives",async()=>{
    const p=page(0,2);p.items[1]={...p.items[1],kind:"toolResult",text:"next result"};
    mocks.invoke.mockImplementation(async(c:string)=>c==="open_transcript_history"||c==="read_transcript_history_page"?p:c==="refresh_transcript_history_tail"?{...p,items:[]}:null);
    await act(async()=>{root.render(<ArchiveTranscript descriptor={descriptor} targetEventId={p.items[0].occurrenceId}/>);await new Promise(resolve=>setTimeout(resolve,25));});
    const tools=[...host.querySelectorAll<HTMLDetailsElement>("details.cmux-archive-tool")];
    const range=document.createRange();range.selectNodeContents(tools[0].querySelector(".cmux-archive-tool-content")!);
    await act(async()=>{window.getSelection()!.addRange(range);document.dispatchEvent(new Event("selectionchange"));});
    await act(async()=>{root.render(<ArchiveTranscript descriptor={descriptor} targetEventId={p.items[1].occurrenceId}/>);await new Promise(resolve=>setTimeout(resolve,10));});
    expect(tools[0].open).toBe(true);expect(tools[1].open).toBe(false);
    await act(async()=>{window.getSelection()!.removeAllRanges();document.dispatchEvent(new Event("selectionchange"));await new Promise(resolve=>setTimeout(resolve,25));});
    expect(tools[1].open).toBe(true);
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
