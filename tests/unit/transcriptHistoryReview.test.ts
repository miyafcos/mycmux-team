// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import type {ArchiveItem,TranscriptDescriptor,TranscriptPage} from "../../src/lib/livebrief";
const mock=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock("@tauri-apps/api/core",async original=>({...await original<typeof import("@tauri-apps/api/core")>(),invoke:mock.invoke}));
import {TranscriptHistoryReader,archiveCacheStats,ARCHIVE_CACHE_BYTES} from "../../src/stores/transcriptHistoryStore";
const readers:TranscriptHistoryReader[]=[];
const d=(id:string):TranscriptDescriptor=>({ptySessionId:id,tabId:`tab-${id}`,expectedAgentKind:"claude",expectedAgentSessionId:id});
const row=(n:number,g="g",text=`message ${n}`):ArchiveItem=>({occurrenceId:`${g}:${n}`,sourceStart:String(n*100),sourceEnd:String((n+1)*100),slot:0,kind:"user",timestamp:1,text,bodyRef:null,callId:null,tool:null,target:null,aliases:[]});
function page(from:number,to:number,patch:Partial<TranscriptPage>={}):TranscriptPage{return {readerId:"lease",sourceGeneration:"g",snapshotEnd:String(to*100),items:Array.from({length:to-from},(_,i)=>row(from+i)),olderCursor:from?`older-${from}`:null,newerCursor:`fence-${to}`,latestCursor:`latest-${to}`,scanContinuation:null,reachedStart:from===0,reachedFence:true,diagnostics:[],...patch};}
function deferred<T>(){let resolve!:(v:T)=>void,reject!:(e:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
const make=(id:string)=>{const r=new TranscriptHistoryReader(d(id));readers.push(r);return r;};
beforeEach(()=>{vi.spyOn(document,"hidden","get").mockReturnValue(false);vi.useFakeTimers();mock.invoke.mockReset();mock.invoke.mockImplementation(async(cmd:string)=>cmd==="open_transcript_history"?page(0,1):cmd==="heartbeat_transcript_history"?{hasNewBytes:false}:null);});
afterEach(()=>{for(const r of readers.splice(0))r.dispose();vi.restoreAllMocks();vi.useRealTimers();});
describe("independent archive review regressions",()=>{
 it.each(["partial","error"])("R1 discards a late old %s response while another old consumer keeps its lease",async(kind)=>{
  const old=deferred<TranscriptPage>(),fresh=deferred<TranscriptPage>();
  mock.invoke.mockImplementation((cmd:string,args:any)=>{
   if(cmd==="open_transcript_history")return args.request.expectedAgentSessionId==="B"?fresh.promise:Promise.resolve(page(0,1));
   if(cmd==="refresh_transcript_history_tail")return old.promise;
   if(cmd==="read_transcript_history_page")return Promise.resolve(page(0,1));
   return Promise.resolve(null);
  });
  const a=make("A"),keeper=make("A");await flush();expect(keeper.snapshot.status).toBe("ready");
  const request=a.latest();await flush();a.reopen(d("B"));await flush();
  if(kind==="partial")old.resolve(page(1,2,{sourceGeneration:"old-A",items:[row(1,"old-A","SECRET A")],scanContinuation:"old-work",reachedFence:false}));else old.reject("sourceChanged");
  await flush();await vi.advanceTimersByTimeAsync(1);expect(a.snapshot.sourceGeneration).toBeNull();expect(a.snapshot.items).toEqual([]);expect(a.snapshot.error).toBeNull();
  fresh.resolve(page(0,1,{readerId:"B-reader",sourceGeneration:"B",items:[row(0,"B","B only")]}));await flush();await vi.advanceTimersByTimeAsync(1);await request;
  expect(a.snapshot.sourceGeneration).toBe("B");expect(a.snapshot.items.map(i=>i.text)).toEqual(["B only"]);
 });
 it.each([3,9])("R2 retries admission for %i opens, recovers after capacity returns, and cancels on close",async(count)=>{
  let available=false,attempts=0;
  mock.invoke.mockImplementation(async(cmd:string,args:any)=>{if(cmd==="open_transcript_history"){attempts++;if((args.request.expectedAgentSessionId===`r${count-1}`||args.request.expectedAgentSessionId==="cancelled")&&!available)throw "readerBusy";return page(0,1,{readerId:args.request.expectedAgentSessionId});}if(cmd==="refresh_transcript_history_tail")return page(1,1,{readerId:args.readerId});if(cmd==="heartbeat_transcript_history")return {hasNewBytes:false};return null;});
  const opened=Array.from({length:count},(_,i)=>make(`r${i}`));await flush();const busy=opened[count-1];expect(busy.snapshot.notice).toBe("readerBusy");
  available=true;opened[0].dispose();await vi.advanceTimersByTimeAsync(3500);expect(busy.snapshot.status).toBe("ready");
  available=false;const cancelled=make("cancelled");await flush();expect(cancelled.snapshot.notice).toBe("readerBusy");cancelled.dispose();const before=attempts;await vi.advanceTimersByTimeAsync(5000);expect(attempts).toBe(before);
 });
 it.each([false,true])("R3 staggered consumers have contiguous coverage after an %s append poll",async(append)=>{
  let fence=1,polls=0;
  mock.invoke.mockImplementation(async(cmd:string,args:any)=>{
   if(cmd==="open_transcript_history")return page(0,1);
   if(cmd==="read_transcript_history_page")return page(0,fence);
   if(cmd==="refresh_transcript_history_tail"){const from=Number(args.afterCursor.split("-")[1]);fence=++polls===1?2:append?3:2;return page(from,fence);}
   return {hasNewBytes:false};
  });
  const a=make("coverage");await flush();await vi.advanceTimersByTimeAsync(1500);expect(a.snapshot.items.map(i=>i.text)).toEqual(["message 0","message 1",]);
  const b=make("coverage");await flush();await vi.advanceTimersByTimeAsync(1500);
  const expected=append?["message 0","message 1","message 2"]:["message 0","message 1"];expect(a.snapshot.items.map(i=>i.text)).toEqual(expected);expect(b.snapshot.items.map(i=>i.text)).toEqual(expected);expect(new Set(b.snapshot.items.map(i=>i.occurrenceId)).size).toBe(b.snapshot.items.length);
 });
 it.each(["close","hide"])("R4 connection finishes a continuation after its requesting consumer is %s",async(action)=>{
  let job=false;let actor:TranscriptHistoryReader;
  mock.invoke.mockImplementation(async(cmd:string,args:any)=>{
   if(cmd==="open_transcript_history")return page(100,101);
   if(cmd==="read_transcript_history_page"){
    if(args.request.cursor==="work"){job=false;return page(0,100);}
    if(job)throw "readerBusy";
    if(args.request.cursor==="older-100"){job=true;queueMicrotask(()=>action==="close"?actor.dispose():actor.setVisible(false));return page(0,100,{scanContinuation:"work",reachedStart:false,reachedFence:false});}
    return args.request.cursor==="older-101"?page(0,101):page(101,102);
   }
   if(cmd==="refresh_transcript_history_tail"){if(job)throw "readerBusy";return page(101,102);}
   return null;
  });
  const a=make("continuation"),b=make("continuation");actor=a;await flush();
  const work=a.load("older");await vi.advanceTimersByTimeAsync(100);await work;
  await b.latest();await vi.advanceTimersByTimeAsync(100);
  expect(job).toBe(false);expect(b.snapshot.notice).not.toBe("readerBusy");expect(b.snapshot.status).toBe("ready");
  expect(b.snapshot.items.map(i=>i.text)).toEqual(["message 101"]);
  await b.load("older");await vi.advanceTimersByTimeAsync(100);expect(b.snapshot.notice).not.toBe("readerBusy");expect(b.snapshot.reachedStart).toBe(true);expect(b.snapshot.items[0].text).toBe("message 0");expect(b.snapshot.items.at(-1)?.text).toBe("message 101");
 });
 it.each(["complete","readerBusy"])("R4 publishes initial rows and resumes a hidden consumer after %s work and cache eviction",async(result)=>{
  const complete=deferred<TranscriptPage>();let actor:TranscriptHistoryReader;let job=true,continuations=0;
  const large=(from:number,id:string)=>page(from,from+60,{readerId:id,reachedFence:false,items:Array.from({length:60},(_,i)=>row(from+i,"g","x".repeat(8100)))});
  mock.invoke.mockImplementation(async(cmd:string,args:any)=>{
   if(cmd==="open_transcript_history"){
    if(args.request.expectedAgentSessionId.startsWith("noise"))return large(10000,args.request.expectedAgentSessionId);
    queueMicrotask(()=>actor.dispose());return page(100,101,{scanContinuation:"initial-work",reachedStart:false,reachedFence:false});
   }
   if(cmd==="read_transcript_history_page"){
    if(args.request.readerId.startsWith("noise"))return large(Number(args.request.cursor.split("-")[1])-60,args.request.readerId);
    if(args.request.cursor==="initial-work"){if(!job)throw "cursorExpired";continuations++;if(result==="readerBusy" && continuations<=3)throw "readerBusy";return complete.promise.then(p=>{job=false;return p;});}
    return ["older-101","latest-101"].includes(args.request.cursor)?page(0,101):page(101,102);
   }
   if(cmd==="refresh_transcript_history_tail"){if(job)throw "readerBusy";return page(101,102);}
   return null;
  });
  actor=make("initial-progress");const keeper=make("initial-progress");keeper.setVisible(false);await flush();
  expect(keeper.snapshot.items.map(i=>i.text)).toEqual(["message 100"]);await vi.advanceTimersByTimeAsync(1);expect(continuations).toBe(1);
  if(result==="readerBusy")await vi.advanceTimersByTimeAsync(800);
  complete.resolve(page(0,101));await flush();if(result==="complete")expect(job).toBe(false);
  const noise=Array.from({length:6},(_,i)=>make(`noise-${i}`));await flush();
  for(let n=0;n<4;n++)for(const r of noise){await r.load("older");expect(archiveCacheStats().bytes).toBeLessThanOrEqual(ARCHIVE_CACHE_BYTES);}
  keeper.setVisible(true);await vi.advanceTimersByTimeAsync(100);expect(keeper.snapshot.continuation).toBeNull();const latest=keeper.latest();await vi.advanceTimersByTimeAsync(100);await latest;expect(keeper.snapshot.notice).not.toBe("readerBusy");expect(keeper.snapshot.items.map(i=>i.text)).toEqual(["message 101"]);expect(continuations).toBe(result==="complete"?1:4);expect(job).toBe(false);
 });
 it.each([1,2])("R6 replaces distant unselected pages across five full windows with %i consumers per source",async(copies)=>{
  const large=(from:number)=>page(from,from+60,{reachedFence:false,items:Array.from({length:60},(_,i)=>row(from+i,"g","x".repeat(8100)))});
  mock.invoke.mockImplementation(async(cmd:string,args:any)=>{
   if(cmd==="open_transcript_history")return large(10000);
   if(cmd==="read_transcript_history_page")return large(Number(args.request.cursor.split("-")[1])-60);
   return null;
  });
  const views=Array.from({length:5*copies},(_,i)=>make(`cache-${Math.floor(i/copies)}`));await flush();
  for(let n=0;n<4;n++)for(const r of views){await r.load("older");expect(archiveCacheStats().bytes).toBeLessThanOrEqual(ARCHIVE_CACHE_BYTES);}
  const old=views[0].snapshot.olderCursor;await views[0].load("older");
  expect(views[0].snapshot.notice).not.toBe("readerBusy");expect(views[0].snapshot.olderCursor).not.toBe(old);expect(archiveCacheStats().bytes).toBeLessThanOrEqual(ARCHIVE_CACHE_BYTES);
  for(const r of views)for(let i=1;i<r.snapshot.items.length;i++)expect(r.snapshot.items[i].sourceStart).toBe(r.snapshot.items[i-1].sourceEnd);
 });
});
