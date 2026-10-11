import { useEffect, useRef, useSyncExternalStore } from "react";
import { TranscriptSearch, TRANSCRIPT_SEARCH_QUERY_LIMIT, type TranscriptSearchState } from "../../stores/transcriptSearchStore";

function reasonText(reason: string | null): string {
  if (reason === "readerBusy") return "読み取りが混み合っているため、途中で止まりました";
  if (reason === "readTimeout") return "読み取りを待つ時間の上限で、途中で止まりました";
  if (reason === "incompleteRecord") return "書き込み途中の記録はまだ検索できません";
  if (reason === "sourceChanged" || reason === "bindingChanged") return "会話の記録が変わったため、途中で止まりました";
  return "読み取れない記録があり、途中で止まりました";
}
export function transcriptSearchStatusText(state: TranscriptSearchState): string {
  const count = state.matches.length.toLocaleString("ja-JP");
  if (state.status === "idle") return "この会話の過去の発言を検索";
  if (state.status === "composing") return "日本語の入力を確定すると検索します";
  if (state.status === "unavailable") return "このタブの会話記録を確認できると検索できます";
  if (state.status === "limited") return `${count} 件以上 · 件数の上限で止めました`;
  if (state.status === "complete") return state.matches.length ? `全 ${count} 件（表示本文） · 最初まで検索しました` : "表示本文に見つかりません · 最初まで検索しました";
  if (state.status === "stopped") return `ここまでで ${count} 件 · 途中で止めました`;
  if (state.status === "partial") return `ここまでで ${count} 件 · ${reasonText(state.reason)}`;
  return `ここまでで ${count} 件 · ${state.status === "waiting" ? "検索を準備中" : "さかのぼって検索中"}`;
}

export function TranscriptHistorySearchBar({ search, onClose, newTail = false, visible = true }: { search: TranscriptSearch; onClose: () => void; newTail?: boolean; visible?: boolean }) {
  const state = useSyncExternalStore(search.subscribe, search.getSnapshot, search.getSnapshot);
  const bar = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const compositionEndedAt = useRef(-Infinity);
  const actions = useRef({ onClose }); actions.current = { onClose };
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!bar.current?.contains(event.target as Node)) return;
      // Native capture precedes the terminal/global shortcut bubble handlers.
      // Leave default text/IME editing intact, including the confirming Enter.
      event.stopPropagation(); event.stopImmediatePropagation();
      if (composing.current || event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") { event.preventDefault(); actions.current.onClose(); }
      else if (event.key === "Enter" && event.target === input.current) {
        event.preventDefault();
        if (Date.now() - compositionEndedAt.current > 50) search.move(event.shiftKey ? -1 : 1);
      }
    };
    document.addEventListener("keydown", keydown, true);
    return () => document.removeEventListener("keydown", keydown, true);
  }, [search]);
  const running = state.status === "waiting" || state.status === "searching" || state.navigating;
  return <div ref={bar} className="terminal-transcript-search" data-transcript-search="true" data-transcript-search-generation={state.generation} data-transcript-search-state={state.status}
    data-transcript-search-identity={state.identity ?? undefined} data-transcript-search-snapshot-end={state.snapshotEnd ?? undefined} data-transcript-search-source-generation={state.sourceGeneration ?? undefined}
    onKeyUp={event => event.stopPropagation()} onKeyPress={event => event.stopPropagation()}
    onMouseDown={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
    <input ref={input} type="search" autoFocus={visible} data-transcript-search-input="true" aria-label="会話履歴を検索"
      placeholder="この会話を検索" maxLength={TRANSCRIPT_SEARCH_QUERY_LIMIT} value={state.query}
      onChange={event => search.setQuery(event.target.value, composing.current)}
      onCompositionStart={() => { composing.current = true; search.setQuery(input.current?.value ?? "", true); }}
      onCompositionEnd={event => { composing.current = false; compositionEndedAt.current = Date.now(); search.setQuery(event.currentTarget.value); }} />
    <div className="terminal-transcript-search__controls">
      <button type="button" disabled={state.selected <= 0 || state.status === "composing"} onClick={() => search.move(-1)}>前へ</button>
      <button type="button" disabled={!state.matches.length || state.selected >= state.matches.length - 1 || state.status === "composing"} onClick={() => search.move(1)}>次へ</button>
      {running ? <button type="button" onClick={() => search.stop()}>止める</button> : <button type="button" disabled={!state.normalizedQuery || state.status === "composing"} onClick={() => search.restart()}>もう一度検索</button>}
      {state.selected >= 0 ? <span>{state.selected + 1}/{state.matches.length.toLocaleString("ja-JP")} 件目</span> : null}
    </div>
    <div role="status" aria-live="polite" data-transcript-search-status="true">{transcriptSearchStatusText(state)}</div>
    {state.navigating ? <div role="status">一致した発言へ移動中</div> : state.navigationReason ? <div role="status">一致した発言を表示できません。もう一度検索して試してください。</div> : null}
    <div className="terminal-transcript-search__scope">一致する発言を数えます。長い本文の続きは対象外。開始時点の記録を検索します。{newTail ? "新しい記録は、もう一度検索すると探せます。" : ""}</div>
  </div>;
}
