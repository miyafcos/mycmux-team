// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock("@tauri-apps/api/core",async(importOriginal)=>({...await importOriginal<typeof import("@tauri-apps/api/core")>(),invoke:mocks.invoke}));
import { TranscriptHistoryReader, archiveCacheStats } from "../../src/stores/transcriptHistoryStore";
import type { ArchiveItem, TranscriptDescriptor, TranscriptPage } from "../../src/lib/livebrief";

const readers:TranscriptHistoryReader[]=[];
let sequence=0;
function descriptor():TranscriptDescriptor { return {ptySessionId:`pty-${++sequence}`,tabId:`tab-${sequence}`,expectedAgentKind:"claude",expectedAgentSessionId:`id-${sequence}`}; }
function item(n:number):ArchiveItem { return {occurrenceId:`g:${n}`,sourceStart:String(n*100),sourceEnd:String(n*100+100),slot:0,kind:"user",timestamp:null,text:`message ${n}`,bodyRef:null,callId:null,tool:null,target:null,aliases:[`native-${n}`]}; }
function page(from:number,to:number,patch:Partial<TranscriptPage>={}):TranscriptPage { return {readerId:"reader",sourceGeneration:"g",snapshotEnd:"100000",items:Array.from({length:to-from},(_,n)=>item(from+n)),olderCursor:from?`older-${from}`:null,newerCursor:`newer-${to}`,latestCursor:"latest",scanContinuation:null,reachedStart:from===0,reachedFence:to===1000,diagnostics:[],...patch}; }
async function settled(reader:TranscriptHistoryReader):Promise<void> { for(let n=0;n<100;n++){await new Promise((r)=>setTimeout(r,0));if(!reader.snapshot.loading)return;}throw new Error("reader did not settle"); }
beforeEach(()=>{mocks.invoke.mockReset();mocks.invoke.mockImplementation(async(command:string)=>{if(command==="close_transcript_history")return null;if(command==="open_transcript_history")return page(900,1000);throw new Error(command);});});
afterEach(()=>{for(const reader of readers.splice(0))reader.dispose();vi.useRealTimers();});
function reader(d=descriptor()):TranscriptHistoryReader {const r=new TranscriptHistoryReader(d);readers.push(r);return r;}
describe("bounded archive consumers",()=>{
  it("shares one source lease and immutable pages while keeping follow/windows independent",async()=>{
    const d=descriptor();const a=reader(d),b=reader(d);await settled(a);await settled(b);
    expect(mocks.invoke.mock.calls.filter(([c])=>c==="open_transcript_history")).toHaveLength(1);
    mocks.invoke.mockImplementation(async(c:string,args:{request?:{cursor:string}})=>c==="read_transcript_history_page"?page(800,900):null);
    await a.load("older");expect(a.snapshot.items).toHaveLength(200);expect(b.snapshot.items).toHaveLength(100);expect(a.snapshot.following).toBe(false);expect(b.snapshot.following).toBe(true);
    a.dispose();expect(mocks.invoke.mock.calls.filter(([c])=>c==="close_transcript_history")).toHaveLength(0);
    b.dispose();await Promise.resolve();expect(mocks.invoke.mock.calls.filter(([c])=>c==="close_transcript_history")).toHaveLength(1);
  });
  it("evicts after five pages and can reload the evicted newer interval",async()=>{
    const r=reader();await settled(r);
    mocks.invoke.mockImplementation(async(c:string,args:{request?:{cursor:string}})=>{
      if(c!=="read_transcript_history_page")return null;
      const cursor=args.request!.cursor;const n=Number(cursor.split("-")[1]);return cursor.startsWith("older")?page(n-100,n):page(n,n+100);
    });
    for(let n=0;n<8;n++)await r.load("older");
    expect(r.snapshot.pages).toHaveLength(5);expect(r.snapshot.items).toHaveLength(500);expect(r.snapshot.items[0].text).toBe("message 100");expect(r.snapshot.reachedFence).toBe(false);
    await r.load("newer");expect(r.snapshot.items[0].text).toBe("message 200");expect(r.snapshot.items[499].text).toBe("message 699");expect(archiveCacheStats().bytes).toBeLessThanOrEqual(16*1024*1024);
  });
  it("continues the same opaque context token without memoizing a partial reply forever",async()=>{
    let calls=0;mocks.invoke.mockImplementation(async(c:string)=>{if(c==="open_transcript_history")return page(990,1000,{items:[item(999)],olderCursor:null,newerCursor:null,latestCursor:null,scanContinuation:"context"});if(c==="read_transcript_history_page"){calls++;return calls<3?page(990,1000,{items:[item(999)],olderCursor:null,newerCursor:null,latestCursor:null,scanContinuation:"context"}):page(990,1000);}return null;});
    const r=reader();await settled(r);expect(calls).toBe(3);expect(r.snapshot.items).toHaveLength(10);expect(new Set(r.snapshot.items.map((i)=>i.occurrenceId)).size).toBe(10);
  });
  it("closes a delayed initial response and never revives the disposed view",async()=>{
    let resolve!:(p:TranscriptPage)=>void;mocks.invoke.mockImplementation((c:string)=>c==="open_transcript_history"?new Promise<TranscriptPage>((r)=>{resolve=r;}):Promise.resolve(null));
    const r=reader();await Promise.resolve();await Promise.resolve();r.dispose();resolve(page(0,1));await new Promise((r)=>setTimeout(r,0));
    expect(r.snapshot.status).toBe("closed");expect(mocks.invoke).toHaveBeenCalledWith("close_transcript_history",{readerId:"reader"});
  });
  it("pins selection, retains an old source on rollover, and only reopens explicitly",async()=>{
    const r=reader();await settled(r);r.setSelection(true);await r.load("older");expect(mocks.invoke.mock.calls.filter(([c])=>c==="read_transcript_history_page")).toHaveLength(0);
    r.setSelection(false);r.freeze();expect(r.snapshot.items).toHaveLength(100);expect(r.snapshot.status).toBe("frozen");expect(r.snapshot.following).toBe(false);
    const next=descriptor();r.reopen(next);await settled(r);expect(r.snapshot.descriptor).toEqual(next);expect(mocks.invoke.mock.calls.filter(([c])=>c==="open_transcript_history")).toHaveLength(2);
  });
  it("finishes a missing target at byte zero and does not leave it queued forever",async()=>{
    const r=reader();await settled(r);mocks.invoke.mockImplementation(async(c:string)=>c==="read_transcript_history_page"?page(0,10):null);
    expect(await r.find((i)=>i.text==="absent")).toBeNull();expect(r.snapshot.notice).toBe("targetMissing");expect(r.snapshot.reachedStart).toBe(true);
  });  it("rejects duplicate legacy aliases beyond the five-page retained window",async()=>{
    const r=reader();await settled(r);
    mocks.invoke.mockImplementation(async(c:string,args:{request?:{cursor:string}})=>{
      if(c==="refresh_transcript_history_tail")return page(1000,1000,{reachedFence:true});
      if(c!=="read_transcript_history_page")return null;
      const cursor=args.request!.cursor;const n=cursor==="latest"?1000:Number(cursor.split("-")[1]);const p=page(Math.max(0,n-100),n);
      p.items=p.items.map((i)=>i.text==="message 990"||i.text==="message 100"?{...i,aliases:["repeated-alias"]}:i);return p;
    });
    expect(await r.find((i)=>i.aliases.includes("repeated-alias"),{unique:true,fromLatest:true})).toBeNull();
    expect(r.snapshot.notice).toBe("ambiguousTarget");expect(r.snapshot.pages.length).toBeLessThanOrEqual(5);
  });
  it("restores a unique evicted target only after scanning to the source beginning",async()=>{
    const r=reader();await settled(r);
    mocks.invoke.mockImplementation(async(c:string,args:{request?:{cursor:string}})=>{
      if(c==="refresh_transcript_history_tail")return page(1000,1000,{reachedFence:true});
      if(c!=="read_transcript_history_page")return null;
      const cursor=args.request!.cursor;const n=cursor==="latest"?1000:Number(cursor.split("-")[1]);return page(Math.max(0,n-100),n);
    });
    const target=await r.find((i)=>i.aliases.includes("native-990"),{unique:true,fromLatest:true});
    expect(target?.text).toBe("message 990");expect(r.snapshot.items.some((i)=>i.occurrenceId===target?.occurrenceId)).toBe(true);
    expect(r.snapshot.items).toHaveLength(100);expect(r.snapshot.notice).toBeNull();
    expect(mocks.invoke.mock.calls.filter(([c])=>c==="read_transcript_history_page").length).toBeGreaterThan(5);
  });
  it("chooses the latest label occurrence and stops a busy first-search without spinning",async()=>{
    const r=reader();await settled(r);expect((await r.find((i)=>i.kind==="user"))?.text).toBe("message 999");
    mocks.invoke.mockRejectedValue(new Error("readerBusy"));expect(await r.first()).toBe(false);expect(r.snapshot.notice).toBe("searchPaused");
    expect(mocks.invoke.mock.calls.filter(([c])=>c==="read_transcript_history_page")).toHaveLength(1);
  });
  it("drains bounded body verification before exposing text and aborts when the viewer closes",async()=>{
    const r=reader();await settled(r);let count=0;
    mocks.invoke.mockImplementation(async(c:string)=>c==="read_transcript_history_body"?++count===1?{text:"",cursor:"verify",sourceText:true,validationPending:true}:{text:"verified",cursor:"32768",sourceText:true,validationPending:false}:null);
    expect((await r.readBody({...item(1),bodyRef:"raw-body"},null)).text).toBe("verified");expect(count).toBe(2);
    const abort=new AbortController();let resolve!:(p:unknown)=>void;mocks.invoke.mockImplementation((c:string)=>c==="read_transcript_history_body"?new Promise((r)=>{resolve=r;}):Promise.resolve(null));
    const pending=r.readBody({...item(1),bodyRef:"raw-body"},null,abort.signal);await Promise.resolve();await Promise.resolve();abort.abort();resolve({text:"",cursor:"verify",sourceText:true,validationPending:true});
    await expect(pending).rejects.toThrow("cursorExpired");
  });
  it("catches a tail backlog across successive pages without moving a historical consumer",async()=>{
    vi.useFakeTimers();const d=descriptor();const a=reader(d),b=reader(d);await vi.advanceTimersByTimeAsync(10);b.setFollowing(false);
    mocks.invoke.mockImplementation(async(c:string,args:{request?:{cursor:string}})=>{
      if(c==="refresh_transcript_history_tail")return page(1000,1100,{reachedFence:false,snapshotEnd:"130000"});
      if(c==="read_transcript_history_page"){const n=Number(args.request!.cursor.split("-")[1]);return page(n,n+100,{reachedFence:n+100===1300,snapshotEnd:"130000"});}return {hasNewBytes:true};
    });
    await vi.advanceTimersByTimeAsync(1500);await vi.advanceTimersByTimeAsync(20);
    expect(a.snapshot.items.at(-1)?.text).toBe("message 1299");expect(a.snapshot.reachedFence).toBe(true);
    expect(b.snapshot.items.at(-1)?.text).toBe("message 999");expect(b.snapshot.newTail).toBe(true);
  });

  it("releases lease-bound cached bodies after the final consumer closes",async()=>{
    const d=descriptor();const a=reader(d),b=reader(d);await settled(a);await settled(b);const before=archiveCacheStats().bytes;expect(before).toBeGreaterThan(0);
    a.dispose();expect(archiveCacheStats().bytes).toBe(before);b.dispose();expect(archiveCacheStats()).toEqual({bytes:0,pages:0,connections:0});
  });

});
