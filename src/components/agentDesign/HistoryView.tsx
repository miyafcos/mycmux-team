import { useEffect, useRef, useState } from "react";
import type { AgentDesignApi, AgentDesignCatalog, AgentServiceId, DesignGitHistory, DesignHistory, DesignHistoryChange, DesignHistoryDiff } from "../../lib/agentDesignApi";
import { agentDesignStrings as s, bytes, number } from "./agentDesignStrings";
import { dateTime, itemRole, sizeText } from "./presentation";
import { HistoryUnavailable } from "./ReviewViews";

export const historyStrings = {
  title: "いつ何が変わったか", help: "保存されたファイルの変更と、製品が実際に読んだ量の変化を別の札で表示します。",
  snapshots: "写し", git: "git", item: "項目の git 履歴", choose: "項目を選んで見る",
  filter: "層で絞る", all: "すべての層", amounts: "読む量", fileChanged: "ファイルが変わった", readAmountChanged: "読む量が変わった",
  added: "足した", deleted: "消した", changed: "変わった", renamed: "名前が変わった",
  loading: "履歴を読み込んでいます", gitLoading: "この項目の git 履歴を読んでいます",
  empty: "写しがまだありません。読み直すと最初の写しを残します。",
  one: "写しは 1 つです。次の読み直しから、2 つの写しを比べます。",
  noChanges: "写しの間に確認できる変更はありません。", noMatch: "この条件に合う変更はありません。",
  writing: "新しい写しを裏で保存しています。前に読んだ履歴を表示します。",
  error: "履歴を取得できませんでした。読み直して確認してください。",
  warning: "保存できなかった写し、または読めない写しがあります。",
  select: "変更を選ぶと、ここに差を表示します。",
  noBody: "中身は出さない", snapshotBody: "写しには本文を保存していません。大きさと更新日時、許した文書のハッシュで変更を確認します。本文の差は、この項目の git 履歴から選んでください。",
  memoryBody: "記憶の本文の差は出しません。変更があったことと大きさだけを表示します。",
  fieldBody: "秘密でない設定項目だけの差です。env の値・MCP の設定値・hooks の引数は表示しません。",
  author: "書いた人", time: "時刻", size: "大きさ", unknownSize: "大きさは不明",
  diffLoading: "選んだ変更の差を読んでいます", diffError: "この変更の差を取得できませんでした。",
  noDiff: "表示できる本文・設定項目の変更はありません。", truncated: "長い差は一部を省略しています。",
  statuses: { noRepository: "この項目の場所に git の作業ツリーはありません。", gitUnavailable: "git が見つかりません。写しの履歴を表示します。",
    timeout: "git の読取が時間の上限に達しました。写しの履歴を表示します。", noCommits: "この項目の git の変更はありません。",
    gitFailed: "git の履歴を読み取れませんでした。", unsupported: "この履歴・本文の形は未対応です。",
    historyDenied: "この項目の中身は履歴から開けません。", tooLarge: "この差は読取の大きさの上限を超えています。" } as Record<string, string>,
  metrics: { instructions: "指示", memory: "記憶の索引", listing: "スキルの一覧", startup: "起動のフックの出力",
    product: "製品が足す節", total: "毎回読む量", knownTotal: "確認できた分", listingCount: "一覧の本数", listingChars: "一覧の字数" } as Record<string, string>,
};
const h = historyStrings;
export function historySize(change: DesignHistoryChange) {
  if (change.beforeBytes != null && change.afterBytes != null) {
    const delta = change.afterBytes - change.beforeBytes;
    return (delta >= 0 ? "+" : "−") + bytes(Math.abs(delta));
  }
  if (change.kind === "added" && change.afterBytes != null) return "+" + bytes(change.afterBytes);
  if (change.kind === "deleted" && change.beforeBytes != null) return "−" + bytes(change.beforeBytes);
  if (change.linesAdded != null && change.linesDeleted != null) return "+" + change.linesAdded + " / −" + change.linesDeleted + " 行";
  return h.unknownSize;
}
function time(at: string, day = false) {
  const date = new Date(at);
  return Number.isFinite(date.getTime()) ? day ? date.toLocaleDateString("ja-JP") : date.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) : s.unknown;
}

const statusWords: Record<string, string> = {
  ignored: "このファイルは編集履歴の対象外です。除外の設定に当たっています。変更していないという意味ではありません。",
  untracked: "このファイルは編集履歴に登録されていません。変更していないという意味ではありません。",
  noCommits: "取得した範囲には変更の記録がありません。全期間の変更なしとは判定しません。",
  noRepository: "この場所にファイルの変更履歴はありません。現在の本文は下から確認できます。",
  gitUnavailable: "変更履歴を読む道具が見つかりません。", timeout: "変更履歴の取得に時間がかかり、中断しました。",
  historyDenied: "この対象の変更履歴は取得できません。", unsupported: "この形式の変更履歴は読み取れません。",
  tooLarge: h.statuses.tooLarge,
  gitFailed: "変更履歴の取得に失敗しました。もう一度取得してください。", itemUnavailable: "現在の目録と保存した写しに対象がありません。",
};
const kindWords: Record<string, string> = { added: "追加", deleted: "削除", changed: "変更", renamed: "名前を変更" };
const metricWords: Record<string, string> = { instructions: "初期の指示", memory: "初期の記憶", listing: "スキルの一覧", startup: "起動時の出力", product: "製品の指示", total: "初期量の合計", knownTotal: "確認できた初期量", listingCount: "一覧のスキル数", listingChars: "一覧の字数" };
function amount(change: DesignHistoryChange["amountChanges"][number]) {
  const unit = change.key === "listingCount" ? "本" : "字";
  return `${metricWords[change.key] ?? change.key}: ${change.before == null ? "未取得" : number(change.before) + " " + unit} → ${change.after == null ? "未取得" : number(change.after) + " " + unit}`;
}
function summary(change: DesignHistoryChange) {
  if (change.badge === "readAmountChanged") return change.amountChanges.map(amount).join(" · ");
  if (change.source === "git") return `${kindWords[change.kind] ?? "変更"} · ${change.linesAdded == null ? "追加行は未取得" : number(change.linesAdded) + " 行追加"} · ${change.linesDeleted == null ? "削除行は未取得" : number(change.linesDeleted) + " 行削除"}`;
  const known = (value: number | null) => value == null ? "量は未取得" : sizeText({ chars: null, lines: null, bytes: value });
  return `${kindWords[change.kind] ?? "変更"} · ${known(change.beforeBytes)} → ${known(change.afterBytes)} · ${historySize(change)}`;
}
interface HistoryViewProps { catalog: AgentDesignCatalog; api: AgentDesignApi; query: string; serviceId?: AgentServiceId; onOpen?: (id: string) => void }
export function HistoryView({ onOpen = () => {}, ...props }: HistoryViewProps) {
  if (!props.api.history) return <HistoryUnavailable catalog={props.catalog} query={props.query} onOpen={onOpen} />;
  return <HistoryRecords {...props} onOpen={onOpen} />;
}
function HistoryRecords({ catalog, api, query, serviceId, onOpen }: HistoryViewProps & { onOpen: (id: string) => void }) {
  const [history, setHistory] = useState<DesignHistory | null>(null);
  const [before, setBefore] = useState(""); const [after, setAfter] = useState("");
  const [pair, setPair] = useState<DesignHistoryChange[] | null>(null);
  const [mode, setMode] = useState("snapshot"); const [service, setService] = useState<string>(serviceId ?? "all"); const [layer, setLayer] = useState("all");
  const [selected, setSelected] = useState(""); const [git, setGit] = useState<DesignGitHistory | null>(null);
  const [change, setChange] = useState<DesignHistoryChange | null>(null); const [diff, setDiff] = useState<DesignHistoryDiff | null>(null);
  const [error, setError] = useState(""); const [retry, setRetry] = useState(0); const [gitBusy, setGitBusy] = useState(false);
  const scope = useRef(0);
  const historyFolder = useRef(catalog.cwd);
  useEffect(() => { setService(serviceId ?? "all"); setSelected(""); setChange(null); setGit(null); setDiff(null); }, [catalog.cwd, serviceId]);
  useEffect(() => {
    const token = ++scope.current; let timer: ReturnType<typeof setTimeout> | undefined;
    if (historyFolder.current !== catalog.cwd) {
      historyFolder.current = catalog.cwd; setHistory(null); setPair(null); setBefore(""); setAfter(""); setSelected(""); setChange(null); setDiff(null); setGit(null);
    }
    setError("");
    const load = async () => {
      try {
        const data = await api.history!(catalog.cwd); if (token !== scope.current) return;
        setHistory(data);
        const points = data.snapshots ?? [];
        if (points.length >= 2) {
          setBefore(value => points.some(point => point.id === value) ? value : points[points.length - 2].id);
          setAfter(value => points.some(point => point.id === value) ? value : points[points.length - 1].id);
        }
        if (data.writing) timer = setTimeout(() => void load(), 200);
      } catch { if (token === scope.current) setError(h.error + " 変更がないとは判定できません。"); }
    };
    void load(); return () => { scope.current++; clearTimeout(timer); };
  }, [api, catalog.cwd, catalog.generatedAt, retry]);
  useEffect(() => {
    let active = true; setPair(null); setChange(null);
    if (before && after && api.historyPair) void api.historyPair(before, after, catalog.cwd).then(data => { if (active) { setPair(data); setError(""); } }).catch(() => { if (active) setError("この二時点を比較できません。古い写しから新しい写しの順に選んでください。"); });
    return () => { active = false; };
  }, [api, before, after, catalog.cwd]);
  useEffect(() => {
    let active = true; setGit(null); setDiff(null); setChange(null); setGitBusy(!!selected);
    if (selected && api.historyGit) void api.historyGit(selected, catalog.cwd).then(data => { if (active) setGit(data); }).catch(() => { if (active) setGit({ status: "gitFailed", changes: [] }); }).finally(() => { if (active) setGitBusy(false); });
    else setGitBusy(false);
    return () => { active = false; };
  }, [api, selected, catalog.cwd, catalog.generatedAt, serviceId, retry]);
  useEffect(() => {
    let active = true; setDiff(null);
    if (change?.hash && change.itemId && api.historyDiff) void api.historyDiff(change.itemId, change.hash, catalog.cwd).then(data => { if (active) setDiff(data); }).catch(() => { if (active) setDiff({ mode: "hidden", status: "gitFailed", lines: [], beforeBytes: null, afterBytes: null, truncated: false }); });
    return () => { active = false; };
  }, [api, change, catalog.cwd, serviceId]);
  const points = history?.snapshots ?? [];
  const start = points.find(p => p.id === before); const end = points.find(p => p.id === after);
  const interval = start && end ? (Date.parse(end.capturedAt) - Date.parse(start.capturedAt)) / 1000 : null;
  const current = catalog.items.find(item => item.id === selected);
  const allItems = new Map(catalog.items.map(item => [item.id, { id: item.id, service: item.service, layer: item.layer, displayName: item.displayName, path: item.path }]));
  for (const entry of history?.changes ?? []) if (entry.itemId && !allItems.has(entry.itemId)) allItems.set(entry.itemId, { id: entry.itemId, service: entry.service as typeof catalog.items[number]["service"], layer: entry.layer, displayName: entry.displayName, path: entry.path });
  const matches = (row: { service: string; layer: number; displayName: string; path: string | null; subject?: string | null }) => (service === "all" || row.service === service) && (layer === "all" || row.layer === Number(layer)) && (!query || [row.displayName, row.path, row.subject, s.layerNames[row.layer]].some(value => value?.toLowerCase().includes(query.toLowerCase())));
  const items = [...allItems.values()].filter(matches);
  const changes = (mode === "snapshot" ? pair ?? (before && after ? [] : history?.changes ?? []) : git?.changes ?? []).filter(row => row.badge === "readAmountChanged" ? (service === "all" || row.service === service) && (layer === "all" || layer === "-1") && (!query || summary(row).toLowerCase().includes(query.toLowerCase())) : matches(row))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const days = new Map<string, DesignHistoryChange[]>();
  for (const row of changes) { const day = time(row.at, true); days.set(day, [...days.get(day) ?? [], row]); }
  return <div className="ad-history-records" data-ad-view="history"><main className="ad-main">
    <h2>二つの時点とファイルの変更を比べる</h2>
    <p>写しは目録を読み直した時点の量と更新日です。ファイルの変更履歴は、そのファイルを編集の記録に入れたときだけ取れます。</p>
    <div className="ad-facts"><section><h3>過去の写し</h3><p>{history ? `${number(history.snapshotCount)} 時点` : "取得中"}</p><p>{dateTime(history?.capturedAt)}</p></section><section><h3>今回の目録</h3><p>{dateTime(catalog.generatedAt)}</p><p>{number(catalog.items.length)} 項目 · 全サービスの 7 層</p></section><section><h3>比較の範囲</h3><p>この作業フォルダだけ。最大 60 時点。</p><code className="ad-path">{catalog.cwd}</code></section><section><h3>記録の限界</h3><p>更新日と読んだ日は別です。記録なしは変更なしの証明ではありません。</p><p>写しは本文を保存しません。現在の本文は下の項目から開けます。</p></section></div>
    <div className="ad-actions"><button aria-pressed={mode === "snapshot"} onClick={() => { setMode("snapshot"); setChange(null); }}>過去の写しを比べる</button><button aria-pressed={mode === "git"} onClick={() => { setMode("git"); setChange(null); }}>ファイルの変更履歴</button><button onClick={() => setRetry(n => n + 1)}>記録を再取得</button></div>
    {error && <p role="alert">{error}</p>}{history?.writing && <p role="status">{h.writing}</p>}{!!history?.warnings.length && <p role="alert">{h.warning} 取得できた範囲だけを表示しています。</p>}
    {mode === "snapshot" && <section><h3>比較元と比較先</h3><div className="ad-actions">{[["比較元", before, setBefore], ["比較先", after, setAfter]].map(([label, value, set]) => <label key={label as string}>{label as string}<select aria-label={label as string} value={value as string} onChange={event => (set as typeof setBefore)(event.target.value)} disabled={!api.historyPair || points.length < 2}>{!points.length && <option value="">写しは未取得</option>}{points.map(point => <option key={point.id} value={point.id}>{dateTime(point.capturedAt)} · {number(point.itemCount)} 項目</option>)}</select></label>)}</div>
      {start && end && <p>比較元 {dateTime(start.capturedAt)} · {number(start.itemCount)} 項目 → 比較先 {dateTime(end.capturedAt)} · {number(end.itemCount)} 項目{interval != null && interval >= 0 && ` · 間隔 ${number(interval)} 秒`}。現在の目録とは別の二時点です。</p>}
      {points.length > 0 && <table className="ad-dense-table"><thead><tr><th>写しの時刻</th><th>元の目録の時刻</th><th>対象</th></tr></thead><tbody>{points.map(point => <tr key={point.id}><th>{dateTime(point.capturedAt)}</th><td>{dateTime(point.catalogGeneratedAt)}</td><td>{number(point.itemCount)} 項目 · {point.services?.map(value => `${value.service}: ${value.state === "present" ? "取得済み" : value.state === "absent" ? "なし" : "未取得"} ${number(value.itemCount)} 項目`).join(" · ") ?? "サービス別の範囲は未取得"}</td></tr>)}</tbody></table>}
      {history && points.length < 2 && <p>{history.snapshotCount === 0 ? h.empty : history.snapshotCount === 1 ? h.one : "二時点の範囲は未取得です。"} 比べるにはこの作業フォルダの写しが 2 時点必要です。</p>}
    </section>}
    <div className="ad-actions"><label>サービス <select aria-label="履歴のサービス" value={service} onChange={e => setService(e.target.value)}><option value="all">全サービス</option>{catalog.services.map(value => <option key={value.id} value={value.id}>{value.displayName}</option>)}</select></label><label>層 <select aria-label="履歴の層" value={layer} onChange={e => setLayer(e.target.value)}><option value="all">全層</option><option value="-1">{h.amounts}</option>{[7, 6, 5, 4, 3, 2, 1].map(value => <option key={value} value={value}>{s.layerNames[value]}</option>)}</select></label></div>
    {mode === "git" && <><h3>ファイルを選ぶ · {number(items.length)} 件</h3><p className="ad-muted">上の検索欄で名前・置き場所を探せます。</p><table className="ad-dense-table"><thead><tr><th>項目・置き場所</th><th>役割・量・更新</th><th>確認</th></tr></thead><tbody>{items.map(item => { const live = catalog.items.find(row => row.id === item.id); return <tr key={item.id} aria-selected={selected === item.id}><th><button data-ad-history-item={item.id} onClick={() => setSelected(item.id)}>{item.displayName}</button><code className="ad-path">{item.path}</code></th><td>{item.service} · {s.layerNames[item.layer]}{live && <small>{itemRole(live, catalog)} · {sizeText(live.size)} · {dateTime(live.modifiedAt)}</small>}</td><td>{live ? <button data-ad-open={item.id} onClick={() => onOpen(item.id)}>現在の本文を開く</button> : "現在の目録にはありません"}</td></tr>; })}</tbody></table></>}
    <h3>{mode === "snapshot" ? "二時点の変更" : "選んだファイルの変更"} · {mode === "snapshot" && before && after && pair == null ? "比較中" : number(changes.length) + " 件"}</h3>
    {mode === "git" && (gitBusy ? <p role="status">変更履歴を取得中</p> : git?.status !== "ready" && <p>{selected ? statusWords[git?.status ?? ""] ?? "この履歴は未取得です。" : "上のファイルから選んでください。取得するのは最新 30 件までです。"}</p>)}
    {mode === "snapshot" && pair && pair.length === 0 && <p>この二時点の間は変更 0 件です。現在まで変更がないという意味ではありません。</p>}
    {!changes.length && history && (query || layer !== "all") && <p>{h.noMatch}</p>}
    <div className="ad-history-days">{[...days].map(([day, rows]) => <section key={day}><h3>{day}</h3>
      <table className="ad-dense-table"><thead><tr><th>日時・対象</th><th>変更の要約</th><th>記録の出所</th></tr></thead><tbody>{rows.map(row => <tr key={row.id} aria-selected={change?.id === row.id}>
        <th><button data-ad-change={row.id} onClick={() => setChange(row)}>{dateTime(row.at)}<small>{row.displayName === "readAmount" ? "初期に読む量" : row.displayName}</small></button></th>
        <td><span className={"ad-badge ad-history-badge-" + row.badge}>{row.badge === "readAmountChanged" ? h.readAmountChanged : h.fileChanged}</span> {summary(row)}{row.subject && <small>原件名: {row.subject}</small>}</td>
        <td>{row.source === "git" ? "ファイルの変更履歴" : "目録の写し"}{row.hash && <code>{row.hash.slice(0, 8)}</code>}{row.author && <small>{row.author}</small>}</td>
      </tr>)}</tbody></table>
    </section>)}</div>
  </main><aside className="ad-detail"><h2>{change ? "選んだ変更の中身" : "確認できる範囲"}</h2>
    {change ? <><p>{summary(change)}</p><p>{dateTime(change.at)} · {change.service} · {s.layerNames[change.layer] ?? "初期の量"}</p><code className="ad-path">{change.path}</code>
      {change.itemId && catalog.items.some(row => row.id === change.itemId) && <button data-ad-open={change.itemId} onClick={() => onOpen(change.itemId!)}>現在の本文を開く</button>}
      {change.badge === "readAmountChanged" && <dl className="ad-fields">{change.amountChanges.map(value => <div key={value.key}><dt>{metricWords[value.key] ?? value.key}</dt><dd>{amount(value)}</dd></div>)}</dl>}
      {change.hash && <p>原件名: {change.subject}<br /><small>{h.author} {change.author || s.unknown}</small></p>}
      {change.hash ? diff ? diff.status !== "ready" ? <p>{diff.status === "gitFailed" ? h.diffError : statusWords[diff.status] ?? h.diffError}</p> : diff.mode === "hidden" ? <p>{h.noBody}。{change.layer === 4 && h.memoryBody}</p> : <><p>{diff.mode === "fields" ? h.fieldBody : "本文の行の差。秘密の値は伏せ字です。"}</p>{!diff.lines.some(line => line.kind !== "context") && <p>{h.noDiff}</p>}<div className="ad-history-diff" aria-label="行番号つきの差">{diff.lines.map((line, index) => <div key={index} className={"ad-history-line " + line.kind} data-kind={line.kind}><span>{line.oldLine}</span><span>{line.newLine}</span><span>{line.kind === "added" ? "+" : line.kind === "deleted" ? "−" : " "}</span><code>{line.text}</code></div>)}</div>{diff.truncated && <p>{h.truncated}</p>}</> : <p role="status">本文の差を取得中</p> : <p>{change.layer === 4 ? h.memoryBody : h.snapshotBody}</p>}
    </> : <><h3>最新の記録</h3><p>{dateTime(history?.capturedAt)} · {history ? number(history.snapshotCount) + " 時点" : "写しは取得中"}</p><h3>量の推移</h3>{(history?.changes ?? []).filter(row => row.badge === "readAmountChanged").slice(0, 5).map(row => <p key={row.id}>{dateTime(row.at)} · {row.service}<small>{summary(row)}</small></p>)}{!history?.changes.some(row => row.badge === "readAmountChanged") && <p>取得した写しには量の変更記録がありません。現在までの読み取りや使用の回数は未収集です。</p>}<h3>次の確認</h3><p>二時点を選ぶ → 変更の行を押す → 現在の本文を開く。</p><p>ファイルの変更履歴では、対象外・未登録・取得失敗を分けて表示します。</p></>}
    {current && <p>選択中: {current.displayName} · 更新 {dateTime(current.modifiedAt)}。この更新日と最新の変更記録は別です。</p>}
  </aside></div>;
}
