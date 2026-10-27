import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ArchiveItem, TranscriptDescriptor } from "../../lib/livebrief";
import { dashboardStrings } from "./dashboardStrings";
import { TranscriptHistoryReader, descriptorKey } from "../../stores/transcriptHistoryStore";
import { useDashboardViewStore } from "../../stores/dashboardViewStore";
import { labelsMatch } from "../terminal/terminalTurnChipState";
import { DashboardLinkedText, type DashboardLinkContext } from "./DashboardLinkedText";
import { MarkdownView } from "./MarkdownView";
import { useTranscriptHistory } from "./useTranscriptHistory";
import { ArchiveHeights, archiveLayout, archiveWindow, anchoredScrollTop, archiveBodyBlocks, indexAt, type ArchiveAnchor } from "./archiveWindow";
import { matchesTranscriptQuery, TRANSCRIPT_SEARCH_WAIT_MS } from "../../stores/transcriptSearchStore";

const explanations: Record<string,string> = {
  unlinked:"会話の記録はまだ関連付けられていません", recordMissing:"この会話の記録はまだ見つかりません",
  permissionDenied:"この会話の記録を読み取れません", ambiguousSource:"同じ会話の記録が複数あり、開けません",
  identityMismatch:"会話の記録と関連付けが一致しません", sourceChanged:"記録が変更されました。表示中の内容を保持しています",
  cursorExpired:"会話の読み取り期限が切れました。開き直せます", bindingChanged:"以前の会話を表示しています（追記の表示は停止中）",
  readerBusy:"ほかの会話を読み取り中です。少し待って再試行できます", unsupportedAgent:"このタブには会話記録がありません",
  locatingRecord:"この会話の記録を探しています", incompleteRecord:"書き込み途中の記録の完成を待っています",
  contextPending:"前の文脈を読み取っています", searching:"前の会話を検索しています", targetMissing:"指定した発言は記録に見つかりませんでした",
  searchPaused:"検索を一時停止しました。再試行できます", selectionPaused:"選択を解除すると検索できます",
  ambiguousTarget:"同じ発言の参照が複数あり、移動できません",
  anchorPaused:"読んでいる位置を保ちました。表示中の会話を移動してから、もう一度試してください",
};
const explain=(code:string)=>explanations[code]??"会話を読み取れませんでした。再試行できます";
const last=<T,>(items:readonly T[]):T|undefined=>items[items.length-1];

export interface ArchiveTranscriptProps {
  descriptor: TranscriptDescriptor | null;
  visible?: boolean;
  prepared?: TranscriptHistoryReader;
  tabId?: string | null;
  context?: DashboardLinkContext | null;
  targetEventId?: string | null;
  targetEventRequest?: number;
  onUserMessages?: (messages: readonly {text:string;occurredAt:number}[]) => void;
  transcriptSearch?: { query: string; targetId: string | null; generation: number; navigation: number; identity: string | null; snapshotEnd: string | null; sourceGeneration: string | null };
  onSearchNavigation?: (generation: number, navigation: number, pending: boolean, reason?: string | null) => void;
}
export function ArchiveTranscript(props:ArchiveTranscriptProps) {
  const reader=useTranscriptHistory(props.descriptor,props.prepared);
  if(!reader) return <ArchiveEmpty unavailable reason={explain("unlinked")}/>;
  return <ArchiveReaderView reader={reader} {...props}/>;
}

/** A cancelled read still drains on the shared connection. Wait for its
 * consumer loading state before find(fromLatest), without changing latest's
 * existing ordinary-reader contract. The caller owns the deadline. */
function waitForReaderIdle(reader: TranscriptHistoryReader, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const changed = () => {
      if (!signal.aborted && reader.snapshot.loading && reader.snapshot.status !== "closed") return;
      unsubscribe(); signal.removeEventListener("abort", changed); resolve();
    };
    const unsubscribe = reader.subscribe(changed);
    signal.addEventListener("abort", changed, { once: true });
    changed();
  });
}

function ArchiveReaderView({reader,descriptor,visible=true,tabId,context=null,targetEventId,targetEventRequest=0,onUserMessages,transcriptSearch,onSearchNavigation}:ArchiveTranscriptProps&{reader:TranscriptHistoryReader}) {
  const state=useSyncExternalStore(reader.subscribe,reader.getSnapshot,reader.getSnapshot);
  useEffect(()=>{
    if(state.status!=="ready" || !descriptor || descriptorKey(descriptor)!==descriptorKey(state.descriptor)) return;
    const messages=state.items.filter((i)=>i.kind==="user" && i.timestamp!==null && !i.bodyRef).map((i)=>({text:i.text,occurredAt:i.timestamp!}));
    if(messages.length)onUserMessages?.(messages);
  },[state.items,state.status,state.descriptor,descriptor,onUserMessages]);
  const log=useRef<HTMLDivElement>(null);
  const heights=useRef(new ArchiveHeights());
  const anchor=useRef<ArchiveAnchor|null>(null);
  const pendingJump=useRef<string|null>(null);
  const [geometry,setGeometry]=useState({top:0,height:600});
  const [measurement,setMeasurement]=useState(0);
  const [body,setBody]=useState<ArchiveItem|null>(null);
  const [showRecords,setShowRecords]=useState(false);
  const [toolReveal,setToolReveal]=useState<{id:string;request:number}|null>(null);
  const recordCount=state.items.filter((item)=>item.kind==="source"||item.kind==="diagnostic").length;
  const displayItems=useMemo(()=>showRecords?state.items:state.items.filter((item)=>item.kind!=="source"&&item.kind!=="diagnostic"),[state.items,showRecords]);
  const [searching,setSearching]=useState(false);
  const navigation=useRef(0);
  useEffect(()=>()=>{navigation.current++;reader.cancelSearch();},[reader]);
  const [selected,setSelected]=useState(false);
  const selectionWindow=useRef<ReturnType<typeof archiveWindow>|null>(null);
  const layout=useMemo(()=>archiveLayout(displayItems,heights.current),[displayItems,measurement]);
  const computedWindow=archiveWindow(layout,geometry.top,geometry.height,body?96:120);
  const computedWindowRef=useRef(computedWindow);computedWindowRef.current=computedWindow;
  const windowed=selected&&selectionWindow.current?selectionWindow.current:computedWindow;
  const mounted=displayItems.slice(windowed.start,windowed.end);
  const capture=()=>{
    const node=log.current; if(!node) return;
    const top=node.getBoundingClientRect().top;
    const first=Array.from(node.querySelectorAll<HTMLElement>("[data-archive-row]")).find((row)=>row.getBoundingClientRect().bottom>top);
    if(first) {anchor.current={id:first.dataset.archiveRow!,offset:first.getBoundingClientRect().top-top};reader.setAnchor(first.dataset.archiveRow!);}
  };
  const updateGeometry=()=>{ const node=log.current; if(node) setGeometry({top:node.scrollTop,height:node.clientHeight||600}); };
  useLayoutEffect(()=>{
    reader.setBeforeMutation(capture); return ()=>reader.setBeforeMutation(null);
  },[reader]);
  useLayoutEffect(()=>{
    const node=log.current; if(!node) return;
    if(pendingJump.current) {
      const index=displayItems.findIndex((i)=>i.occurrenceId===pendingJump.current);
      if(index>=0) { node.scrollTop=layout[index]; pendingJump.current=null; }
    } else if(state.following && state.reachedFence && !selected) node.scrollTop=node.scrollHeight;
    else if(anchor.current && !selected) { const top=anchoredScrollTop(anchor.current,displayItems,layout); if(top!==null) node.scrollTop=top; }
    updateGeometry(); capture();
  },[displayItems,layout,state.following,state.reachedFence,selected]);
  useLayoutEffect(()=>{
    const node=log.current; if(!node || typeof ResizeObserver==="undefined") return;
    const observer=new ResizeObserver((entries)=>{
      if(selected) return;
      let changed=false;
      for(const entry of entries) {
        const element=entry.target as HTMLElement;
        if(element.dataset.archiveRow) changed=heights.current.set(element.dataset.archiveRow,element.getBoundingClientRect().height)||changed;
      }
      if(changed) setMeasurement((value)=>value+1);
      if(entries.some((e)=>e.target===node)) updateGeometry();
    });
    observer.observe(node); node.querySelectorAll("[data-archive-row]").forEach((row)=>observer.observe(row));
    return ()=>observer.disconnect();
  },[displayItems,windowed.start,windowed.end,selected]);
  useEffect(()=>{
    const visibility=()=>reader.setVisible(visible && !document.hidden);
    const selection=()=>{ const s=window.getSelection(); const active=!!s && !s.isCollapsed && !!s.anchorNode && !!log.current?.parentElement?.contains(s.anchorNode); if(active&&!selectionWindow.current) selectionWindow.current=computedWindowRef.current; if(!active) selectionWindow.current=null; reader.setSelection(active); setSelected(active); };
    visibility(); document.addEventListener("visibilitychange",visibility); document.addEventListener("selectionchange",selection);
    return ()=>{document.removeEventListener("visibilitychange",visibility);document.removeEventListener("selectionchange",selection);reader.setSelection(false);};
  },[reader,visible]);
  useEffect(()=>{setBody(null);setShowRecords(false);},[state.sourceGeneration]);
  const jump=(item:ArchiveItem)=>{ reader.setFollowing(false); capture(); pendingJump.current=item.occurrenceId; setGeometry((old)=>({...old,top:layout[displayItems.findIndex((i)=>i.occurrenceId===item.occurrenceId)]??0})); setMeasurement((m)=>m+1); };
  const visibleIndex=indexAt(layout,geometry.top);
  const turns=state.items.filter((i)=>i.kind==="user");
  const currentTurn=last(displayItems.slice(0,visibleIndex+1).filter((i)=>i.kind==="user"))??turns[0];
  const step=async(delta:-1|1)=>{
    reader.setFollowing(false); const current=currentTurn; const index=turns.findIndex((i)=>i.occurrenceId===current?.occurrenceId);
    const target=turns[index+delta]; if(target) {jump(target);return;}
    const before=current?BigInt(current.sourceStart):null;
    const ticket=++navigation.current;setSearching(true);
    try { while(ticket===navigation.current && reader.visible) {
      const direction=delta===-1?"older":"newer";
      const cursor=delta===-1?reader.snapshot.olderCursor:reader.snapshot.newerCursor;
      await reader.load(direction,{navigate:true}); if(ticket!==navigation.current) return;
      const candidates=reader.snapshot.items.filter((i)=>i.kind==="user" && (before===null||(delta===-1?BigInt(i.sourceStart)<before:BigInt(i.sourceStart)>before)));
      const next=delta===-1?last(candidates):candidates[0];
      if(next) {pendingJump.current=next.occurrenceId;setMeasurement((m)=>m+1);return;}
      if((delta===-1?reader.snapshot.reachedStart:reader.snapshot.reachedFence)||reader.snapshot.error||!reader.visible||cursor===(delta===-1?reader.snapshot.olderCursor:reader.snapshot.newerCursor)) return;
    } } finally { if(ticket===navigation.current)setSearching(false); }
  };
  const request=useDashboardViewStore((s)=>tabId?s.userTurnRequests[tabId]??null:null);
  const requestBusy=useRef<number|null>(null);
  useEffect(()=>{
    if(!request||!tabId||state.loading||requestBusy.current===request.seq) return;
    const claimed=useDashboardViewStore.getState().claimUserTurnRequest(tabId,request.seq); if(!claimed) return;
    requestBusy.current=request.seq;
    const navigate=async()=>{
      setSearching(true);
      try {
        if(request.kind==="step") await step(request.delta);
        else if(request.kind==="label") { const item=await reader.find((i)=>i.kind==="user"&&labelsMatch(request.label,i.text),{fromLatest:true}); if(item) {pendingJump.current=item.occurrenceId;setMeasurement((m)=>m+1);} }
        else { await reader.latest(); const item=last(reader.snapshot.items.filter((i)=>i.kind==="user")); if(item) {pendingJump.current=item.occurrenceId;setMeasurement((m)=>m+1);} }
      } finally {setSearching(false);}
    };
    void navigate();
  },[request,tabId,state.loading]);
  const targetKey=useRef<string|null>(null);
  const targetReady=state.status==="ready" && !!state.sourceGeneration;
  const [activeSearchMatch, setActiveSearchMatch] = useState<string | null>(null);
  useEffect(() => {
    if(selected)return;
    setActiveSearchMatch(null);
    const target = transcriptSearch?.targetId;
    if (!target || !visible || transcriptSearch.identity !== descriptorKey(state.descriptor)) return;
    const report = (pending: boolean, reason: string | null = null) => onSearchNavigation?.(transcriptSearch.generation, transcriptSearch.navigation, pending, reason);
    if (!targetReady) { if (state.error) report(false, state.error); return; }
    const abort = new AbortController();
    let cancelled = false;
    report(true);
    const timer = setTimeout(() => { abort.abort(); report(false, "readTimeout"); }, TRANSCRIPT_SEARCH_WAIT_MS);
    const navigate = async () => {
      try {
        // Recheck after each wake: an ordinary jump can acquire the reader
        // before this continuation resumes. No await separates the final
        // loading check from find's synchronous latest startup.
        while (reader.snapshot.loading && reader.snapshot.status !== "closed" && !abort.signal.aborted) await waitForReaderIdle(reader, abort.signal);
        if (cancelled || abort.signal.aborted) return;
        if (reader.snapshot.status === "closed") { report(false, "targetMissing"); return; }
        const item = await reader.find(item => item.occurrenceId === target, { fromLatest: true, signal: abort.signal });
        if (cancelled || abort.signal.aborted) return;
        if (!item) { report(false, reader.snapshot.error ?? reader.snapshot.notice ?? "targetMissing"); return; }
        if(item.kind==="source"||item.kind==="diagnostic")setShowRecords(true);
        setToolReveal(previous=>({id:item.occurrenceId,request:(previous?.request??0)+1}));
        pendingJump.current = item.occurrenceId;
        setActiveSearchMatch(item.occurrenceId);
        setMeasurement(value => value + 1);
        report(false);
      } catch (error) { if (!cancelled && !abort.signal.aborted) report(false, String(error)); }
      finally { clearTimeout(timer); }
    };
    void navigate();
    return () => { cancelled = true; clearTimeout(timer); abort.abort(); if (pendingJump.current === target) pendingJump.current = null; };
  }, [reader, transcriptSearch?.targetId, transcriptSearch?.generation, transcriptSearch?.navigation, transcriptSearch?.identity, visible, targetReady, state.error, onSearchNavigation, selected]);
  useEffect(()=>{
    if(!targetEventId||!targetReady||selected) return;
    const key=`${targetEventId}:${targetEventRequest}:${state.sourceGeneration}`; if(targetKey.current===key) return;
    let cancelled=false;setSearching(true);
    const prefix=`${state.descriptor.expectedAgentKind}:${state.descriptor.expectedAgentSessionId}:${state.sourceGeneration}:`;
    const exact=targetEventId.startsWith(prefix) && /^\d+:\d+$/.test(targetEventId.slice(prefix.length));
    void reader.find((i)=>exact?i.occurrenceId===targetEventId:i.aliases.includes(targetEventId),{unique:!exact,fromLatest:true}).then((item)=>{if(!cancelled&&item){targetKey.current=key;if(item.kind==="source"||item.kind==="diagnostic")setShowRecords(true);setToolReveal(previous=>({id:item.occurrenceId,request:(previous?.request??0)+1}));pendingJump.current=item.occurrenceId;setMeasurement((m)=>m+1);}}).finally(()=>{if(!cancelled)setSearching(false);});
    return ()=>{cancelled=true;setSearching(false);};
  },[targetEventId,targetEventRequest,targetReady,reader,selected]);
  const different=!!descriptor&&descriptorKey(descriptor)!==descriptorKey(state.descriptor);
  const searchFence = transcriptSearch?.query && transcriptSearch.identity === descriptorKey(state.descriptor)
    && transcriptSearch.sourceGeneration === state.sourceGeneration && transcriptSearch.snapshotEnd !== null ? BigInt(transcriptSearch.snapshotEnd) : null;
  const activeTarget = searchFence !== null && transcriptSearch?.targetId === activeSearchMatch ? activeSearchMatch : null;
  return <div className="cmux-archive-transcript" data-archive-view="true">
    <div className="cmux-archive-actions">
      <button type="button" disabled={!!state.loading||selected||!state.items.length} onClick={()=>{const ticket=++navigation.current;setSearching(true);void reader.first().then((reached)=>{if(ticket===navigation.current && reached){pendingJump.current=reader.snapshot.items.find((item)=>showRecords||(item.kind!=="source"&&item.kind!=="diagnostic"))?.occurrenceId??null;setMeasurement((m)=>m+1);}}).finally(()=>{if(ticket===navigation.current)setSearching(false);});}}>最初へ</button>
      <button type="button" disabled={!!state.loading||selected||state.status!=="ready"} onClick={()=>void reader.latest()}>最新へ</button>
      {searching?<button type="button" onClick={()=>{navigation.current++;reader.cancelSearch();setSearching(false);}}>検索を停止</button>:null}
      {different?<button type="button" onClick={()=>reader.reopen(descriptor!)}>現在の会話を開く</button>:null}
      {(state.error||state.notice==="readerBusy")&&!different?<button type="button" onClick={()=>reader.reopen()}>もう一度開く</button>:null}
      {recordCount?<button type="button" aria-pressed={showRecords} disabled={selected} title="読み込み済みの未分類・大きい記録を表示" onClick={()=>{capture();setShowRecords((shown)=>!shown);}}>記録の詳細 {recordCount}件</button>:null}
      <span>端末の履歴は Shift+ホイール</span>
    </div>
    {state.error?<div role="status" className="cmux-archive-notice">{explain(state.error)}</div>:null}
    {state.notice?<div role="status" className="cmux-archive-notice">{explain(state.notice)}</div>:null}
    <div className="cmux-archive-nav">
      <button type="button" aria-label="前の指示へ" disabled={!!state.loading||selected||(!turns.length&&state.reachedStart)} onClick={()=>void step(-1)}>▲</button>
      <button type="button" aria-label="次の指示へ" disabled={!!state.loading||selected||(state.following&&state.reachedFence)} onClick={()=>void step(1)}>▼</button>
      <span>{turns.length?`${Math.max(1,turns.findIndex((t)=>t.occurrenceId===currentTurn?.occurrenceId)+1)}/${turns.length}（読み込み済み）`:"指示はまだありません"}</span>
      <span className="cmux-dashboard-user-turn-nav-label">{currentTurn?.text}</span>
    </div>
    {!state.reachedStart?<button type="button" className="cmux-archive-boundary" disabled={!!state.loading||selected} onClick={()=>void reader.load("older")}>前の会話を読む</button>:<div className="cmux-archive-boundary">会話の最初</div>}
    <div ref={log} className="cmux-dashboard-chat-log cmux-archive-log" role="log" aria-label="会話履歴" tabIndex={0} onScroll={()=>{
      updateGeometry(); capture(); const node=log.current!;
      reader.setFollowing(state.reachedFence&&node.scrollHeight-node.clientHeight-node.scrollTop<=24);
    }}>
      <div aria-hidden="true" style={{height:windowed.top}}/>
      {mounted.map((item)=><div key={item.occurrenceId} data-archive-row={item.occurrenceId} data-dashboard-event={item.occurrenceId}
        data-transcript-search-match={searchFence !== null && BigInt(item.sourceStart) < searchFence && BigInt(item.sourceEnd) <= searchFence && matchesTranscriptQuery(item, transcriptSearch!.query) ? "true" : undefined}
        data-transcript-search-active={activeTarget === item.occurrenceId ? "true" : undefined}
        className={`cmux-archive-row${activeTarget === item.occurrenceId ? " cmux-archive-search-active" : ""}`}><ArchiveRow item={item} context={context} bodyDisabled={selected} revealRequest={toolReveal?.id===item.occurrenceId?toolReveal.request:0} onBody={()=>{capture();setBody(item);}}/></div>)}
      <div aria-hidden="true" style={{height:windowed.bottom}}/>
      {!displayItems.length && recordCount ? <div className="cmux-archive-notice" role="status">この範囲には表示できる会話本文がありません。記録の詳細から内容を確認できます。</div> : null}
      {!state.items.length ? <ArchiveEmpty unavailable={state.status!=="ready" || !!state.error || state.notice==="readerBusy"} reason={state.error?explain(state.error):state.notice?explain(state.notice):state.loading?"会話を読み込んでいます":undefined}/> : null}
      {state.continuation?<div className="cmux-archive-pending">前の文脈を読み取っています</div>:null}
    </div>
    {!state.reachedFence?<button type="button" className="cmux-archive-boundary" disabled={!!state.loading||selected} onClick={()=>void reader.load("newer")}>後の会話を読む</button>:null}
    {state.newTail?<button type="button" onClick={()=>void reader.latest()}>新しい記録へ</button>:null}
    {body?<ArchiveBody key={body.occurrenceId} reader={reader} item={body} onClose={()=>setBody(null)}/>:null}
  </div>;
}
function ArchiveEmpty({unavailable=false,reason}:{unavailable?:boolean;reason?:string}) {
  return <div className="cmux-dashboard-chat-empty" data-dashboard-chat-empty={unavailable?"unavailable":"empty"} role="status">
    {unavailable?<><div>{dashboardStrings.chatUnavailable}</div><div>{dashboardStrings.telemetryUnavailable}{reason?` (${reason})`:""}</div></>:dashboardStrings.chatEmpty}
  </div>;
}
const ArchiveRow=memo(function ArchiveRow({item,context,onBody,bodyDisabled,revealRequest}:{item:ArchiveItem;context:DashboardLinkContext|null;onBody:()=>void;bodyDisabled:boolean;revealRequest:number}){
  const [toolOpen,setToolOpen]=useState(false);
  const appliedReveal=useRef(0);
  useEffect(()=>{if(revealRequest&&revealRequest!==appliedReveal.current&&!bodyDisabled){appliedReveal.current=revealRequest;setToolOpen(true);}},[revealRequest,bodyDisabled]);
  const role=item.kind==="user"?"私":item.kind==="assistant"?"エージェント":item.kind==="toolCall"?item.tool??"ツール":item.kind==="toolResult"?"ツール結果":item.kind==="question"?"記録された質問":item.kind==="boundary"?"会話の区切り":item.kind==="attachment"?"添付資料":"元の記録";
  const timestamp=item.timestamp===null?null:new Date(item.timestamp);
  const time=timestamp&&Number.isFinite(timestamp.getTime())?timestamp.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}):null;
  const more=item.bodyRef?<button type="button" disabled={bodyDisabled} onClick={onBody}>{item.kind==="source"||item.kind==="diagnostic"?"元の記録を表示":"本文の続きを表示"}</button>:null;
  if(item.kind==="toolCall"||item.kind==="toolResult")return <details className="cmux-dashboard-msg cmux-archive-tool" open={toolOpen} onToggle={(event)=>setToolOpen(event.currentTarget.open)}>
    <summary>{role}{item.target?<span>{item.target}</span>:null}{time?<span>{time}</span>:null}</summary>
    <div className="cmux-archive-tool-content"><div className="cmux-dashboard-msg-plain"><DashboardLinkedText text={item.text} context={context}/></div>{more}</div>
  </details>;
  return <div className={`cmux-dashboard-msg ${item.kind==="assistant"?"is-agent":item.kind==="user"?"is-user":"cmux-archive-evidence"}`}>
    <div className="cmux-dashboard-msg-who"><span>{role}</span>{time?<span>{time}</span>:null}</div>
    {item.target?<div className="cmux-archive-target">{item.target}</div>:null}
    {item.kind==="assistant"?<MarkdownView text={item.text} context={context}/>:<div className="cmux-dashboard-msg-plain"><DashboardLinkedText text={item.text} context={context}/></div>}
    {item.kind==="question"?<small>回答は端末で行います</small>:null}
    {more}
  </div>;
});
function ArchiveBody({reader,item,onClose}:{reader:TranscriptHistoryReader;item:ArchiveItem;onClose:()=>void}) {
  const [chunk,setChunk]=useState<{text:string;cursor:string|null;sourceText:boolean}|null>(null);
  const [back,setBack]=useState<(string|null)[]>([]);
  const [position,setPosition]=useState<string|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [loading,setLoading]=useState(false);
  useEffect(()=>{
    let disposed=false;const abort=new AbortController();setLoading(true);setError(null);
    void reader.readBody(item,position,abort.signal).then((p)=>{if(!disposed)setChunk(p);}).catch((e)=>{if(!disposed)setError(explain(String(e).replace(/^Error: /,"")));}).finally(()=>{if(!disposed)setLoading(false);});
    return ()=>{disposed=true;abort.abort();};
  },[reader,item,position]);
  return <section className="cmux-archive-body" aria-label="会話の本文"><div className="cmux-archive-actions">
    <span>{chunk?.sourceText?"元の記録（読み取り専用）":"本文（読み取り専用）"}</span>
    <button type="button" disabled={loading||position===null} onClick={()=>{setPosition(null);setBack([]);}}>本文の最初へ</button>
    <button type="button" disabled={loading||!back.length} onClick={()=>{setPosition(back[back.length-1]);setBack((b)=>b.slice(0,-1));}}>前へ</button>
    <button type="button" disabled={loading||!chunk?.cursor} onClick={()=>{setBack((b)=>[...b,position].slice(-4));setPosition(chunk!.cursor);}}>続きへ</button>
    <button type="button" onClick={onClose}>本文を閉じる</button>
  </div>{error?<div role="status">{error}</div>:null}<pre tabIndex={0}>{loading?"本文を読み取っています":archiveBodyBlocks(chunk?.text??"").map((text,index)=><span key={index} data-archive-body-block="true">{text}</span>)}</pre></section>;
}
