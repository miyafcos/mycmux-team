import { useEffect, useMemo, useRef, useState } from "react";
import { OverlayShell } from "../common/OverlayShell";
import { useWorkspaceListStore } from "../../stores/workspaceListStore";
import { useSessionAttentionStore } from "../../stores/sessionAttentionStore";
import { useGroupingRuntimeStore } from "../../stores/groupingRuntimeStore";
import { useLauncherDirsStore } from "../../stores/launcherDirsStore";
import { getWindowFragments, type WindowFragment } from "../../lib/ipc";
import { windowLabel } from "../../lib/windowContext";
import { getTabDisplayLabel } from "../../lib/tabDisplayLabel";
import { beginGroupingTrace } from "../../lib/groupingDiagnostics";
import { boundedGroupingWait } from "../../lib/groupingWaits";
import { navigateOverviewCard } from "../../lib/workOverviewNavigation";
import { activityAge, buildOverviewSnapshot, buildOverviewSuggestions, overviewGatherPlan, overviewVisibleKeys,
  OVERVIEW_STATE_LABELS, type OverviewCard, type OverviewState, type OverviewSuggestion } from "../../lib/workOverview";
import { groupingBoundary } from "../layout/groupingBoundary";
import { useUiStore } from "../../stores/uiStore";
import { groupingCommitFailureMessage, groupingPrepareFailureMessage, groupingUndoFailureMessage } from "../layout/TabGroupingPanel";
import "./WorkOverview.css";

const FOLD_KEY = "mycmux.overview.folded.v1";
let peerCache: { fragments: WindowFragment[]; confirmedAt: number | null } = { fragments: [], confirmedAt: null };
function readFolded(): Record<string, string> {
  try { const raw = JSON.parse(localStorage.getItem(FOLD_KEY) ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(raw).filter(([, value]) => typeof value === "string")) as Record<string, string>; }
  catch { return {}; }
}
interface Props { open: boolean; closing?: boolean; onClose: () => void; onLegacy: () => void }
export function WorkOverview({ open, closing = false, onClose, onLegacy }: Props) {
  const workspaces = useWorkspaceListStore(state => state.workspaces);
  const registryView = useLauncherDirsStore(state => state.view);
  const undo = useGroupingRuntimeStore(state => state.undo);
  const poisoned = useGroupingRuntimeStore(state => state.poisoned);
  const [status, setStatus] = useState(() => useSessionAttentionStore.getState());
  const [now, setNow] = useState(Date.now);
  const [peers, setPeers] = useState(peerCache);
  const [folded, setFolded] = useState(readFolded);
  const [filter, setFilter] = useState<OverviewState | "all">("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [peerError, setPeerError] = useState(false);
  const busy = useRef(false);
  const ownWindow = windowLabel();
  const snapshot = useMemo(() => buildOverviewSnapshot({ workspaces, ownWindow, fragments: peers.fragments,
    attention: status.attentionBySession, signals: status.statusSignalsBySession, peerConfirmedAt: peers.confirmedAt }),
  [workspaces, ownWindow, peers, status]);
  const [baseKeys, setBaseKeys] = useState(() => snapshot.cards.map(card => card.key));
  const priorCards = useRef(new Set(snapshot.cards.map(card => card.key)));
  const initialNotifications = useRef(new Map(snapshot.cards.map(card => [card.key, card.notificationKey])));
  const trace = useRef<ReturnType<typeof beginGroupingTrace> | null>(null);
  useEffect(() => {
    trace.current = beginGroupingTrace(); trace.current.mark("scan"); trace.current.finish("shown");
  }, []);
  useEffect(() => {
    if (!open) return;
    let disposed = false, fetching = false;
    const updatePeers = async () => {
      if (disposed || fetching || document.visibilityState === "hidden") return;
      fetching = true;
      try {
        const fragments = await boundedGroupingWait(getWindowFragments(), 3_000);
        if (!disposed) { peerCache = { fragments, confirmedAt: Date.now() }; setPeers(peerCache); setPeerError(false); }
      } catch { if (!disposed) setPeerError(true); }
      finally { fetching = false; }
    };
    void updatePeers();
    const peerTimer = setInterval(() => void updatePeers(), 10_000);
    const statusTimer = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      // Canonical signals only; no PTY tail reads or output subscriptions.
      setStatus(useSessionAttentionStore.getState());
      setNow(Date.now());
    }, 1_000);
    const visible = () => { if (document.visibilityState === "visible") void updatePeers(); };
    document.addEventListener("visibilitychange", visible);
    return () => { disposed = true; clearInterval(peerTimer); clearInterval(statusTimer); document.removeEventListener("visibilitychange", visible); };
  }, [open]);
  useEffect(() => {
    const additions = snapshot.cards.filter(card => !priorCards.current.has(card.key) && (filter === "all" || card.state === filter)).map(card => card.key);
    priorCards.current = new Set(snapshot.cards.map(card => card.key));
    if (additions.length) setBaseKeys(keys => [...keys, ...additions.filter(key => !keys.includes(key))]);
  }, [snapshot.cards, filter]);
  const keys = overviewVisibleKeys(snapshot.cards, filter, folded, baseKeys);
  const cardsByKey = new Map(snapshot.cards.map(card => [card.key, card]));
  const cards = keys.map(key => cardsByKey.get(key)!).filter(Boolean);
  const proposals = useMemo(() => buildOverviewSuggestions(snapshot.cards, registryView?.doc?.entries ?? [], folded),
    [snapshot.cards, registryView, folded]);
  const [displayedProposals, setDisplayedProposals] = useState(proposals);
  const newCount = snapshot.cards.filter(card => card.notificationKey && initialNotifications.current.get(card.key) !== card.notificationKey).length;
  const refresh = (nextFilter = filter) => {
    setFilter(nextFilter);
    setBaseKeys(overviewVisibleKeys(snapshot.cards, nextFilter, {}));
    setDisplayedProposals(proposals);
    initialNotifications.current = new Map(snapshot.cards.map(card => [card.key, card.notificationKey]));
  };
  const fold = (card: OverviewCard) => {
    if (card.state !== "done" || !card.notificationKey) return;
    const next = { ...folded, [card.key]: card.notificationKey };
    setFolded(next);
    setDisplayedProposals(rows => rows.filter(row => row.cardKey !== card.key));
    try { localStorage.setItem(FOLD_KEY, JSON.stringify(next)); } catch { /* Client-local acknowledgement. */ }
    beginGroupingTrace().finish("folded");
  };
  const apply = (proposal: OverviewSuggestion) => {
    if (busy.current) return;
    const card = cardsByKey.get(proposal.cardKey);
    if (!card) return;
    if (proposal.kind === "fold") { fold(card); return; }
    // Recheck ownership/evidence against the latest layout, rather than a displayed stale row.
    const current = useWorkspaceListStore.getState().workspaces;
    const live = buildOverviewSnapshot({ workspaces: current, ownWindow, attention: useSessionAttentionStore.getState().attentionBySession });
    const checked = buildOverviewSuggestions(live.cards, registryView?.doc?.entries ?? [], folded)
      .find(item => item.id === proposal.id && item.kind === "gather");
    if (!checked || checked.kind !== "gather" || checked.windowLabel !== ownWindow) { setNotice("置き場が変わりました。提案を更新してください。"); return; }
    const plan = overviewGatherPlan(checked, current);
    if (!plan) { setNotice("置き場が変わりました。提案を更新してください。"); return; }
    busy.current = true;
    const actionTrace = beginGroupingTrace();
    try {
      actionTrace.mark("prepare");
      const prepared = groupingBoundary.prepare(plan, {
        baseline: current.flatMap(workspace => workspace.panes.flatMap(pane => pane.tabs.map(tab => ({
          tabId: tab.id, sessionId: tab.sessionId, workspaceId: workspace.id, paneId: pane.id,
        })))),
        activeWorkspaceId: useWorkspaceListStore.getState().activeWorkspaceId,
        activeSessionId: useUiStore.getState().activePaneId ?? useUiStore.getState().lastActivePaneId,
        allocationSeed: crypto.randomUUID(), createdAt: Date.now(),
      });
      if (!prepared.ok) { setNotice(groupingPrepareFailureMessage(prepared)); actionTrace.finish("error"); return; }
      actionTrace.mark("apply");
      const result = groupingBoundary.commit(plan, prepared.ticket);
      actionTrace.finish(result.commit.ok ? "applied" : "error");
      setNotice(result.commit.ok ? "寄せました。元に戻せます。" : groupingCommitFailureMessage(result.commit));
    } catch { actionTrace.finish("error"); setNotice("寄せられませんでした。今の配置を確認してください。"); }
    finally { busy.current = false; }
  };
  const undoAction = () => {
    const actionTrace = beginGroupingTrace(); actionTrace.mark("apply");
    const result = groupingBoundary.undo();
    actionTrace.finish(result.ok ? "undone" : "error");
    setNotice(result.ok ? "前の配置に戻しました。" : groupingUndoFailureMessage(result));
  };
  const view = async (card: OverviewCard) => {
    setSelected(card.key);
    try { await navigateOverviewCard(card); onClose(); }
    catch { setNotice("そのペインへ移れませんでした。窓と置き場を更新してください。"); }
  };
  const groups = new Map<string, { card: OverviewCard; cards: OverviewCard[] }>();
  for (const card of cards) {
    const key = card.windowLabel + ":" + card.workspaceId + ":" + card.paneId;
    const group = groups.get(key) ?? { card, cards: [] };
    group.cards.push(card); groups.set(key, group);
  }
  const foldedCards = snapshot.cards.filter(card => card.state === "done" && card.notificationKey && folded[card.key] === card.notificationKey);
  return <OverlayShell open={open} closing={closing} onClose={onClose} size="wide" ariaLabel="整理" id="work-overview-panel">
    <section className="cmux-work-overview" data-work-overview="true">
      <header><strong>整理</strong><span>{new Date(now).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })} の状態 · {snapshot.cards.length} ペイン</span>
        <button type="button" onClick={onClose} aria-label="整理を閉じる">×</button></header>
      <nav aria-label="仕事の状態">
        <button aria-pressed={filter === "all"} onClick={() => refresh("all")}>すべて {snapshot.cards.length}</button>
        {(Object.keys(OVERVIEW_STATE_LABELS) as OverviewState[]).map(state => <button key={state} aria-pressed={filter === state}
          data-overview-state={state} onClick={() => refresh(state)}>{OVERVIEW_STATE_LABELS[state]} {snapshot.counts[state]}</button>)}
      </nav>
      <div className="cmux-work-overview-notice">
        <span>{newCount ? "新しい知らせ " + newCount + " 件" : "今いるタブのまとまりで見渡せます"}</span>
        <button onClick={() => refresh()}>一覧を更新</button>
        {undo?.status === "available" && !poisoned ? <button onClick={undoAction}>元に戻す</button> : null}
      </div>
      {notice ? <p role="status" className="cmux-work-overview-message">{notice}</p> : null}
      {peerError ? <p role="status" className="cmux-work-overview-message">別窓の置き場を取得できませんでした。前回の表示を保ち、再取得します。</p> : null}
      <div className="cmux-work-overview-body">
        <section className="cmux-work-overview-proposals" aria-label="提案">
          <h2>提案 <span>1 つずつ、取り消せます</span></h2>
          {displayedProposals.length ? displayedProposals.map(proposal => <div key={proposal.id} className="cmux-work-overview-proposal">
            <div><strong>{proposal.title}</strong><p>{proposal.reason}</p></div>
            <button disabled={(proposal.kind === "gather" && poisoned) || !proposals.some(current => current.id === proposal.id)} onClick={() => apply(proposal)}>{proposal.kind === "fold" ? "確認して畳む" : "寄せる"}</button>
          </div>) : <p>今のまとまりを保ちます。確かな材料がそろったときに提案します。</p>}
        </section>
        <section aria-label="仕事の見渡し">
          {[...groups].map(([key, group]) => <section className="cmux-work-overview-group" key={key}>
            <h2>{group.card.workspaceName} / {group.card.paneName}
              <span>{group.card.peer ? "別窓 " + group.card.windowLabel + " · 最終確認 " + activityAge(group.card.peerConfirmedAt, now) : "この窓"}</span></h2>
            {group.cards.map(card => <article key={card.key} data-overview-card={card.key} data-session-id={card.tab.sessionId}
              aria-current={selected === card.key ? "true" : undefined} className={"cmux-work-overview-card" + (selected === card.key ? " is-selected" : "")}
              onFocus={() => setSelected(card.key)}>
              <div><strong>{getTabDisplayLabel(card.tab)}</strong><span>{card.workspaceName} / {card.paneName}</span></div>
              <div className="cmux-work-overview-state"><span>{OVERVIEW_STATE_LABELS[card.state]}</span><span>{activityAge(card.lastActivityAt, now)}</span></div>
              <button onClick={() => void view(card)}>見る →</button>
              <div className="cmux-work-overview-fold-action">{card.state === "done" && card.notificationKey ? <button onClick={() => fold(card)}>確認して畳む</button> : null}</div>
            </article>)}
          </section>)}
          {!cards.length ? <p>この状態のペインはありません。</p> : null}
        </section>
        {foldedCards.length ? <details className="cmux-work-overview-folded"><summary>確認済み {foldedCards.length} ペイン</summary>
          {foldedCards.map(card => <div key={card.key}>{getTabDisplayLabel(card.tab)} <button onClick={() => { const next = { ...folded }; delete next[card.key]; setFolded(next);
            try { localStorage.setItem(FOLD_KEY, JSON.stringify(next)); } catch { /* Optional. */ } }}>もう一度見る</button></div>)}</details> : null}
      </div>
      <footer><span>新しい知らせは数で表示します。一覧は「更新」で絞り直せます。</span><button onClick={onLegacy}>前の 3 案で並べ直す</button></footer>
    </section>
  </OverlayShell>;
}
